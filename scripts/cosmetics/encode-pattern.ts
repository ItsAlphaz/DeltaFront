/**
 * Encodes a small bitmap as the base64url pattern data the game reads
 * (packages/shared/src/PatternDecoder.ts), so a pattern for the DeltaFront
 * catalog can be drawn as text instead of hand-assembled bytes.
 *
 *   npx tsx scripts/cosmetics/encode-pattern.ts <bitmap-file> [scale]
 *
 * The file has one row per line: `#` is the primary colour, `.` the secondary
 * one, all rows the same width. `scale` (0 to 7, default 0) makes every cell
 * 2^scale tiles wide. The pattern data is printed on stdout; paste it into
 * `src/account-api/catalog/cosmetics.json`.
 *
 * Format: byte 0 is the version (0); byte 1 holds the scale in its low 3 bits
 * and the low 5 bits of (width - 2) above them; byte 2 holds the high 2 bits
 * of (width - 2) and (height - 2) above them; then one bit per cell, row by
 * row, least significant bit first, where a set bit means "secondary".
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const MIN_SIDE = 2;
export const MAX_WIDTH = 2 + 0x7f;
export const MAX_HEIGHT = 2 + 0x3f;

/** The raw pattern bytes for `rows` (see the file comment for the rows). */
export function encodePatternBytes(rows: string[], scale = 0): Uint8Array {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (!Number.isInteger(scale) || scale < 0 || scale > 7) {
    throw new Error("scale must be a whole number from 0 to 7");
  }
  if (width < MIN_SIDE || height < MIN_SIDE) {
    throw new Error(`a pattern is at least ${MIN_SIDE}x${MIN_SIDE} cells`);
  }
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new Error(`a pattern is at most ${MAX_WIDTH}x${MAX_HEIGHT} cells`);
  }
  for (const row of rows) {
    if (row.length !== width) throw new Error("every row must be as wide");
    if (!/^[#.]+$/.test(row)) {
      throw new Error("rows may only contain # (primary) and . (secondary)");
    }
  }
  const w = width - MIN_SIDE;
  const h = height - MIN_SIDE;
  const bytes = new Uint8Array(3 + ((width * height + 7) >> 3));
  bytes[0] = 0;
  bytes[1] = (scale & 0x07) | ((w & 0x1f) << 3);
  bytes[2] = ((w >> 5) & 0x03) | (h << 2);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      if (row[x] === ".") {
        const index = y * width + x;
        bytes[3 + (index >> 3)] |= 1 << (index & 7);
      }
    }
  });
  return bytes;
}

/** The base64url pattern data for `rows`. */
export function encodePattern(rows: string[], scale = 0): string {
  return Buffer.from(encodePatternBytes(rows, scale)).toString("base64url");
}

/** Bitmap rows from a text file's content (blank lines and `//` comments are skipped). */
export function parseBitmap(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, scale] = process.argv.slice(2);
  if (file === undefined) {
    console.error("usage: encode-pattern.ts <bitmap-file> [scale]");
    process.exit(2);
  }
  console.log(
    encodePattern(
      parseBitmap(fs.readFileSync(file, "utf8")),
      scale === undefined ? 0 : Number(scale),
    ),
  );
}
