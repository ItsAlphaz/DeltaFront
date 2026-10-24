import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { CosmeticPack } from "@openfront/shared/CosmeticSchemas";
import { bundleSavings, levelLockOf, type ResolvedCosmetic } from "./Cosmetics";
import { translateText } from "./Utils";
import { timeLeft } from "./components/BundleCard";

/**
 * The bundle the homepage's top notice bar (NewsBox) features: one that is for
 * sale to this player, in season and not level-locked. A seasonal bundle (it has an end) comes first, soonest end
 * first, because it will not be there long; otherwise the biggest saving.
 */
export function pickFeaturedBundle(
  resolved: readonly ResolvedCosmetic[],
  userMe: UserMeResponse | false,
  now: number = Date.now(),
): ResolvedCosmetic | null {
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
  if (open.length === 0) return null;
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
  )[0];
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
