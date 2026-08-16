//! Register Metaplex metadata for the share mint.
//!
//! Requires the **manager**: naming a token is part of presenting a basket, not
//! part of reaching its funds.
//!
//! This instruction has to exist in the program at all because the share mint's
//! authority is the tracker PDA — only this program can sign as it. Without it
//! the token shows up in every wallet as a bare mint address, and DexScreener
//! and friends have no name or logo to read.
//!
//! # A hand-rolled CPI instead of `mpl-token-metadata`
//!
//! The Anchor program pulled in the whole `mpl-token-metadata` crate to build
//! one instruction. Here it is 30 lines of borsh: a discriminator, three
//! strings, and four `None`s. That crate was a measurable slice of the Anchor
//! binary and this replaces it exactly.
//!
//! `CreateMetadataAccountV3` layout, from the Metaplex instruction enum:
//!
//! ```text
//! u8       discriminator = 33
//! DataV2:
//!   string name
//!   string symbol
//!   string uri
//!   u16    seller_fee_basis_points
//!   Option<Vec<Creator>>  creators           = None
//!   Option<Collection>    collection         = None
//!   Option<Uses>          uses               = None
//! bool     is_mutable
//! Option<CollectionDetails> collection_details = None
//! ```
//!
//! Borsh encodes a `String` as a 4-byte little-endian length then the bytes,
//! and `Option::None` as a single zero byte.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::VaultError;

/// `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`
pub const TOKEN_METADATA_PROGRAM_ID: Address = Address::new_from_array([
    11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205, 88, 184, 108, 115,
    26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70,
]);

const CREATE_METADATA_ACCOUNT_V3: u8 = 33;

/// Metaplex's own limits. Checked here so an over-long name fails as our error
/// rather than as an opaque CPI failure.
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

/// The largest instruction this can build.
///
/// Written as a sum of named parts rather than a single number, because the
/// tail is five bytes and not four — `creators`, `collection`, `uses`,
/// `is_mutable`, `collection_details` — and getting that wrong is a slice
/// panic, which in a `no_std` program is an abort.
/// `a_maximal_payload_fits_the_buffer` is what proves it.
const MAX_IX_DATA: usize = 1                        // discriminator
    + (4 + MAX_NAME_LEN)
    + (4 + MAX_SYMBOL_LEN)
    + (4 + MAX_URI_LEN)
    + 2                                             // seller_fee_basis_points
    + 5; // creators, collection, uses, is_mutable, collection_details

/// `name_len: u8 || name || symbol_len: u8 || symbol || uri_len: u8 || uri`
pub struct Args<'a> {
    pub name: &'a [u8],
    pub symbol: &'a [u8],
    pub uri: &'a [u8],
}

impl<'a> Args<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Self, VaultError> {
        fn take<'b>(data: &'b [u8], at: &mut usize, max: usize) -> Option<&'b [u8]> {
            let len = *data.get(*at)? as usize;
            if len == 0 || len > max {
                return None;
            }
            let start = *at + 1;
            let end = start.checked_add(len)?;
            if end > data.len() {
                return None;
            }
            *at = end;
            Some(&data[start..end])
        }

        let mut at = 0usize;
        let name = take(data, &mut at, MAX_NAME_LEN).ok_or(VaultError::InvalidName)?;
        let symbol = take(data, &mut at, MAX_SYMBOL_LEN).ok_or(VaultError::InvalidSymbol)?;
        let uri = take(data, &mut at, MAX_URI_LEN).ok_or(VaultError::InvalidName)?;
        // Exact length: trailing bytes mean the caller encoded something this
        // handler is not reading.
        if at != data.len() {
            return Err(VaultError::MalformedInstructionData);
        }
        Ok(Self { name, symbol, uri })
    }
}

/// Build the `CreateMetadataAccountV3` payload into `out`, returning its length.
pub fn encode_create_v3(args: &Args, out: &mut [u8; MAX_IX_DATA]) -> usize {
    let mut n = 0usize;
    let mut put = |bytes: &[u8], n: &mut usize| {
        out[*n..*n + bytes.len()].copy_from_slice(bytes);
        *n += bytes.len();
    };

    put(&[CREATE_METADATA_ACCOUNT_V3], &mut n);
    for s in [args.name, args.symbol, args.uri] {
        put(&(s.len() as u32).to_le_bytes(), &mut n);
        put(s, &mut n);
    }
    put(&0u16.to_le_bytes(), &mut n); // seller_fee_basis_points
    put(&[0], &mut n); // creators: None
    put(&[0], &mut n); // collection: None
    put(&[0], &mut n); // uses: None
                       // Mutable, so the URI can move to a permanent host later.
    put(&[1], &mut n); // is_mutable: true
    put(&[0], &mut n); // collection_details: None
    n
}

