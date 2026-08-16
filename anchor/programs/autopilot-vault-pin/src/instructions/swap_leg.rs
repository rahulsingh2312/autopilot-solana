//! Route one leg through Jupiter, signed by the vault PDA.
//!
//! Requires the **manager**. Repositioning the basket is what a creator does;
//! it must never come with the ability to take anything out.
//!
//! # The security model is deliberately narrow
//!
//! This instruction does **not** try to understand the route. `route_data` is
//! opaque bytes and the accounts behind it are unchecked — they are Jupiter's
//! to validate, not ours. What it does instead is bracket the CPI with
//! measurements the vault cares about and refuse to proceed unless they hold:
//!
//! 1. **The swap program is pinned**, compiled in, never passed. A caller
//!    cannot route the vault's assets through a program of their choosing.
//! 2. **Both token accounts belong to the vault.** Whatever the route does, the
//!    proceeds cannot land anywhere else.
//! 3. **The destination is a published leg** (or wSOL, the sleeve). The manager
//!    cannot convert the vault into a token nobody voted for by publishing one
//!    basket and trading another.
//! 4. **Balances are read before and after.** Spending more than `amount_in` or
//!    receiving less than `min_amount_out` reverts the whole transaction, which
//!    makes a hostile or merely broken route a failed transaction rather than a
//!    loss.
//!
//! This is why the swap lives in the program at all. An off-chain executor
//! holding a withdrawal key would be far simpler, and would mean a window in
//! which depositor funds sit in an operator's wallet. Here they never leave.
//!
//! # Selling into the sleeve is always allowed
//!
//! Only *buys* are checked against the published basket. Exiting a position
//! must never be blocked by the basket that no longer wants it — otherwise a
//! rebalance that drops a leg would strand it.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;

/// `amount_in: u64 || min_amount_out: u64 || route_data[..]`, little-endian.
pub const ARGS_HEADER_LEN: usize = 16;

pub fn parse_args(data: &[u8]) -> Result<(u64, u64, &[u8]), VaultError> {
    if data.len() < ARGS_HEADER_LEN {
        return Err(VaultError::MalformedInstructionData);
    }
    let amount_in = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let min_amount_out = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let route = &data[ARGS_HEADER_LEN..];
    if route.is_empty() {
        return Err(VaultError::EmptyRoute);
    }
    Ok((amount_in, min_amount_out, route))
}

/// Jupiter aggregator v6 — `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`,
/// pinned rather than passed.
pub const JUPITER_PROGRAM_ID: Address = Address::new_from_array([
    4, 121, 213, 91, 242, 49, 192, 110, 238, 116, 197, 110, 206, 104, 21, 7, 253, 177, 178, 222,
    163, 244, 142, 81, 2, 177, 205, 162, 86, 188, 19, 143,
]);

/// Wrapped SOL. The vault holds native lamports, Jupiter trades tokens, so
/// every route into or out of the SOL sleeve passes through this mint.
///
/// A raw `[u8; 32]` rather than an `Address`, because it is only ever compared
/// against leg mints, which the tracker layout stores as raw bytes.
pub const WSOL_MINT: [u8; 32] = [
    6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196, 57, 220, 26,
    235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1,
];

/// Upper bound on accounts forwarded to the route, stack-allocated.
///
/// Only referenced by the on-chain handler, so it is gated with it.
///
/// `invoke_signed_with_slice` would take any number but allocates on the heap,
/// and this program declares `no_allocator!`, so the bound has to be static.
///
/// **This is a stack budget, not a transaction budget.** An SBF frame is capped
/// at 4 KB, and one `InstructionAccount` per slot is the largest thing this
/// handler puts on the stack. An earlier version reserved 64 slots *and* kept
/// parallel `[Address; 64]` / `[bool; 64]` arrays to work around a borrow, for
/// a 7,552-byte frame — 3,360 over the limit. The program aborted after 510
/// compute units with "Program failed to complete", which reads like anything
/// but a stack overflow.
///
/// `cargo-build-sbf` does warn, on a line beginning `Error: Function … Stack
/// offset of N exceeded max offset of 4096`. It is not a build failure, so it
/// is easy to filter out of build output and never see.
///
/// A live Jupiter direct route uses 25 accounts; 40 leaves headroom for a
/// two-hop
/// route while keeping the frame under 4 KB — 48 was 32 bytes over.
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
const MAX_ROUTE_ACCOUNTS: usize = 40;

