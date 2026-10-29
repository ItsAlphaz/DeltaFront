// A stand-in for the account API's Vault (GET /vault and the three draws), for looking at the page in a real
// browser: the odds and items come from the private catalog's own config, the draws are plain random picks.
import { readFileSync } from "node:fs";

const PRIVATE = new URL("../../../DeltaFront-Private-Store/", import.meta.url);
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];

/** The private catalog, with every image inlined so a page with no asset server can draw it. */
export function privateCatalog() {
  const catalog = JSON.parse(
    readFileSync(new URL("catalog/cosmetics.json", PRIVATE), "utf8"),
  );
  const effects = JSON.parse(
    readFileSync(new URL("catalog/effects.json", PRIVATE), "utf8"),
  ).effects;
  catalog.effects = effects;
  const inline = (item) => {
    if (typeof item.url !== "string") return;
    try {
      const svg = readFileSync(new URL(`assets/${item.url}`, PRIVATE));
      const type = item.url.endsWith(".png") ? "image/png" : "image/svg+xml";
      item.url = `data:${type};base64,${svg.toString("base64")}`;
    } catch {
      // an item with no image file keeps its name only
    }
  };
  for (const kind of ["flags", "crowns"]) {
    for (const item of Object.values(catalog[kind] ?? {})) inline(item);
  }
  return catalog;
}

const flareOf = (ref) =>
  ref.colorPalette === undefined
    ? `${ref.type}:${ref.name}`
    : `${ref.type}:${ref.name}:${ref.colorPalette}`;

export function vaultMock(catalog, account) {
  const vault = catalog.vault;
  const rarityOf = (ref) => {
    if (ref.type === "pattern") return catalog.patterns[ref.name].rarity;
    if (ref.type === "flag") return catalog.flags[ref.name].rarity;
    if (ref.type === "crown") return catalog.crowns[ref.name].rarity;
    for (const byName of Object.values(catalog.effects)) {
      if (byName[ref.name]) return byName[ref.name].rarity;
    }
    return "common";
  };
  const byRarity = (pool) => {
    const out = Object.fromEntries(RARITIES.map((r) => [r, []]));
    for (const ref of pool) out[rarityOf(ref)].push(ref);
    return out;
  };
  const views = (pool) =>
    pool.map((ref) => ({ ...ref, rarity: rarityOf(ref) }));
  const day = { daily: false, packs: 0, spins: 0 };
  const pity = {};
  const pick = (weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      if ((roll -= weights[i]) < 0) return i;
    }
    return weights.length - 1;
  };
  const card = (ref) => {
    const flare = flareOf(ref);
    const rarity = rarityOf(ref);
    const dupe = account.flares.includes(flare);
    const credits = dupe ? vault.dupeCredits[rarity] : 0;
    if (!dupe) account.flares.push(flare);
    else account.credits += credits;
    return {
      type: ref.type,
      name: ref.name,
      ...(ref.colorPalette === undefined
        ? {}
        : { colorPalette: ref.colorPalette }),
      rarity,
      dupe,
      credits,
    };
  };
  const nextMidnight = () => {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
  };
  const openPack = (name) => {
    const pack = vault.packs[name];
    const items = byRarity(pack.pool);
    const cards = pack.slots.map((slot, i) => {
      const usable = RARITIES.filter(
        (r) => (slot[r] ?? 0) > 0 && items[r].length,
      );
      const rarity = usable[pick(usable.map((r) => slot[r]))];
      const ref =
        items[rarity][Math.floor(Math.random() * items[rarity].length)];
      return { ref, last: i === pack.slots.length - 1 };
    });
    return { pack: name, cards: cards.map(({ ref }) => card(ref)) };
  };
  return {
    view() {
      const wheel = vault.wheel;
      const total = wheel.segments.reduce((a, s) => a + s.weight, 0);
      return {
        wheel: {
          spinPrice: wheel.spinPrice,
          segments: wheel.segments.map((s) => ({
            id: s.id,
            label: s.label,
            prize: s.prize,
            percent: Math.round((s.weight / total) * 10000) / 100,
          })),
          items: views(wheel.pool),
        },
        packs: Object.values(vault.packs).map((p) => {
          const items = byRarity(p.pool);
          return {
            name: p.name,
            displayName: p.displayName,
            tagline: p.tagline,
            priceSoft: p.priceSoft,
            rarity: p.rarity,
            inSeason: true,
            pity: p.pity,
            slots: p.slots.map((slot) => {
              const usable = RARITIES.filter(
                (r) => (slot[r] ?? 0) > 0 && items[r].length,
              );
              const sum = usable.reduce((a, r) => a + slot[r], 0);
              return Object.fromEntries(
                usable.map((r) => [
                  r,
                  Math.round((slot[r] / sum) * 10000) / 100,
                ]),
              );
            }),
            items: views(p.pool),
          };
        }),
        dupeCredits: vault.dupeCredits,
        limits: vault.limits,
        state: {
          pity: Object.fromEntries(
            Object.entries(pity).map(([k, v]) => [k, v]),
          ),
          today: { packs: day.packs, spins: day.spins },
          daily: { available: !day.daily, nextAt: nextMidnight() },
          balance: account.credits,
        },
      };
    },
    draw(kind, packName) {
      if (kind === "pack") {
        const pack = vault.packs[packName];
        if (!pack) return { status: 404, body: { reason: "Pack not found" } };
        if (account.credits < pack.priceSoft)
          return { status: 400, body: { reason: "Insufficient balance" } };
        account.credits -= pack.priceSoft;
        day.packs++;
        const result = openPack(packName);
        return {
          status: 200,
          body: { result, balance: account.credits, replay: false },
        };
      }
      if (kind === "daily" && day.daily)
        return {
          status: 409,
          body: { code: "DAILY_USED", nextAt: nextMidnight() },
        };
      const cost = kind === "daily" ? 0 : vault.wheel.spinPrice;
      if (account.credits < cost)
        return { status: 400, body: { reason: "Insufficient balance" } };
      account.credits -= cost;
      if (kind === "daily") day.daily = true;
      else day.spins++;
      const wheel = vault.wheel;
      const index = pick(wheel.segments.map((s) => s.weight));
      const segment = wheel.segments[index];
      const items = byRarity(wheel.pool);
      let won = 0;
      const out = {
        segment: index,
        segmentId: segment.id,
        prize: segment.prize,
        creditsWon: 0,
        cost,
        daily: kind === "daily",
      };
      if (segment.prize.kind === "credits") {
        won = segment.prize.amount;
        account.credits += won;
      } else if (segment.prize.kind === "item") {
        const list = items[segment.prize.rarity];
        out.card = card(list[Math.floor(Math.random() * list.length)]);
        won = out.card.credits;
      } else {
        out.pack = openPack(segment.prize.pack);
        won = out.pack.cards.reduce((a, c) => a + c.credits, 0);
      }
      out.creditsWon = won;
      return {
        status: 200,
        body: { result: out, balance: account.credits, replay: false },
      };
    },
  };
}
