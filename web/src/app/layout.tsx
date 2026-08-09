import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";

import { Providers } from "./providers";
import { BRAND, CLUSTER } from "@/lib/config";
import "./globals.css";

/**
 * Three faces: Instrument Serif carries the editorial headlines, Inter is the
 * working body copy, JetBrains Mono is every balance, weight, and address.
 */
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

const title = `${BRAND.name}: famous portfolios, one token`;
const description =
  "Deposit SOL, get one token that tracks a famous investor's disclosed portfolio. Burn it for SOL any time. No brokerage account, no market hours.";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${BRAND.domain}`),
  title: { default: title, template: `%s · ${BRAND.name}` },
  description,
  openGraph: {
    title,
    description,
    type: "website",
    siteName: BRAND.name,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: title }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
  icons: { icon: "/icon.svg" },
  other: { "solana:cluster": CLUSTER },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full`}
    >
      <body className="dotgrid flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
