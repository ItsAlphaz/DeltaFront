/**
 * Flares: the strings that say who owns what (docs/DeltaFrontAccountsPlan.md
 * sections 1.6 and 10). `/users/@me` lists them in `player.flares`, and the
 * game server checks every equipped cosmetic against them at join.
 *
 *   pattern:<name>:<palette>   a pattern in one colour palette
 *   pattern:<name>             a pattern with no palettes
 *   flag:<name>                effect:<name>
 *
 * They are built only here, from catalog entries, so an ownership string can
 * never be assembled from player input.
 */

/** The shape of any flare DeltaFront stores: no wildcards, no spaces, bounded. */
export const FLARE_SHAPE =
  /^(pattern|flag|effect):[a-z0-9_]{1,32}(:[a-z0-9_]{1,32})?$/;

export const MAX_FLARE_LENGTH = 80;

export const patternFlare = (name: string, palette: string | null): string =>
  palette === null ? `pattern:${name}` : `pattern:${name}:${palette}`;

export const flagFlare = (name: string): string => `flag:${name}`;

export const effectFlare = (name: string): string => `effect:${name}`;

/** True for anything the game server would treat as "owns everything of this kind". */
export function isWildcardFlare(flare: string): boolean {
  return flare === "*" || flare.includes("*");
}

/** True when `value` is shaped like a flare (it may still not be in the catalog). */
export function hasFlareShape(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= MAX_FLARE_LENGTH &&
    FLARE_SHAPE.test(value)
  );
}
