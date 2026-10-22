// Two real clients through the real game server (plan rows 6.4 to 6.6, and the orders over the wire).
//
//   scripts/playtest/stack.sh node scripts/playtest/multiclient.mjs
//
// A creates a private lobby from the real Create Lobby screen, B joins it by the
// link, A starts the match; both pick spawns and grow with real map clicks. A then
// takes B's capital with a real attack. After that, with real clicks (and the
// client's own transport for the orders the UI would not offer):
//   B: intelligence, a base, a recruit      A: Suppress (two steps)
//   B: an uprising and a replacement capital (refused: nothing to do it from)
// B then reloads its page in the middle of the CRISIS (and A its own later). At
// every point the two clients' state hashes (the engine reports one every 10
// ticks) are compared, and the real server's log is scanned for desync lines.
//
// Needs a server running current code (the private stack is one). Takes about 8 minutes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, URL_BASE, reporter, sleep } from "./game.mjs";
import { launch } from "./lib.mjs";

const HOOKS =
  "try{localStorage.setItem('settings.tutorialDismissed','true')}catch(e){}\n" +
  readFileSync(new URL("./hooks.js", import.meta.url), "utf8");
const R = reporter("two clients through the real server");
const { check, note } = R;
const SPAWN = { A: { x: 453, y: 553 }, B: { x: 462, y: 553 } };

