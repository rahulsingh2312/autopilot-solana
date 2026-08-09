/**
 * How much continuous canvas animation this device should be asked for.
 *
 * Two canvases on this site repaint forever: the halftone portrait breathing
 * and the particle field drifting. On a laptop that is free. On a mid-range
 * phone the halftone alone is thousands of arcs per frame, which shows up as
 * dropped frames while scrolling, and a stuttering page is a worse experience
 * than a still one. So the budget is measured once and both respect it.
 *
 *   "none"  reduced-motion is set: paint one frame, never animate
 *   "light" phone or modest hardware: keep transitions, drop idle loops
 *   "full"  desktop: everything
 */
export type MotionBudget = "none" | "light" | "full";

/** Below this, treat the device as a phone regardless of what it claims. */
const NARROW_PX = 768;

export function motionBudget(): MotionBudget {
  if (typeof window === "undefined") return "full";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return "none";
  }

  const narrow = window.innerWidth < NARROW_PX;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  // Both are advisory and absent on Safari, so a missing value is optimistic.
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;

  if (narrow || coarse || cores <= 4 || memory <= 4) return "light";
  return "full";
}
