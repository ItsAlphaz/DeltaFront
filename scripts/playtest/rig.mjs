// The rig for the human playtest sessions (docs/PreReleasePlaytest.md, H1 to H5).
//
//   node scripts/playtest/rig.mjs <session> [flags]
//
// It opens a maximized Chrome with sound on, sets a scenario up in the real
// game, plays the OTHER side from a script, and writes a timeline of what
// happened (state, messages, orders, the CRISIS clock) so that a vague "it felt
// off at about minute 4" can be looked up afterwards. You play with your own mouse.
//
// Sessions
//   solo          the real Solo screen (the Capital System is on by default); you play nations
//   defender      you are the defender: a scripted raider takes your capital, then
//                   --raider thin     stays busy elsewhere (its home army is thin: unrest can rise)
//                   --raider strong   stays home (its army recovers: unrest only falls)
//                   --raider counter  keeps attacking what is left of your land
//                 --assault-at <tick>  when it strikes (default 900 = a minute and a half)
//   occupier      you are the occupier: you take the scripted defender's capital (--auto-assault
//                 does it for you at --assault-at, default 700) and she resists on a script
//   presentation  you set the camera (pan, zoom: snow, sea, land) and the capital falls
//                 after --delay <seconds> (default 90): look at the CRISIS announcement
//
// Flags: --url <page> (default http://localhost:9000/, your dev client; it is current
// because Vite reloads, but your dev GAME SERVER may be stale: Solo does not use it),
// --no-sound, --reduced-motion (emulate the system preference), --selftest (a scripted
// player checks the rig itself and exits).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUT,
  URL_BASE,
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
} from "./game.mjs";

