import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { CosmeticPack } from "@openfront/shared/CosmeticSchemas";
import { bundleSavings, levelLockOf, type ResolvedCosmetic } from "./Cosmetics";
import { translateText } from "./Utils";
import { timeLeft } from "./components/BundleCard";

/** The featured bundle changes at the top of every hour. */
export const FEATURED_ROTATION_MS = 60 * 60 * 1000;

/** Milliseconds until the featured bundle next changes. */
export function msUntilNextFeatured(now: number = Date.now()): number {
  return FEATURED_ROTATION_MS - (now % FEATURED_ROTATION_MS);
}

/**
 * The bundles the homepage's top notice bar (NewsBox) can feature: those for
 * sale to this player, in season and not level-locked, a seasonal one (it has
 * an end) before the others, soonest end first, then the biggest saving.
 */
export function featuredCandidates(
  resolved: readonly ResolvedCosmetic[],
  userMe: UserMeResponse | false,
  now: number = Date.now(),
): ResolvedCosmetic[] {
  const open = resolved.filter((r) => {
    if (r.type !== "cosmeticPack" || r.relationship !== "purchasable") {
      return false;
    }
    const pack = r.cosmetic as CosmeticPack;
    if (pack.startsAt !== undefined && now < Date.parse(pack.startsAt)) {
      return false;
    }
    if (pack.endsAt !== undefined && now >= Date.parse(pack.endsAt)) {
      return false;
    }
    return (pack.priceSoft ?? 0) > 0 && levelLockOf(r, userMe) === null;
  });
  const ends = (r: ResolvedCosmetic) =>
    (r.cosmetic as CosmeticPack).endsAt === undefined
      ? Infinity
      : Date.parse((r.cosmetic as CosmeticPack).endsAt!);
  const saving = (r: ResolvedCosmetic) => bundleSavings(r)?.savePct ?? 0;
  return [...open].sort(
    (a, b) =>
      ends(a) - ends(b) ||
      saving(b) - saving(a) ||
      (a.cosmetic as CosmeticPack).name.localeCompare(
        (b.cosmetic as CosmeticPack).name,
      ),
  );
}

/**
 * The one bundle featured right now. It moves to the next candidate at the
 * top of every hour, the same one for everybody, so a deal that is on sale is
 * not shown all day while others wait.
 */
export function pickFeaturedBundle(
  resolved: readonly ResolvedCosmetic[],
  userMe: UserMeResponse | false,
  now: number = Date.now(),
): ResolvedCosmetic | null {
  const candidates = featuredCandidates(resolved, userMe, now);
  if (candidates.length === 0) return null;
  const hour = Math.floor(now / FEATURED_ROTATION_MS);
  return candidates[hour % candidates.length];
}

/** "ends in 2d 4h" for a seasonal bundle, else "is 26% off", else nothing. */
export function featuredNote(featured: ResolvedCosmetic): string {
  const pack = featured.cosmetic as CosmeticPack;
  if (pack.endsAt !== undefined) {
    return translateText("main.featured_ends", {
      time: timeLeft(Date.parse(pack.endsAt) - Date.now()),
    });
  }
  const savings = bundleSavings(featured);
  return savings !== null && savings.savePct > 0
    ? translateText("main.featured_off", { percent: savings.savePct })
    : "";
}

/** Opens the Store on its Bundles tab. */
export function openBundlesTab(): void {
  window.showPage?.("page-item-store");
  const store = document.getElementById("page-item-store") as
    | (HTMLElement & { setActiveTab?: (key: string) => void })
    | null;
  requestAnimationFrame(() => store?.setActiveTab?.("bundles"));
}
