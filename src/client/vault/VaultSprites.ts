import { html, svg, type TemplateResult } from "lit";
import { darken, lighten, type Rgb } from "./VaultPixel";

/**
 * The Vault's pixel-art icons. Each is a few rows of characters, one per pixel:
 * `.` is empty, `P` the icon's own colour with `L` (lighter) and `D` (darker)
 * shades of it, and the rest fixed colours (`K` outline, `W` white, `Y`/`y`
 * gold, `R`/`r` red, `B` black). The same rows are drawn as crisp SVG for the
 * page and, rotated, into the wheel's pixels.
 */
const SPRITES = {
  /** A cut gem, tinted by its rarity. */
  gem: [
    "..KKKKKKK..",
    ".KLLPPPPDK.",
    "KLLLPPPPDDK",
    "KKKKKKKKKKK",
    ".KLLPPPDDK.",
    "..KLPPPDK..",
    "...KLPDK...",
    "....KPK....",
    ".....K.....",
  ],
  /** The Credits coin: a black coin with a red rim and a white delta, as the game draws it. */
  coin: [
    "....RRRR....",
    "..RRBBBBRR..",
    ".RBBBBBBBBR.",
    ".RBBBWWBBBR.",
    "RBBBWBBWBBBR",
    "RBBWBBBBWBBR",
    "RBWBBBBBBWBR",
    "RBWWWWWWWWBR",
    "RBBBBBBBBBBr",
    ".RBBBBBBBBr.",
    "..RRBBBBrr..",
    "....rrrr....",
  ],
  /** A foil pack, tinted. */
  pack: [
    "KKKKKKKKK",
    "KWKWKWKWK",
    "KPPPPPPPK",
    "KPPPWPPPK",
    "KPPWWWPPK",
    "KPWWWWWPK",
    "KPPWWWPPK",
    "KPPPWPPPK",
    "KDDDDDDDK",
    "KWKWKWKWK",
    "KKKKKKKKK",
  ],
  /** The jackpot's star. */
  star: [
    ".....K.....",
    "....KYK....",
    "....KYK....",
    "KKKKKYKKKKK",
    "KYYYYYYYYYK",
    ".KYYYWYYYK.",
    "..KYYYYYK..",
    "..KYYKYYK..",
    ".KYYK.KYYK.",
    ".KYK...KYK.",
    ".KK.....KK.",
  ],
  /** A wrapped present: the daily spin. */
  gift: [
    "..KKKK.KKKK.",
    ".KYYYYKYYYYK",
    ".KYKKYKYKKYK",
    "..KKYYYYKK..",
    "KKKKKYYKKKKK",
    "KPPPPYYPPPPK",
    "KPPPPYYPPPPK",
    "KYYYYYYYYYYK",
    "KPPPPYYPPPPK",
    "KPPPPYYPPPPK",
    "KDDDDYYDDDDK",
    "KKKKKKKKKKKK",
  ],
  /** The pack's emblem: a four-point star with a white core. */
  emblem: [
    ".......P.......",
    ".......P.......",
    "......PWP......",
    "......PWP......",
    ".....PPWPP.....",
    ".....PWWWP.....",
    "..PPPPPWPPPPP..",
    "PPPWWWWWWWWWPPP",
    "..PPPPPWPPPPP..",
    ".....PWWWP.....",
    ".....PPWPP.....",
    "......PWP......",
    "......PWP......",
    ".......P.......",
    ".......P.......",
  ],
  /** A four-point sparkle. */
  sparkle: ["..P..", ".PPP.", "PPPPP", ".PPP.", "..P.."],
  lock: [
    "..PPP..",
    ".P...P.",
    ".P...P.",
    "PPPPPPP",
    "PPPPPPP",
    "PPP.PPP",
    "PPP.PPP",
    "PPPPPPP",
  ],
  check: ["......P", ".....PP", "P...PP.", "PP.PP..", ".PPP...", "..P...."],
  shield: [
    "PPPPPPPPP",
    "PPPPPPPPP",
    "PPPPPPPPP",
    "PPPPPPPPP",
    ".PPPPPPP.",
    ".PPPPPPP.",
    "..PPPPP..",
    "...PPP...",
    "....P....",
  ],
  clock: [
    "..PPPPP..",
    ".P.....P.",
    "P.......P",
    "P...P...P",
    "P...PP..P",
    "P.......P",
    ".P.....P.",
    "..PPPPP..",
  ],
  chevron: ["P.....P", ".P...P.", "..P.P..", "...P..."],
} as const;

export type SpriteName = keyof typeof SPRITES;

export const spriteRows = (name: SpriteName): readonly string[] =>
  SPRITES[name];

/** The CSS colour of a sprite character: `currentColor` and shades of it for the icon's own colour. */
const SVG_FILL: Record<string, string> = {
  P: "currentColor",
  L: "color-mix(in srgb, currentColor 55%, #fff)",
  D: "color-mix(in srgb, currentColor 55%, #000)",
  K: "#140f1c",
  W: "#fff",
  Y: "#fbbf24",
  y: "#b8801c",
  R: "#e5383b",
  r: "#8b1d28",
  B: "#090909",
};

/** One path of the rows, for one character: a run of pixels is a single `h` stroke. */
function runs(rows: readonly string[], ch: string): string {
  let d = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== ch) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === ch) end++;
      d += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return d;
}

/**
 * The sprite as an inline SVG at a whole `scale` (screen pixels per sprite
 * pixel), as crisp as the screen allows, coloured by the `color` it is put in.
 */
export function sprite(name: SpriteName, scale = 2): TemplateResult {
  const rows = SPRITES[name];
  const width = Math.max(...rows.map((r) => r.length));
  const chars = [...new Set(rows.join("").replace(/\./g, ""))];
  return html`<svg
    class="vault-sprite shrink-0"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 ${width} ${rows.length}"
    width=${width * scale}
    height=${rows.length * scale}
    shape-rendering="crispEdges"
    aria-hidden="true"
    data-sprite=${name}
  >
    ${chars.map(
      (ch) =>
        svg`<path d=${runs(rows, ch)} style="fill:${SVG_FILL[ch] ?? "currentColor"}" />`,
    )}
  </svg>`;
}

/** The colour of a sprite character when a canvas draws it. */
export function spriteColor(ch: string, tint: Rgb): Rgb {
  switch (ch) {
    case "P":
      return tint;
    case "L":
      return lighten(tint, 0.45);
    case "D":
      return darken(tint, 0.45);
    case "K":
      return [20, 15, 28];
    case "W":
      return [255, 255, 255];
    case "Y":
      return [251, 191, 36];
    case "y":
      return [184, 128, 28];
    case "R":
      return [229, 56, 59];
    case "r":
      return [139, 29, 40];
    default:
      return [9, 9, 9];
  }
}
