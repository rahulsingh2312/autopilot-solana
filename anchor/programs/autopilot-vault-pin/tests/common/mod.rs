//! Differential test harness: one scenario, two programs, one assertion.
//!
//! The Pinocchio port gives up everything Anchor generated — discriminators,
//! `has_one`, `seeds`/`bump`, rent-exemption on `init`, owner and signer
//! checks, bounds-checked deserialization. Each of those is a named Solana
//! exploit class when it is missing, and the port's defence is not that the
//! code looks right. It is that a test drives *both* binaries through the same
//! scenario and asserts they land in the same observable state.
//!
//! # What "the same state" means
//!
//! The two programs deliberately do not share an account layout. Anchor writes
//! an 8-byte discriminator then borsh; the port writes a 1-byte tag, a version,
//! and fixed little-endian offsets. Comparing raw account bytes would compare
//! the thing that is *supposed* to differ.
//!
//! So the comparison is on [`Observed`]: share supply, vault lamports, fee
//! recipient balance, holder token balance, and the handful of tracker fields
//! that both layouts agree on the meaning of. That is exactly the surface a
//! holder, the frontend, and the NAV calculation can see. If those match, the
//! port is behaviourally equivalent where it matters and free to differ where
//! it does not.
//!
//! # Why the real `.so`, not the linked crate
//!
//! LiteSVM loads the compiled artifacts. Linking the handlers directly would
//! test the arithmetic while skipping the runtime's owner checks, the CPI
//! boundary, rent exemption, and every account-validation path — which is the
//! entire surface the port is at risk on.

#![allow(dead_code)]

use std::path::PathBuf;

use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

// ---------------------------------------------------------------------------
// Well-known addresses
// ---------------------------------------------------------------------------

/// The Anchor program's `declare_id!`. Its generated entrypoint rejects any
/// other address, so the harness has to load it here and nowhere else.
pub const ANCHOR_PROGRAM_ID: Address =
    Address::from_str_const("8cKanyTRdgbdf8eWiLpqzy3kwzsXWXNxQdd6NRauCSNK");

/// The port takes its id from the runtime, so this is arbitrary — chosen
/// distinct from the Anchor id so that every PDA in a scenario differs between
/// the two runs. A test that accidentally hardcodes one program's address
/// fails loudly instead of silently passing.
pub const PIN_PROGRAM_ID: Address =
    Address::from_str_const("PinAJvvBsRoWNfnQXRqL2eNjDDvL5crFxKcuBZbxa8T");

pub const TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM_ID: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM_ID: Address = Address::from_str_const("11111111111111111111111111111111");
/// Anchor's `Sysvar<'info, Rent>` still takes an account slot. The port reads
/// rent from a compiled-in constant instead — see `constants::rent_exempt_minimum`
/// — which is one account off every instruction and one fewer thing to pass.
pub const RENT_SYSVAR_ID: Address =
    Address::from_str_const("SysvarRent111111111111111111111111111111111");

pub const TRACKER_SEED: &[u8] = b"tracker";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SHARE_SEED: &[u8] = b"share";

/// Anchor's 8-byte instruction sighashes, copied from the frontend's pinned
/// table in `web/src/lib/vault/program.ts` rather than recomputed. If the
/// frontend and this harness ever disagree, the frontend is the one users
/// transact through, so it is the authority.
pub mod anchor_ix {
    pub const INITIALIZE_TRACKER: [u8; 8] = [27, 157, 128, 87, 48, 201, 132, 35];
    pub const DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
    pub const REDEEM_FOR_SOL: [u8; 8] = [60, 155, 227, 70, 252, 132, 98, 231];
    pub const REDEEM_IN_KIND: [u8; 8] = [102, 58, 189, 252, 192, 219, 140, 89];
    pub const REBALANCE: [u8; 8] = [108, 158, 77, 9, 210, 52, 88, 62];
    pub const SET_PAUSED: [u8; 8] = [91, 60, 125, 192, 176, 225, 166, 218];
    pub const SET_FEES: [u8; 8] = [137, 178, 49, 58, 0, 245, 242, 190];
}

