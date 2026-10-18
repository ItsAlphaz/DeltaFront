// The match ends while a CRISIS and a resistance are running (plan row 6.2, browser part): everything stands down, nothing breaks.
import {
  assault,
  callOffRaider,
  keepRaiderBusy,
  openGame,
  regen,
  reporter,
  sleep,
  startMatch,
  stats,
  tick,
  view,
} from "./game.mjs";
const R = reporter("match end during a CRISIS and a resistance");
const { check, note } = R;
const g = await openGame({});
const { b } = g;
const text = (sel) =>
  g.ev(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return e? e.textContent.replace(/\\s+/g,' ').trim(): null})()`,
  );
const click = async (sel) => {
  const r = await g.ev(
    `(()=>{ const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, dis: !!el.disabled}})()`,
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
  const { inject } = await startMatch(g, {
    startingGold: 3000000,
    extra: { maxTimerValue: 3 },
  });
  await regen(g);
  const cap = await assault(g, inject);
  check(
    "1 the capital falls",
    cap && cap.kind === "captured",
    JSON.stringify(cap),
  );
  await callOffRaider(g, inject);
  await keepRaiderBusy(g);
  const victim = await g.ev(`window.__pl[window.__cid].id`);
  for (let i = 0; i < 14; i++) {
    const v = await view(g);
    const t = (await stats(g)).tiles;
    if (v && v.regions.some((r) => r.status === 1) && t >= 100) break;
    if (t < 100) {
      note(`the occupation overshot: ${t} tiles left`);
      break;
    }
    await inject("window.__p2", {
      type: "attack",
      targetID: victim,
      troops: 12000,
    });
    await sleep(5600);
  }
  await callOffRaider(g, inject);
  await sleep(1500);
  // a recruit that cannot arrive before the match ends (it takes 30 s)
  const now = await tick(g);
  note(`tick ${now}; the match is set to end at about tick 1800`);
  await g.b.key(".", "Period", 190);
  await waitUntil(async () => (await tick(g)) >= 1650, 120000, 300);
  await g.b.key(",", "Comma", 188);
  const a = await view(g);
  await click('[data-order="recruit"]');
  await sleep(600);
  await g.ev(
    `(()=>{ const r=document.querySelector('[data-form=recruit] input[type=range]'); if(!r) return 0; const b=r.getBoundingClientRect(); return 1 })()`,
  );
  const okc = await click('[data-form="recruit"] [data-rc="confirm"]');
  await sleep(1500);
  const c = await view(g);
  if ((await stats(g)).tiles === 0) {
    // the raid took all her land: she can only be in limbo, and recruiting needs a place to gather
    note(
      "the defender is landless (limbo): no recruit to leave pending; the end is checked in that state",
    );
  } else {
    check(
      "2 a recruit is ordered shortly before the end (it would arrive after the match)",
      okc && c.pending.length === 1 && c.pending[0].arrives > 1800,
      `clicked ${okc}; ${JSON.stringify(c.pending)}; tick ${await tick(g)}`,
    );
  }
  const crisisUp = await g.ev(
    `!!document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.dock')`,
  );
  const panelUp = !!(await text('[data-rc="mine"]'));
  check(
    "3 before the end, the CRISIS panel and the resistance panel are both up",
    crisisUp === true && panelUp,
    `crisis ${crisisUp}, panel ${panelUp}`,
  );
  // the end
  const win = await waitUntil(
    async () => {
      const w = await g.J(`window.__wins || []`);
      return w && w.length ? w : null;
    },
    150000,
    400,
  );
  const endTick = win && win[0] && win[0].tick;
  check(
    "4 the match ends on its timer (a Win update arrives)",
    !!win,
    JSON.stringify(win),
  );
  await sleep(3500);
  await b.shot("end-1");
  const crisisAfter = await g.ev(
    `!!document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.dock')`,
  );
  check(
    "5 the CRISIS panel is gone when the match is over",
    crisisAfter === false,
    String(crisisAfter),
  );
  const v1 = await view(g);
  note(
    `after the end: pending ${JSON.stringify(v1.pending)}, tick ${await tick(g)}, phase ${v1.phase}, endReason ${v1.endReason}`,
  );
  const ended = v1.phase === 0 || v1.endReason === "match_over";
  check(
    "6 the resistance stands down: the engine marks it over (match_over)",
    ended,
    `phase ${v1.phase} reason ${v1.endReason}`,
  );
  const modal = await g.ev(
    `!!document.querySelector('win-modal') && (document.querySelector('win-modal').isVisible ?? true)`,
  );
  note("win modal element present: " + modal);
  // nothing moves after the end
  const f0 = (await view(g)).funds,
    av0 = (await view(g)).available,
    t0 = await tick(g);
  await sleep(6000);
  const f1 = (await view(g)).funds,
    av1 = (await view(g)).available,
    t1 = await tick(g);
  check(
    "7 after the end, funds and the reserve no longer change (no income, no arrivals)",
    f0 === f1 && av0 === av1,
    `funds ${f0}->${f1}, reserve ${av0}->${av1} (ticks ${t0}->${t1})`,
  );
  // an order after the end
  const n0 = await g.J(`(window.__msgs||[]).length`);
  await inject("window.__cid", { type: "resistance_recruit", troops: 5000 });
  await sleep(2500);
  const v2 = await view(g);
  check(
    "8 an order after the end changes nothing (no funds spent, nothing pending)",
    v2.funds === f1 && v2.pending.length === v1.pending.length,
    `funds ${f1}->${v2.funds}, pending ${v1.pending.length}->${v2.pending.length}`,
  );
  const newMsgs = await g.J(`(window.__msgs||[]).slice(${n0}).map(m=>m.m)`);
  note("messages after the order: " + JSON.stringify(newMsgs));
  const errs =
    (await g.J(`window.__log.filter(l=>l.k==='error'||l.k==='rejection')`)) ||
    [];
  check(
    "9 no page errors",
    errs.length === 0,
    JSON.stringify(errs).slice(0, 200),
  );
  const consoleErrors = b.consoleLog.filter(
    (l) =>
      /^error:/.test(l) &&
      !/favicon|Failed to load resource|DEPRECATED|jwks/i.test(l),
  );
  check(
    "9b no console errors",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
} catch (e) {
  console.log("ERR", e.stack || e.message);
}
R.summary();
g.close();
process.exit(0);
