/**
 * The mint's own artwork for a tracker token.
 *
 * Above HALFTONE_MIN this is the halftone the token metadata points at, so
 * the site and a wallet show the same object. Below it, the source switches
 * to the un-screened headshot in public/avatars.
 *
 * That is a deliberate exception, measured rather than assumed: rendered at
 * 18px, a screen of 5px dots is finer than the pixel grid it lands on, and
 * every face collapses into identical grey discs. The photographic cut stays
 * legible at that size and its ring colour tells rows apart. A mark nobody
 * can distinguish is not identity, it is noise, and the halftone still owns
 * every surface big enough to actually show it.
 */

/** Below this many CSS px the dot screen stops resolving. */
const HALFTONE_MIN = 40;

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
  const slug = ticker.toLowerCase();
  const src =
    size >= HALFTONE_MIN ? `/tokens/${slug}.png` : `/avatars/${slug}.png`;

  return (
    // A 7-file static set at icon size: the optimizer would cost a round trip
    // to save nothing.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
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
