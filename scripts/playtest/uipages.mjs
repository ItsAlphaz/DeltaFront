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
// `demo` leaves a real window open on the signed-in site for browsing (it is not pinned to a size, so it can be resized).
const demo = pages.includes("demo");
const width = narrow ? 700 : 1440;
const g = await openGame(
  demo
    ? { width: 1440, height: 1000 }
    : { viewport: { width, height: narrow ? 900 : 1000 }, dpr: 1 },
);

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
  } else if (/:8787\/clans/.test(request.url)) {
    // the clan API: the browse list, a clan, its members
    const u = new URL(request.url);
    const origin = request.headers?.Origin ?? "http://localhost:9000";
    const reply = (body, code = 200) =>
      g.b.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: code,
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "access-control-allow-origin", value: origin },
          { name: "access-control-allow-credentials", value: "true" },
          {
            name: "access-control-allow-headers",
            value: "authorization,content-type",
          },
        ],
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
      });
    const clan = (tag, name, isOpen, n) => ({
      tag,
      name,
      description: "Friendly, active, always recruiting.",
      isOpen,
      memberCount: n,
      softBalance: String(n * 4100),
      hardBalance: "0",
      createdAt: "2026-09-01T10:00:00.000Z",
      xp: n * 12345,
    });
    const clans = [
      clan("STAFF", "DF Staff", false, 2),
      clan("ALPHA", "Alpha Company", true, 14),
      clan("IRON", "Iron Wolves", false, 31),
    ];
    const parts = u.pathname.split("/").filter(Boolean);
    if (request.method === "OPTIONS") await reply({}, 204);
    else if (parts.length === 1)
      await reply({ results: clans, total: 3, page: 1, limit: 20 });
    else if (parts[2] === "members")
      await reply({
        results: [
          {
            role: "leader",
            joinedAt: "2026-09-01T10:00:00.000Z",
            publicId: "p1",
            username: "Alphaz",
            verified: true,
            level: 44,
            prestige: 0,
          },
          {
            role: "officer",
            joinedAt: "2026-09-02T10:00:00.000Z",
            publicId: "p2",
            username: "CptMendoYen",
            verified: true,
            level: 31,
            prestige: 0,
          },
          {
            role: "member",
            joinedAt: "2026-09-05T10:00:00.000Z",
            publicId: "p3",
            username: "Player3",
            level: 12,
            prestige: 0,
          },
        ],
        total: 3,
        page: 1,
        limit: 20,
        pendingRequests: 2,
      });
    else if (parts.length === 2)
      await reply(
        clans.find((c) => c.tag === parts[1].toUpperCase()) ?? clans[0],
      );
    else await reply({ results: [], total: 0, page: 1, limit: 20 });
  } else if (!/\/leaderboard\//.test(request.url)) {
    await g.b.send("Fetch.continueRequest", { requestId });
  }
});
await g.b.send("Fetch.enable", {
  patterns: [
    { urlPattern: "*cosmetics.json*" },
    { urlPattern: "*leaderboard*" },
    { urlPattern: "*:8787/clans*" },
  ],
});

