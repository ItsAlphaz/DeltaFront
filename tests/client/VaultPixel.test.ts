import { describe, expect, it } from "vitest";
import {
  bayerAt,
  hexToRgb,
  lighten,
  mixWord,
  pack,
  pixelBorder,
  tone,
} from "../../src/client/vault/VaultPixel";
import {
  spriteRows,
  type SpriteName,
} from "../../src/client/vault/VaultSprites";

describe("the pixel helpers", () => {
  it("makes a border with the corner pixel left out, in the colour asked for", () => {
    const url = decodeURIComponent(pixelBorder("#fbbf24"));
    expect(url).toContain('fill="#fbbf24"');
    // the four edge pixels of a 3x3, and no corners
    expect(url).toContain("M1 0h1v1H1zM0 1h1v1H0zM2 1h1v1H2zM1 2h1v1H1z");
    // the same colour is the same border
    expect(pixelBorder("#fbbf24")).toBe(pixelBorder("#fbbf24"));
    expect(tone("#4ade80")).toContain("--c:#4ade80;--bi:url(");
  });

  it("reads colours and mixes them", () => {
    expect(hexToRgb("#fbbf24")).toEqual([251, 191, 36]);
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(lighten([0, 0, 0], 0.5)).toEqual([128, 128, 128]);
    // a drawn pixel, mixed halfway to white
    const word = mixWord(pack(100, 50, 0), [255, 255, 255], 0.5);
    expect(word & 255).toBe(178);
    expect((word >> 8) & 255).toBe(153);
  });

  it("dithers in a repeating checker of thresholds around zero", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) seen.add(bayerAt(x, y));
    expect(seen.size).toBe(16);
    for (const v of seen) {
      expect(v).toBeGreaterThan(-0.5);
      expect(v).toBeLessThan(0.5);
    }
    expect(bayerAt(5, 6)).toBe(bayerAt(1, 2));
  });
});

describe("the sprites", () => {
  const names: SpriteName[] = [
    "gem",
    "coin",
    "pack",
    "star",
    "gift",
    "emblem",
    "sparkle",
    "lock",
    "check",
    "shield",
    "clock",
    "chevron",
  ];

  it("are drawn on a regular grid", () => {
    for (const name of names) {
      const rows = spriteRows(name);
      expect(new Set(rows.map((r) => r.length)).size, name).toBe(1);
    }
  });

  it("use only the characters the page knows how to colour", () => {
    for (const name of names) {
      expect(spriteRows(name).join(""), name).toMatch(/^[.PLDKWYyRrB]+$/);
    }
  });
});
