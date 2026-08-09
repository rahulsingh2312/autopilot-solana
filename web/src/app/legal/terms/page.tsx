import type { Metadata } from "next";

import { LegalPage } from "../legal-page";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = {
  title: "Terms",
  description: "What you can expect from this software, and what you cannot.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      updated="August 2026"
      intro={`${BRAND.name} is experimental software running on a test network. These terms are short because the honest version is short.`}
      sections={[
        {
          heading: "What this is",
          body: [
            `${BRAND.name} is an interface to a Solana program that mints and burns a token against a vault. We publish the interface and the program source. We do not take custody of your funds, hold your keys, or execute anything you have not signed.`,
            "There is no account, no login, and no agreement you sign with us. Using the site means accepting that the software is provided as it is.",
          ],
        },
        {
          heading: "No advice, no offer",
          body: [
            "Nothing on this site is investment, legal, or tax advice, and nothing is a recommendation to buy or sell anything. Tracker descriptions are commentary on public information.",
            "This is not an offer or solicitation in any jurisdiction where that would be unlawful. You are responsible for determining whether you are permitted to use it.",
          ],
        },
        {
          heading: "No warranty",
          body: [
            "The program is unaudited. The interface may be wrong. Prices, balances, and quotes are read from a public RPC and may be stale or unavailable. Everything is provided without warranty of any kind, express or implied.",
            "To the maximum extent the law allows, we are not liable for any loss arising from use of this software, including losses caused by bugs, exploits, RPC failure, wallet failure, or a strategy performing badly.",
          ],
        },
        {
          heading: "Names and trademarks",
          body: [
            `${BRAND.name} is not affiliated with, endorsed by, or connected to any person or organisation a tracker follows. Names appear to describe publicly disclosed information. All trademarks belong to their owners.`,
            "If you own a name used here and object to its use, write to us and we will change it.",
          ],
        },
        {
          heading: "Changes",
          body: [
            "The program is upgradeable and this interface changes often. Material changes to fees or tracker composition are recorded on chain, which is a better record than this page.",
          ],
        },
      ]}
    />
  );
}
