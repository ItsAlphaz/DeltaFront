/**
 * The Vault's pixel look: the pieces everything pixel-drawn shares. Frames,
 * palette arithmetic and dithering for the canvases (the wheel, the sky) that
 * work out every pixel themselves, and the pixel face for text drawn on them.
 */

/** The game's pixel face (resources/fonts/pixelify-sans, registered in Main.ts). */
export const PIXEL_FONT = '"Pixelify Sans"';

/** Resolves once the pixel face can be drawn on a canvas (or at once if it cannot be loaded). */
export function pixelFontReady(): Promise<void> {
  if (typeof document === "undefined" || document.fonts === undefined) {
    return Promise.resolve();
  }
  return document.fonts.load(`700 16px ${PIXEL_FONT}`).then(
    () => undefined,
    () => undefined,
  );
}

const borders = new Map<string, string>();

/**
 * A CSS `border-image` source for a pixel border of `color`: one pixel thick
 * with the corner pixel left out, which is what a rounded corner is in pixel
 * art. Use it as `border: var(--u) solid transparent; border-image: var(--bi)
 * 1 / var(--u) / 0 stretch; background-clip: padding-box` (`.vault-px-frame`),
 * so one pixel is `--u` wide and the notch is one pixel too. Unlike a clip-path
 * it leaves shadows, filters and transforms alone.
 */
export function pixelBorder(color: string): string {
  let url = borders.get(color);
  if (url === undefined) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3" shape-rendering="crispEdges">` +
      `<path d="M1 0h1v1H1zM0 1h1v1H0zM2 1h1v1H2zM1 2h1v1H1z" fill="${color}"/></svg>`;
    url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    borders.set(color, url);
  }
  return url;
}

/** The inline style that gives an element its tone: `--c` for what reads it, `--bi` for its pixel border. */
export const tone = (color: string): string =>
  `--c:${color};--bi:${pixelBorder(color)}`;

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** An opaque pixel as a canvas ImageData word (little-endian ABGR). */
export const pack = (r: number, g: number, b: number): number =>
  ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

export const packRgb = (c: Rgb): number => pack(c[0], c[1], c[2]);

/** Between two colours, `t` from 0 (the first) to 1 (the second). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

export const lighten = (c: Rgb, t: number): Rgb => mix(c, [255, 255, 255], t);
export const darken = (c: Rgb, t: number): Rgb => mix(c, [0, 0, 0], t);

/** A word of the buffer, mixed with a colour: for a pixel that is already drawn. */
export function mixWord(word: number, to: Rgb, t: number): number {
  const r = word & 255;
  const g = (word >> 8) & 255;
  const b = (word >> 16) & 255;
  return pack(
    Math.round(r + (to[0] - r) * t),
    Math.round(g + (to[1] - g) * t),
    Math.round(b + (to[2] - b) * t),
  );
}

/** The 4×4 ordered-dither matrix, as thresholds from -0.5 to 0.5: a gradient drawn with it is made of checkered steps. */
export const BAYER4: readonly number[] = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
].map((v) => (v + 0.5) / 16 - 0.5);

export const bayerAt = (x: number, y: number): number =>
  BAYER4[((y & 3) << 2) | (x & 3)];

export const TAU = Math.PI * 2;
