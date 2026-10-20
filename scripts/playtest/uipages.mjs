// The account pages (Store, Inventory, Leaderboard, Clans, Create Lobby) in a real browser, for comparing with the
// design's screenshots: scripts/playtest/stack.sh node scripts/playtest/uipages.mjs [store|inventory|leaderboard|clans|lobby] [--narrow]
//
// The private stack has no account API, so the page is given what it would ask the API for: the catalog through
// request interception (a larger one than the public sample, so the grids fill) and a signed-in response through the
// same event Main broadcasts. Start it with DF_ACCOUNT_FEATURES=accounts,store,inventory,clans,leaderboards,progression.
import { readFileSync } from "node:fs";
import { openGame, OUT, sleep } from "./game.mjs";

const pages = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const narrow = process.argv.includes("--narrow");
const width = narrow ? 700 : 1440;
const g = await openGame({
  viewport: { width, height: narrow ? 900 : 1000 },
  dpr: 1,
});

// ---- a catalog big enough to fill the grids
const catalog = JSON.parse(
  readFileSync("src/account-api/catalog/cosmetics.json", "utf8"),
);
const rarities = ["common", "uncommon", "rare", "epic", "legendary", "common"];
const colours = [
  "#3fa37a",
  "#e0b84a",
  "#8a8a92",
  "#9b5de5",
  "#4a7be0",
  "#e5383b",
  "#4ade80",
  "#f07174",
];
const base = catalog.effects.transportShipTrail.red_wake;
const names = [
  "Aurora Ring",
  "Copper Sparks",
  "Royal Cinders",
  "Venom Ring",
  "Mono Sparks",
  "Ice Fire Cinders",
  "Deep Sea Ring",
  "Signal Sparks",
  "Forest Cinders",
  "Galaxy Ring",
  "Rose Gold Sparks",
  "Prism Cinders",
];
names.forEach((label, i) => {
  const name = label.toLowerCase().replace(/ /g, "_");
  catalog.effects.transportShipTrail[name] = {
    ...base,
    name,
    priceSoft: [800, 800, 900, 1500, 900, 800, 1100, 900, 800, 800, 700, 900][
      i
    ],
    rarity: rarities[i % rarities.length],
    attributes: {
      ...base.attributes,
      colors: [colours[i % colours.length], "#f5f5f5"],
    },
  };
});
const ownedEffects = ["prism_cinders", "red_wake"];
const flares = [
  ...ownedEffects.map((n) => `effect:${n}`),
  "pattern:grid_check:ember",
  "pattern:delta_stripes:ember",
  "pattern:delta_stripes:ash",
  "flag:split_field",
];

g.b.onEvent(async (d) => {
  if (d.method !== "Fetch.requestPaused") return;
  const { requestId, request } = d.params;
  if (/cosmetics\.json/.test(request.url)) {
    await g.b.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "access-control-allow-origin", value: "*" },
      ],
      body: Buffer.from(JSON.stringify(catalog)).toString("base64"),
    });
  } else {
    await g.b.send("Fetch.continueRequest", { requestId });
  }
});
await g.b.send("Fetch.enable", {
  patterns: [{ urlPattern: "*cosmetics.json*" }],
});

const me = {
  user: { email: "a@b.c" },
  player: {
    publicId: "p1",
    username: "Alphaz",
    flares,
    currency: { soft: 981850, hard: 0 },
    progress: {
      prestige: 0,
      level: 44,
      xpInLevel: 550,
      xpForNext: 1000,
      lifetimeXp: 100557,
      legend: false,
      canPrestige: false,
    },
  },
};
await g.ev(
  `document.dispatchEvent(new CustomEvent('userMeResponse',{detail:${JSON.stringify(me)}})); 1`,
);
await sleep(800);

const shot = async (name) => {
  await g.b.shot(name);
  console.log("shot", name);
};
for (const page of pages.length ? pages : ["store"]) {
  if (page === "store") {
    await g.ev(`window.showPage('page-item-store'); 1`);
    await sleep(2500);
    await shot(`ui-store-effects${narrow ? "-narrow" : ""}`);
    await g.ev(
      `document.querySelector('store-modal [data-key="effects"]')?.click(); document.querySelector('store-modal [data-ui-segmented="store-tabs"] [data-key="effects"]')?.click(); 1`,
    );
    await sleep(1200);
    await g.ev(
      `(()=>{ const c=[...document.querySelectorAll('store-modal [data-ui-item="store-product"]')]; (c[9]||c[0])?.click(); return c.length })()`,
    );
    await sleep(900);
    await shot(`ui-store-effects-selected${narrow ? "-narrow" : ""}`);
    await g.ev(
      `document.querySelector('store-modal [data-ui-segmented="store-tabs"] [data-key="cosmetics"]')?.click(); 1`,
    );
    await sleep(1200);
    await shot(`ui-store-cosmetics${narrow ? "-narrow" : ""}`);
  }
}
console.log("out", OUT);
g.close();
process.exit(0);