async function client(name) {
  const b = await launch({ width: 1280, height: 800 });
  await b.send("Page.enable");
  await b.send("Runtime.enable");
  await b.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOKS });
  const J = async (expr, ms = 15000) => {
    const r = await b.ev(
      `JSON.stringify(${expr}, (k,v)=>typeof v==='bigint'?String(v):v)`,
      ms,
    );
    if (typeof r !== "string") return r;
    try {
      return JSON.parse(r);
    } catch {
      return r;
    }
  };
  const load = async (url) => {
    await b.send("Page.navigate", { url });
    await sleep(2500);
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const r = await b.ev(
        `document.readyState==='complete' && !!document.querySelector('game-mode-selector')`,
      );
      if (r === true) break;
    }
    await sleep(2000);
    await b.clickAt(100, 100);
  };
  const clickText = async (sel, text) => {
    const r = await b.ev(
      `(()=>{ const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>((e.textContent||'').replace(/\\s+/g,' ').trim()).toLowerCase().includes(${JSON.stringify(text.toLowerCase())})); const el=els.sort((a,b)=>a.textContent.length-b.textContent.length)[0]; if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    );
    if (!r || r.error) return false;
    await b.clickAt(r.x, r.y);
    return true;
  };
  const click = async (sel, o = {}) => {
    const r = await b.ev(
      `(()=>{ const el=document.querySelectorAll(${JSON.stringify(sel)})[${o.nth ?? 0}]; if(!el) return null; el.scrollIntoView?.({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width*${o.fx ?? 0.5}, y:r.top+r.height*${o.fy ?? 0.5}, dis: !!el.disabled}})()`,
    );
    if (!r || r.error || r.dis) return false;
    await b.clickAt(r.x, r.y);
    return true;
  };
  const text = (sel) =>
    b.ev(
      `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return e? e.textContent.replace(/\\s+/g,' ').trim(): null})()`,
    );
  const inGame = async () =>
    (await b.ev(`!!((document.querySelector('capital-markers')||{}).game)`)) ===
    true;
  const tile = (x, y) =>
    J(
      `(()=>{ const th=document.querySelector('capital-markers').transformHandler; return th.worldToScreenCoordinates({x:${x},y:${y}}) })()`,
    );
  return { name, b, J, load, clickText, click, text, inGame, tile };
}

const waitUntil = async (cond, ms, every = 500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await cond();
    if (v) return v;
    await sleep(every);
  }
  return null;
};

// a random unclaimed land tile touching my land (within 40 tiles of my capital), as a screen point
const pickJS = () => `(()=>{
  const cm=document.querySelector('capital-markers'); const game=cm.game, th=cm.transformHandler; const me=game.myPlayer().smallID();
  const W=game.width(), H=game.height(); const cap=game.myPlayer().capitalTile(); const cx=cap%W, cy=Math.floor(cap/W);
  for(let k=0;k<600;k++){
    const x=Math.round(cx+(Math.random()*2-1)*40), y=Math.round(cy+(Math.random()*2-1)*40);
    if(x<1||y<1||x>=W-1||y>=H-1) continue; const t=game.ref(x,y); if(!game.isLand(t)||game.ownerID(t)!==0) continue;
    let adj=false; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) if(game.ownerID(game.ref(x+dx,y+dy))===me) adj=true; if(!adj) continue;
    const s=th.worldToScreenCoordinates({x,y}); if(s.x<20||s.x>innerWidth-20||s.y<150||s.y>innerHeight-150) continue; return {x:s.x,y:s.y};
  }
  return null; })()`;
// the opponent's tile nearest its capital that touches my land, as a screen point
const borderJS = `(()=>{
  const cm=document.querySelector('capital-markers'); const game=cm.game, th=cm.transformHandler; const me=game.myPlayer().smallID();
  const foe = me===1?2:1; const W=game.width(), H=game.height();
  const cap=game.players().find(p=>p.smallID()===foe).capitalTile(); const cx=cap%W, cy=Math.floor(cap/W);
  let best=null, bd=1e9;
  for(let y=cy-40;y<=cy+40;y++) for(let x=cx-40;x<=cx+40;x++){
    if(x<1||y<1||x>=W-1||y>=H-1) continue; const t=game.ref(x,y); if(game.ownerID(t)!==foe) continue;
    let adj=false; for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) if(game.ownerID(game.ref(x+dx,y+dy))===me) adj=true; if(!adj) continue;
    const d=(x-cx)**2+(y-cy)**2; if(d<bd){bd=d;best={x,y};}
  }
  if(!best) return null; return th.worldToScreenCoordinates(best); })()`;
// the opponent's tile nearest the middle of a region, as a screen point
const foeTileJS = (region) => `(()=>{
  const cm=document.querySelector('capital-markers'); const game=cm.game, th=cm.transformHandler;
  const W=game.width(), H=game.height(); const cols=Math.ceil(W/32); const row=Math.floor(${region}/cols), col=${region}%cols; const x0=col*32,y0=row*32;
  const foe=game.myPlayer().smallID()===1?2:1; let best=null, bd=1e9;
  for(let y=y0;y<Math.min(H,y0+32);y++) for(let x=x0;x<Math.min(W,x0+32);x++){ const t=game.ref(x,y); if(!game.isLand(t)||game.ownerID(t)!==foe) continue; const d=(x-x0-16)**2+(y-y0-16)**2; if(d<bd){bd=d;best={x,y};} }
  if(!best) return null; return th.worldToScreenCoordinates(best); })()`;
const resistanceOf2 = `(()=>{ const v=(window.__ins||{})[2]; if(!v) return null; return {tick: window.__lastTick, phase:v.phase, funds:v.funds, avail:v.available, pend:v.pending, bases:v.bases, ops:v.operations, intel:v.intel, sup:v.suppressions, reclaimed:v.reclaimed, deadline:v.deadline, limbo:v.limboDeadline, regions:v.regions.map(r=>[r.id,r.status,r.band,r.hasBase?1:0,r.suppressed?1:0]), msgs:(window.__msgs||[]).filter(m=>/insurgency|capital/.test(m.m)).map(m=>[m.tick,m.m,m.pid])}; })()`;

const A = await client("A");
const B = await client("B");
const clients = { A, B };

/** Both clients' state hashes over the ticks they share. */
async function compareHashes(label) {
  const [a, b] = await Promise.all([
    A.J(`window.__hash||{}`, 30000),
    B.J(`window.__hash||{}`, 30000),
  ]);
  const common = Object.keys(a).filter((t) => t in b);
  const differing = common.filter((t) => a[t] !== b[t]);
  check(
    `${label}: the two clients' state hashes agree at every shared tick`,
    common.length > 20 && differing.length === 0,
    `${common.length} shared ticks (${common[0]}..${common[common.length - 1]}), ${differing.length} differ ${differing.slice(0, 4)}`,
  );
  return common.length;
}
// The resistance of B as each client sees it: the same state, sampled a tick or two
// apart, so only the purse (income moves into it every tick) is compared with a margin.
const same = async (label) => {
  const [a, b] = await Promise.all([A.J(resistanceOf2), B.J(resistanceOf2)]);
  const bare = (x) => (x ? { ...x, tick: 0, funds: 0 } : x);
  const funds = Math.abs(Number(a?.funds) - Number(b?.funds));
  check(
    `${label}: both clients see the same resistance state`,
    JSON.stringify(bare(a)) === JSON.stringify(bare(b)) && funds <= 600,
    `${JSON.stringify(bare(a)).slice(0, 220)} (purse ${a?.funds} / ${b?.funds})`,
  );
  return a;
};

