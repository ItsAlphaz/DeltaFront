// The golden path, in a real browser, with an assertion at every step (plan rows 1.1, 4.4-4.7, 6.1, 6.2 partly).
// Capital System on -> capital lost -> CRISIS -> resistance -> intel, recruit, base -> uprising -> reclaim
// -> refused orders -> pause and a menu during the CRISIS -> the warnings and sounds -> a replacement capital.
// (v0.8.0: both capitals are bought first, startMatch does it.)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUT,
  assault,
  callOffRaider,
  foe,
  keepRaiderBusy,
  me,
  openGame,
  regen,
  reporter,
  sleep,
  startMatch,
  stats,
  tick,
  view,
} from "./game.mjs";
const R = reporter("golden path");
const { check, note } = R;
const g = await openGame({});
const { b } = g;
const shot = (n) => b.shot("golden-" + n);
const num = (s) => {
  const m = String(s)
    .replace(/,/g, "")
    .match(/([\d.]+)\s*([KM]?)/);
  if (!m) return NaN;
  return parseFloat(m[1]) * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : 1);
};
const bigint = (x) => Number(x);
const text = (sel) =>
  g.ev(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return e? e.textContent.replace(/\\s+/g,' ').trim(): null})()`,
  );
const click = async (sel, o = {}) => {
  const r = await g.ev(
    `(()=>{ const els=[...document.querySelectorAll(${JSON.stringify(sel)})]; const el=els[${o.nth || 0}]; if(!el) return null; el.scrollIntoView?.({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width*${o.fx ?? 0.5}, y:r.top+r.height*${o.fy ?? 0.5}, dis: !!el.disabled}})()`,
  );
  if (!r || r.error || r.dis) return false;
  await b.clickAt(r.x, r.y);
  return true;
};
let speed = 0;
const faster = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await b.key(".", "Period", 190);
    speed++;
  }
};
const normal = async () => {
  while (speed > 0) {
    await b.key(",", "Comma", 188);
    speed--;
  }
  while (speed < 0) {
    await b.key(".", "Period", 190);
    speed++;
  }
};
const waitUntil = async (cond, ms, every = 500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await cond();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
const waitTick = async (target, fast = 2, ms = 240000) => {
  await faster(fast);
  const ok = await waitUntil(async () => (await tick(g)) >= target, ms, 400);
  await normal();
  return !!ok;
};
const owned = (kind, region) =>
  g.J(`(()=>{
  const rc = document.querySelector('resistance-command'); const game = rc.game; const th = rc.transformHandler;
  const W = game.width(), H = game.height(); const me = window.__mySmall, foe = window.__pl[window.__p2].small;
  const region = ${region}; const cols = Math.ceil(W / 32); const row = Math.floor(region / cols), col = region % cols; const x0 = col * 32, y0 = row * 32;
  const own = (x, y, who) => { if (x < 0 || y < 0 || x >= W || y >= H) return false; const t = game.ref(x, y); return game.isLand(t) && game.ownerID(t) === who; };
  let best = null, bd = -1, bdist = 1e9;
  for (let y = y0; y < y0 + 32; y++) for (let x = x0; x < x0 + 32; x++) {
    if (${JSON.stringify(kind)} === 'foe') { if (!own(x, y, foe)) continue; const d = (x - x0 - 16) ** 2 + (y - y0 - 16) ** 2; if (d < bdist) { bdist = d; best = { x, y }; } }
    else { if (!own(x, y, me)) continue; let depth = 0; for (let r = 1; r < 12; r++) { let all = true; for (const [dx, dy] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,-r],[r,-r],[-r,r]]) if (!own(x+dx,y+dy,me)) all = false; if (!all) break; depth = r; } if (depth > bd) { bd = depth; best = { x, y, depth }; } }
  }
  if (!best) return { err: 'none' };
  return { tile: best, screen: th.worldToScreenCoordinates({ x: best.x, y: best.y }) };
})()`);
const occupied = (v) => ((v && v.regions) || []).filter((r) => r.status === 1);
const funds = (v) => bigint(v.funds);

try {
  // ------------------------------------------------------------------ setup and the fall
  const { inject } = await startMatch(g, { startingGold: 3000000 });
  const m0 = await me(g),
    f0 = await foe(g);
  check(
    "1 both players have bought a capital (nobody starts with one)",
    m0.capitalTile >= 0 && f0.capitalTile >= 0,
    `${m0.capitalTile} / ${f0.capitalTile}`,
  );
  const rg = await regen(g);
  note("regen " + JSON.stringify(rg));
  const cap = await assault(g, inject);
  check(
    "2 the raider captures my capital (a CapitalEvent 'captured')",
    cap &&
      cap.kind === "captured" &&
      cap.owner === m0.small &&
      cap.captor === f0.small,
    JSON.stringify(cap),
  );
  check(
    "2b the captor is paid once: 250K gold and troops",
    cap && cap.gold === "250000" && cap.troops > 0,
    `${cap && cap.gold} gold, ${cap && cap.troops} troops`,
  );
  const T0 = cap.tick,
    END = cap.crisisEnd;
  await callOffRaider(g, inject);
  await sleep(1500);
  const m1 = await me(g);
  check(
    "2c the CRISIS lasts 3 minutes (1,800 ticks) from the fall",
    m1.crisisEnd - m1.crisisStart === 1800 && cap.crisisEnd === m1.crisisEnd,
    `start ${m1.crisisStart}, end ${m1.crisisEnd}, event end ${cap.crisisEnd}`,
  );
  check(
    "2d my player carries the CRISIS and has no capital",
    m1.capitalTile === -1 && Math.abs(m1.crisisStart - T0) <= 1,
    JSON.stringify({
      cap: m1.capitalTile,
      s: m1.crisisStart,
      e: m1.crisisEnd,
      eventTick: T0,
    }),
  );
  const badges = await g.J(
    `[...document.querySelectorAll('.df-capital-marker')].map(e=>{const r=e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]})`,
  );
  check(
    "2e a capital's badge on the map is a small marker (10-40 px), not a screen-sized disc",
    badges.length >= 1 &&
      badges.every(([w, h]) => w >= 10 && w <= 40 && h >= 10 && h <= 40),
    JSON.stringify(badges),
  );
  // the announcement, as the page drew it
  await sleep(9500);
  const rec = await g.J(`window.__rec || []`);
  const phases = [...new Set(rec.map((f) => f.ph))].join(">");
  check(
    "3 the announcement runs announce > docking > active",
    phases === "announce>docking>active",
    phases,
  );
  const vw = await g.ev("innerWidth");
  const holdFrames = rec.filter(
    (f) =>
      f.ph === "announce" &&
      f.titleOp >= 0.99 &&
      f.subOp >= 0.99 &&
      f.title &&
      f.sub,
  );
  const hold = holdFrames[Math.floor(holdFrames.length / 2)];
  check(
    "3b at its hold the title is large (>= 50% of the width) and centred",
    hold &&
      hold.title.w >= 0.5 * vw &&
      Math.abs(hold.title.x + hold.title.w / 2 - vw / 2) <= 0.05 * vw,
    hold && JSON.stringify(hold.title) + " vw " + vw,
  );
  check(
    "3c the subtitle is fully visible at the hold, under the title",
    hold &&
      hold.subOp >= 0.99 &&
      hold.sub &&
      hold.sub.y >= hold.title.y + hold.title.h * 0.8,
    hold && JSON.stringify({ sub: hold.sub, title: hold.title }),
  );
  check(
    "3d the edge glow and the flash both play, then are gone",
    rec.some((f) => f.edge > 0.3) &&
      rec.some((f) => f.flash > 0.3) &&
      rec[rec.length - 1].edge < 0.05,
    JSON.stringify({
      maxEdge: Math.max(...rec.map((f) => f.edge || 0)),
      maxFlash: Math.max(...rec.map((f) => f.flash || 0)),
    }),
  );
  const last = rec[rec.length - 1];
  check(
    "3e the title ends in the panel at the right edge, with the time and the status",
    last.ph === "active" &&
      last.dock &&
      Math.abs(last.dock.x + last.dock.w - (vw - 16)) <= 2 &&
      /^\d\d:\d\d$/.test(last.time) &&
      last.status === "CAPITAL LOST",
    JSON.stringify({ dock: last.dock, time: last.time, status: last.status }),
  );
  await shot("1-docked");

  // ------------------------------------------------------------------ the resistance starts
  // keep the occupier busy elsewhere (its home army thin, so that unrest can rise), and let it take some more land
  await keepRaiderBusy(g);
  const victim = await g.ev(`window.__pl[window.__cid].id`);
  let v = await view(g);
  // small pushes, each judged at the next unrest update (every 5 s), until a region is occupied and I still hold land
  for (let i = 0; i < 14; i++) {
    v = await view(g);
    const t = (await stats(g)).tiles;
    if (occupied(v).length >= 1 && t >= 100) break;
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
  v = await view(g);
  check(
    "4 the resistance exists: a force, a purse and a capacity of twice the force",
    v &&
      v.startingTroops > 0 &&
      funds(v) >= 100000 &&
      v.capacity === 2 * v.startingTroops,
    v &&
      JSON.stringify({
        start: v.startingTroops,
        funds: v.funds,
        cap: v.capacity,
      }),
  );
  check(
    "4b the force is within the 1,000..25,000 shown limits",
    v.startingTroops >= 10000 && v.startingTroops <= 250000,
    String(v.startingTroops),
  );
  check(
    "4c at least one region is occupied by the raider, and I still hold land",
    occupied(v).length >= 1 && (await stats(g)).tiles > 0,
    `${occupied(v).length} occupied, tiles ${(await stats(g)).tiles}`,
  );
  const panel = await text('[data-rc="mine"]');
  const ready = await text('[data-rc="ready"]'),
    fundsT = await text('[data-rc="funds"]');
  check(
    "4d the panel shows the engine's reserve and funds",
    panel &&
      Math.abs(num(ready) - Math.floor(v.available / 10)) /
        Math.max(1, Math.floor(v.available / 10)) <
        0.02 &&
      Math.abs(num(fundsT) - funds(v)) / funds(v) < 0.03,
    `ready ${ready} vs ${Math.floor(v.available / 10)}, funds ${fundsT} vs ${v.funds}`,
  );
  await shot("2-panel");

  // ------------------------------------------------------------------ pause and a menu, during the CRISIS
  const dockTime = () =>
    g.ev(
      `(document.querySelector('crisis-overlay').shadowRoot.querySelector('.time')||{}).textContent`,
    );
  const gameClock = () => text("[data-game-timer]");
  {
    const t0 = await tick(g),
      d0 = await dockTime();
    const paused = await click('img[alt="play/pause"]');
    await sleep(3000);
    const t1 = await tick(g),
      d1 = await dockTime();
    await sleep(4000);
    const t2 = await tick(g),
      d2 = await dockTime();
    check(
      "5 pausing holds the match's ticks and the CRISIS time",
      paused && t2 - t1 <= 1 && d1 === d2,
      `ticks ${t0}->${t1}->${t2}, shown ${d0} ${d1} ${d2}`,
    );
    await click('img[alt="play/pause"]');
    await sleep(3000);
    const t3 = await tick(g),
      d3 = await dockTime();
    const secs = (s) => {
      const [m, x] = s.split(":");
      return +m * 60 + +x;
    };
    check(
      "5b resuming carries on from where it was (the time is the match's, not the browser's)",
      t3 - t2 >= 15 && secs(d2) - secs(d3) >= 1 && secs(d2) - secs(d3) <= 4,
      `ticks +${t3 - t2}, shown ${d2} -> ${d3}`,
    );
    // a menu: in Solo, the settings menu pauses the match (in multiplayer it cannot: see the two-client run)
    const ta = await tick(g),
      da = await dockTime();
    await click('img[alt="settings"]');
    await sleep(4000);
    const tb = await tick(g),
      db = await dockTime();
    await shot("3-menu");
    await b.key("Escape", "Escape", 27);
    await sleep(3000);
    const tc = await tick(g),
      dc = await dockTime();
    check(
      "5c opening the settings menu in Solo pauses the match, and the CRISIS time holds with it",
      // one tick may pass before the pause lands, which can cross a shown second
      tb - ta <= 2 && Math.abs(secs(da) - secs(db)) <= 1,
      `ticks +${tb - ta}, shown ${da} -> ${db}`,
    );
    check(
      "5d closing it resumes, and the CRISIS time carries on",
      tc - tb >= 15 && secs(db) - secs(dc) >= 1,
      `ticks +${tc - tb}, shown ${db} -> ${dc}`,
    );
  }

  // ------------------------------------------------------------------ intel, recruit, base
  const before = async () => view(g);
  let a = await before(),
    c,
    arrives = 0,
    amount = 0,
    target = null;
  const section = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      check(name + " ran to its end", false, (e && e.message) || String(e));
    }
  };
  await section("intel, recruit and base", async () => {
    check(
      "6 intelligence: the order opens its form",
      await click('[data-order="intel"]'),
      "",
    );
    await sleep(700);
    check(
      "6b the form names the region and the cost",
      /Gather intelligence/.test((await text('[data-form="intel"]')) || "") &&
        /10\.0K/.test((await text('[data-form="intel"]')) || ""),
      await text('[data-form="intel"]'),
    );
    await click('[data-form="intel"] [data-rc="confirm"]');
    await sleep(2000);
    c = await view(g);
    check(
      "6c intelligence costs 10,000 and a report with the unrest and the garrison arrives",
      funds(a) - funds(c) >= 9000 &&
        funds(a) - funds(c) <= 10100 &&
        c.intel.length === 1 &&
        c.intel[0].garrison > 0,
      `funds ${a.funds} -> ${c.funds}; ${JSON.stringify(c.intel)}`,
    );
    check(
      "6d the panel shows the exact figures on that region's row",
      /garrison/i.test((await text('[data-rc="mine"]')) || ""),
      "",
    );

    a = await before();
    await click('[data-order="recruit"]');
    await sleep(700);
    await click('[data-form="recruit"] input[type=range]', { fx: 0.2 });
    await sleep(500);
    const rform = await text('[data-form="recruit"]');
    const previewCost = num((rform.match(/Cost\s*([\d.]+K?)/) || [])[1]);
    await click('[data-form="recruit"] [data-rc="confirm"]');
    await sleep(2000);
    c = await before();
    const spent = funds(a) - funds(c);
    check(
      "7 recruiting charges exactly what the form showed",
      Math.abs(spent - previewCost) <= 600 && c.pending.length === 1,
      `preview ${previewCost}, spent ${spent}, pending ${JSON.stringify(c.pending)}`,
    );
    arrives = c.pending[0].arrives;
    amount = c.pending[0].troops;

    a = await before();
    await click('[data-order="base"]');
    await sleep(700);
    check(
      "8 the base order asks for a tile the enemy holds",
      /enemy holds/i.test((await text(".tile-picker-hint")) || ""),
      await text(".tile-picker-hint"),
    );
    target = occupied(a).sort((x, y) => y.band - x.band)[0];
    await click(`.rc-region[data-region="${target.id}"] .go`);
    await sleep(3500);
    const ft = await owned("foe", target.id);
    await b.clickAt(ft.screen.x, ft.screen.y);
    await sleep(1000);
    check(
      "8b clicking an enemy tile in a restless region opens the base form with its cost",
      /Found a base at/.test((await text('[data-form="base"]')) || "") &&
        /50\.0K/.test((await text('[data-form="base"]')) || ""),
      await text('[data-form="base"]'),
    );
    await click('[data-form="base"] [data-rc="confirm"]');
    await sleep(2000);
    c = await before();
    check(
      "8c the base costs 50,000 and stands in that region",
      funds(a) - funds(c) >= 49000 &&
        funds(a) - funds(c) <= 50100 &&
        c.bases.length === 1 &&
        c.bases[0].region === target.id,
      `funds ${a.funds} -> ${c.funds}; ${JSON.stringify(c.bases)}`,
    );
    await shot("4-base");

    // the recruits arrive after 30 seconds
    await waitTick(arrives + 2, 2, 120000);
    c = await before();
    check(
      "9 the recruits arrive after 30 s and join the reserve",
      c.pending.length === 0 && c.available >= a.available + amount - 200,
      `reserve ${a.available} -> ${c.available} (+${amount} expected)`,
    );
  });

  // ------------------------------------------------------------------ the uprising
  await section("the uprising", async () => {
    await faster(2);
    const ready2 = await waitUntil(
      async () => {
        const x = await view(g);
        return occupied(x).some((r) => r.band >= 2) ? x : null;
      },
      240000,
      1000,
    );
    await normal();
    check(
      "10 unrest in an occupied region rises to 'Unrestful' while the occupier is busy elsewhere",
      !!ready2,
      ready2
        ? JSON.stringify(occupied(ready2).map((r) => [r.id, r.band]))
        : "never",
    );
    if (ready2) {
      a = await before();
      const ta = await tick(g);
      const tilesBefore = (await stats(g)).tiles;
      check(
        "11 the uprising order opens its form",
        await click('[data-order="uprising"]'),
        "",
      );
      await sleep(800);
      await click('[data-form="uprising"] input[type=range]', { fx: 0.95 });
      await sleep(500);
      const uform = await text('[data-form="uprising"]');
      check(
        "11b the form says it can fail, where it breaks in and what it costs",
        /can fail/.test(uform) && /25\.0K/.test(uform),
        uform,
      );
      await click('[data-form="uprising"] [data-rc="confirm"]');
      await waitUntil(
        async () => {
          const x = await view(g);
          return x.reclaimed > a.reclaimed || x.operations.length > 0
            ? x
            : null;
        },
        30000,
        400,
      );
      await sleep(6000);
      c = await before();
      const tilesAfter = (await stats(g)).tiles;
      check(
        "11c the uprising wins land back: tiles rise and a region is Held again",
        tilesAfter > tilesBefore + 50 && c.reclaimed > a.reclaimed,
        `tiles ${tilesBefore} -> ${tilesAfter}, reclaimed ${a.reclaimed} -> ${c.reclaimed}`,
      );
      check(
        "11d it cost 25,000 and paid the 20,000 reclaim reward once",
        Math.abs(
          funds(a) - funds(c) - (25000 - 20000 * (c.reclaimed - a.reclaimed)),
        ) <= 1500,
        `funds ${a.funds} -> ${c.funds}`,
      );
      check(
        "11e a region won back adds 3 minutes to the resistance (1,800 ticks)",
        c.deadline - a.deadline === 1800 * (c.reclaimed - a.reclaimed),
        `deadline ${a.deadline} -> ${c.deadline}`,
      );
      await waitUntil(
        async () => {
          const x = await view(g);
          return x.operations.length === 0;
        },
        90000,
        1000,
      );
      const msgs = await g.J(`(window.__msgs||[]).map(m=>m.m)`);
      check(
        "11f the player is told: uprising won, region reclaimed",
        msgs.includes("events_display.insurgency_uprising_won") &&
          msgs.includes("events_display.insurgency_region_reclaimed"),
        msgs.filter((m) => /insurgency/.test(m)).join(","),
      );
      await shot("5-uprising-result");
    }
  });

  // ------------------------------------------------------------------ refused orders
  await section("the refused orders", async () => {
    a = await before();
    const ownTile = await owned(
      "own",
      (a.regions.find((r) => r.status === 0) || a.regions[0]).id,
    );
    const refuse = async (intent, key) => {
      const n0 = await g.J(`(window.__msgs||[]).length`);
      await inject("window.__cid", intent);
      const m = await waitUntil(
        async () => {
          const all = await g.J(`(window.__msgs||[]).slice(${n0}).map(m=>m.m)`);
          return (
            all &&
            all.find((x) =>
              key === "ANY"
                ? /^events_display\.insurgency_reject_/.test(x)
                : x === key,
            )
          );
        },
        8000,
        300,
      );
      return !!m;
    };
    const held = a.regions.find((r) => r.status === 0);
    const cases = [
      [
        { type: "resistance_uprising", region: held.id, troops: 5000 },
        "events_display.insurgency_reject_not_occupied",
        "an uprising in a region she holds",
      ],
      [
        { type: "resistance_recruit", troops: 900000 },
        "events_display.insurgency_reject_capacity",
        "a recruit beyond the capacity",
      ],
      [
        {
          type: "resistance_base",
          tile: ownTile.err
            ? 0
            : await g.ev(
                `document.querySelector('resistance-command').game.ref(${ownTile.tile.x},${ownTile.tile.y})`,
              ),
        },
        "events_display.insurgency_reject_tile",
        "a base on her own land",
      ],
      [
        {
          type: "resistance_uprising",
          region: (occupied(a)[0] || held).id,
          troops: 9000000,
        },
        "ANY",
        "more troops than she has (refused for whichever reason the engine meets first)",
      ],
    ];
    let told = 0;
    for (const [intent, key, what] of cases) {
      const ok = await refuse(intent, key);
      if (ok) told++;
      else note("no message for " + what);
    }
    c = await before();
    check(
      "12 four refused orders each tell the sender why",
      told === 4,
      `${told}/4`,
    );
    check(
      "12b and cost nothing: no funds, reserve or pending change beyond income",
      funds(c) >= funds(a) - 5 &&
        funds(c) - funds(a) <= 4000 &&
        c.available === a.available &&
        c.pending.length === a.pending.length,
      `funds ${a.funds} -> ${c.funds}, reserve ${a.available} -> ${c.available}`,
    );
    const shownMsg = await g.ev(
      `(()=>{ const e=document.querySelector('events-display'); return e? (e.innerText||'').replace(/\\s+/g,' ').trim(): null })()`,
    );
    check(
      "12c the refusal reads in the events panel (plain words)",
      /not|cannot|invalid|valid|held/i.test(shownMsg || ""),
      shownMsg,
    );
    await shot("6-refused");
  });

  // ------------------------------------------------------------------ run out the CRISIS: warnings, sounds, the end
  note(`now tick ${await tick(g)}; the CRISIS ends at ${END}`);
  const nowT = await tick(g);
  if (nowT < END + 50) {
    // approach the 60 s mark quickly, then take the rest at normal speed so that the warnings are heard in real time
    if (nowT < END - 640) await waitTick(END - 640, 2, 400000);
    await waitUntil(async () => (await tick(g)) >= END + 30, 120000, 1000);
  }
  await sleep(2000);
  const T = await g.J(`window.__timer || []`);
  const secs = (s) => {
    const [m, x] = s.split(":");
    return +m * 60 + +x;
  };
  const secsLeft = (t) => Math.max(0, Math.ceil((END - t) / 10));
  const act = T.filter(
    (r) => r.ph === "active" && r.time && r.tick >= T0 && r.tick < END,
  );
  const dev = act.map((r) => secs(r.time) - secsLeft(r.tick));
  check(
    "13 the displayed countdown equals the match's own time on every sample",
    act.length > 200 && dev.every((d) => d === 0),
    `${act.length} samples; deviations ${JSON.stringify([...new Set(dev)])}`,
  );
  const firstWarn = T.find((r) => r.lvl === "warning"),
    firstUrgent = T.find((r) => r.lvl === "urgent"),
    firstOver = T.find((r) => r.ph === "over");
  const prevOf = (r) => T[T.indexOf(r) - 1];
  const dense = (r) => prevOf(r) && r.tick - prevOf(r).tick <= 6;
  // every sample's level agrees with its time (running above 60 s, warning 60..11, urgent 10..1, over at 0)
  const levelOf = (sec, over) =>
    over ? "over" : sec <= 10 ? "urgent" : sec <= 60 ? "warning" : "running";
  const wrong = T.filter(
    (r) =>
      r.time &&
      r.tick >= T0 &&
      r.tick <= END + 1 &&
      r.ph !== "over" &&
      r.lvl !== levelOf(secs(r.time), false),
  );
  check(
    "13b every sample's level agrees with its time: running above 60 s, warning from 60 s, urgent from 10 s",
    wrong.length === 0,
    `${wrong.length} disagree ${JSON.stringify(wrong.slice(0, 2).map((r) => [r.tick, r.time, r.lvl]))}`,
  );
  check(
    "13c the warning begins at 60 s (01:00, tick end-600) where the samples are dense enough to see it",
    firstWarn &&
      secs(firstWarn.time) <= 60 &&
      (!dense(firstWarn) ||
        (firstWarn.time === "01:00" &&
          Math.abs(firstWarn.tick - (END - 600)) <= 2)),
    firstWarn &&
      `tick ${firstWarn.tick} time ${firstWarn.time} dense=${dense(firstWarn)}`,
  );
  check(
    "13d the urgent state begins at 10 s (00:10, tick end-100) where the samples are dense",
    firstUrgent &&
      secs(firstUrgent.time) <= 10 &&
      (!dense(firstUrgent) ||
        (firstUrgent.time === "00:10" &&
          Math.abs(firstUrgent.tick - (END - 100)) <= 2)),
    firstUrgent &&
      `tick ${firstUrgent.tick} time ${firstUrgent.time} dense=${dense(firstUrgent)}`,
  );
  check(
    "13d2 the end shows 'penalties lifted' at 00:00 on the tick the CRISIS ends",
    firstOver &&
      firstOver.time === "00:00" &&
      firstOver.status === "PENALTIES LIFTED" &&
      Math.abs(firstOver.tick - END) <= 3,
    firstOver && `tick ${firstOver.tick} ${firstOver.status}`,
  );
  check(
    "13e the pulse at 60 s happens once (a pulse class appears in the warning state)",
    T.some((r) => r.lvl === "warning" && /pulse-[01]/.test(r.cls)),
    "",
  );
  const log = await g.J(`window.__log`);
  const peaks = log.filter((l) => l.k === "out-peak").map((l) => l.v);
  const names = [
    [3.39, "crisis-capital-lost"],
    [1.33, "crisis-warning"],
    [2.44, "crisis-over"],
  ];
  const aud = log.filter((l) => l.k === "audio-start").map((l) => l.v);
  const soundAt = (dur, around, tol = 4) =>
    aud.find(
      (s) =>
        Math.abs(s.dur - dur) < 0.06 &&
        s.tick !== undefined &&
        Math.abs(s.tick - around) <= tol,
    );
  const level = (s) => {
    const w = peaks
      .filter(
        (p) => p.wall >= s.wall - 100 && p.wall <= s.wall + s.dur * 1000 + 300,
      )
      .map((p) => p.p);
    return w.length ? Math.max(...w) : 0;
  };
  for (const [dur, around, label] of [
    [3.39, T0, "the 'capital lost' cue starts on the tick of the fall"],
    [1.33, END - 600, "the 60-second warning cue starts at 60 s left"],
    [2.44, END, "the 'crisis over' cue starts on the tick the CRISIS ends"],
  ]) {
    const s = soundAt(dur, around);
    check(
      "14 " + label,
      !!s,
      s
        ? `tick ${s.tick} (expected ${around}), ctx ${s.ctx}`
        : `no ${dur}s sound near tick ${around}`,
    );
    if (s)
      check(
        "14b ...and is audible but not clipped at the output (peak " +
          level(s).toFixed(2) +
          ")",
        level(s) > 0.05 && level(s) < 0.95,
        String(level(s)),
      );
  }
  check(
    "14c there is no cue at the urgent mark (only the pulse and the digits)",
    !aud.some(
      (s) =>
        s.tick !== undefined &&
        Math.abs(s.tick - (END - 100)) <= 2 &&
        s.dur > 0.5,
    ),
    "",
  );
  await shot("7-after-crisis");

  // ------------------------------------------------------------------ the replacement capital
  check(
    "15 the 'Buy your capital' button is offered (500K)",
    /500K/.test((await text("[data-capital-action]")) || ""),
    await text("[data-capital-action]"),
  );
  await click("[data-capital-action]");
  await sleep(800);
  check(
    "15b it asks for my own land, away from the border",
    /own land, away from the border/i.test(
      (await text(".tile-picker-hint")) || "",
    ),
    await text(".tile-picker-hint"),
  );
  const vv = await view(g);
  const heldRegion = vv.regions.filter((r) => r.status === 0).map((r) => r.id);
  let site = null;
  const vp = await g.J(`[innerWidth, innerHeight]`);
  for (const id of heldRegion) {
    await click(`.rc-region[data-region="${id}"] .go`);
    await sleep(3000);
    const o = await owned("own", id);
    if (
      !o.err &&
      o.tile.depth >= 3 &&
      o.screen.x > 340 &&
      o.screen.x < vp[0] - 240 &&
      o.screen.y > 150 &&
      o.screen.y < vp[1] - 130
    ) {
      site = o;
      break;
    }
  }
  note("site " + JSON.stringify(site));
  const gold0 = bigint((await stats(g)).gold);
  check(
    "15a there is a clear spot of my own land on screen to click",
    !!site,
    "",
  );
  await b.clickAt(site.screen.x, site.screen.y);
  await sleep(2500);
  const m2 = await me(g),
    a3 = await stats(g);
  check(
    "15c the capital is founded where I clicked",
    m2.capitalTile >= 0,
    String(m2.capitalTile),
  );
  check(
    "15d it cost 500,000 gold",
    Math.abs(gold0 - bigint(a3.gold) - 500000) <= 12000,
    `gold ${gold0} -> ${a3.gold}`,
  );
  const badges2 = await g.J(
    `[...document.querySelectorAll('.df-capital-marker')].map(e=>{const r=e.getBoundingClientRect(); return {w:Math.round(r.width), mine: e.classList.contains('mine'), rep: e.classList.contains('replacement')}})`,
  );
  check(
    "15f my new capital's badge is small, dashed (a replacement) and marked as mine",
    badges2.some((x) => x.mine && x.rep && x.w >= 10 && x.w <= 40),
    JSON.stringify(badges2),
  );
  check(
    "15e the player is told: 'capital founded'",
    (await g.J(`(window.__msgs||[]).map(m=>m.m)`)).includes(
      "events_display.capital_founded",
    ),
    "",
  );
  await shot("8-new-capital");

  // ------------------------------------------------------------------ nothing broke
  const errs =
    (await g.J(`window.__log.filter(l=>l.k==='error'||l.k==='rejection')`)) ||
    [];
  check(
    "16 no page errors or unhandled rejections during the whole run",
    errs.length === 0,
    JSON.stringify(errs).slice(0, 300),
  );
  const consoleErrors = b.consoleLog.filter(
    (l) =>
      /^error:/.test(l) &&
      !/favicon|Failed to load resource|DEPRECATED|jwks/i.test(l),
  );
  check(
    "16b no console errors from the page or its workers",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );
  writeFileSync(
    join(OUT, "golden-timeline.json"),
    JSON.stringify({ T, aud, msgs: await g.J(`window.__msgs`) }),
  );
} catch (e) {
  console.log("ERR", e.stack || e.message);
}
R.summary();
g.close();
process.exit(0);
