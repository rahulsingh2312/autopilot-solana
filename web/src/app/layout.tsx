import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";

import { Providers } from "./providers";
import { Intro } from "@/components/site/intro";
import { BRAND, CLUSTER } from "@/lib/config";
import "./globals.css";

/**
 * Decides whether the cold open plays, during HTML parsing and before the
 * first paint. It has to run here rather than in the component: matchMedia
 * doesn't exist on the server, so anything that waits for hydration paints the
 * site first and drops a splash on top of it. Keep the condition identical to
 * shouldPlay() in components/site/intro.tsx.
 */
const INTRO_FLAG = `(function(){try{if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.dataset.intro=""}catch(e){}})()`;

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

const title = `${BRAND.name}: trade the trader, not the market`;
const description =
  "Tracker tokens on Solana. Deposit SOL, hold one token that follows a famous investor's disclosed holdings, and burn it back for SOL at NAV whenever you want. Every balance on the page is read live from the chain.";

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
  keywords: [
    "Solana",
    "tokenized equities",
    "xStocks",
    "13F tracker",
    "copy trading",
    "on-chain index",
  ],
  other: { "solana:cluster": CLUSTER },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: INTRO_FLAG }} />
      </head>
      <body className="dotgrid flex min-h-full flex-col">
        <Intro />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