#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::constants::*,
    crate::spl::read_token_account,
    crate::state::Tracker,
    pinocchio::cpi::{invoke_signed_with_bounds, Seed, Signer},
    pinocchio::instruction::{InstructionAccount, InstructionView},
    pinocchio_system::instructions::Transfer,
    // **Classic** SPL Token, not Token-2022. Every use of these two below is on
    // the wSOL account, and wSOL is a classic mint — `So111…112` predates
    // Token-2022 and is owned by the original program. Invoking Token-2022
    // against it fails, because the account is not owned by that program.
    //
    // The Token-2022 aliases are the natural thing to reach for here, since the
    // legs are Token-2022 and `swap_leg` handles both sides. They are the wrong
    // ones. This is the same mistake the Anchor program made in
    // `redeem_in_kind`, in the opposite direction.
    pinocchio_token::instructions::{CloseAccount, SyncNative},
};

/// ```text
/// 0 manager           signer
/// 1 tracker
/// 2 vault             writable
/// 3 source_token      writable — what is being sold, owned by the vault
/// 4 destination_token writable — what is being bought, owned by the vault
/// 5 source_mint
/// 6 destination_mint
/// 7 token_program     SPL Token or Token-2022
/// 8 system_program
/// 9 jupiter_program   pinned below
/// 10.. remaining      the route's own accounts, forwarded verbatim
/// ```
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (amount_in, min_amount_out, route_data) = parse_args(data)?;
    if amount_in == 0 {
        return Err(VaultError::ZeroAmount.into());
    }

    let [manager, tracker_ai, vault_ai, source_ta, destination_ta, source_mint_ai, destination_mint_ai, _token_program, _system_program, jupiter_program, route @ ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };

    // ---- account validation ----
    require_signer(manager)?;
    require_writable(vault_ai)?;
    require_writable(source_ta)?;
    require_writable(destination_ta)?;
    // Pinned, never taken on trust. This is check (1).
    require_program(jupiter_program, &JUPITER_PROGRAM_ID)?;

    let source_mint = source_mint_ai.address().to_bytes();
    let destination_mint = destination_mint_ai.address().to_bytes();
    if source_mint == destination_mint {
        return Err(VaultError::SwapToSameMint.into());
    }

    require_owned_by(tracker_ai, program_id)?;
    let tracker_key = tracker_ai.address().to_bytes();
    let vault_key = vault_ai.address().to_bytes();
    let vault_bump;
    {
        let d = tracker_ai.try_borrow()?;
        let tracker = Tracker::load(&d)?;
        require_pda(
            tracker_ai,
            &[TRACKER_SEED, tracker.ticker()],
            tracker.bump(),
            program_id,
        )?;
        require_pda(
            vault_ai,
            &[VAULT_SEED, &tracker_key],
            tracker.vault_bump(),
            program_id,
        )?;
        if tracker.manager() != manager.address().to_bytes() {
            return Err(VaultError::NotManager.into());
        }

        // Check (3): buying must land in something the published basket says we
        // hold. Selling into the sleeve is always allowed.
        if destination_mint != WSOL_MINT {
            let mut found = false;
            for i in 0..tracker.leg_count() {
                if tracker.leg_mint(i) == Some(destination_mint) {
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(VaultError::MintNotInBasket.into());
            }
        }
        vault_bump = tracker.vault_bump();
    }

    // Check (2): whatever the route does, proceeds cannot land anywhere else.
    let (src_mint, src_owner, _) = read_token_account(source_ta)?;
    if src_mint != source_mint {
        return Err(VaultError::TokenAccountMintMismatch.into());
    }
    if src_owner != vault_key {
        return Err(VaultError::TokenAccountOwnerMismatch.into());
    }
    let (dst_mint, dst_owner, _) = read_token_account(destination_ta)?;
    if dst_mint != destination_mint {
        return Err(VaultError::TokenAccountMintMismatch.into());
    }
    if dst_owner != vault_key {
        return Err(VaultError::TokenAccountOwnerMismatch.into());
    }

    let vault_bump_seed = [vault_bump];
    let vault_seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(&tracker_key[..]),
        Seed::from(&vault_bump_seed[..]),
    ];

    // Wrapping: the vault's SOL is native lamports, but a route consumes
    // tokens. Move exactly `amount_in` into the wSOL account and sync it, so
    // the balance the route sees is the balance we intended to risk.
    if source_mint == WSOL_MINT {
        Transfer {
            from: vault_ai,
            to: source_ta,
            lamports: amount_in,
        }
        .invoke_signed(&[Signer::from(&vault_seeds)])?;
        SyncNative::new(source_ta, None).invoke()?;
    }

    // Check (4), first half: measure before.
    let (_, _, source_before) = read_token_account(source_ta)?;
    let (_, _, destination_before) = read_token_account(destination_ta)?;

    // Forward the route untouched. The vault is a non-signer in the caller's
    // account list precisely because it cannot sign a transaction; its
    // signature is supplied here, by seeds.
    if route.len() > MAX_ROUTE_ACCOUNTS {
        return Err(VaultError::RemainingAccountsMismatch.into());
    }
    // Borrow the addresses straight out of `route` rather than copying them
    // into a second array: both this and the account slice passed below are
    // immutable borrows, so they coexist, and the 2 KB of copies was most of
    // what blew the stack frame.
    let route_view: &[AccountView] = route;
    let mut metas = [const { InstructionAccount::readonly(&JUPITER_PROGRAM_ID) };
        MAX_ROUTE_ACCOUNTS];
    for (i, account) in route_view.iter().enumerate() {
        // The vault is a non-signer in the caller's account list precisely
        // because it cannot sign a transaction; its signature is supplied here,
        // by seeds.
        let is_vault = account.address().to_bytes() == vault_key;
        metas[i] = InstructionAccount::new(account.address(), account.is_writable(), is_vault);
    }

    invoke_signed_with_bounds::<MAX_ROUTE_ACCOUNTS, _>(
        &InstructionView {
            program_id: &JUPITER_PROGRAM_ID,
            accounts: &metas[..route_view.len()],
            data: route_data,
        },
        route_view,
        &[Signer::from(&vault_seeds)],
    )?;

    // Check (4), second half. This is the whole guarantee: whatever happened
    // inside the route, the vault spent no more than it offered and received no
    // less than it demanded, or nothing happened at all.
    let (_, _, source_after) = read_token_account(source_ta)?;
    let (_, _, destination_after) = read_token_account(destination_ta)?;

    let spent = source_before
        .checked_sub(source_after)
        .ok_or(VaultError::SwapIncreasedSourceBalance)?;
    if spent > amount_in {
        return Err(VaultError::SwapSpentTooMuch.into());
    }
    let received = destination_after
        .checked_sub(destination_before)
        .ok_or(VaultError::MathOverflow)?;
    if received < min_amount_out {
        return Err(VaultError::SlippageExceeded.into());
    }

    // Unwrap whatever wSOL is left — the proceeds of a sale, or the remainder
    // of a purchase that used less than it was given. Closing returns the
    // lamports to the vault, which is where the SOL sleeve lives.
    if destination_mint == WSOL_MINT {
        CloseAccount::new(destination_ta, vault_ai, vault_ai)
            .invoke_signed(&[Signer::from(&vault_seeds)])?;
    } else if source_mint == WSOL_MINT && source_after > 0 {
        CloseAccount::new(source_ta, vault_ai, vault_ai)
            .invoke_signed(&[Signer::from(&vault_seeds)])?;
    }

    Ok(())
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub fn handle(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
    Err(VaultError::NotImplemented.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arguments_and_route() {
        let mut d = std::vec::Vec::new();
        d.extend_from_slice(&1_000u64.to_le_bytes());
        d.extend_from_slice(&900u64.to_le_bytes());
        d.extend_from_slice(&[1, 2, 3, 4]);
        assert_eq!(parse_args(&d).unwrap(), (1_000, 900, &[1u8, 2, 3, 4][..]));
    }

    /// An empty route would forward a zero-length instruction to Jupiter, which
    /// is never what a caller meant.
    #[test]
    fn rejects_an_empty_route() {
        let mut d = std::vec::Vec::new();
        d.extend_from_slice(&1_000u64.to_le_bytes());
        d.extend_from_slice(&900u64.to_le_bytes());
        assert_eq!(parse_args(&d).err(), Some(VaultError::EmptyRoute));
    }

    #[test]
    fn rejects_a_truncated_header() {
        assert_eq!(
            parse_args(&[0u8; ARGS_HEADER_LEN - 1]).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }

    /// Both addresses are compiled in, and a wrong one points the vault's
    /// assets at the wrong program with the vault's own signature attached.
    ///
    /// The full 32 bytes are asserted, not a prefix. An earlier draft of this
    /// file had the correct first 22 bytes of the Jupiter id and garbage after
    /// — a first-and-last-byte check would have passed it, because the last
    /// byte happened to match too.
    #[test]
    fn pinned_addresses_are_exactly_right() {
        // JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
        assert_eq!(
            JUPITER_PROGRAM_ID.to_bytes(),
            [
                4, 121, 213, 91, 242, 49, 192, 110, 238, 116, 197, 110, 206, 104, 21, 7, 253, 177,
                178, 222, 163, 244, 142, 81, 2, 177, 205, 162, 86, 188, 19, 143
            ]
        );
        // So11111111111111111111111111111111111111112
        assert_eq!(
            WSOL_MINT,
            [
                6, 155, 136, 87, 254, 171, 129, 132, 251, 104, 127, 99, 70, 24, 192, 53, 218, 196,
                57, 220, 26, 235, 59, 85, 152, 160, 240, 0, 0, 0, 0, 1
            ]
        );
    }
}