/// The port's one-byte discriminators, mirroring `Instruction` in `lib.rs`.
pub mod pin_ix {
    pub const INITIALIZE_TRACKER: u8 = 0;
    pub const DEPOSIT: u8 = 1;
    pub const REDEEM_FOR_SOL: u8 = 2;
    pub const REDEEM_IN_KIND: u8 = 3;
    pub const REBALANCE: u8 = 4;
    pub const SET_PAUSED: u8 = 7;
    pub const SET_FEES: u8 = 8;
    pub const SET_AUTHORITY: u8 = 11;
    pub const SET_MANAGER: u8 = 12;
}

// ---------------------------------------------------------------------------
// Flavor
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Anchor,
    Pin,
}

impl Flavor {
    pub fn program_id(self) -> Address {
        match self {
            Flavor::Anchor => ANCHOR_PROGRAM_ID,
            Flavor::Pin => PIN_PROGRAM_ID,
        }
    }

    fn so_name(self) -> &'static str {
        match self {
            Flavor::Anchor => "autopilot_vault.so",
            Flavor::Pin => "autopilot_vault_pin.so",
        }
    }

    /// Both programs are run against every scenario, so `[Anchor, Pin]` is the
    /// canonical iteration order and tests read as "do this on both".
    pub const BOTH: [Flavor; 2] = [Flavor::Anchor, Flavor::Pin];
}

fn deploy_dir() -> PathBuf {
    // tests live at <crate>/tests, artifacts at <workspace>/target/deploy
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy")
        .canonicalize()
        .expect("target/deploy missing — run `cargo-build-sbf` for both programs first")
}

// ---------------------------------------------------------------------------
// Observed state
// ---------------------------------------------------------------------------

/// The surface both programs must agree on.
///
/// Deliberately excludes anything layout-specific: no discriminator, no field
/// offsets, no account size. A difference here is a behavioural difference, not
/// a representational one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    /// Share mint supply. This *is* the share count in both programs — neither
    /// keeps a second copy that could drift.
    pub share_supply: u64,
    /// Lamports in the vault PDA, reserve included.
    pub vault_lamports: u64,
    /// What the vault considers depositor money: lamports minus rent reserve.
    pub net_assets: u64,
    pub rent_reserve: u64,
    pub fee_recipient_lamports: u64,
    pub holder_shares: u64,
    pub deposit_fee_ppm: u16,
    pub redeem_fee_ppm: u16,
    pub paused: bool,
    pub leg_count: u8,
    /// Basket in order, as `(mint, weight_bps)`. Symbols are excluded: the
    /// Anchor layout stores one per leg and the port drops it, which is an
    /// intended divergence recorded in the port's module docs.
    pub legs: Vec<([u8; 32], u16)>,
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

pub struct Harness {
    pub svm: LiteSVM,
    pub flavor: Flavor,
    pub program_id: Address,
    pub payer: Keypair,
    pub fee_recipient: Address,
    /// The share mint keypair, for the port only.
    ///
    /// Anchor derives its mint from `["share", tracker]`; the port takes a
    /// caller-supplied keypair so the address can be a vanity one. That is an
    /// intended divergence, so `Observed` compares mint *supply* rather than
    /// mint address — the address is exactly the thing that is meant to differ.
    pub share_mint_kp: Keypair,
}

impl Harness {
    pub fn new(flavor: Flavor) -> Self {
        let mut svm = LiteSVM::new();
        let program_id = flavor.program_id();
        let path = deploy_dir().join(flavor.so_name());
        svm.add_program_from_file(program_id, &path)
            .unwrap_or_else(|e| panic!("failed to load {}: {e:?}", path.display()));

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * 1_000_000_000).unwrap();

        let fee_recipient = Address::new_unique();
        // Fee transfers target a bare system account. Give it rent exemption up
        // front so a fee arriving at a zero-lamport account is never the thing
        // that fails a scenario.
        svm.airdrop(&fee_recipient, 1_000_000_000).unwrap();

