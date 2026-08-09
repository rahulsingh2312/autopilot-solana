/**
 * The mint's own artwork for a tracker token.
 *
 * This is the same file a wallet renders for the asset, served from
 * public/tokens/<ticker>.png and referenced by the token metadata. Drawing
 * something else here would give one asset two identities, so every place a
 * ticker appears in the UI reaches for this rather than inventing a chip.
 */
export function TokenIcon({
  ticker,
  size = 18,
  className = "",
}: {
  ticker: string;
  /** Rendered square size in CSS pixels. */
  size?: number;
  className?: string;
}) {
  return (
    // A 7-file static set at icon size: the optimizer would cost a round trip
    // to save nothing.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/tokens/${ticker.toLowerCase()}.png`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`inline-block shrink-0 rounded-full align-[-0.18em] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Icon plus ticker as one unbreakable unit. Inline rather than flex so it can
 * sit mid-sentence ("You hold 0.5 pltSOL") without turning its container into
 * a flex row.
 */
export function TokenTicker({
  ticker,
  size = 16,
  className = "",
}: {
  ticker: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 align-middle ${className}`}>
      <TokenIcon ticker={ticker} size={size} />
      {ticker}
    </span>
  );
}
