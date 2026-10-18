// Helpers for driving a match in a real browser: open the game page with the
// hooks installed, start a two-player match (you and a scripted "raider" 9 tiles
// away, on Antarctica), grow both armies, and take the capital. See README.md.
import { readFileSync } from "node:fs";
import { OUT, launch, sleep } from "./lib.mjs";

export { OUT, sleep };

/** The game page. Defaults to a local dev client. */
export const URL_BASE = process.env.PLAYTEST_URL ?? "http://localhost:9000/";

const HOOKS =
  "try{localStorage.setItem('settings.tutorialDismissed','true')}catch(e){}\n" +
  readFileSync(new URL("./hooks.js", import.meta.url), "utf8");

/**
 * Collects checks. Each prints PASS or FAIL with what was measured; summary()
 * prints the tally and sets the process's exit code, so a script can gate on it.
 */
export function reporter(title) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok, detail });
    console.log(
      (ok ? "PASS " : "FAIL ") +
        name +
        (detail !== "" ? "  -- " + String(detail).slice(0, 260) : ""),
    );
    return !!ok;
  };
  const note = (s) => console.log("note " + s);
  const summary = () => {
    const passed = results.filter((r) => r.ok).length;
    console.log(
      `\n${title}: ${passed}/${results.length} passed` +
        (passed < results.length
          ? "  FAILED: " +
            results
              .filter((r) => !r.ok)
              .map((r) => r.name)
              .join(" | ")
          : ""),
    );
    if (passed < results.length) process.exitCode = 1;
    return results;
  };
  return { check, note, summary, results };
}

/**
 * Opens Chrome on the game page with the hooks installed.
 *   viewport {width,height}, dpr, mobile   pin an exact viewport (otherwise the
 *                                          size at load is pinned: the desktop may resize the window)
 *   reducedMotion                          emulate prefers-reduced-motion: reduce
 *   mute                                   false to let the page make sound
 */
export async function openGame(o = {}) {
  const b = await launch({
    width: o.width ?? 1280,
    height: o.height ?? 800,
    mute: o.mute ?? true,
    args: o.args,
  });
  await b.send("Page.enable");
  await b.send("Runtime.enable");
  await b.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  if (o.reducedMotion) {
    await b.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
  }
  if (o.dpr || o.viewport) {
    const v = o.viewport ?? { width: o.width ?? 1280, height: o.height ?? 800 };
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: v.width,
      height: v.height,
      deviceScaleFactor: o.dpr ?? 1,
      mobile: !!o.mobile,
    });
  }
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOKS });
  await b.send("Page.navigate", { url: o.url ?? URL_BASE });
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const r = await b.ev(
      `document.readyState==='complete' && !!document.querySelector('game-mode-selector')`,
    );
    if (r === true) break;
  }
  await sleep(2500);
  if (!o.dpr && !o.viewport && !o.keepWindowSize) {
    const d = await b.ev(
      `JSON.stringify([innerWidth, innerHeight, devicePixelRatio])`,
    );
    try {
      const [iw, ih, dpr] = JSON.parse(d);
      await b.send("Emulation.setDeviceMetricsOverride", {
        width: iw,
        height: ih,
        deviceScaleFactor: dpr,
        mobile: false,
      });
    } catch {
      // keep the window as it is
    }
  }
  // a real click first, so that the page may play sound
  if (!o.noClick) await b.clickAt(200, 200);
  /** Evaluate an expression in the page and parse its (JSON) value. */
  const J = async (expr) => {
    const r = await b.ev(
      `JSON.stringify(${expr}, (k,v)=>typeof v==='bigint'?String(v):v)`,
    );
    if (typeof r !== "string") return null;
    try {
      return JSON.parse(r);
    } catch {
      return null;
    }
  };
  return { b, J, ev: b.ev, close: () => b.close() };
}

/**
 * A two-human match on Antarctica (compact): "me" (the player of this page) and
 * a scripted raider, spawned 9 tiles apart. Returns inject(who, intent): queue an
 * intent for either player (solo only).
 *   startingGold, capitalSystem, extra (more GameConfig fields)
 *   buyCapitals (default true): v0.8.0 sells the capital, so both players buy
 *     theirs (the same order the tile picker sends) once the spawn phase is over;
 *     false leaves them without one, for a check of the purchase itself.
 */