        Self {
            svm,
            flavor,
            program_id,
            payer,
            fee_recipient,
            share_mint_kp: Keypair::new(),
        }
    }

    // ---- PDAs -------------------------------------------------------------

    pub fn tracker_pda(&self, ticker: &str) -> (Address, u8) {
        Address::find_program_address(&[TRACKER_SEED, ticker.as_bytes()], &self.program_id)
    }

    /// Where this flavor's share mint lives.
    ///
    /// Anchor: a PDA. The port: the caller's keypair. Callers ask the harness
    /// rather than deriving, so a scenario reads the same for both.
    pub fn share_mint(&self, tracker: &Address) -> Address {
        match self.flavor {
            Flavor::Anchor => {
                Address::find_program_address(&[SHARE_SEED, tracker.as_ref()], &self.program_id).0
            }
            Flavor::Pin => self.share_mint_kp.pubkey(),
        }
    }

    pub fn vault_pda(&self, tracker: &Address) -> (Address, u8) {
        Address::find_program_address(&[VAULT_SEED, tracker.as_ref()], &self.program_id)
    }

    pub fn ata(&self, owner: &Address, mint: &Address) -> Address {
        Address::find_program_address(
            &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
            &ATA_PROGRAM_ID,
        )
        .0
    }

    // ---- transactions -----------------------------------------------------

    pub fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    /// Send, expect rejection, and return the custom error code.
    ///
    /// Asserting on the *code* rather than on "it failed somehow" is the
    /// difference between a test that proves the fee ceiling holds and one
    /// that passes because the account list was malformed. The port pins its
    /// error numbering to Anchor's precisely so this comparison is meaningful.
    pub fn send_err_code(&mut self, ix: Instruction, signers: &[&Keypair]) -> u32 {
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        let err = match self.svm.send_transaction(tx) {
            Ok(_) => panic!("[{:?}] expected rejection, transaction succeeded", self.flavor),
            Err(e) => e,
        };
        let text = format!("{:?}", err.err);
        // `InstructionError(0, Custom(6007))`
        let code = text
            .rsplit_once("Custom(")
            .and_then(|(_, rest)| rest.split(')').next())
            .and_then(|n| n.parse::<u32>().ok());
        match code {
            Some(c) => c,
            None => panic!(
                "[{:?}] expected a custom program error, got {text}\nlogs:\n{}",
                self.flavor,
                err.meta.logs.join("\n")
            ),
        }
    }

    /// Send an `initialize_tracker`, signing correctly for this flavor.
    ///
    /// The port's share mint is a caller keypair and must co-sign; Anchor's is
    /// a PDA and must *not* be passed, or `Transaction::sign` rejects a keypair
    /// with no matching signer slot. Kept here so no scenario has to remember.
    pub fn send_init(&mut self, ix: Instruction) {
        let payer = self.payer.insecure_clone();
        let mint = self.share_mint_kp.insecure_clone();
        match self.flavor {
            Flavor::Anchor => self.send_ok(ix, &[&payer]),
            Flavor::Pin => self.send_ok(ix, &[&payer, &mint]),
        }
    }

    /// The same, for a call expected to be rejected.
    pub fn send_init_err(&mut self, ix: Instruction) -> u32 {
        let payer = self.payer.insecure_clone();
        let mint = self.share_mint_kp.insecure_clone();
        match self.flavor {
            Flavor::Anchor => self.send_err_code(ix, &[&payer]),
            Flavor::Pin => self.send_err_code(ix, &[&payer, &mint]),
        }
    }

    /// Send and expect success, attaching program logs to the panic so a
    /// failing differential run says *why* rather than just which side broke.
    pub fn send_ok(&mut self, ix: Instruction, signers: &[&Keypair]) {
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(_) => {}
            Err(e) => panic!(
                "[{:?}] transaction failed: {:?}\nlogs:\n{}",
                self.flavor,
                e.err,
                e.meta.logs.join("\n")
            ),
        }
    }

    // ---- reads ------------------------------------------------------------

    pub fn lamports(&self, a: &Address) -> u64 {
        self.svm.get_balance(a).unwrap_or(0)
    }

    /// SPL mint supply, read at its fixed offset rather than through a token
    /// crate: the layout is frozen and the dependency is not worth it.
    ///
    /// ```text
    /// 0   COption<Pubkey> mint_authority (4 + 32)
    /// 36  u64             supply
    /// 44  u8              decimals
    /// ```
    pub fn mint_supply(&self, mint: &Address) -> u64 {
        let acct = match self.svm.get_account(mint) {
            Some(a) if a.data.len() >= 44 => a,
            _ => return 0,
        };
        u64::from_le_bytes(acct.data[36..44].try_into().unwrap())
    }

    /// SPL token account balance.
    ///
    /// ```text
    /// 0   Pubkey mint
    /// 32  Pubkey owner
    /// 64  u64    amount
    /// ```
    pub fn token_balance(&self, token_account: &Address) -> u64 {
        let acct = match self.svm.get_account(token_account) {
            Some(a) if a.data.len() >= 72 => a,
            _ => return 0,
        };
        u64::from_le_bytes(acct.data[64..72].try_into().unwrap())
    }

    /// Decode the tracker through whichever layout this flavor wrote, and
    /// return only the fields both layouts define.
    pub fn observe(&self, ticker: &str, holder: &Address) -> Observed {
        let (tracker, _) = self.tracker_pda(ticker);
        let share_mint = self.share_mint(&tracker);
        let (vault, _) = self.vault_pda(&tracker);

        let data = self
            .svm
            .get_account(&tracker)
            .unwrap_or_else(|| panic!("[{:?}] tracker account missing", self.flavor))
            .data;

        let t = match self.flavor {
            Flavor::Anchor => decode_anchor_tracker(&data),
            Flavor::Pin => decode_pin_tracker(&data),
        };

        let vault_lamports = self.lamports(&vault);

        Observed {
            share_supply: self.mint_supply(&share_mint),
            vault_lamports,
            net_assets: vault_lamports.saturating_sub(t.rent_reserve),
            rent_reserve: t.rent_reserve,
            fee_recipient_lamports: self.lamports(&self.fee_recipient),
            holder_shares: self.token_balance(&self.ata(holder, &share_mint)),
            deposit_fee_ppm: t.deposit_fee_ppm,
            redeem_fee_ppm: t.redeem_fee_ppm,
            paused: t.paused,
            leg_count: t.legs.len() as u8,
            legs: t.legs,
        }
    }
}

