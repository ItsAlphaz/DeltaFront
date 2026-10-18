// v0.8.0: the two side cards (capital founded, capital captured) and the building
// bar at a phone's size, a small window, and with reduced motion: they stay on
// screen, off the middle, and do not move when motion is reduced.
//
//   scripts/playtest/stack.sh node scripts/playtest/cards.mjs
import {
  openGame,
  regen,
  reporter,
  sleep,
  startMatch,
  stats,
} from "./game.mjs";

const { check, summary } = reporter("side cards at other sizes");
const CASES = [
  { name: "phone", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "small window", viewport: { width: 800, height: 600 } },
  {
    name: "reduced motion",
    viewport: { width: 1280, height: 720 },
    reducedMotion: true,
  },
];
for (const c of CASES) {
  const g = await openGame({
    viewport: c.viewport,
    dpr: 1,
    mobile: c.mobile,
    reducedMotion: c.reducedMotion,
  });
  try {
    const { inject } = await startMatch(g, {
      startingGold: 3_000_000,
      buyCapitals: false,
      extra: { instantBuild: false },
    });
    await sleep(1500);
    await inject("window.__cid", { type: "found_capital", tile: 612071 });
    await inject("window.__p2", { type: "found_capital", tile: 612080 });
    await sleep(2500);
    const bar = await g.J(
      `(()=>{ const m=document.querySelector('.df-capital-marker.building'); const i=m&&m.querySelector('.df-capital-bar i'); const r=m&&m.querySelector('.df-capital-bar').getBoundingClientRect(); return m?{bar:!!i, w:r.width, x:r.left, vw:innerWidth}:null })()`,
    );
    check(
      `${c.name}: the capital being built has its own progress bar, on screen`,
      !!bar && bar.bar && bar.x >= 0 && bar.x + bar.w <= bar.vw,
      JSON.stringify(bar),
    );
    await g.b.key(".", "Period", 190);
    for (let i = 0; i < 60; i++) {
      const m = await g.J(`window.__pl[window.__cid].capitalTile`);
      const f = await g.J(`window.__pl[window.__p2].capitalTile`);
      if (m >= 0 && f >= 0) break;
      await sleep(1000);
    }
    await g.b.key(",", "Comma", 188);
    await sleep(1200);
    const geo = (sel) =>
      g.J(
        `(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); const c=e&&e.shadowRoot&&e.shadowRoot.querySelector('.card,.banner'); if(!c) return null; const r=c.getBoundingClientRect(); const cs=getComputedStyle(c); return {l:r.left,r:r.right,t:r.top,b:r.bottom,vw:innerWidth,vh:innerHeight,anim:cs.animationName, scrollW:document.documentElement.scrollWidth} })()`,
      );
    const founded = await geo("capital-founded");
    check(
      `${c.name}: the founded card is fully on screen at the left`,
      !!founded &&
        founded.l >= 0 &&
        founded.r <= founded.vw &&
        founded.b <= founded.vh + 1 &&
        founded.scrollW <= founded.vw,
      JSON.stringify(founded),
    );
    if (c.reducedMotion)
      check(
        `${c.name}: it does not animate`,
        !!founded && /^none$/.test(founded.anim),
        founded && founded.anim,
      );
    await g.b.shot(`cards-${c.name.replace(/ /g, "-")}-founded`);
    await sleep(9500);
    // take her capital
    await regen(g, 60000, 120);
    const victim = await g.ev(`window.__pl[window.__p2].id`);
    let cap = null;
    for (let i = 0; i < 1200 && !cap; i++) {
      if (i % 25 === 0)
        await inject("window.__cid", {
          type: "attack",
          targetID: victim,
          troops: Math.floor((await stats(g, "cid")).troops * 0.95),
        });
      await sleep(80);
      cap = await g.J(
        `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
      );
    }
    await sleep(1200);
    const won = await geo("capital-victory");
    check(
      `${c.name}: the capture card is fully on screen at the left`,
      !!cap &&
        !!won &&
        won.l >= 0 &&
        won.r <= won.vw &&
        won.b <= won.vh + 1 &&
        won.scrollW <= won.vw,
      JSON.stringify(won),
    );
    if (c.reducedMotion)
      check(
        `${c.name}: it does not animate`,
        !!won && /^none$/.test(won.anim),
        won && won.anim,
      );
    await g.b.shot(`cards-${c.name.replace(/ /g, "-")}-captured`);
  } catch (e) {
    check(`${c.name}: ran`, false, e.stack || e.message);
  }
  g.close();
}
summary();
process.exit(process.exitCode ?? 0);
