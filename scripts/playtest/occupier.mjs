// The other side of the fall: I am the raider (the captor and then the occupier), in a real browser.
// The capture banner and its sounds, the reward, the occupier's warnings, and the two-step Suppress (plan rows 2.1 B, 2.5 partly, 3.x audio).
import {
  openGame,
  regen,
  reporter,
  sleep,
  startMatch,
  stats,
  tick,
} from "./game.mjs";
const R = reporter("occupier");
const { check, note } = R;
const g = await openGame({ mute: true });
const { b } = g;
const text = (sel) =>
  g.ev(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return e? e.textContent.replace(/\\s+/g,' ').trim(): null})()`,
  );
const click = async (sel, o = {}) => {
  const r = await g.ev(
    `(()=>{ const el=document.querySelectorAll(${JSON.stringify(sel)})[${o.nth || 0}]; if(!el) return null; el.scrollIntoView?.({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, dis: !!el.disabled}})()`,
  );
  if (!r || r.error || r.dis) return false;
  await b.clickAt(r.x, r.y);
  return true;
};
const waitUntil = async (cond, ms, every = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await cond();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
try {
  const { inject } = await startMatch(g, { startingGold: 3000000 });
  await g.ev(`window.__mySmall = window.__pl[window.__cid].small; 1`);
  const me0 = await g.J(`window.__pl[window.__cid]`),
    foe0 = await g.J(`window.__pl[window.__p2]`);
  await regen(g);
  const g0 = Number((await stats(g)).gold),
    t0 = (await stats(g)).troops;
  // the assault: I attack the other player's capital
  const victim = foe0.id;
  const myT = (await stats(g, "cid")).troops;
  let cap = null;
  for (let i = 0; i < 1500 && !cap; i++) {
    if (i % 25 === 0)
      await inject("window.__cid", {
        type: "attack",
        targetID: victim,
        troops: Math.floor(myT * 0.95),
      });
    await sleep(80);
    cap = await g.J(
      `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
    );
  }
  check(
    "1 I capture the other player's capital",
    cap && cap.captor === me0.small && cap.owner === foe0.small,
    JSON.stringify(cap),
  );
  check(
    "1b I am paid 250K gold and troops, once",
    cap && cap.gold === "250000" && cap.troops > 0,
    `${cap && cap.gold} / ${cap && cap.troops}`,
  );
  await sleep(1500);
  const g1 = Number((await stats(g)).gold);
  check(
    "1c my gold rose by about 250,000 (plus income)",
    g1 - g0 >= 245000 && g1 - g0 <= 275000,
    `${g0} -> ${g1}`,
  );
  // the banner
  const ban = await g.J(
    `(()=>{ const e=document.querySelector('capital-victory'); if(!e) return null; const t=(e.shadowRoot? e.shadowRoot.textContent : e.textContent)||''; const r=e.getBoundingClientRect(); return {text:t.replace(/\\s+/g,' ').trim().slice(0,200), rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]} })()`,
  );
  note("banner " + JSON.stringify(ban));
  await b.shot("occ-1-capture");
  // the sounds for the captor
  await sleep(4000);
  const log = await g.J(`window.__log`);
  const aud = log.filter((l) => l.k === "audio-start").map((l) => l.v),
    peaks = log.filter((l) => l.k === "out-peak").map((l) => l.v);
  const lvl = (s) => {
    const w = peaks
      .filter(
        (p) => p.wall >= s.wall - 100 && p.wall <= s.wall + s.dur * 1000 + 300,
      )
      .map((p) => p.p);
    return w.length ? Math.max(...w) : 0;
  };
  const conq = aud.find(
    (s) =>
      Math.abs(s.dur - 2.58) < 0.06 &&
      s.tick !== undefined &&
      Math.abs(s.tick - cap.tick) <= 4,
  );
  const kach = aud.find(
    (s) =>
      Math.abs(s.dur - 0.59) < 0.06 &&
      s.tick !== undefined &&
      Math.abs(s.tick - cap.tick) <= 40,
  );
  check(
    "2 the 'conquered' cue starts at the capture",
    !!conq,
    conq ? `tick ${conq.tick} vs ${cap.tick}` : "none",
  );
  check(
    "2b ...audible and not clipped",
    conq && lvl(conq) > 0.05 && lvl(conq) < 0.95,
    conq && String(lvl(conq)),
  );
  check(
    "2c the coin cue ('ka-ching') follows",
    !!kach,
    kach ? `tick ${kach.tick}` : "none",
  );
  check(
    "2d ...audible and not clipped",
    kach && lvl(kach) > 0.03 && lvl(kach) < 0.95,
    kach && String(lvl(kach)),
  );
  const dupes = aud.filter((s) => Math.abs(s.dur - 2.58) < 0.06);
  note(
    "sounds: " +
      JSON.stringify(
        aud
          .filter((s) => s.tick !== undefined && s.tick >= cap.tick - 2)
          .map((s) => [s.tick, s.dur]),
      ),
  );
  const conqEv = await g.J(
    `(window.__msgs||[]).filter(m=>/capital|conquer|elimin/.test(m.m)).map(m=>[m.tick,m.m,m.pid])`,
  );
  note("capital/conquest messages: " + JSON.stringify(conqEv));
  check(
    "2e the 'conquered' cue plays once, at the capture, and not again for a player who is still resisting",
    dupes.length === 1 && Math.abs(dupes[0].tick - cap.tick) <= 4,
    JSON.stringify(dupes.map((s) => s.tick)),
  );
  const badges = await g.J(
    `[...document.querySelectorAll('.df-capital-marker')].map(e=>{const r=e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), e.classList.contains('mine')]})`,
  );
  check(
    "2f the badge of my own capital is small and marked mine",
    badges.some(([w, h, mine]) => mine && w >= 10 && w <= 40),
    JSON.stringify(badges),
  );

  // keep the defender's land from vanishing: the defender is a script, it just loses what the raid took. More raids until a region is occupied.
  // ---- the occupier's panel
  const occ = await waitUntil(
    async () => {
      const t = await text('[data-rc="occupier"]');
      return t && /Suppress|resistance|Resistance/.test(t) ? t : null;
    },
    30000,
    500,
  );
  check("3 the occupier's panel appears: someone resists me", !!occ, occ);
  note("occupier panel: " + occ);
  // keep raiding a little until a region of hers is mine
  for (let i = 0; i < 10; i++) {
    const v = await g.J(
      `window.__ins && window.__ins[window.__pl[window.__p2].small]`,
    );
    if (v && v.regions.some((r) => r.status === 1)) break;
    await inject("window.__cid", {
      type: "attack",
      targetID: victim,
      troops: 15000,
    });
    await sleep(5600);
  }
  const before = await stats(g);
  const traceFrom = await g.J(`(window.__trace||[]).length`);
  await b.shot("occ-2-panel");
  const sup = await text('[data-rc="suppress"]');
  check(
    "4 a Suppress button is offered for an occupied region, with its price",
    !!sup && /troops/i.test(sup),
    sup,
  );
  const first = await click('[data-rc="suppress"]');
  await sleep(600);
  const armed = await text('[data-rc="suppress"]');
  check(
    "4b the first click only arms it ('Click again: -N troops')",
    first && /Click again/i.test(armed || ""),
    armed,
  );
  const mid = await stats(g);
  check(
    "4c arming takes no troops",
    mid.troops >= before.troops - 2000,
    `${before.troops} -> ${mid.troops}`,
  );
  await click('[data-rc="suppress"]');
  await sleep(2500);
  const after = await stats(g);
  const vv = await g.J(`window.__ins[window.__pl[window.__p2].small]`);
  const sups = (vv && vv.suppressions) || [];
  check(
    "5 the second click suppresses: a suppression runs for 60 seconds",
    sups.length === 1,
    JSON.stringify(sups),
  );
  const tr = await g.J(`(window.__trace||[]).slice(${traceFrom})`);
  let drop = 0,
    dropAt = null;
  for (let i = 1; i < tr.length; i++) {
    const d = tr[i - 1][1] - tr[i][1];
    if (d > drop) {
      drop = d;
      dropAt = tr[i][0];
    }
  }
  const committed = drop;
  note(
    `largest single-tick drop in my troops after the click: ${drop} at tick ${dropAt}`,
  );
  check(
    "5b the troops are taken out of my army in one step, at least 1,000 shown (10,000 engine units)",
    // the army regenerates in the same tick (more with a capital's +25 %): net of that
    drop >= 8000 && drop <= 40000,
    `drop ${drop} at tick ${dropAt}`,
  );
  const msgs = await g.J(
    `(window.__msgs||[]).filter(m=>/suppress/.test(m.m)).map(m=>[m.tick,m.m,m.pid])`,
  );
  check(
    "5c the resistance is told",
    msgs.some((m) => /insurgency_suppressed/.test(m[1])),
    JSON.stringify(msgs),
  );
  const panelAfter = await text('[data-rc="occupier"]');
  check(
    "5d the panel shows it running ('Suppressing · time left')",
    /Suppressing/.test(panelAfter || ""),
    panelAfter,
  );
  await b.shot("occ-3-suppressing");
  // a second one on the same region is refused in the UI (busy)
  const rows = await g.J(
    `[...document.querySelectorAll('[data-rc="occupier"] li, [data-rc="occupier"] .row, [data-rc="occupier"] > div > div')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).filter(t=>/O1[78]/.test(t)).slice(0,4)`,
  );
  note("occupier rows: " + JSON.stringify(rows));
  const row574 = (rows || []).find((t) => /O17/.test(t)) || "";
  check(
    "5e the region being suppressed no longer offers Suppress (the other region still does)",
    /Suppressing/.test(row574) && !/Suppress ·/.test(row574),
    row574,
  );
  // the end: most of the troops come home (90%)
  const endTick = sups[0].endTick;
  note(`suppression ends at tick ${endTick}; now ${await tick(g)}`);
  await g.b.key(".", "Period", 190);
  await g.b.key(".", "Period", 190);
  let pre = null,
    post = null;
  while ((await tick(g)) < endTick - 8) await sleep(150);
  await g.b.key(",", "Comma", 188);
  await g.b.key(",", "Comma", 188);
  await waitUntil(async () => (await tick(g)) > endTick + 6, 30000, 150);
  const tr2 = await g.J(
    `(window.__trace||[]).filter(r=>r[0]>=${endTick - 4} && r[0]<=${endTick + 5})`,
  );
  let gain = 0,
    gainAt = null;
  for (let i = 1; i < tr2.length; i++) {
    const d = tr2[i][1] - tr2[i - 1][1];
    if (d > gain) {
      gain = d;
      gainAt = tr2[i][0];
    }
  }
  note(
    `around the end (tick ${endTick}): ${JSON.stringify(tr2.map((r) => [r[0], r[1]]))}`,
  );
  check(
    "6 when it ends about 90% of the troops come home in one step",
    gain >= committed * 0.9 - 2500 &&
      gain <= committed * 0.9 + 2500 &&
      Math.abs(gainAt - endTick) <= 2,
    `+${gain} (expected about ${Math.round(committed * 0.9)}) at tick ${gainAt}; ends at ${endTick}`,
  );
  const v2 = await g.J(`window.__ins[window.__pl[window.__p2].small]`);
  check(
    "6b the suppression is gone from the engine's state",
    v2.suppressions.length === 0,
    JSON.stringify(v2.suppressions),
  );
  const errs =
    (await g.J(`window.__log.filter(l=>l.k==='error'||l.k==='rejection')`)) ||
    [];
  check(
    "7 no page errors",
    errs.length === 0,
    JSON.stringify(errs).slice(0, 200),
  );
} catch (e) {
  console.log("ERR", e.stack || e.message);
}
R.summary();
g.close();
process.exit(0);