// ---------------------------------------------------------------------------
// Tracker decoding, one per layout
// ---------------------------------------------------------------------------

pub struct DecodedTracker {
    pub rent_reserve: u64,
    pub deposit_fee_ppm: u16,
    pub redeem_fee_ppm: u16,
    pub paused: bool,
    pub legs: Vec<([u8; 32], u16)>,
}

/// Anchor's borsh layout, walked by hand.
///
/// Variable-length: `ticker` and `name` are borsh strings and `legs` is a
/// borsh vec whose `symbol` is itself a string, so every field after the first
/// string sits at an offset that depends on the data. That is precisely why
/// the port uses fixed offsets, and why this decoder has to walk rather than
/// index.
fn decode_anchor_tracker(data: &[u8]) -> DecodedTracker {
    let mut o = 8; // discriminator
    o += 32 * 3; // authority, share_mint, fee_recipient

    let read_str = |data: &[u8], o: &mut usize| {
        let len = u32::from_le_bytes(data[*o..*o + 4].try_into().unwrap()) as usize;
        *o += 4 + len;
    };
    read_str(data, &mut o); // ticker
    read_str(data, &mut o); // name

    let leg_count = u32::from_le_bytes(data[o..o + 4].try_into().unwrap()) as usize;
    o += 4;
    let mut legs = Vec::with_capacity(leg_count);
    for _ in 0..leg_count {
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&data[o..o + 32]);
        o += 32;
        read_str(data, &mut o); // symbol — dropped by the port on purpose
        let weight = u16::from_le_bytes(data[o..o + 2].try_into().unwrap());
        o += 2;
        legs.push((mint, weight));
    }

    let deposit_fee_ppm = u16::from_le_bytes(data[o..o + 2].try_into().unwrap());
    o += 2;
    let redeem_fee_ppm = u16::from_le_bytes(data[o..o + 2].try_into().unwrap());
    o += 2;
    o += 8 + 8 + 4; // rebalance_interval, last_rebalance_ts, rebalance_count
    o += 2; // filing_delay_days
    let rent_reserve = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    o += 8;
    let paused = data[o] != 0;

    DecodedTracker {
        rent_reserve,
        deposit_fee_ppm,
        redeem_fee_ppm,
        paused,
        legs,
    }
}

