import type { Metadata } from "next";

import { LegalPage } from "../legal-page";
import { BRAND, RPC_URL } from "@/lib/config";

const rpcHost = (() => {
  try {
    return new URL(RPC_URL).host;
  } catch {
    return "the configured RPC provider";
  }
})();

export const metadata: Metadata = {
  title: "Privacy",
  description: "What this site stores, which is very little.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="August 2026"
      intro="This site collects almost nothing, and the parts it does collect are listed here in full."
      sections={[
        {
          heading: "What we store on your device",
          body: [
            "One entry in local storage recording which of the three visual themes you picked, so the page does not reset to the default every visit. Nothing else, and no advertising or analytics cookies.",
            "Your wallet extension stores its own connection state. That belongs to the wallet, not to us.",
          ],
        },
        {
          heading: "What we store on a server",
          body: [
            "Only what you type into the early-access form: an email address, and the connected wallet address if you have connected one. It is used to email you once when the creator flow ships. It is not sold, shared, or added to a mailing list.",
            `Ask us to delete it at ${BRAND.contactEmail} and we will.`,
          ],
        },
        {
          heading: "What third parties see",
          body: [
            `Reading vault balances sends requests to ${rpcHost}. That provider sees your IP address and the accounts being queried, including your wallet address once connected. Their handling of that data is governed by their policy, not ours.`,
            "Every transaction you sign is public and permanent on Solana. Wallet addresses, amounts, and timestamps are visible to anyone forever. That is a property of the chain, not a choice this site makes.",
          ],
        },
        {
          heading: "What we do not do",
          body: [
            "No analytics, no session recording, no fingerprinting, no third-party trackers, no advertising pixels. If that changes, this page changes first.",
          ],
        },
      ]}
    />
  );
}
