"use client";

/**
 * NAV is the one piece of jargon on this page that a newcomer cannot guess,
 * and it is also the number they transact at. It gets a marker and a plain
 * definition rather than an assumption that everyone knows.
 */
export const NAV_DEFINITION =
  "NAV is what one token is worth: everything the vault holds, divided by tokens outstanding. You mint and redeem at it.";

/** The marker itself. Superscript, keyboard reachable, explains on hover. */
export function NavStar({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label={NAV_DEFINITION}
      title={NAV_DEFINITION}
      className={`num cursor-help align-super text-[0.625rem] text-faint transition-colors hover:text-ink ${className}`}
    >
      *
    </button>
  );
}

/** The always-visible footnote. Hover is not available on a phone. */
export function NavFootnote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[0.6875rem] leading-relaxed text-faint ${className}`}>
      <span className="num mr-1">*</span>
      {NAV_DEFINITION}
    </p>
  );
}
