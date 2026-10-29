// The account pages (Store, Inventory, Leaderboard, Clans, Create Lobby) in a real browser, for comparing with the
// design's screenshots: scripts/playtest/stack.sh node scripts/playtest/uipages.mjs [store|inventory|leaderboard|clans|lobby] [--narrow|--phone]
//
// The private stack has no account API, so the page is given what it would ask the API for: the catalog through
// request interception (a larger one than the public sample, so the grids fill) and a signed-in response through the
// same event Main broadcasts. Start it with DF_ACCOUNT_FEATURES=accounts,store,inventory,clans,leaderboards,progression.
import { readFileSync } from "node:fs";
import { openGame, OUT, sleep } from "./game.mjs";
import { privateCatalog, vaultMock } from "./vaultMock.mjs";

const pages = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const phone = process.argv.includes("--phone");
const narrow = process.argv.includes("--narrow") || phone;
// `demo` leaves a real window open on the signed-in site for browsing (it is not pinned to a size, so it can be resized).
const demo = pages.includes("demo");
const width = phone ? 390 : narrow ? 700 : 1440;
const g = await openGame(
  demo
    ? { width: 1440, height: 1000 }
    : {
        viewport: { width, height: phone ? 844 : narrow ? 900 : 1000 },
        dpr: 1,
      },
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
// bundles: every tier, plus one the player is part-way through owning
const pack = (name, displayName, tagline, rarity, items, priceSoft) => ({
  name,
  displayName,
  description: `${displayName}: a themed set.`,
  tagline,
  rarity,
  priceSoft,
  items: items.map((n) => ({ type: "effect", name: n })),
});
catalog.packs = {
  ...catalog.packs,
  galaxy_loadout: pack(
    "galaxy_loadout",
    "Galaxy Loadout",
    "Every strike, lit like a nebula",
    "epic",
    [
      "aurora_ring",
      "copper_sparks",
      "royal_cinders",
      "venom_ring",
      "mono_sparks",
    ],
    3300,
  ),
  midnight_vault: pack(
    "midnight_vault",
    "Midnight Vault",
    "Sealed. Bonded. Yours.",
    "legendary",
    [
      "ice_fire_cinders",
      "deep_sea_ring",
      "signal_sparks",
      "forest_cinders",
      "galaxy_ring",
      "rose_gold_sparks",
    ],
    4800,
  ),
  half_done: pack(
    "half_done",
    "Half Done",
    "You own one of these",
    "rare",
    ["prism_cinders", "signal_sparks"],
    1300,
  ),
};
// a level lock the player (level 44) has not reached, and a seasonal bundle with a countdown
catalog.effects.transportShipTrail.venom_ring.minLevel = 60;
catalog.packs.galaxy_loadout.endsAt = new Date(
  Date.now() + (2 * 24 + 5) * 3_600_000,
).toISOString();
catalog.packs.midnight_vault.items.push({ type: "effect", name: "venom_ring" });
// the skin creator: a legendary pattern with its own artwork, first in the shop
catalog.patterns.create_your_own = {
  name: "create_your_own",
  priceSoft: 10000,
  pattern: "AAAAAA",
  url: "http://localhost:8787/cosmetics/assets/create_your_own.png",
  product: null,
  rarity: "legendary",
};
// ROLE_SKINS=1 adds the staff and admin skins from the private catalog, as an admin's profile reports them
const roleSkinNames =
  (process.env.ROLE_SKINS ?? "")
    ? [
        "staff_tag",
        "staff_diagonal",
        "admin_tag",
        "admin_diagonal",
        "admin_crest",
        "admin_shield",
      ]
    : [];
const roleCrownNames = roleSkinNames.length
  ? [
      "staff_majesty",
      "pixel_staff",
      "crimson_majesty",
      "pixel_admin",
      "owner_majesty",
      "owner_wings",
      "pixel_owner",
      "ivory_owner",
    ]
  : [];
if (roleSkinNames.length > 0) {
  const priv = JSON.parse(
    readFileSync(
      new URL(
        "../../../DeltaFront-Private-Store/catalog/cosmetics.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const n of roleSkinNames) {
    catalog.patterns[n] = priv.patterns[n];
    catalog.colorPalettes[n] = priv.colorPalettes[n];
  }
  for (const n of roleCrownNames) {
    const art = readFileSync(
      new URL(
        `../../../DeltaFront-Private-Store/assets/${priv.crowns[n].url}`,
        import.meta.url,
      ),
    );
    // the stand-in serves no asset files: the artwork travels inside the URL
    catalog.crowns[n] = {
      ...priv.crowns[n],
      url: `data:image/svg+xml;base64,${art.toString("base64")}`,
    };
  }
}
const ownedEffects = ["prism_cinders", "red_wake"];
const flares = [
  ...ownedEffects.map((n) => `effect:${n}`),
  "pattern:grid_check:ember",
  "pattern:delta_stripes:ember",
  "pattern:delta_stripes:ash",
  "flag:split_field",
  ...roleSkinNames.map((n) => `pattern:${n}:${n}`),
  ...roleCrownNames.map((n) => `crown:${n}`),
];

// ---- a small stand-in for the account service: a session, /users/@me, buying the skin
// creator and saving designs. It lets the real client code run end to end: sign in, buy, draw, save, wear.
const API = "http://localhost:8787";
const accountRoute = /:8787\/(auth\/refresh|users\/@me|shop\/purchase|vault)/;
const creatorArt = (() => {
  try {
    return readFileSync(
      process.env.SKIN_ART ??
        new URL(
          "../../../DeltaFront-Private-Store/overlays/assets/create_your_own.png",
          import.meta.url,
        ),
    );
  } catch {
    return null;
  }
})();
const account = {
  credits: 981850,
  flares: [...flares],
  customSkins: [],
};
if (process.env.OWN_CREATOR) account.flares.push("pattern:create_your_own");
// VAULT=1 serves the private catalog (its images inlined) and a stand-in for the Vault's API
const vaultCatalog = process.env.VAULT ? privateCatalog() : null;
const vaultApi = vaultCatalog ? vaultMock(vaultCatalog, account) : null;
if (vaultCatalog) {
  for (const key of Object.keys(catalog)) delete catalog[key];
  Object.assign(catalog, vaultCatalog);
  delete catalog.vault;
  account.flares = ["pattern:delta_stripes:ash"];
  account.credits = 5000;
}
const meBody = () => ({
  user: { email: "a@b.c" },
  ban: null,
  player: {
    publicId: "p1",
    adfree: false,
    unlimitedRanked: false,
    canCreatePublicLobbies: false,
    trustTier: "untrusted",
    username: "Alphaz",
    usernameBase: "Alphaz",
    verified: true,
    staffRole: "owner",
    flares: account.flares,
    ...(account.customSkins.length ? { customSkins: account.customSkins } : {}),
    currency: { soft: account.credits, hard: 0 },
    progress: me.player.progress,
    achievements: { singleplayerMap: [], player: [] },
    friends: [],
    subscription: null,
  },
});
const fakeJwt = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none" })}.${b64({
    jti: "demo",
    sub: Buffer.alloc(16, 7).toString("base64url"),
    iat: now,
    iss: API,
    aud: "localhost",
    exp: now + 3600,
  })}.x`;
};
g.b.onEvent(async (d) => {
  if (d.method !== "Fetch.requestPaused") return;
  const { requestId, request } = d.params;
  const isArt = /create_your_own\.png/.test(request.url);
  if (!isArt && !accountRoute.test(request.url)) return;
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
        {
          name: "access-control-allow-methods",
          value: "GET,POST,PUT,DELETE,OPTIONS",
        },
      ],
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    });
  const path = new URL(request.url).pathname;
  if (isArt) {
    await g.b.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: creatorArt ? 200 : 404,
      responseHeaders: [
        { name: "content-type", value: "image/png" },
        { name: "access-control-allow-origin", value: "*" },
      ],
      body: (creatorArt ?? Buffer.alloc(0)).toString("base64"),
    });
  } else if (request.method === "OPTIONS") await reply({}, 204);
  else if (path === "/auth/refresh")
    await reply({ jwt: fakeJwt(), expiresIn: 3600 });
  else if (path === "/users/@me") await reply(meBody());
  else if (path === "/vault" && vaultApi) await reply(vaultApi.view());
  else if (
    /^\/vault\/(spin|daily|packs\/[a-z_]+\/open)$/.test(path) &&
    vaultApi
  ) {
    const parts = path.split("/");
    const out = vaultApi.draw(
      parts[2] === "packs" ? "pack" : parts[2],
      parts[3],
    );
    await reply(out.body, out.status);
  } else if (path === "/shop/purchase") {
    const body = JSON.parse(request.postData ?? "{}");
    const flare = `pattern:${body.cosmeticName}`;
    if (body.cosmeticName !== "create_your_own") await reply({}, 400);
    else if (account.flares.includes(flare)) await reply({}, 409);
    else if (account.credits < 10000)
      await reply({ reason: "Insufficient balance" }, 400);
    else {
      account.credits -= 10000;
      account.flares.push(flare);
      await reply({ currency: { soft: account.credits } });
    }
  } else if (/^\/users\/@me\/skins\/\d$/.test(path)) {
    const slot = Number(path.slice(-1));
    account.customSkins = account.customSkins.filter((x) => x.slot !== slot);
    if (request.method === "PUT") {
      account.customSkins.push({
        slot,
        ...JSON.parse(request.postData ?? "{}"),
      });
      account.customSkins.sort((a, b) => a.slot - b.slot);
    }
    await reply({ customSkins: account.customSkins });
  } else await reply({}, 404);
});

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
  } else if (
    !/\/leaderboard\//.test(request.url) &&
    !accountRoute.test(request.url) &&
    !/create_your_own\.png/.test(request.url)
  ) {
    await g.b.send("Fetch.continueRequest", { requestId });
  }
});
await g.b.send("Fetch.enable", {
  patterns: [
    { urlPattern: "*cosmetics.json*" },
    { urlPattern: "*leaderboard*" },
    { urlPattern: "*:8787/clans*" },
    { urlPattern: "*:8787/auth/refresh*" },
    { urlPattern: "*:8787/users/@me*" },
    { urlPattern: "*:8787/shop/purchase*" },
    { urlPattern: "*:8787/vault*" },
    { urlPattern: "*create_your_own.png*" },
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
// the page asked for the profile before the stand-in was there: ask again, so it has a session
const signedIn = await g.ev(
  `import('/src/client/Api.ts').then(async (m) => { m.invalidateUserMe(); return !!(await m.getUserMe()); })`,
);
console.log("session", signedIn);
if (!signedIn) {
  // say why the stand-in profile was refused, so a mock that drifted from the schema is easy to fix
  console.log(
    "profile check",
    await g.ev(
      `fetch('${API}/users/@me',{headers:{authorization:'Bearer x'}}).then((r) => r.json()).then(async (b) => { const { UserMeResponseSchema } = await import('/packages/shared/src/ApiSchemas.ts'); const r = UserMeResponseSchema.safeParse(b); return r.success ? 'ok' : JSON.stringify(r.error.issues.slice(0, 3)); }).catch((e) => String(e))`,
    ),
  );
}
await g.ev(
  `document.dispatchEvent(new CustomEvent('userMeResponse',{detail:${JSON.stringify(meBody())}})); 1`,
);
await sleep(800);

const shot = async (name) => {
  await g.b.shot(name);
  console.log("shot", name);
};
// toggles: flip every switch on the Create Lobby and Solo pages and report what breaks (blank page, errors)
for (const page of pages) {
  if (page === "toggles") {
    for (const id of ["page-host-lobby", "page-single-player"].filter(
      (x) => !process.env.ONLY || x === process.env.ONLY,
    )) {
      await g.ev(
        `window.__errs=[]; window.addEventListener('error',e=>window.__errs.push('error: '+(e.message||'')+' '+(e.error&&e.error.stack||'').split('\\n').slice(0,4).join(' | '))); window.addEventListener('unhandledrejection',e=>window.__errs.push('rejection: '+(e.reason&&e.reason.stack||e.reason))); window.showPage('${id}'); 1`,
      );
      await sleep(3000);
      const jump = await g.ev(
        `(()=>{ const j=[...document.querySelectorAll('[data-config-jump]')].map(e=>e.dataset.configJump); return j })()`,
      );
      console.log(id, "sections", JSON.stringify(jump));
      for (const section of jump ?? []) {
        await g.ev(
          `document.querySelector('[data-config-jump="${section}"]')?.click(); 1`,
        );
        await sleep(500);
        const n = await g.ev(
          `document.querySelectorAll('[role="switch"]').length`,
        );
        for (let i = 0; i < n; i++) {
          await g.ev(
            `document.querySelectorAll('[role="switch"]')[${i}]?.click(); 1`,
          );
          await sleep(400);
          const state = await g.ev(
            `(()=>{ const m=document.querySelector('${id === "page-host-lobby" ? "host-lobby-modal" : "single-player-modal"}'); return {errs: window.__errs.slice(-3), len: m ? m.innerText.length : -1, switches: document.querySelectorAll('[role="switch"]').length, hidden: m ? m.className : null} })()`,
          );
          if (state.errs.length || state.len < 50) {
            console.log(
              "BREAK",
              id,
              section,
              "switch",
              i,
              JSON.stringify(state),
            );
            await shot(`ui-toggle-break-${id}-${section}-${i}`);
          }
        }
      }
      console.log(id, "done");
    }
  }
}
// mouse: the same, with real mouse clicks on the visible switch (what a player does)
for (const page of pages) {
  if (page === "mouse") {
    for (const id of ["page-single-player", "page-host-lobby"]) {
      await g.ev(
        `window.__errs=[]; window.addEventListener('error',e=>window.__errs.push('error: '+e.message+' '+((e.error&&e.error.stack)||'').split('\\n').slice(0,5).join(' | '))); window.addEventListener('unhandledrejection',e=>window.__errs.push('rejection: '+((e.reason&&e.reason.stack)||e.reason))); window.showPage('${id}'); 1`,
      );
      await sleep(3000);
      await g.ev(
        `document.querySelector('${id === "page-host-lobby" ? "host-lobby-modal" : "single-player-modal"} [data-config-jump="rules"]')?.click(); 1`,
      );
      await sleep(900);
      for (let i = 0; i < 4; i++) {
        const r = await g.ev(
          `(()=>{ const t=[...document.querySelectorAll('${id === "page-host-lobby" ? "host-lobby-modal" : "single-player-modal"} [role="switch"]')][${i}]?.parentElement?.querySelector('span[aria-hidden]'); if(!t) return null; const b=t.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2} })()`,
        );
        if (!r) break;
        await sleep(300);
        const r2 = await g.ev(
          `(()=>{ const t=[...document.querySelectorAll('${id === "page-host-lobby" ? "host-lobby-modal" : "single-player-modal"} [role="switch"]')][${i}]?.parentElement?.querySelector('span[aria-hidden]'); const b=t.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2} })()`,
        );
        await g.b.clickAt(r2.x, r2.y);
        await sleep(900);
        const st = await g.ev(
          `(()=>{ const m=document.querySelector('${id === "page-host-lobby" ? "host-lobby-modal" : "single-player-modal"}'); return {errs:window.__errs.slice(-3), len: m? m.innerText.length : -1, url: location.href.slice(0,80)} })()`,
        );
        console.log(id, "click", i, JSON.stringify(st).slice(0, 700));
        await shot(`ui-mouse-${id}-${i}`);
      }
    }
  }
}
// metrics: the heights of the Solo page's layout chain before and after one switch is flipped
for (const page of pages) {
  if (page === "metrics") {
    const chain = `(()=>{ const out=[]; let e=document.querySelector('single-player-modal [data-ui="two-column"]'); while(e && e!==document.body){ const r=e.getBoundingClientRect(); const cs=getComputedStyle(e); out.push(e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+'.'+String(e.className).split(' ').slice(0,3).join('.')+' h='+Math.round(r.height)+' ov='+cs.overflowY+' disp='+cs.display+' hgt='+cs.height); e=e.parentElement } return out })()`;
    await g.ev(`window.showPage('page-single-player'); 1`);
    await sleep(3000);
    console.log("BEFORE", JSON.stringify(await g.ev(chain), null, 1));
    await g.ev(
      `document.querySelector('[data-config-jump="rules"]')?.click(); 1`,
    );
    await sleep(700);
    await g.ev(`document.querySelectorAll('[role="switch"]')[2]?.click(); 1`);
    await sleep(900);
    console.log("AFTER", JSON.stringify(await g.ev(chain), null, 1));
    await shot("ui-metrics-after");
  }
}
// preview: the Store's cards and its WebGL preview, which are drawn on the default look
for (const page of pages) {
  if (page === "preview") {
    await g.ev(`window.showPage('page-item-store'); 1`);
    await sleep(3000);
    await g.ev(
      `document.querySelector('store-modal [data-ui-segmented="store-tabs"] [data-key="effects"]')?.click(); 1`,
    );
    await sleep(1500);
    await g.ev(
      `(()=>{ const c=[...document.querySelectorAll('store-modal [data-store-product]')]; (c[2]||c[0])?.click(); return c.length })()`,
    );
    await sleep(900);
    await shot("ui-preview-cards");
    await g.ev(
      `document.querySelector('store-modal [data-ui-button="preview"], store-modal [data-name="preview"], store-modal button[name="preview"]')?.click(); 1`,
    );
    await sleep(5000);
    await shot("ui-preview-modal");
  }
}
// solo-fx: the homepage Solo button at rest and hovered (mid-sheen)
for (const page of pages) {
  if (page === "solo-fx") {
    await sleep(2500);
    await shot("ui-solo-rest");
    const at = await g.ev(
      `(()=>{ const b=document.querySelector('.solo-btn'); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`,
    );
    // hold the :hover state with the DevTools protocol (a moving mouse is flaky), then zoom in on the button
    await g.b.send("DOM.enable");
    await g.b.send("CSS.enable");
    const doc = await g.b.send("DOM.getDocument", { depth: 0 });
    const node = await g.b.send("DOM.querySelector", {
      nodeId: doc.result.root.nodeId,
      selector: ".solo-btn",
    });
    await g.b.send("CSS.forcePseudoState", {
      nodeId: node.result.nodeId,
      forcedPseudoClasses: ["hover"],
    });
    for (const [name, wait] of [
      ["a", 450],
      ["b", 350],
    ]) {
      await sleep(wait);
      const clip = {
        x: at.x - 260,
        y: at.y - 60,
        width: 520,
        height: 120,
        scale: 3,
      };
      const png = await g.b.send("Page.captureScreenshot", {
        format: "png",
        clip,
      });
      (await import("node:fs")).writeFileSync(
        `${OUT}/ui-solo-hover-${name}.png`,
        Buffer.from(png.result.data, "base64"),
      );
    }
    await g.b.send("CSS.forcePseudoState", {
      nodeId: node.result.nodeId,
      forcedPseudoClasses: [],
    });
    {
      const png = await g.b.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: at.x - 260,
          y: at.y - 60,
          width: 520,
          height: 120,
          scale: 3,
        },
      });
      (await import("node:fs")).writeFileSync(
        `${OUT}/ui-solo-rest-zoom.png`,
        Buffer.from(png.result.data, "base64"),
      );
    }
  }
}
for (const page of pages) {
  if (page === "bundles") {
    await g.ev(`window.showPage('page-item-store'); 1`);
    await sleep(3000);
    await g.ev(
      `document.querySelector('store-modal [data-ui-segmented="store-tabs"] [data-key="bundles"]')?.click(); 1`,
    );
    await sleep(2500);
    await shot(`ui-bundles${narrow ? "-narrow" : ""}`);
    await g.ev(
      `document.querySelector('[data-cosmetic-key="cosmeticPack:midnight_vault"]')?.scrollIntoView({block:'center'}); 1`,
    );
    await sleep(800);
    await shot("ui-bundles-lock");
    await g.ev(
      `(()=>{ const c=document.querySelector('store-modal [data-bundle-card]'); c?.scrollIntoView(); c?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); return !!c })()`,
    );
    await g.ev(
      `document.querySelector('store-modal [data-bundle-card]')?.click(); 1`,
    );
    await sleep(1200);
    await shot(`ui-bundles-dialog${narrow ? "-narrow" : ""}`);
  }
}
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
      `(()=>{ const c=[...document.querySelectorAll('store-modal [data-store-product]')]; (c[9]||c[0])?.click(); return c.length })()`,
    );
    await sleep(900);
    await shot(`ui-store-effects-selected${narrow ? "-narrow" : ""}`);
    await g.ev(
      `document.querySelector('store-modal [data-ui-segmented="store-tabs"] [data-key="cosmetics"]')?.click(); 1`,
    );
    await sleep(1200);
    await shot(`ui-store-cosmetics${narrow ? "-narrow" : ""}`);
    // the other cosmetic categories: their artwork must show whole in the cards
    for (const sub of ["flags", "crowns"]) {
      await g.ev(
        `document.querySelector('store-modal [data-ui-tabs] [data-key="${sub}"]')?.click(); 1`,
      );
      await sleep(1500);
      await g.ev(
        `document.querySelector('store-modal [data-store-product]')?.click(); 1`,
      );
      await sleep(900);
      await shot(`ui-store-${sub}${narrow ? "-narrow" : ""}`);
    }
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
  // the top notice bar on its second notice (the first is the featured bundle)
  if (page === "notices") {
    await sleep(2500);
    await g.ev(
      `document.querySelectorAll('news-box[variant="strip"] .gap-1 button')[1]?.click(); 1`,
    );
    await sleep(500);
    await shot("ui-notices");
  }
  // the Vault: the hero, hovering the odds and the wheel, the free daily spin turning and landing, the packs, a pack tearing open and showing its cards, and the collection
  if (page === "vault") {
    await sleep(2500);
    // say why the page could not read the Vault, should the stand-in drift from the schema
    console.log(
      "vault check",
      await g.ev(
        `fetch('${API}/vault',{headers:{authorization:'Bearer x'}}).then((r) => r.json()).then(async (b) => { const { VaultViewSchema } = await import('/packages/shared/src/VaultSchemas.ts'); const r = VaultViewSchema.safeParse(b); return r.success ? 'ok' : JSON.stringify(r.error.issues.slice(0, 3)); }).catch((e) => String(e))`,
      ),
    );
    // REDUCED=1: the same walk with the system asking for less motion
    if (process.env.REDUCED) {
      await g.b.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }
    const sfx = `${process.env.REDUCED ? "-reduced" : ""}${phone ? "-phone" : narrow ? "-narrow" : ""}`;
    const click = (sel) =>
      g.ev(`document.querySelector(${JSON.stringify(sel)})?.click(); 1`);
    // a real pointer at a fraction of an element; says what it ended up over
    const hover = async (sel, fx = 0.5, fy = 0.5) => {
      const at = await g.ev(
        `(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width*${fx},y:r.y+r.height*${fy}} })()`,
      );
      if (at === null) {
        console.log("hover: no", sel);
        return;
      }
      for (const dx of [-6, 0]) {
        await g.b.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: at.x + dx,
          y: at.y,
        });
        await sleep(90);
      }
      await sleep(450);
      console.log(
        "hover",
        sel,
        JSON.stringify(at),
        await g.ev(
          `(()=>{ const hs=[...document.querySelectorAll(':hover')]; const h=hs[hs.length-1]; const sc=document.querySelector('vault-modal o-modal')?.shadowRoot?.querySelector('[data-modal-scroll]'); return (h ? h.tagName+'.'+String(h.className).slice(0,40) : 'none') + ' scrollTop=' + (sc ? sc.scrollTop : 'n/a') + ' dpr=' + devicePixelRatio + ' iw=' + innerWidth })()`,
        ),
      );
    };
    const scrollTo = async (sel) => {
      await g.ev(
        `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'start'}); 1`,
      );
      await sleep(1400);
    };
    await g.ev(`window.showPage('page-vault'); 1`);
    await sleep(3600);
    await shot(`ui-vault${sfx}`);
    console.log(
      "outlines",
      await g.ev(
        `JSON.stringify([...document.querySelectorAll('[data-vault-daily], [data-vault-daily] *')].map((e) => { const c = getComputedStyle(e); return [e.tagName, String(e.className.baseVal ?? e.className).slice(0, 30), c.outlineStyle, c.outlineWidth, c.borderTopStyle, c.borderTopWidth, c.borderTopColor, e.matches(':focus-visible')]; }).filter((r) => r[2] !== 'none' || r[4] !== 'none'))`,
      ),
    );
    {
      const r = await g.ev(
        `(()=>{ const r=document.querySelector('.vault-ring').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height} })()`,
      );
      const { result } = await g.b.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: r.x - 20,
          y: r.y - 20,
          width: r.w + 40,
          height: r.h + 40,
          scale: 6,
        },
      });
      (await import("node:fs")).writeFileSync(
        `${process.env.PLAYTEST_OUT ?? "/tmp"}/ui-vault-ring-zoom.png`,
        Buffer.from(result.data, "base64"),
      );
    }
    if (narrow) await scrollTo("[data-vault-odds-block]");
    await hover('[data-vault-legend="item:epic"]');
    console.log(
      "highlight",
      await g.ev(
        `(()=>{ const w=document.querySelector('vault-wheel'); return JSON.stringify({h:w.highlight, dim:w.dim, vis:w.visible, frame:w.frame!==null}) })()`,
      ),
    );
    await shot(`ui-vault-odds-hover${sfx}`);
    await hover("vault-wheel", 0.85, 0.2);
    await shot(`ui-vault-wheel-tilt${sfx}`);
    await click("[data-vault-odds-block] [data-vault-odds-toggle]");
    await sleep(700);
    await shot(`ui-vault-odds-open${sfx}`);
    await click("[data-vault-odds-block] [data-vault-odds-toggle]");
    await click("[data-vault-daily]");
    await sleep(1800);
    await shot(`ui-vault-spinning${sfx}`);
    await sleep(5000);
    await shot(`ui-vault-landed${sfx}`);
    await sleep(900);
    await shot(`ui-vault-credits${sfx}`);
    await click("[data-reveal-done]");
    await sleep(2200);
    await shot(`ui-vault-balance${sfx}`);
    // a win of 250 Credits: the balance counts up and the change floats beside it
    await g.ev(
      `(()=>{ const c=document.querySelector('vault-count'); c.value = c.value + 250; return 1 })()`,
    );
    await sleep(450);
    await shot(`ui-vault-delta${sfx}`);
    await scrollTo("[data-vault-packs]");
    await shot(`ui-vault-packs${sfx}`);
    await hover('[data-vault-pack="officer"] .vault-pack-shelf', 0.8, 0.25);
    await shot(`ui-vault-pack-hover${sfx}`);
    await click('[data-vault-pack="officer"] [data-vault-odds-toggle]');
    await sleep(700);
    await shot(`ui-vault-pack-odds${sfx}`);
    await click('[data-vault-pack="officer"] [data-vault-odds-toggle]');
    await click('[data-vault-pack="officer"] [data-vault-open="officer"]');
    await sleep(1000);
    await shot(`ui-vault-sealed${sfx}`);
    await hover("[data-reveal-pack]", 0.92, 0.08);
    await shot(`ui-vault-sealed-tilt${sfx}`);
    await click("[data-reveal-pack]");
    await sleep(350);
    await shot(`ui-vault-tearing${sfx}`);
    await sleep(1300);
    await shot(`ui-vault-cards${sfx}`);
    await click('[data-reveal-card="0"]');
    await sleep(1200);
    await shot(`ui-vault-card-1${sfx}`);
    await click("[data-reveal-skip]");
    await sleep(3200);
    await shot(`ui-vault-done${sfx}`);
    await hover('[data-reveal-card="2"]', 0.2, 0.8);
    await shot(`ui-vault-card-tilt${sfx}`);
    await click("[data-reveal-done]");
    await sleep(1500);
    await scrollTo("[data-vault-collection]");
    await shot(`ui-vault-collection${sfx}`);
    await hover("[data-vault-item]", 0.3, 0.3);
    await shot(`ui-vault-item-hover${sfx}`);
    await click('[data-vault-rarity="legendary"]');
    await sleep(900);
    await shot(`ui-vault-collection-filter${sfx}`);
  }
  // the news, help and settings icons while their buttons are hovered: which animations run, and a close-up frame of each
  if (page === "navicons") {
    await sleep(2500);
    const box = (sel) =>
      g.ev(
        `(()=>{ const r=document.querySelector('${sel}').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height} })()`,
      );
    const move = (x, y) =>
      g.b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const [name, page, wait] of [
      ["news", "page-news", 160],
      ["help", "page-help", 300],
      ["settings", "page-settings", 450],
    ]) {
      const r = await box(`button[data-page="${page}"]`);
      await move(2, 2);
      await sleep(900);
      await move(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(wait);
      const running = await g.ev(
        `JSON.stringify([...document.getAnimations()].map((a) => a.animationName ?? a.transitionProperty).filter(Boolean))`,
      );
      console.log(name, "running:", running);
      const { result } = await g.b.send("Page.captureScreenshot", {
        format: "png",
        clip: {
          x: r.x - 8,
          y: r.y - 8,
          width: r.w + 16,
          height: r.h + 16,
          scale: 6,
        },
      });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        `${OUT}/ui-navicon-${name}.png`,
        Buffer.from(result.data, "base64"),
      );
      console.log("shot ui-navicon-" + name);
    }
  }
  // the profile button's hover, the menu opening, and a hovered row
  if (page === "accountmenu") {
    await sleep(2500);
    const rect = (sel) =>
      g.ev(
        `(()=>{ const r=document.querySelector('${sel}').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`,
      );
    const move = (p) =>
      g.b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
      });
    const trigger = await rect("[data-account-trigger]");
    await move(trigger);
    await sleep(600);
    await shot("ui-account-hover");
    await g.b.clickAt(trigger.x, trigger.y);
    await shot("ui-account-opening");
    await sleep(900);
    await shot("ui-account-open");
    await move(await rect('[data-menu-item="account-settings"]'));
    await sleep(500);
    await shot("ui-account-row");
  }
  // "Use verified" and back: the name must keep its place
  if (page === "verified") {
    await sleep(2500);
    const where = () =>
      g.ev(`(() => {
        const u = document.querySelector('username-input');
        const name = u.querySelector('input[aria-label], [class*="NAME"], .truncate');
        const el = u.querySelector('input[type=text]') || u.querySelector('span.truncate');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ tag: el.tagName, x: Math.round(r.x), w: Math.round(r.width), centre: Math.round(r.x + r.width / 2) });
      })()`);
    console.log("before", await where());
    await shot("ui-verified-before");
    // the harness account has no verified name to play under, so give it one, then press the real button
    await g.ev(
      `(() => { const u = document.querySelector('username-input'); u.verifiedName = () => 'Alphaz'; u.requestUpdate(); return 1 })()`,
    );
    await sleep(300);
    await g.ev(
      `document.querySelector('username-input [data-verified-use]').click(); 1`,
    );
    // frames of the motion
    for (const name of ["a", "b", "c"]) {
      await shot(`ui-verified-fx-${name}`);
    }
    await sleep(800);
    console.log("after", await where());
    await shot("ui-verified-after");
  }
  // the skin creator: the shop's headliner card, buying it, drawing and saving a design
  if (page === "skincreator") {
    const rect = (sel) =>
      g.ev(
        `(()=>{ const e=document.querySelector('${sel}'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height} })()`,
      );
    const move = (p) =>
      g.b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
      });
    await g.ev(`window.showPage('page-item-store'); 1`);
    await sleep(2500);
    await g.ev(
      `document.querySelector('store-modal [data-ui-segmented="store-tabs"] [data-key="cosmetics"]')?.click(); 1`,
    );
    await sleep(1500);
    await shot("ui-skin-shop");
    const card = await rect("[data-cosmetic-feature]");
    console.log("card", JSON.stringify(card));
    if (card) {
      await move(card);
      await sleep(900);
      await shot("ui-skin-hover");
      await g.ev(
        `document.querySelector('[data-cosmetic-feature]').closest('cosmetic-card').querySelector('[data-cosmetic-main]')?.click(); 1`,
      );
      await sleep(900);
      await shot("ui-skin-detail");
    }
    await g.ev(`window.location.hash = 'modal=skin-creator'; 1`);
    await sleep(2500);
    await shot("ui-skin-locked");
    console.log(
      "locked",
      await g.ev(`!!document.querySelector('[data-skin-creator-locked]')`),
    );
    // buy it through the real shop button, then draw
    await g.ev(`document.querySelector('skin-creator-modal')?.close?.(); 1`);
    await sleep(800);
    await g.ev(`window.showPage('page-item-store'); 1`);
    await sleep(1200);
    await g.ev(
      `document.querySelector('[data-cosmetic-feature]')?.closest('cosmetic-card')?.querySelector('[data-cosmetic-main]')?.click(); 1`,
    );
    await sleep(600);
    await g.ev(
      `document.querySelector('store-modal [data-ui="detail-action"] button')?.click(); 1`,
    );
    await sleep(800);
    await shot("ui-skin-confirm");
    await g.ev(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().toLowerCase() === 'confirm')?.click(); 1`,
    );
    await sleep(1500);
    await shot("ui-skin-bought");
    // the shop reloads the page after a purchase
    await g.ev(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().toLowerCase() === 'close')?.click(); 1`,
    );
    await sleep(6000);
    await g.ev(`window.location.hash = 'modal=skin-creator'; 1`);
    await sleep(2500);
    await shot("ui-skin-editor");
    const canvas = await rect("skin-editor-canvas canvas");
    console.log("canvas", JSON.stringify(canvas));
    if (canvas) {
      const at = (fx, fy) => ({
        x: canvas.x - canvas.w / 2 + canvas.w * fx,
        y: canvas.y - canvas.h / 2 + canvas.h * fy,
      });
      const mouse = (type, p, extra = {}) =>
        g.b.send("Input.dispatchMouseEvent", {
          type,
          x: p.x,
          y: p.y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
          ...extra,
        });
      const stroke = async (a, b) => {
        await mouse("mouseMoved", a, { buttons: 0 });
        await mouse("mousePressed", a);
        for (let i = 1; i <= 10; i++)
          await mouse("mouseMoved", {
            x: a.x + ((b.x - a.x) * i) / 10,
            y: a.y + ((b.y - a.y) * i) / 10,
          });
        await mouse("mouseReleased", b);
      };
      await stroke(at(0.1, 0.1), at(0.9, 0.9));
      await stroke(at(0.9, 0.1), at(0.1, 0.9));
      await stroke(at(0.5, 0.05), at(0.5, 0.95));
      await sleep(400);
      await shot("ui-skin-drawn");
      await g.ev(
        `document.querySelector('[data-ui-button="save"]')?.click(); 1`,
      );
      await sleep(1500);
      await g.ev(
        `document.querySelector('[data-ui-button="wear"]')?.click(); 1`,
      );
      await sleep(600);
      await shot("ui-skin-saved");
    }
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
    if (roleSkinNames.length > 0) {
      await g.ev(
        `document.querySelector('inventory-modal [data-loadout-category="patterns"]')?.click(); 1`,
      );
      await sleep(1200);
      await shot("ui-inventory-roleskins");
      await g.ev(
        `document.querySelector('inventory-modal [data-loadout-category="crowns"]')?.click(); 1`,
      );
      await sleep(1200);
      await shot("ui-inventory-rolecrowns");
    }
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
      document.dispatchEvent(new CustomEvent('userMeResponse',{detail:${JSON.stringify(meBody())}}));
      const a = document.querySelector('#nav-account-signin-text'); a && a.classList.add('hidden');
      const m = document.querySelector('clan-modal');
      if (m && m.signedOut) {
        m.signedOut = false; m.loading = false; m.myPublicId = 'p1';
        m.myClans = ${myClans};
        m.myClanRoles = new Map([['STAFF','leader'],['ALPHA','member']]);
        m.requestUpdate();
      }
      return 1 })()`);
  // the harness account has no verified name, so give it one: "Use verified" then switches on, as it does for a real account
  await g.ev(
    `(() => { const u = document.querySelector('username-input'); if (u) { u.verifiedName = () => 'Alphaz'; u.requestUpdate(); } return 1 })()`,
  );
  console.log("demo window open: close it (or wait for the timeout) to stop");
  while (!g.b.isClosed()) {
    await feed();
    await sleep(1500);
  }
}
console.log("out", OUT);
g.close();
process.exit(0);
