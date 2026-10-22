// The two UI fixes after the first v0.8.0 playtest feedback, in a real browser:
//   1. the capital rings: a capital that scrolls back into view does not burst, and the rings are the quiet ones;
//   2. the resistance panel stays on the screen and scrolls to its last line, at several window sizes and
//      with the cards above it pushing its top down.
//
//   scripts/playtest/stack.sh node scripts/playtest/uifixes.mjs
import {
  assault,
  openGame,
  regen,
  reporter,
  sleep,
  startMatch,
} from "./game.mjs";

const { check, note, summary } = reporter("ui fixes");
const g = await openGame({ viewport: { width: 1280, height: 720 }, dpr: 1 });
const size = (w, h) =>
  g.b.send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
try {
  const { inject } = await startMatch(g, { startingGold: 3_000_000 });

  // ---- 1. rings
  const markers = () =>
    g.J(
      `[...document.querySelectorAll('capital-markers .df-capital-marker')].map(e=>({of:e.dataset.capitalOf, burst:e.classList.contains('burst'), other:e.classList.contains('other'), mine:e.classList.contains('mine')}))`,
    );
  const fresh = await markers();
  note(
    "markers right after the capitals were founded: " + JSON.stringify(fresh),
  );
  const bursting = fresh.filter((m) => m.burst);
  check(
    "a capital founded just now bursts (mine fully, the other's with the quiet ring)",
    bursting.length === 0 || bursting.every((m) => m.mine !== m.other),
    JSON.stringify(bursting),
  );
  await sleep(6000); // let every burst finish
  check(
    "after a few seconds nothing is bursting",
    (await markers()).every((m) => !m.burst),
    JSON.stringify(await markers()),
  );
  const css = await g.J(
    `(()=>{ const m=document.querySelector('capital-markers .df-capital-marker.mine'); return m? {ring:getComputedStyle(m,'::after').animationDuration, name:getComputedStyle(m,'::after').animationName}:null })()`,
  );
  check(
    "my own capital's idle ring is the slow one (3.6 s)",
    !!css && css.ring === "3.6s",
    JSON.stringify(css),
  );
  // Mark the elements, zoom far into a corner so that both capitals leave the screen, zoom back out.
  await g.ev(
    `document.querySelectorAll('capital-markers .df-capital-marker').forEach(e=>e.dataset.old='1'); 1`,
  );
  // The layer drops a capital's marker when it leaves the screen and makes a new one when it comes back.
  // The game keeps the camera where it wants it, so do exactly that to the layer: drop the markers
  // and let the next frame rebuild them from the real game state (the old code burst on every rebuild).
  await g.ev(
    `(()=>{ const cm=document.querySelector('capital-markers'); cm.querySelectorAll('.df-capital-marker').forEach(e=>e.remove()); cm.markers.clear(); return 1 })()`,
  );
  const away = await markers();
  await sleep(900);
  const back = await g.J(
    `[...document.querySelectorAll('capital-markers .df-capital-marker')].map(e=>({old:e.dataset.old==='1', burst:e.classList.contains('burst')}))`,
  );
  check(
    "the markers were dropped and made again by the layer (the case that used to burst)",
    away.length === 0 && back.length >= 1 && back.every((m) => !m.old),
    JSON.stringify({ away: away.length, back }),
  );
  check(
    "...and none of them bursts when it scrolls back into view",
    back.length > 0 && back.every((m) => !m.burst),
    JSON.stringify(back),
  );
  await g.b.shot("uifixes-after-zoom");

  // ---- 2. the resistance panel
  // grow the army first, as the golden path does: an all-in raid on a tiny army wipes the land out
  await regen(g);
  const cap = await assault(g, inject);
  check(
    "my capital falls so that the resistance panel is offered",
    !!cap,
    JSON.stringify(cap),
  );
  let panel = null;
  for (let i = 0; i < 60 && !panel; i++) {
    await sleep(500);
    panel = await g.J(
      `(()=>{ const p=document.querySelector('.rc'); return p? {h:p.getBoundingClientRect().height}: null })()`,
    );
  }
  check("the resistance panel is on screen", !!panel, JSON.stringify(panel));
  if (!panel) {
    note(
      "no panel; resistance-command: " +
        JSON.stringify(
          await g.J(
            `(()=>{ const e=document.querySelector('resistance-command'); return e? {len:e.innerHTML.length, text:e.textContent.replace(/\\s+/g,' ').trim().slice(0,200), phase:(window.__ins&&window.__ins[window.__pl[window.__cid].small])?'has-ins':'no-ins'}: 'no element' })()`,
          ),
        ),
    );
  }
  const geom = () =>
    g.J(
      `(()=>{ const p=document.querySelector('.rc'); if(!p) return null; const r=p.getBoundingClientRect(); p.scrollTop=p.scrollHeight; const last=p.lastElementChild; const lr=last?last.getBoundingClientRect():null; const out={top:Math.round(r.top), bottom:Math.round(r.bottom), vh:innerHeight, scrolls:p.scrollHeight>p.clientHeight+1, atEnd:Math.abs(p.scrollTop+p.clientHeight-p.scrollHeight)<=1, lastBottom: lr?Math.round(lr.bottom):null, maxH:getComputedStyle(p).maxHeight}; p.scrollTop=0; return out })()`,
    );
  for (const [w, h] of [
    [1280, 720],
    [1280, 560],
    [1600, 900],
    [1100, 480],
  ]) {
    await size(w, h);
    await sleep(900);
    const x = await geom();
    check(
      `${w}x${h}: the panel ends above the bottom of the screen, and its last line can be scrolled into view`,
      !!x &&
        x.bottom <= x.vh &&
        (!x.scrolls || x.atEnd) &&
        (x.lastBottom === null || x.lastBottom <= x.vh),
      JSON.stringify(x),
    );
    await g.b.shot(`uifixes-panel-${w}x${h}`);
  }
  // With the cards above it (the capital panel, the founded card, the victory card) pushing its top down.
  await size(1280, 720);
  await g.ev(
    `document.documentElement.style.setProperty('--df-capital-extra','260px'); document.documentElement.style.setProperty('--df-capital-extra2','140px'); 1`,
  );
  await sleep(900);
  const stacked = await geom();
  check(
    "with two more cards above it (top pushed down) it still ends on the screen and scrolls to the end",
    !!stacked &&
      stacked.bottom <= stacked.vh &&
      (!stacked.scrolls || stacked.atEnd),
    JSON.stringify(stacked),
  );
  await g.b.shot("uifixes-panel-stacked");
  await g.ev(
    `document.documentElement.style.removeProperty('--df-capital-extra'); document.documentElement.style.removeProperty('--df-capital-extra2'); 1`,
  );
} catch (e) {
  console.log("ERR", e.stack || e.message);
  process.exitCode = 1;
}
summary();
g.close();
process.exit(process.exitCode ?? 0);