/// The port's fixed layout. Offsets mirror `state::tracker` — kept as literals
/// here rather than imported so that a change to the layout has to be made in
/// two places deliberately, and `header_layout_is_frozen` catches the drift.
fn decode_pin_tracker(data: &[u8]) -> DecodedTracker {
    const PAUSED: usize = 3;
    const LEG_COUNT: usize = 8;
    const RENT_RESERVE: usize = 150;
    const DEPOSIT_FEE_PPM: usize = 158;
    const REDEEM_FEE_PPM: usize = 160;
    const LEGS: usize = 170;
    // 32 mint + 2 weight + 32 feed_id. The feed id moved in here when
    // `LegOracle` was deleted; Anchor keeps it in a separate PDA, so
    // `Observed` compares mint and weight only.
    const LEG_SIZE: usize = 66;

    let leg_count = data[LEG_COUNT] as usize;
    let mut legs = Vec::with_capacity(leg_count);
    for i in 0..leg_count {
        let off = LEGS + i * LEG_SIZE;
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&data[off..off + 32]);
        let weight = u16::from_le_bytes(data[off + 32..off + 34].try_into().unwrap());
        legs.push((mint, weight));
    }

    DecodedTracker {
        rent_reserve: u64::from_le_bytes(data[RENT_RESERVE..RENT_RESERVE + 8].try_into().unwrap()),
        deposit_fee_ppm: u16::from_le_bytes(
            data[DEPOSIT_FEE_PPM..DEPOSIT_FEE_PPM + 2].try_into().unwrap(),
        ),
        redeem_fee_ppm: u16::from_le_bytes(
            data[REDEEM_FEE_PPM..REDEEM_FEE_PPM + 2].try_into().unwrap(),
        ),
        paused: data[PAUSED] != 0,
        legs,
    }
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

/// A basket leg as the scenarios describe it.
///
/// Two fields exist only for one side. `symbol` is required by the Anchor
/// layout and ignored by the port. `feed_id` is carried by neither instruction
/// payload — the port sets it with `set_leg_feed` and Anchor keeps it in a
/// `LegOracle` PDA — so it is here only for scenarios that configure one.
/// [`Observed`] compares neither.
#[derive(Clone, Debug)]
pub struct Leg {
    pub mint: Address,
    pub symbol: &'static str,
    pub weight_bps: u16,
    pub feed_id: [u8; 32],
}

fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

impl Harness {
    /// `initialize_tracker`, encoded for whichever program this harness runs.
    ///
    /// The two argument lists differ — the port drops `name`,
    /// `rebalance_interval` and `filing_delay_days` (written once, read by
    /// nothing) and adds `max_legs` (the account is sized once and never
    /// reallocated). Both are recorded as intended divergences in the port's
    /// module docs, so the harness encodes each natively rather than pretending
    /// they are the same call.
    pub fn initialize_tracker_ix(
        &self,
        ticker: &str,
        legs: &[Leg],
        deposit_fee_ppm: u16,
        redeem_fee_ppm: u16,
        max_legs: u8,
    ) -> Instruction {
        let (tracker, _) = self.tracker_pda(ticker);
        let share_mint = self.share_mint(&tracker);
        let (vault, _) = self.vault_pda(&tracker);

        // The tail differs: Anchor declares `token_program, system_program,
        // rent`, the port declares `system_program, token_program` and reads
        // rent from a constant. Encode each natively rather than forcing one
        // program to accept the other's account list.
        let mut accounts = vec![
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(self.fee_recipient, false),
            AccountMeta::new(tracker, false),
            // The port's mint signs for its own creation; Anchor's is a PDA.
            AccountMeta::new(share_mint, self.flavor == Flavor::Pin),
            AccountMeta::new(vault, false),
        ];
        match self.flavor {
            Flavor::Anchor => accounts.extend([
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(RENT_SYSVAR_ID, false),
            ]),
            Flavor::Pin => accounts.extend([
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ]),
        }

        let data = match self.flavor {
            Flavor::Anchor => {
                let mut d = anchor_ix::INITIALIZE_TRACKER.to_vec();
                borsh_str(&mut d, ticker);
                borsh_str(&mut d, ticker); // name — unused by the port
                d.extend_from_slice(&(legs.len() as u32).to_le_bytes());
                for leg in legs {
                    d.extend_from_slice(leg.mint.as_ref());
                    borsh_str(&mut d, leg.symbol);
                    d.extend_from_slice(&leg.weight_bps.to_le_bytes());
                }
                d.extend_from_slice(&deposit_fee_ppm.to_le_bytes());
                d.extend_from_slice(&redeem_fee_ppm.to_le_bytes());
                d.extend_from_slice(&0i64.to_le_bytes()); // rebalance_interval
                d.extend_from_slice(&0u16.to_le_bytes()); // filing_delay_days
                d
            }
            Flavor::Pin => {
                let mut d = vec![pin_ix::INITIALIZE_TRACKER];
                d.push(0); // strategy: spot basket
                d.push(max_legs);
                d.extend_from_slice(&deposit_fee_ppm.to_le_bytes());
                d.extend_from_slice(&redeem_fee_ppm.to_le_bytes());
                d.push(ticker.len() as u8);
                let mut padded = [0u8; 12];
                padded[..ticker.len()].copy_from_slice(ticker.as_bytes());
                d.extend_from_slice(&padded);
                d.push(legs.len() as u8);
                for leg in legs {
                    d.extend_from_slice(leg.mint.as_ref());
                    d.extend_from_slice(&leg.weight_bps.to_le_bytes());
                }
                d
            }
        };

        Instruction {
            program_id: self.program_id,
            accounts,
            data,
        }
    }
}