export async function startMatch(g, o = {}) {
  const cap = o.capitalSystem ?? { enabled: true };
  await g.ev(`(()=>{ const cid='me'+Math.random().toString(36).slice(2,8).padEnd(6,'x'), p2='fo'+Math.random().toString(36).slice(2,8).padEnd(6,'x'); window.__cid=cid; window.__p2=p2; const gid='g'+Math.random().toString(36).slice(2,10);
    document.dispatchEvent(new CustomEvent('join-lobby',{bubbles:true,composed:true,detail:{gameID:gid,source:'singleplayer',gameStartInfo:{gameID:gid,lobbyCreatedAt:Date.now(),
     players:[{clientID:cid,username:${JSON.stringify(o.myName ?? "Playtester")},clanTag:null,cosmetics:{}},{clientID:p2,username:${JSON.stringify(o.foeName ?? "Raider")},clanTag:null,cosmetics:{}}],
     config:{gameMap:'Antarctica',gameMapSize:'Compact',gameType:'Singleplayer',gameMode:'Free For All',playerTeams:2,difficulty:'Medium',maxTimerValue:undefined,bots:0,infiniteGold:false,donateGold:false,donateTroops:false,infiniteTroops:false,instantBuild:true,randomSpawn:false,disabledUnits:[],nations:'disabled',startingGold:${o.startingGold ?? 3000000},capitalSystem:${JSON.stringify(cap)},...${JSON.stringify(o.extra ?? {})}}}}}));
    window.__inject=[{type:'spawn',tile:612071,clientID:cid},{type:'spawn',tile:612080,clientID:p2}];return 1})()`);
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const s = await g.J(`({tick:window.__tick, pl:window.__pl})`);
    const a = s && s.pl && Object.values(s.pl);
    // v0.8.0: nobody starts with a capital, so wait for both to spawn.
    if (a && a.length >= 2 && a.every((x) => x.small !== undefined)) break;
  }
  await g.ev(`window.__mySmall = window.__pl[window.__cid].small; 1`);
  const inject = (who, intent) =>
    g.ev(
      `window.__inject=(window.__inject||[]).concat([Object.assign({clientID:${who}}, ${JSON.stringify(intent)})]);1`,
    );
  // both grow a little, so that their lands touch
  for (let i = 0; i < 2; i++) {
    await inject("window.__cid", {
      type: "attack",
      targetID: null,
      troops: null,
    });
    await inject("window.__p2", {
      type: "attack",
      targetID: null,
      troops: null,
    });
    await sleep(1800);
  }
  await sleep(1500);
  if (o.buyCapitals !== false && cap.enabled) {
    await buyCapitals(g, inject);
  }
  return { inject };
}

/**
 * Both players buy a capital at their spawn tile (or a tile beside it, if a
 * neighbour's land made that one a border). The order is refused, and nothing
 * charged, until the spawn phase is over: try again until both have one.
 */
export async function buyCapitals(g, inject) {
  const spawn = { "window.__cid": 612071, "window.__p2": 612080 };
  for (let attempt = 0; attempt < 30; attempt++) {
    const pl = await g.J(`window.__pl`);
    const both = Object.values(pl || {});
    if (both.length >= 2 && both.every((x) => x.capitalTile >= 0)) return true;
    const offsets = [0, 1, -1, 2, -2, 3, -3];
    for (const [who, tile] of Object.entries(spawn)) {
      const id = await g.ev(who);
      const mine = Object.values(pl || {}).find((x) => x.clientID === id);
      if (mine && mine.capitalTile >= 0) continue;
      await inject(who, {
        type: "found_capital",
        tile: tile + offsets[attempt % offsets.length],
      });
    }
    await sleep(1500);
  }
  return false;
}

export const me = (g) => g.J(`window.__pl[window.__cid]`);
export const foe = (g) => g.J(`window.__pl[window.__p2]`);
export const view = (g) =>
  g.J(`window.__ins && window.__ins[window.__mySmall] || null`);
export const tick = (g) => g.ev(`window.__tick`);
export const stats = (g, who = "cid") =>
  g.J(`window.__stats && window.__stats[window.__pl[window.__${who}].small]`);

/** Speed the clock up until both armies are worth fighting with, then back to normal. */
export async function regen(g, target = 150000, maxSec = 150) {
  await g.b.key(".", "Period", 190);
  const t0 = Date.now();
  let last = null;
  while ((Date.now() - t0) / 1000 < maxSec) {
    await sleep(700);
    const a = await stats(g, "cid");
    const c = await stats(g, "p2");
    last = { me: a && a.troops, foe: c && c.troops };
    if (a && c && a.troops >= target && c.troops >= target) break;
  }
  await g.b.key(",", "Comma", 188);
  await sleep(1200);
  return last;
}

/** The raider attacks until my capital falls. Returns the capital event, or null. */
export async function assault(g, inject, maxLoops = 1500) {
  const victimId = await g.ev(`window.__pl[window.__cid].id`);
  const foeTroops = (await stats(g, "p2")).troops;
  for (let i = 0; i < maxLoops; i++) {
    if (i % 25 === 0) {
      await inject("window.__p2", {
        type: "attack",
        targetID: victimId,
        troops: Math.floor(foeTroops * 0.95),
      });
    }
    await sleep(80);
    const ev = await g.J(
      `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
    );
    if (ev) return ev;
  }
  return null;
}

/** Stop the raider's outgoing attacks (so that I keep the land I have left). */
export async function callOffRaider(g, inject) {
  const f = await foe(g);
  for (const a of (f && f.out) || []) {
    await inject("window.__p2", { type: "cancel_attack", attackID: a.id });
  }
}

/** The raider keeps spending its troops on unclaimed land: its home army stays thin. */
export const keepRaiderBusy = (g) =>
  g.ev(
    `(()=>{ if(window.__atkLoop) clearInterval(window.__atkLoop); window.__atkLoop=setInterval(()=>{ window.__inject=(window.__inject||[]).concat([{clientID: window.__p2, type:'attack', targetID:null, troops:null}]); }, 700); return 1})()`,
  );
