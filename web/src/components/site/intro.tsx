"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { BRAND } from "@/lib/config";

/** How long the card holds. Matches the clip and the .intro-bar drain. */
const HOLD_MS = 1000;
/** Must match the .intro transition in globals.css, or it unmounts mid-fade. */
const FADE_MS = 650;

/**
 * The same predicate the root layout's inline script runs. The two must never
 * disagree: the script decides what the browser paints, this decides whether
 * the clock runs, and a split verdict either strands the visitor behind a
 * frozen card or flashes one that nothing will dismiss.
 *
 * It plays on every load, not once per session — the clip is the entrance, not
 * an onboarding step. Only a reduced-motion request opts out.
 */
function shouldPlay() {
  if (typeof window === "undefined") return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The one-second cold open.
 *
 * Markup renders unconditionally and CSS hides it, so the server HTML and the
 * client's first render agree; only the inline script's `data-intro` flag on
 * <html> makes it visible, and that runs during parsing. Deciding in an effect
 * instead would let the visitor see the site and then get a splash slammed
 * over it, which is worse than having no splash at all.
 *
 * The ground is the primary button's gradient at full size, so the exit reads
 * as the site's own colour draining back to paper rather than a black card
 * getting out of the way.
 */
export function Intro() {
  const [playing, setPlaying] = useState(shouldPlay);
  const [running, setRunning] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const dismiss = useCallback(() => setLeaving(true), []);

  // React clears attributes on <html> it doesn't own when Strict Mode remounts
  // in dev, taking the script's flag with it. A no-op in production.
  useLayoutEffect(() => {
    if (playing) document.documentElement.dataset.intro = "";
    else delete document.documentElement.dataset.intro;
  }, [playing]);

  useEffect(() => {
    if (!playing) return;

    // Deferring the video to an effect keeps it out of the server HTML, so a
    // reduced-motion visitor never pays to download it. The poster is painted
    // as a background underneath, so the swap is invisible.
    setRunning(true);

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const hold = setTimeout(dismiss, HOLD_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") dismiss();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      clearTimeout(hold);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [playing, dismiss]);

  useEffect(() => {
    const el = video.current;
    if (!running || !el) return;

    // React sets `muted` as a DOM property but never writes the attribute, and
    // browsers decide whether autoplay is allowed by reading the attribute. So
    // the JSX `muted` alone gets the clip blocked and parked on frame 0, which
    // looks exactly like a still image. Set both, then ask to play.
    el.muted = true;
    el.setAttribute("muted", "");
    el.play().catch(() => {
      // Blocked anyway: the poster underneath is a legitimate last resort, and
      // the timer above owns the exit regardless, so nobody gets stranded.
    });
  }, [running]);

  useEffect(() => {
    if (!leaving) return;
    const done = setTimeout(() => setPlaying(false), FADE_MS);
    return () => clearTimeout(done);
  }, [leaving]);

  return (
    <div
      className="intro"
      data-run={running}
      data-leaving={leaving}
      onClick={dismiss}
      role="presentation"
    >
      <div className="intro-card">
        {running ? (
          <video
            ref={video}
            src="/intro.mp4"
            muted
            playsInline
            autoPlay
            preload="auto"
            aria-hidden="true"
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>

      <div className="intro-meta">
        <p className="display text-[clamp(1.5rem,4vw,2.25rem)] text-ink">
          {BRAND.name}
        </p>
        <p className="meta">{BRAND.tagline}</p>
      </div>

      {/* The bar says how much is left; everything below it says the wait is
          optional. Three places, because a screen this brief has to advertise
          its own exit or it just reads as the site being slow. */}
      <div className="intro-bar" aria-hidden="true">
        <span />
      </div>

      <button
        type="button"
        onClick={dismiss}
        className="meta intro-skip-inline transition-opacity hover:opacity-100"
      >
        Skip intro
      </button>

      <p className="meta intro-hint" aria-hidden="true">
        Click anywhere · Esc
      </p>

      <button
        type="button"
        onClick={dismiss}
        className="meta intro-skip transition-opacity hover:opacity-100"
      >
        Skip
      </button>
    </div>
  );
}