impl Harness {
    /// Create the depositor's share ATA.
    ///
    /// Both flavors need this explicitly. Anchor's `deposit` would create it
    /// via `init_if_needed`, but the port deliberately requires it to exist —
    /// so the scenario creates it up front for *both*, and the comparison stays
    /// a comparison of deposit behaviour rather than of ATA creation.
    pub fn create_share_ata(&mut self, owner: &Address, ticker: &str) -> Address {
        let (tracker, _) = self.tracker_pda(ticker);
        let share_mint = self.share_mint(&tracker);
        let ata = self.ata(owner, &share_mint);

        // AssociatedTokenAccount::Create — discriminator 0, accounts:
        // payer, ata, owner, mint, system, token
        let ix = Instruction {
            program_id: ATA_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new_readonly(share_mint, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            ],
            data: vec![0],
        };
        let payer = self.payer.insecure_clone();
        self.send_ok(ix, &[&payer]);
        ata
    }

    /// `deposit(lamports_in, min_shares_out)`.
    ///
    /// No tokenized legs in these scenarios, so no oracle accounts are
    /// appended — `value_tokenized_legs` returns zero for a basket whose legs
    /// are all untokenized, which is exactly the devnet situation.
    pub fn deposit_ix(
        &self,
        ticker: &str,
        depositor: &Address,
        lamports_in: u64,
        min_shares_out: u64,
    ) -> Instruction {
        let (tracker, _) = self.tracker_pda(ticker);
        let share_mint = self.share_mint(&tracker);
        let (vault, _) = self.vault_pda(&tracker);
        let shares = self.ata(depositor, &share_mint);

        let (accounts, data) = match self.flavor {
            Flavor::Anchor => {
                let mut d = anchor_ix::DEPOSIT.to_vec();
                d.extend_from_slice(&lamports_in.to_le_bytes());
                d.extend_from_slice(&min_shares_out.to_le_bytes());
                (
                    vec![
                        AccountMeta::new(*depositor, true),
                        AccountMeta::new(tracker, false),
                        AccountMeta::new(share_mint, false),
                        AccountMeta::new(vault, false),
                        AccountMeta::new(self.fee_recipient, false),
                        AccountMeta::new(shares, false),
                        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                        AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
                        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                    ],
                    d,
                )
            }
            Flavor::Pin => {
                let mut d = vec![pin_ix::DEPOSIT];
                d.extend_from_slice(&lamports_in.to_le_bytes());
                d.extend_from_slice(&min_shares_out.to_le_bytes());
                (
                    vec![
                        AccountMeta::new(*depositor, true),
                        AccountMeta::new(tracker, false),
                        AccountMeta::new(share_mint, false),
                        AccountMeta::new(vault, false),
                        AccountMeta::new(self.fee_recipient, false),
                        AccountMeta::new(shares, false),
                        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                    ],
                    d,
                )
            }
        };

        Instruction {
            program_id: self.program_id,
            accounts,
            data,
        }
    }

