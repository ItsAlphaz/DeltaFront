import { prefersReducedMotion } from "./ReducedMotion";

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Eases a number from 0 up to `to` over `durationMs`, calling `onValue` with
 * each step (whole numbers) and finally with `to` itself. Returns a function
 * that stops it where it is. Under reduced motion (or a value too small to be
 * worth it) it reports `to` at once and never schedules a frame.
 */
export function countUp(
  to: number,
  onValue: (value: number) => void,
  durationMs = 900,
): () => void {
  if (!Number.isFinite(to) || to <= 0 || prefersReducedMotion()) {
    onValue(to);
    return () => {};
  }
  let frame = 0;
  let cancelled = false;
  const start = performance.now();
  const step = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / durationMs);
    onValue(t >= 1 ? to : Math.round(to * easeOutCubic(t)));
    if (t < 1) frame = requestAnimationFrame(step);
  };
  onValue(0);
  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
