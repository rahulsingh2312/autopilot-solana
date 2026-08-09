"use client";

import { useEffect, useRef, useState } from "react";

import { motionBudget } from "@/lib/motion";

/**
 * Renders an image as a dot-matrix halftone: ink dots on transparent ground,
 * dot radius driven by source luminance. This is the brand's portrait
 * treatment, a stylized derivative rather than a photograph.
 *
 * When `src` changes the grid does not swap images. Every dot keeps its
 * position and animates its radius from the old portrait's value to the new
 * one, so one face dissolves into the next through the same screen of dots.
 */
export function Halftone({
  src,
  alt,
  /** Rendered size in CSS pixels (square). */
  size = 420,
  /** Distance between dot centers, CSS px. Smaller = finer screen. */
  pitch = 6,
  /** Ink color for the dots. */
  color = "#0a0a0a",
  /** Invert so dark source areas get the big dots (portraits want this). */
  invert = true,
  /** Morph duration in ms when the source changes. */
  duration = 900,
  className = "",
  /** Called after a render with the number of dots actually drawn. */
  onDots,
}: {
  src: string;
  alt: string;
  size?: number;
  pitch?: number;
  color?: string;
  invert?: boolean;
  duration?: number;
  className?: string;
  onDots?: (dots: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  /** Strength per cell for the portrait currently on screen. */
  const currentRef = useRef<Float32Array | null>(null);
  const frameRef = useRef(0);
  const visibleRef = useRef(true);
  const onDotsRef = useRef(onDots);
  onDotsRef.current = onDots;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting;
      },
      { rootMargin: "128px" },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const img = new Image();
    img.decoding = "async";
    img.src = src;

    img
      .decode()
      .then(() => {
        if (cancelled) return;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = size * dpr;
        canvas.height = size * dpr;

        // Sample the source at one pixel per dot cell.
        const cells = Math.ceil(size / pitch);
        const sample = document.createElement("canvas");
        sample.width = cells;
        sample.height = cells;
        const sctx = sample.getContext("2d", { willReadFrequently: true })!;

        // Cover-fit the source into the square sample grid.
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - s) / 2;
        const sy = Math.max(0, (img.naturalHeight - s) * 0.18); // bias toward faces
        sctx.drawImage(img, sx, sy, s, s, 0, 0, cells, cells);
        const data = sctx.getImageData(0, 0, cells, cells).data;

        const total = cells * cells;
        const target = new Float32Array(total);
        for (let i = 0; i < total; i++) {
          const p = i * 4;
          const a = data[p + 3] / 255;
          const lum =
            (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) /
            255;
          target[i] = (invert ? 1 - lum : lum) * a;
        }

        // A first paint has nothing to morph from, and a resolution change
        // makes the old grid meaningless. Both start flat and grow in.
        const previous =
          currentRef.current && currentRef.current.length === total
            ? currentRef.current
            : new Float32Array(total);

        const ctx = canvas.getContext("2d")!;
        const maxR = (pitch / 2) * 0.92 * dpr;
        const step = pitch * dpr;
        const minR = 0.35 * dpr;

        const paint = (mix: Float32Array) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = color;
          let drawn = 0;
          for (let y = 0; y < cells; y++) {
            for (let x = 0; x < cells; x++) {
              const strength = mix[y * cells + x];
              if (strength <= 0) continue;
              const r = maxR * Math.sqrt(strength);
              if (r < minR) continue;
              ctx.beginPath();
              ctx.arc((x + 0.5) * step, (y + 0.5) * step, r, 0, Math.PI * 2);
              ctx.fill();
              drawn++;
            }
          }
          return drawn;
        };

        const budget = motionBudget();

        cancelAnimationFrame(frameRef.current);

        if (budget === "none" || duration <= 0) {
          currentRef.current = target;
          onDotsRef.current?.(paint(target));
          return;
        }

        // The dot count is a property of the portrait, not of any one frame.
        // Reporting it off the settled target keeps the caption from counting
        // up and down forever as the shimmer crosses the minimum radius.
        let settledDots = 0;
        for (let i = 0; i < total; i++) {
          if (maxR * Math.sqrt(target[i]) >= minR) settledDots++;
        }

        const mix = new Float32Array(total);
        const start = performance.now();

        // Two slow diagonal waves at unrelated periods, so the surface never
        // repeats visibly. Amplitude is deliberately small: the portrait
        // should look like it is breathing, not like it is being disturbed.
        const AMP = 0.11;
        const shimmer = (x: number, y: number, seconds: number) =>
          Math.sin((x + y) * 0.16 + seconds * 1.15) * 0.6 +
          Math.sin((x - y * 0.6) * 0.09 - seconds * 0.73) * 0.4;

        // This is the expensive canvas on the page: at pitch 5 a single frame
        // is thousands of arcs. On a phone the morph is worth paying for, but
        // breathing forever afterwards is not, so the loop stops once settled.
        const idles = budget === "full";

        // Half rate. At this pitch a frame is thousands of arcs, and the
        // motion is slow enough that 30fps is indistinguishable from 60.
        const MIN_FRAME_MS = 1000 / 30;
        let lastPaint = 0;

        const tick = (now: number) => {
          if (cancelled) return;

          const elapsed = now - start;
          const t = Math.min(1, elapsed / duration);
          const settled = t >= 1;

          // Without the idle shimmer there is nothing left to draw once the
          // morph lands, so the loop ends rather than repainting an identical
          // frame thousands of arcs at a time.
          if (settled && !idles) {
            if (currentRef.current !== target) {
              currentRef.current = target;
              paint(target);
              onDotsRef.current?.(settledDots);
            }
            return;
          }

          frameRef.current = requestAnimationFrame(tick);

          // Off screen there is nothing to breathe for. rAF already stops in
          // a background tab; this covers the scrolled-past case.
          if (!visibleRef.current) return;
          if (now - lastPaint < MIN_FRAME_MS) return;
          lastPaint = now;

          // Ease out cubic: the dots arrive quickly, then settle.
          const e = 1 - Math.pow(1 - t, 3);
          const seconds = elapsed / 1000;
          // The shimmer fades in behind the morph so the two never fight.
          const amp = idles ? AMP * e : 0;

          for (let y = 0; y < cells; y++) {
            for (let x = 0; x < cells; x++) {
              const i = y * cells + x;
              const base = previous[i] + (target[i] - previous[i]) * e;
              const v = base * (1 + amp * shimmer(x, y, seconds));
              mix[i] = v < 0 ? 0 : v > 1 ? 1 : v;
            }
          }
          paint(mix);

          if (settled && currentRef.current !== target) {
            currentRef.current = target;
            onDotsRef.current?.(settledDots);
          }
        };

        frameRef.current = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameRef.current);
    };
  }, [src, size, pitch, color, invert, duration]);

  if (failed) return null;

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={alt}
      className={className}
      style={{ width: size, maxWidth: "100%", height: "auto", aspectRatio: "1 / 1" }}
    />
  );
}
