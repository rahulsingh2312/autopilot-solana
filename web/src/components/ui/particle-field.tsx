"use client";

import { useEffect, useRef } from "react";

/**
 * A drifting field of ink specks, sized to its container.
 *
 * A CSS repeating gradient can only slide as one sheet, which reads as the
 * page moving rather than particles moving. Individual specks with their own
 * heading and speed is the effect, and that needs a canvas.
 *
 * The caller masks the edges (see .flow-dots) so the field fades out instead
 * of ending on a rectangle.
 */
export function ParticleField({
  /** Specks per 10,000 css px². Density, not a raw count, so it holds at any size. */
  density = 0.9,
  className = "",
}: {
  density?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const visibleRef = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let particles: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      a: number;
      /** Phase offset so the twinkle is not in lockstep across the field. */
      p: number;
    }[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;

    const seed = () => {
      const count = Math.round((width * height * density) / 10_000);
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // Slow, mostly rightward: the diagram reads left to right, and the
        // field should agree with it rather than argue.
        vx: 0.05 + Math.random() * 0.22,
        vy: (Math.random() - 0.5) * 0.1,
        r: 0.5 + Math.random() * 1.1,
        a: 0.12 + Math.random() * 0.3,
        p: Math.random() * Math.PI * 2,
      }));
    };

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width === 0 || height === 0) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const paint = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      for (const s of particles) {
        // Twinkle: a slow sine on alpha so the field shimmers as it drifts.
        const alpha = s.a * (0.65 + 0.35 * Math.sin(t * 0.0012 + s.p));
        ctx.beginPath();
        ctx.fillStyle = `rgba(10, 10, 10, ${alpha.toFixed(3)})`;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const step = () => {
      for (const s of particles) {
        s.x += s.vx;
        s.y += s.vy;
        // Wrap with a margin so a speck never pops at the edge.
        if (s.x > width + 2) s.x = -2;
        if (s.y > height + 2) s.y = -2;
        else if (s.y < -2) s.y = height + 2;
      }
    };

    const MIN_FRAME_MS = 1000 / 30;
    let last = 0;

    const tick = (now: number) => {
      frameRef.current = requestAnimationFrame(tick);
      if (!visibleRef.current) return;
      if (now - last < MIN_FRAME_MS) return;
      last = now;
      step();
      paint(now);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(parent);

    const seen = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting;
      },
      { rootMargin: "128px" },
    );
    seen.observe(parent);

    resize();

    if (reduced.matches) {
      // Still a field, just not a moving one.
      paint(0);
    } else {
      frameRef.current = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(frameRef.current);
      observer.disconnect();
      seen.disconnect();
    };
  }, [density]);

  return (
    <canvas ref={canvasRef} aria-hidden className={className} />
  );
}
