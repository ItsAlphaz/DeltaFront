// The v0.8.0 paid-capital session for a HUMAN to play (docs/Capital.md). Nobody
// starts with a capital; you buy yours. A scripted raider is the other player.
//
//   scripts/playtest/stack.sh node scripts/playtest/purchase.mjs            (private stack)
//   node scripts/playtest/purchase.mjs                                      (your own dev client)
//
// Flags
//   --gold <n>        gold on top of the 200K grant (default 1,000,000: you can buy at
//                     once and still afford a replacement). 0 makes you save: the
//                     affordability bar and the strain countdown are what to watch.
//   --raid-after <s>  seconds after you own a capital before the raider tries to take it
//                     (default 90)
//   --nukes           the raider also buys its own capital, builds a silo and launches
//                     an atom bomb at you every 40 s; you build a SAM launcher to stop
//                     them (needs --gold 3500000: this sets it unless you give one)
//   --no-raid         no raid: only the purchase, the bar, the strain and the bonuses
//   --selftest        a scripted player checks the session itself and exits
//
// What it checks (selftest) or what to look at (you): the numbered list it prints.
// It writes a timeline of your state every 5 s and the capital events as they come
// to the playtest output folder. Do not write to the repository while it runs.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUT,
  URL_BASE,
  assault,
  callOffRaider,
  openGame,
  reporter,
  sleep,
  startMatch,
  stats,
  tick,
} from "./game.mjs";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : dflt;
};
const has = (name) => argv.includes(name);
const SELFTEST = has("--selftest");
const NUKES = has("--nukes");
const NO_RAID = has("--no-raid");
const GOLD = Number(flag("--gold", NUKES ? 3_500_000 : 1_000_000));
const RAID_AFTER = Number(flag("--raid-after", SELFTEST ? 4 : 90));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const TIMELINE = join(OUT, `purchase-${stamp}.jsonl`);
writeFileSync(TIMELINE, "");
const R = reporter("purchase session self-test");
const t0 = Date.now();
const say = (s) => {
  const t = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}] ${s}`,
  );
};
const log = (kind, data = {}) =>
  appendFileSync(
    TIMELINE,
    JSON.stringify({ at: new Date().toISOString(), kind, ...data }, (k, v) =>
      typeof v === "bigint" ? String(v) : v,
    ) + "\n",
  );

const g = await openGame({
  url: flag("--url", URL_BASE),
  mute: has("--no-sound") || SELFTEST,
  keepWindowSize: true,
  args: SELFTEST ? [] : ["--start-maximized"],
});
const { b } = g;
const alive = () => !b.isClosed();
const waitUntil = async (cond, ms, every = 500) => {
  const t = Date.now();
  while (Date.now() - t < ms && alive()) {
    const v = await cond();
    if (v) return v;
    await sleep(every);
  }
  return null;
};
const mine = () => g.J(`window.__pl[window.__cid]`);
const panel = () =>
  g.J(
    `(()=>{ const b=document.querySelector('capital-action [data-capital-action]'); if(!b) return null; const s=document.querySelector('capital-action [data-capital-strain]'); const m=b.querySelector('.meter i'); return {text:b.textContent.replace(/\\s+/g,' ').trim(), strain:s&&s.textContent.replace(/\\s+/g,' ').trim(), strainOn:!!(s&&s.classList.contains('on')), disabled:b.disabled, bar:m&&m.style.width} })()`,
  );

let poll = null;
const startPolling = () => {
  poll = setInterval(async () => {
    if (!alive()) return;
    try {
      const me = await mine();
      const st = await stats(g, "cid");
      const p = await panel();
      log("state", {
        tick: await tick(g),
        capitalTile: me && me.capitalTile,
        crisis: me && me.crisisEnd,
        gold: st && st.gold,
        troops: st && st.troops,
        tiles: st && st.tiles,
        panel: p,
      });
    } catch {
      // the page may be busy
    }
  }, 5000);
};

try {
  const { inject } = await startMatch(g, {
    startingGold: GOLD,
    buyCapitals: false,
    extra: { instantBuild: false }, // the real 30 s build
    myName: "You",
    foeName: "Raider",
  });
  startPolling();
  say(
    `The match has started. You have ${(200_000 + GOLD) / 1000}K gold and no capital.`,
  );
  say(
    "1. The panel at the top left says BUY YOUR CAPITAL, with how much of 500K you hold (a bar and numbers).",
  );
  say(
    "2. Under it: when STRAIN begins (10:00 from the start), in amber. It is not the red CRISIS.",
  );
  say("3. Hover the panel: it lists what a capital gives.");
  say(
    "4. Open the build menu (hold Ctrl and click the map): Missile Silo and Airport say 'Needs a capital' until you own one. SAM Launcher does not.",
  );
  say(
    "5. Click the panel, then click your own land away from the border. You should pay 500K and the panel goes away.",
  );
  say(
    "6. Watch your troop maximum (the bar): +400K, growing from half to full over 3 minutes. Cities/Ports/Factories/Posts cost 25% less.",
  );
  if (!NO_RAID) {
    say(
      `7. ${RAID_AFTER} s after you own a capital the raider tries to take it. If it falls: the CRISIS announcement, your troops drop to the new maximum within a moment, income and regeneration halve for 3 minutes.`,
    );
    say(
      "8. 30 s after the fall the panel offers to buy a replacement (500K). Strain does NOT start during the CRISIS; it begins 10 minutes after the CRISIS ends.",
    );
  }
  if (NUKES) {
    say(
      "9. The raider buys a capital and a silo, then launches an atom bomb at you every 40 s. Build a SAM launcher (no capital needed) and see whether it stops them.",
    );
  }

  if (SELFTEST) {
    // The scripted player: look at the panel, buy at the spawn tile.
    await sleep(2500);
    const p0 = await panel();
    R.check(
      "before buying: the panel offers a capital, with the bar and the strain countdown",
      !!p0 &&
        /Buy your capital/.test(p0.text) &&
        /Strain begins in/.test(p0.strain || "") &&
        !p0.strainOn,
      JSON.stringify(p0),
    );
    // The build menu says why a silo and an airport are out of reach.
    await g.ev(`document.querySelector('build-menu').showMenu(612071); 1`);
    await sleep(1500);
    const needs = await g.J(
      `(()=>{ const m=document.querySelector('build-menu'); const root=m&&m.shadowRoot; if(!root) return null; return [...root.querySelectorAll('[data-needs-capital]')].map(e=>e.closest('button').textContent.replace(/\\s+/g,' ').trim().slice(0,60)) })()`,
    );
    R.check(
      "the build menu marks Missile Silo and Airport 'Needs a capital' (and nothing else)",
      Array.isArray(needs) &&
        needs.length === 2 &&
        needs.every((t) => /Needs a capital/.test(t)),
      JSON.stringify(needs),
    );
    await g.ev(`document.querySelector('build-menu').hideMenu(); 1`);
    // the troop cap, before
    const cap = () =>
      g.J(
        `(()=>{ const game=document.querySelector('capital-markers').game; const me=game.myPlayer(); return {max: game.config().maxTroops(me), strength: me.capitalStrengthPercent(), city: Number(game.unitInfo ? 0 : 0)} })()`,
      );
    globalThis.__cap0 = await cap();
    globalThis.__capFn = cap;
    await inject("window.__cid", { type: "found_capital", tile: 612071 });
  }

  if (SELFTEST) await b.key(".", "Period", 190); // the 30 s build, faster
  const bought = await waitUntil(
    async () => (await mine())?.capitalTile >= 0,
    3 * 3600_000,
    1000,
  );
  if (!bought) throw new Error("the window was closed");
  if (SELFTEST) await b.key(",", "Comma", 188);
  const boughtAt = Date.now();
  say("You own a capital.");
  log("bought", { tile: bought });
  if (SELFTEST) {
    const p1 = await panel();
    R.check("after buying: the panel is gone", p1 === null, JSON.stringify(p1));
    const c1 = await globalThis.__capFn();
    R.check(
      "the troop maximum rose by half the +400K bonus (a new capital is at 50%)",
      c1.strength >= 50 &&
        c1.max - globalThis.__cap0.max > 150_000 &&
        c1.max - globalThis.__cap0.max < 260_000,
      JSON.stringify({ before: globalThis.__cap0, after: c1 }),
    );
    if (NO_RAID && !NUKES) {
      await b.key(".", "Period", 190);
      const full = await waitUntil(
        async () =>
          (await globalThis.__capFn()).strength >= 100
            ? await globalThis.__capFn()
            : null,
        120_000,
        1500,
      );
      await b.key(",", "Comma", 188);
      R.check(
        "after 3 minutes of match time the whole +400K is in",
        !!full &&
          full.max - globalThis.__cap0.max > 380_000 &&
          full.max - globalThis.__cap0.max < 460_000,
        JSON.stringify({ before: globalThis.__cap0, full }),
      );
    }
  }
  if (SELFTEST && NUKES) {
    // The scripted player defends: a SAM launcher (needs no capital) beside the capital.
    await inject("window.__cid", {
      type: "build_unit",
      unit: "SAM Launcher",
      tile: 612071 + 2,
    });
  }

  if (NUKES) {
    void (async () => {
      // the raider's side: a capital, a silo, then a bomb on you every 40 s
      for (let k = 0; k < 8 && alive(); k++) {
        await inject("window.__p2", {
          type: "found_capital",
          tile: 612080 + [0, 1, -1, 2, -2, 3, -3, 4][k],
        });
        await sleep(2500);
        if ((await g.J(`window.__pl[window.__p2].capitalTile`)) >= 0) break;
      }
      await inject("window.__p2", {
        type: "build_unit",
        unit: "Missile Silo",
        tile: 612082,
      });
      say("The raider has a capital and a silo.");
      await sleep(20000);
      while (alive()) {
        const target =
          (await g.J(`window.__pl[window.__cid].capitalTile`)) ?? 612071;
        await inject("window.__p2", {
          type: "build_unit",
          unit: "Atom Bomb",
          tile: target >= 0 ? target : 612071,
        });
        log("raider_nuke", { target });
        say("The raider launches an atom bomb at you.");
        await sleep(40000);
      }
    })();
  }

  if (SELFTEST && NUKES) {
    await b.key(".", "Period", 190); // faster, so that two bombs arrive
    const msgs = await waitUntil(
      async () => {
        const m = await g.J(
          `(window.__msgs||[]).filter(x=>/missile_intercepted|sam_missed/.test(x.m)||/nuke/i.test(x.m)).map(x=>x.m)`,
        );
        return (m ?? []).some((x) => /missile_intercepted/.test(x)) ? m : null;
      },
      150_000,
      2000,
    );
    await b.key(",", "Comma", 188);
    const launched = await g.J(
      `(window.__log||[]).filter(l=>l.k==='injected'&&l.v.what.includes('build_unit')).length`,
    );
    R.check(
      "SAM counterplay: a SAM launcher (no capital needed) shot down a bomb the raider launched with its own silo",
      !!msgs,
      JSON.stringify(msgs) + " injected build_unit batches: " + launched,
    );
  }
  if (!NO_RAID) {
    await sleep(RAID_AFTER * 1000);
    if (!alive()) throw new Error("the window was closed");
    say("The raider attacks your capital.");
    let cap = null;
    for (let round = 1; round <= 3 && !cap && alive(); round++) {
      cap = await assault(g, inject);
      if (!cap) say(`You held (round ${round}). The raider tries again.`);
    }
    if (cap) {
      await callOffRaider(g, inject);
      say(
        "Your capital has fallen: CRISIS. Watch the announcement, the panel and your troops.",
      );
      log("fallen", cap);
      if (SELFTEST) {
        await sleep(2500);
        const me = await mine();
        const p = await panel();
        R.check(
          "the CRISIS began (and the panel's strain text says there is none during it)",
          me.crisisEnd > 0 && /No strain/.test(p?.strain || ""),
          JSON.stringify({ crisisEnd: me.crisisEnd, strain: p?.strain }),
        );
        // a replacement: refused during the wait, accepted after it
        await inject("window.__cid", { type: "found_capital", tile: 612071 });
        await sleep(2500);
        const early = (await mine()).capitalTile;
        R.check(
          "a replacement bought at once is refused (30 s wait)",
          early === -1,
          String(early),
        );
        await b.key(".", "Period", 190);
        await sleep(12000);
        await b.key(",", "Comma", 188);
        // Accepted: it is being built (30 s), then it stands.
        const building = () =>
          g.J(
            `(()=>{ const p=document.querySelector('capital-markers').game.myPlayer(); return p.isBuildingCapital() })()`,
          );
        for (const off of [0, 1, -1, 2, -2, 3, -3]) {
          await inject("window.__cid", {
            type: "found_capital",
            tile: 612071 + off,
          });
          await sleep(1500);
          if (await building()) break;
        }
        await b.key(".", "Period", 190);
        let after = -1;
        for (let i = 0; i < 60 && after < 0; i++) {
          await sleep(1000);
          after = (await mine()).capitalTile;
        }
        await b.key(",", "Comma", 188);
        R.check(
          "after the wait a replacement is bought, built and standing",
          after >= 0,
          String(after),
        );
      }
    } else {
      say("Your capital held.");
    }
  }

  if (SELFTEST) {
    const errs = await g.J(
      `(window.__log||[]).filter(l=>l.k==='error'||l.k==='rejection')`,
    );
    R.check(
      "no page errors",
      (errs ?? []).length === 0,
      JSON.stringify(errs).slice(0, 200),
    );
    R.summary();
  } else {
    say(
      `The timeline is being written to ${TIMELINE}. Close the window when you are done.`,
    );
    await waitUntil(async () => !alive(), 4 * 3600_000, 5000);
  }
  void boughtAt;
} catch (e) {
  say(`stopped: ${e.message}`);
  if (SELFTEST) R.check("the session ran", false, e.stack || e.message);
  if (SELFTEST) R.summary();
}
if (poll) clearInterval(poll);
b.close();
process.exit(process.exitCode ?? 0);