try {
  // ---- a lobby, joined, started
  await A.load(URL_BASE);
  await A.clickText("button", "Create Lobby");
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    await sleep(700);
    const v = await A.b.ev(
      `(document.querySelector('host-lobby-modal')||{}).lobbyId`,
    );
    if (typeof v === "string" && v.length >= 8) id = v;
  }
  await sleep(2500);
  const url = await A.b.ev(`location.href`);
  check(
    "1 the host creates a private lobby on the real server",
    !!id,
    `${id} ${url}`,
  );
  // a small, quick match: Antarctica (compact), no tribes, no nations, instant build, 400K starting
  // gold on top of the grant (v0.8.0: a capital is bought, for 500K)
  await A.b.ev(
    `(()=>{ const m=document.querySelector('host-lobby-modal'); m.selectedMap='Antarctica'; m.compactMap=true; m.bots=0; m.nations=0; m.instantBuild=true; m.startingGold=true; m.startingGoldValue=0.4; m.putGameConfig(); return 1 })()`,
  );
  await sleep(2500);
  await B.load(url);
  const lobbyText = await B.text("join-lobby-modal");
  check(
    "2 the joiner is in the lobby by its link and sees the Capital System among the settings",
    /CAPITAL SYSTEM/i.test(lobbyText ?? "") &&
      /2 PLAYERS/i.test(lobbyText ?? ""),
    String(lobbyText).slice(0, 200),
  );
  await A.clickText("host-lobby-modal o-button", "Start Game");
  check(
    "3 the match starts on both clients",
    !!(await waitUntil(
      async () => (await A.inGame()) && (await B.inGame()),
      60000,
      500,
    )),
    "",
  );
  // the camera is still settling when the match opens: click again until the spawn took
  const spawned = async (c) =>
    (await c.b.ev(
      `(()=>{ const p=document.querySelector('capital-markers').game.myPlayer(); return !!p && p.hasSpawned() })()`,
    )) === true;
  for (const c of [A, B]) {
    for (let attempt = 0; attempt < 8 && !(await spawned(c)); attempt++) {
      await sleep(2500);
      const s = await c.tile(SPAWN[c.name].x, SPAWN[c.name].y);
      await c.b.clickAt(s.x, s.y);
      await sleep(1500);
    }
  }
  // v0.8.0: nobody starts with a capital. Each client buys one with real clicks: the
  // panel's button, then a tile of its own land (its spawn), as a player would.
  const buyCapital = async (c) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const has = await c.b.ev(
        `(()=>{ const p=document.querySelector('capital-markers').game.myPlayer(); return !!p && p.hasCapital() })()`,
      );
      if (has === true) return true;
      const r = await c.J(
        `(()=>{ const b=document.querySelector('capital-action [data-capital-action]'); if(!b||b.disabled) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`,
      );
      if (r) {
        await c.b.clickAt(r.x, r.y);
        await sleep(700);
        const s = await c.tile(SPAWN[c.name].x, SPAWN[c.name].y);
        await c.b.clickAt(s.x, s.y);
      }
      await sleep(2500);
    }
    return false;
  };
  const bought = await Promise.all([buyCapital(A), buyCapital(B)]);
  check(
    "4a both buy a capital with real clicks: the panel's button, then their own land",
    bought.every(Boolean),
    JSON.stringify(bought),
  );
  const capitals = await waitUntil(
    async () => {
      const a = await A.J(
        `Object.values(window.__pl||{}).map(p=>p.capitalTile)`,
      );
      return Array.isArray(a) && a.length === 2 && a.every((t) => t >= 0)
        ? a
        : null;
    },
    90000,
    2000,
  );
  check(
    "4 both pick a spawn with a real click and both capitals stand, the same on both clients",
    !!capitals,
    JSON.stringify(capitals),
  );
  if (!capitals) throw new Error("no capitals: the match did not get going");

  // ---- grow with real map clicks (A westwards, B eastwards)
  // A keeps growing after B stops (a bigger land holds a bigger army), until its all-in attack can win
  for (let k = 0; k < 140; k++) {
    for (const [c, dir] of [
      [A, -1],
      [B, 1],
    ]) {
      if (c === B && k >= 10) continue;
      const p = await c.J(pickJS());
      if (p && p.x !== undefined) await c.b.clickAt(p.x, p.y);
    }
    await sleep(1200);
    if (k > 10 && k % 5 === 0) {
      const s = await A.J(`window.__stats`);
      if (
        s &&
        s[1] &&
        s[2] &&
        s[1].troops >= 1.4 * s[2].troops &&
        s[1].tiles >= 1500
      )
        break;
    }
  }
  const st = await A.J(`window.__stats`);
  note("after growing: " + JSON.stringify(st));
  await compareHashes("before the fight");

  // ---- A takes B's capital
  await A.click("control-panel input[type=range]", { nth: 0, fx: 0.97 });
  let cap = null;
  for (let k = 0; k < 14 && !cap; k++) {
    const p = await A.J(borderJS);
    if (p && p.x !== undefined) await A.b.clickAt(p.x, p.y);
    await sleep(2000);
    cap = await A.J(
      `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
    );
  }
  check(
    "5 A captures B's capital with a real attack",
    cap && cap.captor === 1 && cap.owner === 2,
    JSON.stringify(cap),
  );
  if (!cap) throw new Error("no capture: stopping");
  await sleep(6000);
  const capB = await B.J(
    `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
  );
  check(
    "5b both clients saw the same capture, with the same reward and CRISIS end",
    JSON.stringify(capB) === JSON.stringify(cap) ||
      (capB &&
        cap &&
        capB.tick === cap.tick &&
        capB.gold === cap.gold &&
        capB.troops === cap.troops &&
        capB.crisisEnd === cap.crisisEnd),
    `${JSON.stringify(cap)} / ${JSON.stringify(capB)}`,
  );
  const view = async (c) => ({
    rec: await c.J(`[...new Set((window.__rec||[]).map(f=>f.ph))].join('>')`),
    aud: await c.J(
      `window.__log.filter(l=>l.k==='audio-start').map(l=>[l.v.tick,l.v.dur])`,
    ),
    resist: !!(await c.text('[data-rc="mine"]')),
    occupier: !!(await c.text('[data-rc="occupier"]')),
  });
  const va = await view(A),
    vb = await view(B);
  check(
    "6 the defender (B) gets the CRISIS announcement and the resistance panel; the captor (A) the occupier's panel",
    vb.rec === "announce>docking>active" && vb.resist && va.occupier && !va.rec,
    JSON.stringify({
      B: vb.rec,
      bPanel: vb.resist,
      aOccupier: va.occupier,
      aRec: va.rec,
    }),
  );
  check(
    "6b the captor hears the capture cues at the fall, the defender its own cue",
    va.aud.some(
      ([t, d]) => Math.abs(d - 2.58) < 0.06 && Math.abs(t - cap.tick) <= 3,
    ) &&
      vb.aud.some(
        ([t, d]) => Math.abs(d - 3.39) < 0.06 && Math.abs(t - cap.tick) <= 3,
      ),
    `A ${JSON.stringify(va.aud.slice(-3))} B ${JSON.stringify(vb.aud.slice(-3))}`,
  );
  await same("after the capture");

  // ---- B's orders with real clicks
  const before = await B.J(resistanceOf2);
  await B.click('[data-order="intel"]');
  await sleep(900);
  await B.click('[data-form="intel"] [data-rc="confirm"]');
  await sleep(2500);
  let now = await same("after intelligence");
  check(
    "7 B's intelligence cost 10,000 and returned a report",
    now &&
      before &&
      Number(before.funds) - Number(now.funds) >= 9000 &&
      now.intel.length === 1,
    `${before && before.funds} -> ${now && now.funds}, ${JSON.stringify(now && now.intel)}`,
  );
  // a base in a restless region
  const restless = (now.regions
    .filter((r) => r[1] === 1 && r[2] >= 1)
    .sort((x, y) => y[2] - x[2])[0] ?? [])[0];
  note("restless region " + restless);
  if (restless !== undefined) {
    await B.click('[data-order="base"]');
    await sleep(900);
    await B.click(`.rc-region[data-region="${restless}"] .go`);
    await sleep(3500);
    const p = await B.J(foeTileJS(restless));
    if (p && p.x !== undefined) await B.b.clickAt(p.x, p.y);
    await sleep(1000);
    const form = await B.text('[data-form="base"]');
    await B.click('[data-form="base"] [data-rc="confirm"]');
    await sleep(2500);
    now = await same("after the base");
    check(
      "8 B founds a base with real clicks (50,000)",
      /Found a base|Set up a hideout/.test(form ?? "") &&
        now.bases.length === 1,
      `${form} ${JSON.stringify(now.bases)}`,
    );
    // a recruit (needs a place to gather: the base)
    await B.click('[data-order="recruit"]');
    await sleep(900);
    await B.click('[data-form="recruit"] input[type=range]', { fx: 0.4 });
    await sleep(600);
    await B.click('[data-form="recruit"] [data-rc="confirm"]');
    await sleep(2500);
    now = await same("after the recruit");
    check(
      "9 B recruits (it arrives after 30 s on both clients)",
      now.pend.length === 1,
      JSON.stringify(now.pend),
    );
  } else {
    note(
      "no restless region to found a base in; skipping the base and the recruit",
    );
  }
  // A suppresses (two steps), over the wire
  await A.click('[data-rc="suppress"]');
  await sleep(700);
  const armed = await A.text('[data-rc="suppress"]');
  await A.click('[data-rc="suppress"]');
  await sleep(3000);
  now = await same("after the suppression");
  check(
    "10 A's Suppress (two clicks) reaches the server and both clients run it",
    /Click again/i.test(armed ?? "") && now.sup.length === 1,
    `${armed} ${JSON.stringify(now.sup)}`,
  );
  check(
    "10b the resistance is told",
    now.msgs.some(([, m, pid]) => /insurgency_suppressed/.test(m) && pid === 2),
    JSON.stringify(now.msgs.slice(-3)),
  );
  // the orders the interface would not offer, through the client's own transport
  for (const [label, send, answer] of [
    [
      "an uprising where nothing allows one",
      `new m.SendResistanceUprisingIntentEvent(574, 5000)`,
      /insurgency_reject_/,
    ],
    [
      "a replacement capital with no land",
      `new m.SendFoundCapitalIntentEvent(612071)`,
      /capital_found_|capital_order/,
    ],
  ]) {
    const got = await B.b.ev(
      `(async()=>{ const m = await import('/src/client/Transport.ts'); const rc=document.querySelector('resistance-command'); const n0=(window.__msgs||[]).length; rc.eventBus.emit(${send}); await new Promise(r=>setTimeout(r,2500)); return JSON.stringify((window.__msgs||[]).slice(n0).map(x=>x.m)) })()`,
      20000,
    );
    const onA = await A.J(`(window.__msgs||[]).slice(-3).map(x=>x.m)`);
    check(
      `11 ${label}, sent through the real transport, is answered, the same on both clients`,
      answer.test(String(got)) && onA.some((x) => answer.test(x)),
      `${got} / ${JSON.stringify(onA)}`,
    );
  }
  await compareHashes("with orders in flight");

  // ---- B reloads in the middle of the CRISIS
  const tBefore = await B.J(`window.__lastTick`);
  await B.b.send("Page.reload", {});
  const back = await waitUntil(
    async () =>
      (await B.inGame()) &&
      (await B.J(
        `(()=>{const g=document.querySelector('capital-markers').game; return !g.isCatchingUp()})()`,
      )),
    90000,
    1000,
  );
  check("12 B's reload rejoins the running match and catches up", !!back, "");
  await sleep(3000);
  const tA = await A.J(`window.__lastTick`),
    tB = await B.J(`window.__lastTick`);
  check(
    "12b it is back within a few ticks of A",
    Math.abs(tA - tB) <= 12 && tB > tBefore,
    `A ${tA}, B ${tB}, B before ${tBefore}`,
  );
  const dock = await B.J(
    `(()=>{const r=document.querySelector('crisis-overlay')?.shadowRoot; const d=r&&r.querySelector('.dock'); return d? {ph:d.dataset.crisisPhase, lvl:d.dataset.crisisLevel, time:(r.querySelector('.time')||{}).textContent}: null})()`,
  );
  const secs = (s) => (s ? +s.split(":")[0] * 60 + +s.split(":")[1] : -1);
  check(
    "12c the CRISIS indicator is right after the reload (the match's time, no announcement)",
    dock &&
      dock.ph === "active" &&
      Math.abs(secs(dock.time) - Math.ceil((cap.crisisEnd - tB) / 10)) <= 1,
    JSON.stringify(dock),
  );
  const phasesB = await B.J(`[...new Set((window.__rec||[]).map(f=>f.ph))]`);
  const audB = await B.J(
    `window.__log.filter(l=>l.k==='audio-start').map(l=>[l.v.tick,l.v.dur])`,
  );
  check(
    "12d nothing is replayed as if it were live: no announcement, no 'capital lost' cue",
    !phasesB.includes("announce") &&
      !audB.some(([, d]) => Math.abs(d - 3.39) < 0.06),
    `${JSON.stringify(phasesB)} ${JSON.stringify(audB)}`,
  );
  check(
    "12e B's panel is back with the state it had",
    !!(await B.text('[data-rc="mine"]')),
    "",
  );
  await same("after B's reload");
  await compareHashes(
    "after B's reload (B replayed the whole match from the server's turns)",
  );
  // a menu does not pause a real match
  const m0 = await B.J(
    `[window.__lastTick, (document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.time')||{}).textContent]`,
  );
  await B.click('img[alt="settings"]');
  await sleep(5000);
  const m1 = await B.J(
    `[window.__lastTick, (document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.time')||{}).textContent]`,
  );
  await B.b.key("Escape", "Escape", 27);
  check(
    "13 with a menu open in a real match the ticks and the CRISIS time run on",
    m1[0] - m0[0] >= 35 && secs(m0[1]) - secs(m1[1]) >= 3,
    `ticks ${m0[0]} -> ${m1[0]}, time ${m0[1]} -> ${m1[1]}`,
  );

  // ---- the end of the CRISIS, and A's own reload
  await waitUntil(
    async () => (await B.J(`window.__lastTick`)) >= cap.crisisEnd + 5,
    200000,
    2000,
  );
  const T = await B.J(`window.__timer||[]`);
  const over = T.find((r) => r.ph === "over");
  check(
    "14 the CRISIS ends on both clients' clocks at its end tick",
    over && over.time === "00:00" && Math.abs(over.tick - cap.crisisEnd) <= 3,
    JSON.stringify(over && [over.tick, over.time, over.status]),
  );
  await A.b.send("Page.reload", {});
  await waitUntil(
    async () =>
      (await A.inGame()) &&
      (await A.J(
        `(()=>{const g=document.querySelector('capital-markers').game; return !g.isCatchingUp()})()`,
      )),
    90000,
    1000,
  );
  await sleep(4000);
  const audA = await A.J(
    `window.__log.filter(l=>l.k==='audio-start').map(l=>[l.v.tick,l.v.dur])`,
  );
  check(
    "15 the captor's reload does not replay the capture's cues",
    !audA.some(
      ([, d]) => Math.abs(d - 2.58) < 0.06 || Math.abs(d - 0.59) < 0.06,
    ),
    JSON.stringify(audA),
  );
  await compareHashes("after A's reload");

  // ---- the real server's own verdict
  let log = "";
  try {
    log = readFileSync(
      join(OUT, `${process.env.PLAYTEST_LOGTAG ?? "stack"}-server.log`),
      "utf8",
    );
  } catch {
    note("no server log to read (run through stack.sh to get one)");
  }
  if (log) {
    const desync = log.split("\n").filter((l) => /desync/i.test(l));
    const warn = log
      .split("\n")
      .filter((l) => /"level":"(warn|error)"/.test(l));
    check(
      "16 the real server's log has no desync line and no warning or error",
      desync.length === 0 && warn.length === 0,
      `${desync.length} desync, ${warn.length} warn/error ${warn.slice(0, 2).join(" | ").slice(0, 200)}`,
    );
  }
  const errsA = await A.J(
    `window.__log.filter(l=>l.k==='error'||l.k==='rejection')`,
  );
  const errsB = await B.J(
    `window.__log.filter(l=>l.k==='error'||l.k==='rejection')`,
  );
  check(
    "17 no page errors on either client",
    (errsA || []).length === 0 && (errsB || []).length === 0,
    JSON.stringify([errsA, errsB]).slice(0, 200),
  );
} catch (e) {
  console.log("ERR", e.stack || e.message);
  process.exitCode = 1;
}
R.summary();
for (const c of Object.values(clients)) c.b.close();
process.exit(process.exitCode ?? 0);