    /// `redeem_for_sol(shares_in, min_lamports_out)`.
    pub fn redeem_for_sol_ix(
        &self,
        ticker: &str,
        holder: &Address,
        shares_in: u64,
        min_lamports_out: u64,
    ) -> Instruction {
        let (tracker, _) = self.tracker_pda(ticker);
        let share_mint = self.share_mint(&tracker);
        let (vault, _) = self.vault_pda(&tracker);
        let shares = self.ata(holder, &share_mint);

        let (accounts, data) = match self.flavor {
            Flavor::Anchor => {
                let mut d = anchor_ix::REDEEM_FOR_SOL.to_vec();
                d.extend_from_slice(&shares_in.to_le_bytes());
                d.extend_from_slice(&min_lamports_out.to_le_bytes());
                (
                    vec![
                        AccountMeta::new(*holder, true),
                        AccountMeta::new(tracker, false),
                        AccountMeta::new(share_mint, false),
                        AccountMeta::new(vault, false),
                        AccountMeta::new(self.fee_recipient, false),
                        AccountMeta::new(shares, false),
                        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                    ],
                    d,
                )
            }
            Flavor::Pin => {
                let mut d = vec![pin_ix::REDEEM_FOR_SOL];
                d.extend_from_slice(&shares_in.to_le_bytes());
                d.extend_from_slice(&min_lamports_out.to_le_bytes());
                (
                    vec![
                        AccountMeta::new(*holder, true),
                        AccountMeta::new(tracker, false),
                        AccountMeta::new(share_mint, false),
                        AccountMeta::new(vault, false),
                        AccountMeta::new(self.fee_recipient, false),
                        AccountMeta::new(shares, false),
                        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
                    ],
                    d,
                )
            }
        };

        Instruction {
            program_id: self.program_id,
            accounts,
            data,
        }
    }
}


impl Harness {
    /// `set_paused(bool)` — authority only, on both programs.
    pub fn set_paused_ix(&self, ticker: &str, authority: &Address, paused: bool) -> Instruction {
        let (tracker, _) = self.tracker_pda(ticker);
        let data = match self.flavor {
            Flavor::Anchor => {
                let mut d = anchor_ix::SET_PAUSED.to_vec();
                d.push(u8::from(paused));
                d
            }
            Flavor::Pin => vec![pin_ix::SET_PAUSED, u8::from(paused)],
        };
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(*authority, true),
                AccountMeta::new(tracker, false),
            ],
            data,
        }
    }

    /// `set_fees(deposit_ppm, redeem_ppm)` — authority only, on both programs.
    pub fn set_fees_ix(
        &self,
        ticker: &str,
        authority: &Address,
        deposit_ppm: u16,
        redeem_ppm: u16,
    ) -> Instruction {
        let (tracker, _) = self.tracker_pda(ticker);
        let mut data = match self.flavor {
            Flavor::Anchor => anchor_ix::SET_FEES.to_vec(),
            Flavor::Pin => vec![pin_ix::SET_FEES],
        };
        data.extend_from_slice(&deposit_ppm.to_le_bytes());
        data.extend_from_slice(&redeem_ppm.to_le_bytes());
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(*authority, true),
                AccountMeta::new(tracker, false),
            ],
            data,
        }
    }

    /// `rebalance(legs)`.
    ///
    /// Anchor requires the *authority*; the port requires the *manager*. At
    /// initialization the payer holds both roles, so a scenario that has not
    /// called `set_manager` can drive either program with the same signer —
    /// which is what makes this differentially testable at all.
    pub fn rebalance_ix(&self, ticker: &str, signer: &Address, legs: &[Leg]) -> Instruction {
        let (tracker, _) = self.tracker_pda(ticker);
        let data = match self.flavor {
            Flavor::Anchor => {
                let mut d = anchor_ix::REBALANCE.to_vec();
                d.extend_from_slice(&(legs.len() as u32).to_le_bytes());
                for leg in legs {
                    d.extend_from_slice(leg.mint.as_ref());
                    borsh_str(&mut d, leg.symbol);
                    d.extend_from_slice(&leg.weight_bps.to_le_bytes());
                }
                d
            }
            Flavor::Pin => {
                let mut d = vec![pin_ix::REBALANCE, legs.len() as u8];
                for leg in legs {
                    d.extend_from_slice(leg.mint.as_ref());
                    d.extend_from_slice(&leg.weight_bps.to_le_bytes());
                }
                d
            }
        };
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(*signer, true),
                AccountMeta::new(tracker, false),
            ],
            data,
        }
    }
}

/// Assert two runs of the same scenario landed identically, printing the whole
/// pair on failure — a bare `assert_eq!` on two `Observed` values is unreadable
/// at the point it matters most.
pub fn assert_same(anchor: &Observed, pin: &Observed, scenario: &str) {
    if anchor != pin {
        panic!(
            "differential mismatch in `{scenario}`\n\
             \n  anchor: {anchor:#?}\
             \n  pin:    {pin:#?}\n"
        );
    }
}
