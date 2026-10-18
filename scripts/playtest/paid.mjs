// v0.8.0: the paid capital in the real UI. Nobody starts with a capital; the
// panel offers to buy one and explains the strain.
//
//   scripts/playtest/stack.sh node scripts/playtest/paid.mjs
import { openGame, reporter, sleep, startMatch } from "./game.mjs";

const { check, summary } = reporter("paid capital");
const g = await openGame({ viewport: { width: 1280, height: 720 }, dpr: 1 });
try {
  // 400K of the host's own on top of the 200K grant: enough for one capital.
  const { inject } = await startMatch(g, {
    startingGold: 400_000,
    buyCapitals: false,
    // the real build time (a capital takes as long as a SAM launcher)
    extra: { instantBuild: false },
  });
  await sleep(2500);
  const mine = () => g.J(`window.__pl[window.__cid]`);
  const panel = () =>
    g.J(
      `(()=>{ const b=document.querySelector('capital-action [data-capital-action]'); if(!b) return null; const s=document.querySelector('capital-action [data-capital-strain]'); const r=b.getBoundingClientRect(); return {text:b.textContent.replace(/\\s+/g,' ').trim(), strain:s&&s.textContent.replace(/\\s+/g,' ').trim(), strainOn:s&&s.classList.contains('on'), disabled:b.disabled, title:b.title, x:r.left,y:r.top,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight}})()`,
    );

  let me = await mine();
  check(
    "nobody starts with a capital",
    me.capitalTile === -1,
    JSON.stringify({ capitalTile: me.capitalTile }),
  );
  const p0 = await panel();
  check(
    "the panel is up from the start, offering to buy",
    !!p0 && /Buy your capital/.test(p0.text),
    JSON.stringify(p0),
  );
  check(
    "it says how much of the price is held",
    (p0 && /\d/.test(p0.text) && /\//.test(p0.text)) ||
      (p0 && /click to choose/.test(p0.text)),
    p0 && p0.text,
  );
  check(
    "it explains the strain that is coming, not as a CRISIS",
    p0 && /Strain begins in/.test(p0.strain || "") && !p0.strainOn,
    p0 && p0.strain,
  );
  check(
    "the tooltip lists what a capital gives",
    p0 &&
      /maximum troops/.test(p0.title) &&
      /silos and airports/.test(p0.title),
    p0 && p0.title.slice(0, 120),
  );
  check(
    "the panel is fully on screen",
    p0 &&
      p0.x >= 0 &&
      p0.y >= 0 &&
      p0.x + p0.w <= p0.vw &&
      p0.y + p0.h <= p0.vh,
    JSON.stringify(p0 && [p0.x, p0.y, p0.w, p0.h]),
  );
  await g.b.shot("paid-panel");

  // The panel stands under the leaderboard with a gap, never over it.
  const geo = await g.J(
    `(()=>{ const a=document.querySelector('game-left-sidebar aside'); const b=document.querySelector('capital-action [data-capital-action]'); if(!a||!b) return null; return {asideBottom:a.getBoundingClientRect().bottom, panelTop:b.getBoundingClientRect().top, panelLeft:b.getBoundingClientRect().left} })()`,
  );
  check(
    "the panel is under the leaderboard with a gap, at the very left",
    !!geo && geo.panelTop - geo.asideBottom >= 10 && geo.panelLeft <= 12,
    JSON.stringify(geo),
  );

  // Place it the way a building is placed: click the panel, then a preview follows the cursor.
  const at = (tile) =>
    g.J(
      `(()=>{ const cm=document.querySelector('capital-markers'); const W=cm.game.width(); const c=cm.transformHandler.worldToScreenCoordinates({x:${tile}%W,y:Math.floor(${tile}/W)}); return {x:c.x,y:c.y} })()`,
    );
  const ghost = () =>
    g.J(
      `(()=>{ const e=document.querySelector('[data-capital-ghost]'); if(!e) return null; const r=e.getBoundingClientRect(); return {ok:e.classList.contains('ok'), bad:e.classList.contains('bad'), label:e.textContent, cx:r.left+r.width/2, cy:r.top+r.height/2, w:r.width, bg:getComputedStyle(e).backgroundColor} })()`,
    );
  const btn = await g.J(
    `(()=>{ const b=document.querySelector('capital-action [data-capital-action]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2} })()`,
  );
  await g.b.clickAt(btn.x, btn.y);
  await sleep(600);
  const home = await at(612071);
  await g.b.mouse("mouseMoved", home.x + 1, home.y + 1, {
    button: "none",
    clickCount: 0,
  });
  await sleep(500);
  const gOk = await ghost();
  check(
    "a translucent capital follows the cursor, centred on the tile under it, green where it will do",
    !!gOk &&
      gOk.ok &&
      Math.abs(gOk.cx - home.x) < 20 &&
      Math.abs(gOk.cy - home.y) < 20 &&
      /(rgba\(|\/ 0\.\d+\))/.test(gOk.bg),
    JSON.stringify(gOk),
  );
  await g.b.shot("paid-ghost-ok");
  const foe = await at(612080 + 14);
  await g.b.mouse("mouseMoved", foe.x, foe.y, {
    button: "none",
    clickCount: 0,
  });
  await sleep(500);
  const gBad = await ghost();
  check(
    "over land that is not mine it goes red and says why",
    !!gBad &&
      gBad.bad &&
      /\S/.test(gBad.label) &&
      !/place your capital/.test(gBad.label),
    JSON.stringify(gBad),
  );
  await g.b.shot("paid-ghost-bad");
  await g.b.mouse("mouseMoved", home.x + 1, home.y + 1, {
    button: "none",
    clickCount: 0,
  });
  await sleep(400);
  await g.b.clickAt(home.x + 1, home.y + 1);
  await sleep(1500);
  // Paid for, and going up: it takes as long as a SAM launcher (30 s), and gives nothing yet.
  const building = await g.J(
    `(()=>{ const c=document.querySelector('capital-action [data-capital-building]'); const m=document.querySelector('.df-capital-marker.building'); return {chip:c?c.textContent.replace(/\\s+/g,' ').trim():null, bar:c&&c.querySelector('.meter i')?c.querySelector('.meter i').style.width:null, marker:!!m, owned:document.querySelector('capital-action [data-capital-owned]')!==null} })()`,
  );
  check(
    "it is being built: a progress chip under the leaderboard and an under-construction marker on the map",
    !!building &&
      /Building your capital/.test(building.chip || "") &&
      building.marker &&
      !building.owned,
    JSON.stringify(building),
  );
  me = await mine();
  check(
    "and it is not a capital yet",
    me.capitalTile === -1,
    JSON.stringify({ capitalTile: me.capitalTile }),
  );
  await g.b.shot("paid-building");
  await g.b.key(".", "Period", 190);
  const stood = await (async () => {
    for (let i = 0; i < 60; i++) {
      const m = await mine();
      if (m.capitalTile >= 0) return true;
      await sleep(1000);
    }
    return false;
  })();
  await g.b.key(",", "Comma", 188);
  check(
    "after the building time (30 s of match time) the capital stands",
    stood,
    "",
  );
  await sleep(900);
  const burst = await g.J(
    `document.querySelectorAll('.df-capital-marker.burst').length`,
  );
  check(
    "a burst of rings goes off where it was founded",
    burst >= 1,
    String(burst),
  );
  const side = await g.J(
    `(()=>{ const e=document.querySelector('capital-founded'); const c=e&&e.shadowRoot&&e.shadowRoot.querySelector('[data-capital-founded]'); if(!c) return null; const r=c.getBoundingClientRect(); return {items:c.querySelectorAll('li').length, left:r.left, right:r.right, top:r.top, vw:innerWidth, text:c.textContent.replace(/\\s+/g,' ').trim()} })()`,
  );
  check(
    "a card at the left edge says what the capital does, and stays clear of the middle of the screen",
    !!side &&
      side.items === 6 &&
      side.left <= 16 &&
      side.right <= side.vw * 0.25 &&
      /400K troop capacity/.test(side.text),
    JSON.stringify(side),
  );
  await sleep(2500);
  await g.b.shot("paid-card");
  await sleep(7000);
  const owned = await g.J(
    `(()=>{ const o=document.querySelector('capital-action [data-capital-owned]'); return o?{text:o.textContent.replace(/\\s+/g,' ').trim(), top:o.getBoundingClientRect().top}:null })()`,
  );
  check(
    "afterwards a chip under the leaderboard keeps showing what the capital does",
    !!owned &&
      /Your capital/.test(owned.text) &&
      /troop capacity/.test(owned.text),
    JSON.stringify(owned),
  );
  await g.b.shot("paid-owned");
  me = await mine();
  check(
    "buying it gives the player a capital",
    me.capitalTile >= 0,
    JSON.stringify({ capitalTile: me.capitalTile }),
  );
  const p1 = await panel();
  check(
    "the panel and the strain text are gone once there is a capital",
    p1 === null,
    JSON.stringify(p1),
  );
  const gold = await g.J(`window.__stats[window.__mySmall].gold`);
  check("it cost 500K", gold < 400_000 + 200_000 - 400_000, String(gold));
} catch (e) {
  console.log("ERR", e.stack || e.message);
  process.exitCode = 1;
}
summary();
g.close();
process.exit(process.exitCode ?? 0);