const argv = process.argv.slice(2);
const session = argv[0];
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : dflt;
};
const has = (name) => argv.includes(name);
if (!["solo", "defender", "occupier", "presentation"].includes(session)) {
  console.log(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .slice(1, 33)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
  process.exit(2);
}
const SELFTEST = has("--selftest");
const RAIDER = flag("--raider", "thin");
const ASSAULT_AT = Number(
  flag("--assault-at", session === "occupier" ? 700 : 900),
);
const AUTO_ASSAULT = session === "occupier" ? !has("--no-auto-assault") : false;
const DELAY = Number(flag("--delay", 90));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const TIMELINE = join(OUT, `rig-${session}-${stamp}.jsonl`);
writeFileSync(TIMELINE, "");
const R = reporter(`rig self-test (${session})`);

// ---- English text for the timeline
const EN = JSON.parse(
  readFileSync(
    new URL("../../resources/lang/en.json", import.meta.url),
    "utf8",
  ),
);
const english = (key, params) => {
  let s = key.split(".").reduce((o, k) => (o ? o[k] : undefined), EN) ?? key;
  for (const [k, v] of Object.entries(params ?? {}))
    s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

const t0 = Date.now();
const clock = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const say = (s) => console.log(`[${clock()}] ${s}`);
let lastTick = 0;
const log = (kind, data = {}, show = false) => {
  appendFileSync(
    TIMELINE,
    JSON.stringify(
      { at: new Date().toISOString(), tick: lastTick, kind, ...data },
      (k, v) => (typeof v === "bigint" ? String(v) : v),
    ) + "\n",
  );
  if (show)
    say(`${kind}: ${typeof show === "string" ? show : JSON.stringify(data)}`);
};

const g = await openGame({
  url: flag("--url", URL_BASE),
  mute: has("--no-sound") || SELFTEST,
  keepWindowSize: true,
  noClick: session === "solo",
  reducedMotion: has("--reduced-motion"),
  args: SELFTEST ? [] : ["--start-maximized"],
});
const { b } = g;
process.on("SIGINT", () => {
  say("stopping");
  b.close();
  process.exit(0);
});
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

// ---- the timeline: state every 5 s, messages and capital events as they come, the CRISIS clock
let msgIdx = 0;
let lastBands = "";
let lastCrisis = "";
let lastWins = 0;
let capSeen = false;
async function poll(forceState = false) {
  const s = await g.J(`(()=>{
    const cm=document.querySelector('capital-markers'); const game=cm&&cm.game; const mp=game&&game.myPlayer&&game.myPlayer();
    if (mp) window.__mySmall = mp.smallID();
    const S=window.__stats||{}; const ins=window.__ins||{};
    const me=window.__mySmall; const dock=document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.dock');
    return { tick:window.__lastTick, me, stats:S, ins: Object.fromEntries(Object.entries(ins).map(([k,v])=>[k,{phase:v.phase, funds:v.funds, avail:v.available, pend:v.pending.length, bases:v.bases.length, ops:v.operations.length, reclaimed:v.reclaimed, deadline:v.deadline, limbo:v.limboDeadline, regions:v.regions.map(r=>[r.id,r.status,r.band])}])),
      crisis: dock? {ph:dock.dataset.crisisPhase, lvl:dock.dataset.crisisLevel, time:(dock.querySelector('.time')||{}).textContent} : null,
      msgs:(window.__msgs||[]).slice(${msgIdx}), nmsgs:(window.__msgs||[]).length,
      cap:(window.__log||[]).filter(l=>l.k==='capital').map(l=>l.v), wins:(window.__wins||[]).length, errs:(window.__log||[]).filter(l=>l.k==='error'||l.k==='rejection').length };
  })()`);
  if (!s || s.tick === undefined) return null;
  lastTick = s.tick;
  for (const m of s.msgs ?? [])
    log(
      "msg",
      { key: m.m, text: english(m.m, m.p), to: m.pid },
      `${english(m.m, m.p)}`,
    );
  msgIdx = s.nmsgs ?? msgIdx;
  for (const c of s.cap ?? []) {
    if (c.kind === "captured" && !capSeen) {
      capSeen = true;
      log(
        "capital",
        { event: c },
        `CAPITAL CAPTURED (owner ${c.owner}, captor ${c.captor}, CRISIS until tick ${c.crisisEnd})`,
      );
    }
  }
  const crisisKey = s.crisis ? `${s.crisis.ph}/${s.crisis.lvl}` : "";
  if (crisisKey !== lastCrisis) {
    lastCrisis = crisisKey;
    log(
      "crisis",
      { ...s.crisis },
      `CRISIS panel ${crisisKey} ${s.crisis?.time ?? ""}`,
    );
  }
  const mine = s.ins?.[s.me];
  const bands = mine
    ? mine.regions.map((r) => `${r[0]}:${r[1]}:${r[2]}`).join(",")
    : "";
  if (bands !== lastBands) {
    lastBands = bands;
    log(
      "regions",
      { regions: mine?.regions },
      mine ? `regions (id:status:band) ${bands}` : false,
    );
  }
  if ((s.wins ?? 0) > lastWins) {
    lastWins = s.wins;
    log("win", {}, "THE MATCH HAS ENDED");
  }
  if (forceState) {
    const me = s.stats?.[s.me];
    const others = Object.entries(s.stats ?? {}).filter(
      ([k]) => Number(k) !== s.me,
    );
    log("state", {
      me: s.me,
      stats: s.stats,
      resistance: mine,
      crisis: s.crisis,
    });
    say(
      `tick ${s.tick}  you: ${me ? `${me.tiles} tiles, ${Math.round(me.troops / 10)} troops, ${me.gold} gold` : "-"}  ${others
        .slice(0, 3)
        .map(
          ([k, v]) =>
            `#${k}: ${v.tiles} tiles ${Math.round(v.troops / 10)} troops`,
        )
        .join(
          "  ",
        )}${mine ? `  resistance: funds ${mine.funds}, reserve ${Math.round(mine.avail / 10)}` : ""}${s.crisis ? `  CRISIS ${s.crisis.time}` : ""}`,
    );
  }
  return s;
}
let pollTimer = null;
const startPolling = () => {
  let n = 0;
  pollTimer = setInterval(() => {
    if (alive()) void poll(++n % 5 === 0);
  }, 1000);
};

// ---- the scripted raider and defender
const occupiedRegions = (v) => (v?.regions ?? []).filter((r) => r.status === 1);
async function occupy(inject, victimId) {
  // small pushes, each judged at the next unrest update, until a region is occupied and the player still has land
  for (let i = 0; i < 14 && alive(); i++) {
    const me = await g.J(`window.__ins && window.__ins[window.__mySmall]`);
    const t = (await stats(g)).tiles;
    if (occupiedRegions(me).length >= 1 && t >= 100) break;
    if (t < 100) break;
    await inject("window.__p2", {
      type: "attack",
      targetID: victimId,
      troops: 12000,
    });
    await sleep(5600);
  }
  await callOffRaider(g, inject);
}
async function raiderBehaviour(inject, victimId) {
  if (RAIDER === "thin") {
    await keepRaiderBusy(g);
    say("the raider stays busy elsewhere: its home army is thin");
  } else if (RAIDER === "counter") {
    say("the raider keeps attacking what is left of your land");
    void (async () => {
      while (alive()) {
        await sleep(5000);
        const mine = await stats(g, "cid");
        const foeS = await stats(g, "p2");
        if (mine && mine.tiles > 0 && foeS && foeS.troops > 40000) {
          await inject("window.__p2", {
            type: "attack",
            targetID: victimId,
            troops: Math.floor(foeS.troops * 0.25),
          });
        }
      }
    })();
  } else {
    say("the raider stays home: its army will recover");
  }
}
// the scripted defender (occupier session): a base where a region is restless, recruits, an uprising when one can run
async function defenderPolicy(inject) {
  const p2small = await g.ev(`window.__pl[window.__p2].small`);
  while (alive()) {
    await sleep(3000);
    const tk = await tick(g);
    const v = await g.J(`window.__ins && window.__ins[${p2small}]`);
    if (!v || v.phase === 0) continue;
    const funds = Number(v.funds);
    const regions = v.regions;
    // a base
    if (v.bases.length < 2 && funds >= 75000) {
      const r = occupiedRegions(v)
        .filter((x) => x.band >= 1 && !x.hasBase)
        .sort((a, c) => c.band - a.band)[0];
      if (r) {
        const t = await g.J(
          `(()=>{ const game=document.querySelector('capital-markers').game; const W=game.width(), H=game.height(); const cols=Math.ceil(W/32); const row=Math.floor(${r.id}/cols), col=${r.id}%cols; const x0=col*32,y0=row*32; let best=null,bd=1e9; for(let y=y0;y<Math.min(H,y0+32);y++) for(let x=x0;x<Math.min(W,x0+32);x++){ const t=game.ref(x,y); if(!game.isLand(t)||game.ownerID(t)!==window.__mySmall) continue; const d=(x-x0-16)**2+(y-y0-16)**2; if(d<bd){bd=d;best=t;} } return best })()`,
        );
        if (t !== null) {
          await inject("window.__p2", { type: "resistance_base", tile: t });
          log(
            "order",
            { who: "defender (script)", order: "base", region: r.id },
            `the scripted defender founds a base in region ${r.id}`,
          );
        }
      }
    }
    // recruits with what is not needed for an uprising
    const room =
      v.capacity -
      (v.available + v.deployed + v.pending.reduce((a, p) => a + p.troops, 0));
    const spare = funds - 25000;
    if (spare > 10000 && v.pending.length < 3 && room >= 5000) {
      const batch = Math.min(room, Math.floor(spare / 2));
      if (batch >= 5000) {
        await inject("window.__p2", {
          type: "resistance_recruit",
          troops: batch,
        });
        log(
          "order",
          { who: "defender (script)", order: "recruit", troops: batch },
          `the scripted defender recruits ${Math.round(batch / 10)} troops`,
        );
      }
    }
    // an uprising where one is allowed
    for (const r of regions) {
      if (
        r.status !== 1 ||
        r.band < 2 ||
        r.hasOperation ||
        r.cooldownUntil > tk
      )
        continue;
      if (v.operations.length >= 2 || v.available < 5000 || funds < 25000)
        break;
      await inject("window.__p2", {
        type: "resistance_uprising",
        region: r.id,
        troops: v.available,
      });
      log(
        "order",
        {
          who: "defender (script)",
          order: "uprising",
          region: r.id,
          troops: v.available,
        },
        `the scripted defender launches an uprising in region ${r.id}`,
      );
      break;
    }
  }
}

try {
  if (session === "solo") {
    say(
      "The real homepage is open. Click Solo, pick a small map with many nations, leave the Capital System at its default (on), and play.",
    );
    say(
      "Find your capital marker (a round badge with a house). Capture a nation's capital: you should see the gold banner once, hear the capture cue and the coin, and be paid.",
    );
    startPolling();
    await waitUntil(async () => !alive(), 4 * 3600_000, 5000);
  } else {
    const occ = session === "occupier";
    const { inject } = await startMatch(g, {
      startingGold: 3000000,
      myName: "You",
      foeName: occ ? "Defender" : "Raider",
    });
    startPolling();
    say(
      `The match has started. You are the ${occ ? "occupier (you attack)" : session === "presentation" ? "defender (set your view)" : "defender"}. Your capital is the round badge with a house.`,
    );
    if (SELFTEST) await g.b.key(".", "Period", 190);
    if (session === "presentation") {
      await regen(g);
      say(
        `Pan and zoom the map now (snow, sea, land under the middle of the screen). The capital falls in ${DELAY} seconds.`,
      );
      const until = Date.now() + (SELFTEST ? 3000 : DELAY * 1000);
      let said = 0;
      while (Date.now() < until && alive()) {
        const left = Math.round((until - Date.now()) / 1000);
        if ([60, 30, 10, 5].includes(left) && left !== said) {
          said = left;
          say(`the fall in ${left} s`);
        }
        await sleep(500);
      }
    } else {
      await waitUntil(
        async () => (await tick(g)) >= ASSAULT_AT,
        20 * 60_000,
        1000,
      );
    }
    if (!alive()) throw new Error("the window was closed");
    say(
      session === "occupier" && !AUTO_ASSAULT
        ? "Take the Defender's capital yourself (set the attack slider high, click her land at the border)."
        : "The assault begins.",
    );
    let cap = null;
    if (occ) {
      if (AUTO_ASSAULT) {
        const victim = await g.ev(`window.__pl[window.__p2].id`);
        const mine = (await stats(g, "cid")).troops;
        for (let i = 0; i < 1500 && !cap && alive(); i++) {
          if (i % 25 === 0)
            await inject("window.__cid", {
              type: "attack",
              targetID: victim,
              troops: Math.floor(mine * 0.95),
            });
          await sleep(80);
          cap = await g.J(
            `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
          );
        }
      } else {
        cap = await waitUntil(
          () =>
            g.J(
              `(window.__log.find(l=>l.k==='capital'&&l.v.kind==='captured')||{}).v || null`,
            ),
          30 * 60_000,
          1000,
        );
      }
      if (cap) {
        say(
          "You have the capital. The Defender resists from here, by script: a base, recruits, an uprising when a region allows one.",
        );
        void defenderPolicy(inject);
      }
    } else {
      for (let round = 1; round <= 3 && !cap && alive(); round++) {
        cap = await assault(g, inject);
        if (!cap) say(`You held (round ${round}). The raider tries again.`);
      }
      if (cap) {
        await callOffRaider(g, inject);
        if (session === "defender") {
          const victim = await g.ev(`window.__pl[window.__cid].id`);
          await occupy(inject, victim);
          await raiderBehaviour(inject, victim);
        }
        say(
          "Your capital has fallen. Watch the CRISIS announcement, then Resistance Command on the left.",
        );
      }
    }
    if (SELFTEST) {
      await sleep(20000);
      const lines = readFileSync(TIMELINE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const kinds = new Set(lines.map((l) => l.kind));
      R.check(
        "the match started and the capital fell",
        !!cap,
        JSON.stringify(cap),
      );
      R.check(
        "the timeline recorded the capital event, messages and state",
        kinds.has("capital") && kinds.has("msg") && kinds.has("state"),
        [...kinds].join(","),
      );
      if (!occ) R.check("the CRISIS panel was noted", kinds.has("crisis"), "");
      if (occ)
        R.check(
          "the scripted defender acted (a base or a recruit)",
          lines.some((l) => l.kind === "order"),
          `${lines.filter((l) => l.kind === "order").length} orders`,
        );
      const errs = await g.J(
        `(window.__log||[]).filter(l=>l.k==='error'||l.k==='rejection')`,
      );
      R.check(
        "no page errors",
        (errs ?? []).length === 0,
        JSON.stringify(errs).slice(0, 200),
      );
    } else {
      await waitUntil(async () => !alive(), 4 * 3600_000, 5000);
    }
  }
} catch (e) {
  say(`stopped: ${e.message}`);
  if (SELFTEST) {
    R.check("the rig ran", false, e.stack || e.message);
  }
}
if (pollTimer) clearInterval(pollTimer);
say(`The timeline is in ${TIMELINE}`);
if (SELFTEST) R.summary();
b.close();
process.exit(process.exitCode ?? 0);