#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
use {
    crate::accounts::*,
    crate::constants::*,
    crate::state::Tracker,
    pinocchio::cpi::{invoke_signed_with_bounds, Seed, Signer},
    pinocchio::instruction::{InstructionAccount, InstructionView},
};

/// ```text
/// 0 manager                 signer, writable — pays the metadata account's rent
/// 1 tracker                                  — signs as mint + update authority
/// 2 share_mint
/// 3 metadata                writable         — created by Metaplex at its canonical PDA
/// 4 token_metadata_program
/// 5 system_program
/// 6 rent_sysvar
/// ```
#[cfg(any(target_os = "solana", target_arch = "bpf", feature = "host-pda"))]
pub fn handle(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args = Args::parse(data)?;

    let [manager, tracker_ai, share_mint_ai, metadata_ai, metadata_program, system_program, rent_sysvar, ..] =
        accounts
    else {
        return Err(VaultError::RemainingAccountsMismatch.into());
    };

    require_signer(manager)?;
    require_writable(manager)?;
    require_writable(metadata_ai)?;
    require_program(metadata_program, &TOKEN_METADATA_PROGRAM_ID)?;
    require_program(system_program, &SYSTEM_PROGRAM_ID)?;

    require_owned_by(tracker_ai, program_id)?;
    let ticker_len;
    let mut ticker_buf = [0u8; MAX_TICKER_LEN];
    let bump;
    {
        let d = tracker_ai.try_borrow()?;
        let tracker = Tracker::load(&d)?;
        require_pda(
            tracker_ai,
            &[TRACKER_SEED, tracker.ticker()],
            tracker.bump(),
            program_id,
        )?;
        if share_mint_ai.address().to_bytes() != tracker.share_mint() {
            return Err(VaultError::SeedsMismatch.into());
        }
        if tracker.manager() != manager.address().to_bytes() {
            return Err(VaultError::NotManager.into());
        }
        ticker_len = tracker.ticker().len();
        ticker_buf[..ticker_len].copy_from_slice(tracker.ticker());
        bump = tracker.bump();
    }

    let mut buf = [0u8; MAX_IX_DATA];
    let len = encode_create_v3(&args, &mut buf);

    let bump_seed = [bump];
    let tracker_seeds = [
        Seed::from(TRACKER_SEED),
        Seed::from(&ticker_buf[..ticker_len]),
        Seed::from(&bump_seed[..]),
    ];

    // The tracker PDA appears twice — as mint authority and as update
    // authority — which is exactly what lets this program name a mint nobody
    // else can.
    // Addresses copied into locals first: the meta array has to borrow from
    // something other than the account views, because those are passed to the
    // same call.
    // `Address` is not `Copy`, so these round-trip through the byte array.
    let a_metadata = Address::new_from_array(metadata_ai.address().to_bytes());
    let a_mint = Address::new_from_array(share_mint_ai.address().to_bytes());
    let a_tracker = Address::new_from_array(tracker_ai.address().to_bytes());
    let a_manager = Address::new_from_array(manager.address().to_bytes());
    let a_system = Address::new_from_array(system_program.address().to_bytes());
    let a_rent = Address::new_from_array(rent_sysvar.address().to_bytes());

    let metas = [
        InstructionAccount::writable(&a_metadata),
        InstructionAccount::readonly(&a_mint),
        InstructionAccount::readonly_signer(&a_tracker),
        InstructionAccount::writable_signer(&a_manager),
        InstructionAccount::readonly_signer(&a_tracker),
        InstructionAccount::readonly(&a_system),
        InstructionAccount::readonly(&a_rent),
    ];

    // The tracker appears twice — the duplicate reference is required to keep
    // the 1:1 relationship between metas and account views.
    let views: [&AccountView; 7] = [
        &*metadata_ai,
        &*share_mint_ai,
        &*tracker_ai,
        &*manager,
        &*tracker_ai,
        &*system_program,
        &*rent_sysvar,
    ];

    invoke_signed_with_bounds::<7, _>(
        &InstructionView {
            program_id: &TOKEN_METADATA_PROGRAM_ID,
            accounts: &metas,
            data: &buf[..len],
        },
        &views,
        &[Signer::from(&tracker_seeds)],
    )?;

    Ok(())
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf", feature = "host-pda")))]
pub fn handle(_: &Address, _: &mut [AccountView], _: &[u8]) -> ProgramResult {
    Err(VaultError::NotImplemented.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_args(name: &str, symbol: &str, uri: &str) -> std::vec::Vec<u8> {
        let mut v = std::vec::Vec::new();
        for s in [name, symbol, uri] {
            v.push(s.len() as u8);
            v.extend_from_slice(s.as_bytes());
        }
        v
    }

    #[test]
    fn parses_arguments() {
        let d = encode_args("Buffett Tracker", "bwSOL", "https://x/y.json");
        let a = Args::parse(&d).unwrap();
        assert_eq!(a.name, b"Buffett Tracker");
        assert_eq!(a.symbol, b"bwSOL");
        assert_eq!(a.uri, b"https://x/y.json");
    }

    #[test]
    fn rejects_over_long_fields() {
        let long_name = "x".repeat(MAX_NAME_LEN + 1);
        assert_eq!(
            Args::parse(&encode_args(&long_name, "b", "u")).err(),
            Some(VaultError::InvalidName)
        );
        let long_symbol = "x".repeat(MAX_SYMBOL_LEN + 1);
        assert_eq!(
            Args::parse(&encode_args("n", &long_symbol, "u")).err(),
            Some(VaultError::InvalidSymbol)
        );
    }

    #[test]
    fn rejects_empty_fields_and_trailing_bytes() {
        assert!(Args::parse(&encode_args("", "b", "u")).is_err());
        let mut d = encode_args("n", "b", "u");
        d.push(0);
        assert_eq!(
            Args::parse(&d).err(),
            Some(VaultError::MalformedInstructionData)
        );
    }

    #[test]
    fn rejects_a_truncated_payload() {
        let d = encode_args("name", "sym", "uri");
        for cut in 1..d.len() {
            assert!(Args::parse(&d[..cut]).is_err(), "cut at {cut}");
        }
    }

    /// The encoding is the whole reason this file can drop `mpl-token-metadata`,
    /// so assert the exact bytes rather than trusting it round-trips.
    #[test]
    fn encodes_create_metadata_account_v3() {
        let d = encode_args("Ab", "cd", "ef");
        let args = Args::parse(&d).unwrap();
        let mut buf = [0u8; MAX_IX_DATA];
        let n = encode_create_v3(&args, &mut buf);

        let expected: std::vec::Vec<u8> = [
            &[33u8][..],              // discriminator
            &2u32.to_le_bytes()[..],  // name len
            b"Ab",                    //
            &2u32.to_le_bytes()[..],  // symbol len
            b"cd",                    //
            &2u32.to_le_bytes()[..],  // uri len
            b"ef",                    //
            &0u16.to_le_bytes()[..],  // seller_fee_basis_points
            &[0][..],                 // creators: None
            &[0][..],                 // collection: None
            &[0][..],                 // uses: None
            &[1][..],                 // is_mutable: true
            &[0][..],                 // collection_details: None
        ]
        .concat();

        assert_eq!(&buf[..n], expected.as_slice());
    }

    /// A maximal payload must still fit the fixed buffer — this is what stops
    /// `encode_create_v3` from panicking on a slice bound in a `no_std` program
    /// where a panic is an abort.
    #[test]
    fn a_maximal_payload_fits_the_buffer() {
        let name = "n".repeat(MAX_NAME_LEN);
        let symbol = "s".repeat(MAX_SYMBOL_LEN);
        let uri = "u".repeat(MAX_URI_LEN);
        let d = encode_args(&name, &symbol, &uri);
        let args = Args::parse(&d).unwrap();
        let mut buf = [0u8; MAX_IX_DATA];
        let n = encode_create_v3(&args, &mut buf);
        assert_eq!(n, MAX_IX_DATA);
    }

    #[test]
    fn metaplex_program_id_is_exactly_right() {
        assert_eq!(
            TOKEN_METADATA_PROGRAM_ID.to_bytes(),
            [
                11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205, 88, 184,
                108, 115, 26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70
            ]
        );
    }
}