const lb = (n) => ({
  players: Array.from({ length: n }, (_, i) => ({
    rank: i + 1,
    playerId: i === 0 ? "p1" : "p" + (i + 10),
    accountUsername:
      i === 0 ? "Alphaz" : i === 1 ? "CptMendoYen" : "Player" + i,
    verified: i < 2,
    prestige: 0,
    level: i === 0 ? 44 : Math.max(1, 30 - i),
    legend: false,
    xp: Math.max(25, 100557 - i * 7000),
  })),
  seasons: [{ number: 1, name: "Season 1" }],
  season: { number: 1, name: "Season 1", archived: false },
});
g.b.onEvent(async (d) => {
  if (d.method !== "Fetch.requestPaused") return;
  const { requestId, request } = d.params;
  if (/\/leaderboard\/(xp|season)/.test(request.url)) {
    await g.b.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "access-control-allow-origin", value: "*" },
      ],
      body: Buffer.from(JSON.stringify(lb(demo ? 8 : 2))).toString("base64"),
    });
  }
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
for (const page of pages) {
  if (page === "leaderboard") {
    await g.ev(`window.showPage('page-leaderboard'); 1`);
    await sleep(1500);
    await g.ev(
      `document.querySelector('leaderboard-modal [data-ui-tabs="leaderboard-tabs"] [data-key="xp"]')?.click(); 1`,
    );
    await sleep(2500);
    await shot(`ui-leaderboard${narrow ? "-narrow" : ""}`);
  }
  if (page === "lobby") {
    await g.ev(`window.showPage('page-host-lobby'); 1`);
    await sleep(3500);
    await shot(`ui-lobby${narrow ? "-narrow" : ""}`);
    await g.ev(
      `document.querySelector('host-lobby-modal [data-config-jump="units"]')?.click(); 1`,
    );
    await sleep(1200);
    await shot(`ui-lobby-units${narrow ? "-narrow" : ""}`);
  }
  if (page === "home") {
    await sleep(2500);
    await shot(`ui-home${narrow ? "-narrow" : ""}`);
  }
  // any other page by its element id (page-settings, page-help, ...)
  // optionally with a tab to open: page-settings:graphics
  if (page.startsWith("page-")) {
    const [id, tab] = page.split(":");
    await g.ev(`window.showPage('${id}'); 1`);
    await sleep(2500);
    if (tab) {
      await g.ev(
        `document.querySelector('#${id} o-modal')?.shadowRoot?.querySelector('[role=tab][data-key=${tab}]')?.click(); 1`,
      );
      await sleep(1500);
    }
    await shot(`ui-${id}${tab ? "-" + tab : ""}${narrow ? "-narrow" : ""}`);
  }
  if (page === "clans") {
    await g.ev(`window.showPage('page-clan'); 1`);
    await sleep(2500);
    // no account API here: hand the page the clans it would have fetched
    await g.ev(
      `(()=>{ const m=document.querySelector('clan-modal'); m.signedOut=false; m.loading=false; m.myClans=[{tag:'STAFF',name:'DF Staff',description:'',isOpen:false,memberCount:2},{tag:'ALPHA',name:'Alpha Company',description:'',isOpen:true,memberCount:14}]; m.myClanRoles=new Map([['STAFF','leader'],['ALPHA','member']]); m.requestUpdate(); return 1 })()`,
    );
    await sleep(800);
    await shot(`ui-clans${narrow ? "-narrow" : ""}`);
  }
  if (
    page === "clan-detail" ||
    page === "clan-manage" ||
    page === "clan-requests"
  ) {
    await g.ev(`window.showPage('page-clan'); 1`);
    await sleep(2000);
    await g.ev(
      `(()=>{ const m=document.querySelector('clan-modal'); m.signedOut=false; m.loading=false; m.myPublicId='p1'; m.myClans=[{tag:'STAFF',name:'DF Staff',description:'',isOpen:false,memberCount:2}]; m.myClanRoles=new Map([['STAFF','leader']]); m.myRole='leader'; m.openDetail('STAFF'); return 1 })()`,
    );
    await sleep(2500);
    if (page === "clan-manage") {
      await g.ev(`document.querySelector('clan-modal').view='manage'; 1`);
      await sleep(1500);
    }
    if (page === "clan-requests") {
      await g.ev(`document.querySelector('clan-modal').view='requests'; 1`);
      await sleep(1500);
    }
    await shot(`ui-${page}${narrow ? "-narrow" : ""}`);
  }
  if (page === "inventory") {
    await g.ev(`window.showPage('page-inventory'); 1`);
    await sleep(2500);
    await shot(`ui-inventory${narrow ? "-narrow" : ""}`);
    await g.ev(
      `document.querySelector('inventory-modal [data-loadout-category="effects"]')?.click(); 1`,
    );
    await sleep(1200);
    await shot(`ui-inventory-effects${narrow ? "-narrow" : ""}`);
  }
}
if (demo) {
  // The private stack has no account API: keep the page signed in, and give the clan page the clans it would fetch.
  const myClans = JSON.stringify([
    {
      tag: "STAFF",
      name: "DF Staff",
      description: "",
      isOpen: false,
      memberCount: 2,
    },
    {
      tag: "ALPHA",
      name: "Alpha Company",
      description: "",
      isOpen: true,
      memberCount: 14,
    },
  ]);
  const feed = () =>
    g.ev(`(() => {
      document.dispatchEvent(new CustomEvent('userMeResponse',{detail:${JSON.stringify(me)}}));
      const a = document.querySelector('#nav-account-signin-text'); a && a.classList.add('hidden');
      const m = document.querySelector('clan-modal');
      if (m && m.signedOut) {
        m.signedOut = false; m.loading = false; m.myPublicId = 'p1';
        m.myClans = ${myClans};
        m.myClanRoles = new Map([['STAFF','leader'],['ALPHA','member']]);
        m.requestUpdate();
      }
      return 1 })()`);
  console.log("demo window open: close it (or wait for the timeout) to stop");
  while (!g.b.isClosed()) {
    await feed();
    await sleep(1500);
  }
}
console.log("out", OUT);
g.close();
process.exit(0);
