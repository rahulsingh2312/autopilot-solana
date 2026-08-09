import type { Metadata } from "next";

import { LegalPage } from "../legal-page";
import { BRAND, ISSUER } from "@/lib/config";

export const metadata: Metadata = {
  title: "Risk disclosure",
  description:
    "Everything that can go wrong with a tracker token, stated plainly.",
};

export default function RiskPage() {
  return (
    <LegalPage
      title="Risk disclosure"
      updated="August 2026"
      intro={`Everything below can cost you money. ${BRAND.name} currently runs on devnet, where the SOL is test SOL, but the risks are listed as they would apply on mainnet because that is the point of reading them early.`}
      sections={[
        {
          heading: "The program is unaudited",
          body: [
            "No third party has reviewed this code. The vault holds funds and moves them under program authority, so a bug in it is a bug that can take your deposit. Treat any balance here as at risk of total loss.",
            "The program is upgradeable. Whoever holds the upgrade authority can change its behaviour. Until that authority is burned or moved to a timelock, you are trusting the deployer.",
          ],
        },
        {
          heading: "A tracker token is not a share",
          body: [
            "Holding a tracker token gives you a pro-rata claim on whatever the vault holds. It gives you no ownership of any company, no vote, no dividend, and no rights against any issuer or any person the tracker is named after.",
            "Tracker tokens are not registered securities and are not covered by any investor protection scheme, deposit insurance, or compensation fund.",
          ],
        },
        {
          heading: "Tokenized equities carry issuer risk",
          body: [
            `On mainnet, vaults would hold tokens issued by ${ISSUER.issuer} under the ${ISSUER.name} programme. That is a claim on an entity, collateralized by shares that entity holds. If the issuer fails, is unable to redeem, or loses access to the underlying shares, the token's value depends on the outcome of that failure, not on the stock price.`,
            "Tokenized equities also carry transfer restrictions and jurisdictional limits set by their issuer, which can change without reference to this protocol.",
          ],
        },
        {
          heading: "The strategy may be stale, wrong, or dead",
          body: [
            "Trackers built on regulatory filings inherit the filing's delay. A 13F can be up to 45 days old, so the holdings describe a portfolio the manager may have already exited.",
            "A source can stop entirely. A fund can deregister with the SEC, be acquired, or simply stop filing; a member of Congress can leave office. When that happens the tracker freezes at its final disclosure and will never update again, and it then describes a portfolio that may no longer exist. We state it on the card rather than letting the weights quietly go stale.",
            "Editorial trackers are our own selections. There is no filing behind them and no rule you can audit. The exchange-traded fund that attempted an inverse-Cramer strategy closed in February 2024 after losing money.",
          ],
        },
        {
          heading: "Liquidity and redemption",
          body: [
            "Redeeming for SOL sells the vault's holdings into whatever market exists at that moment. Tokenized-equity books are thin when US markets are closed and thinner for smaller names, so the price you get can be materially worse than the last quoted price.",
            "The quote shown before you sign includes the fee and a minimum you will accept. If the vault cannot meet that minimum, the transaction reverts and nothing is spent except network fees.",
          ],
        },
        {
          heading: "Coverage gaps",
          body: [
            "Only around 130 US equities and ETFs are tokenized today. Where a disclosed position has no tokenized equivalent, that weight stays in the vault's SOL sleeve. The tracker will then not track the strategy it names, and the card states the percentage affected.",
          ],
        },
        {
          heading: "Fees",
          body: [
            "A deposit fee and a redemption fee are charged in basis points and are shown on the quote before you sign. The program caps both at 3% and rejects any attempt to set them higher, but the authority can change them within that cap at any time.",
          ],
        },
        {
          heading: "Jurisdiction",
          body: [
            "Tokenized equities and index-like products are restricted or prohibited in many jurisdictions, including for US persons in some cases. You are responsible for whether you are allowed to use this. Nothing here is an offer to anyone anywhere it would be unlawful.",
          ],
        },
      ]}
    />
  );
}
