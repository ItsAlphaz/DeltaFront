// The match settings in the real screens (plan rows 5.2 to 5.4): the Solo screen, the
// Create Match screen against a real game server, and the public lobby feed.
//
//   scripts/playtest/stack.sh node scripts/playtest/modals.mjs
//
// It needs a server running current code (the private stack is one): a dev server
// that was started before the Capital System's server code landed does not know
// the setting, and a lobby on it has none.
import { OUT, URL_BASE, reporter, sleep } from "./game.mjs";
import { launch } from "./lib.mjs";

void OUT;
const { check, summary } = reporter("match settings");
const b = await launch({});

const rectOf = (sel, text) =>
  b.ev(
    `(()=>{ const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>((e.textContent||'').replace(/\\s+/g,' ').trim()).toLowerCase().includes(${JSON.stringify(text.toLowerCase())})); const el=els.sort((a,b)=>a.textContent.length-b.textContent.length)[0]; if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()`,
  );
const clickText = async (sel, text) => {
  const r = await rectOf(sel, text);
  if (!r || r.error) return false;
  await b.clickAt(r.x, r.y);
  return true;
};
const home = async () => {
  await b.send("Page.navigate", { url: URL_BASE });
  await sleep(2500);
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    const r = await b.ev(
      `document.readyState==='complete' && !!document.querySelector('game-mode-selector')`,
    );
    if (r === true) break;
  }
  await sleep(2500);
};
const card = async (modal) =>
  JSON.parse(
    await b.ev(
      `JSON.stringify((()=>{ const root=document.querySelector(${JSON.stringify(modal)}); const cards=[...root.querySelectorAll('game-config-settings div')].filter(e=>(e.textContent||'').trim().startsWith('Capital System')); const el=cards.sort((a,b)=>a.textContent.length-b.textContent.length)[0]; if(!el) return {error:'no card'}; const sel=el.querySelector('select[data-crisis-minutes]'); return {active:/bg-df-red\\/20/.test(el.className), hasSelect:!!sel, options: sel?[...sel.options].map(o=>o.value):null, value: sel?sel.value:null}})())`,
    ),
  );
const chooseWithKeyboard = async (modal, key, code, vk) => {
  await b.ev(
    `(()=>{ const s=document.querySelector('${modal} select[data-crisis-minutes]'); s.scrollIntoView({block:'center'}); s.focus(); return document.activeElement===s })()`,
  );
  await b.key(key, code, vk);
  await sleep(500);
};
// Start Game puts up "GAME IS STARTING" before it dispatches join-lobby: catch the
// event and stop it, and reload the page before the next scenario.
const startAndRead = async () => {
  await b.ev(
    `window.__sent=[]; document.addEventListener('join-lobby', (e)=>{ window.__sent.push(JSON.parse(JSON.stringify(e.detail.gameStartInfo.config))); e.stopImmediatePropagation(); }, true); 1`,
  );
  await clickText(
    "single-player-modal o-button, single-player-modal button",
    "Start Game",
  );
  await sleep(2500);
  return JSON.parse(await b.ev(`JSON.stringify(window.__sent)`));
};

try {
  await b.send("Page.enable");
  await b.send("Runtime.enable");

  // ---- 5.3 the public lobby feed, as the page received it from the real server
  await home();
  const feed = JSON.parse(
    (await b.ev(
      `JSON.stringify((()=>{ const g=document.querySelector('game-mode-selector'); const L=g&&g.lobbies; if(!L) return null; const out=[]; for (const [mode, list] of Object.entries(L.games||{})) for (const x of list) out.push({mode, id:x.gameID, cap:x.gameConfig&&x.gameConfig.capitalSystem===undefined?'absent':x.gameConfig.capitalSystem}); return out; })())`,
    )) ?? "null",
  );
  check(
    "5.3 the page received the public lobby feed from the real server",
    Array.isArray(feed) && feed.length > 0,
    `${feed && feed.length} lobbies`,
  );
  if (Array.isArray(feed)) {
    check(
      "5.3 every public lobby has the Capital System off",
      feed.every((x) => x.cap === "absent" || x.cap.enabled === false),
      `${feed.filter((x) => x.cap === "absent").length}/${feed.length} absent`,
    );
  }

  // ---- 5.2 and 5.4 Solo
  const opened = await clickText("button", "Solo");
  await sleep(2500);
  const c0 = await card("single-player-modal");
  check(
    "5.2 Solo opens from the real button",
    opened && !c0.error,
    JSON.stringify(c0),
  );
  check("5.2 Solo: the Capital System is on by default", c0.active === true);
  check(
    "5.4 Solo: the CRISIS length choice is offered with 3 and 5, 3 selected",
    c0.hasSelect && c0.options.join() === "3,5" && c0.value === "3",
    JSON.stringify(c0),
  );
  let sent = await startAndRead();
  check(
    "5.2 a default Solo start sends capitalSystem {enabled:true} and no crisisMinutes",
    sent.length === 1 &&
      JSON.stringify(sent[0].capitalSystem) === '{"enabled":true}',
    JSON.stringify(sent.map((c) => c.capitalSystem)),
  );

  await home();
  await clickText("button", "Solo");
  await sleep(2500);
  await chooseWithKeyboard("single-player-modal", "ArrowDown", "ArrowDown", 40);
  const v5 = await b.ev(
    `(document.querySelector('single-player-modal select[data-crisis-minutes]')||{}).value`,
  );
  check(
    "5.4 Solo: choosing 5 minutes on the real <select> with the keyboard",
    v5 === "5",
    String(v5),
  );
  sent = await startAndRead();
  check(
    "5.4 Solo: a start with 5 minutes sends {enabled:true, crisisMinutes:5}",
    sent.length === 1 &&
      JSON.stringify(sent[0].capitalSystem) ===
        '{"enabled":true,"crisisMinutes":5}',
    JSON.stringify(sent.map((c) => c.capitalSystem)),
  );

  await home();
  await clickText("button", "Solo");
  await sleep(2500);
  await chooseWithKeyboard("single-player-modal", "ArrowDown", "ArrowDown", 40);
  const cr = await rectOf(
    "single-player-modal game-config-settings div",
    "Capital System",
  );
  await b.clickAt(cr.x, cr.y - cr.h / 2 + 12);
  await sleep(600);
  const c2 = await card("single-player-modal");
  check(
    "5.2 Solo: clicking the card turns the system off and hides the length choice",
    c2.active === false && c2.hasSelect === false,
    JSON.stringify(c2),
  );
  sent = await startAndRead();
  check(
    "5.2 Solo: with it off nothing about the Capital System is sent, whatever length was chosen",
    sent.length === 1 && sent[0].capitalSystem === undefined,
    JSON.stringify(sent.map((c) => c.capitalSystem)),
  );

  // ---- 5.2 and 5.4 Create Match, against the real server's own copy of the lobby
  const serverConfig = async (id) => {
    for (const w of ["w0", "w1", "w2"]) {
      try {
        const r = await fetch(`${URL_BASE}${w}/api/game/${id}`);
        if (r.ok && (r.headers.get("content-type") || "").includes("json"))
          return (await r.json()).gameConfig;
      } catch {
        // not this worker
      }
    }
    return null;
  };
  const waitServer = async (id, pred, ms = 8000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      last = await serverConfig(id);
      if (last && pred(last)) return last;
      await sleep(400);
    }
    return last;
  };
  await home();
  const made = await clickText("button", "Create Lobby");
  let id = null;
  for (let i = 0; i < 30 && !id; i++) {
    await sleep(700);
    const v = await b.ev(
      `(document.querySelector('host-lobby-modal')||{}).lobbyId`,
    );
    if (typeof v === "string" && v.length >= 8) id = v;
  }
  check(
    "5.2 Create Lobby opens from the real button and the server makes a lobby",
    made && !!id,
    String(id),
  );
  await sleep(1500);
  const h0 = await card("host-lobby-modal");
  check(
    "5.2 Create Match: the Capital System is on by default",
    h0.active === true,
    JSON.stringify(h0),
  );
  check(
    "5.4 Create Match: the CRISIS length choice is offered with 3 and 5, 3 selected",
    h0.hasSelect && h0.options.join() === "3,5" && h0.value === "3",
    JSON.stringify(h0),
  );
  let cfg = await waitServer(id, (c) => c.capitalSystem !== undefined);
  check(
    "5.2 the server's lobby has the Capital System on, with no length",
    cfg && JSON.stringify(cfg.capitalSystem) === '{"enabled":true}',
    JSON.stringify(cfg && cfg.capitalSystem),
  );
  await chooseWithKeyboard("host-lobby-modal", "ArrowDown", "ArrowDown", 40);
  cfg = await waitServer(
    id,
    (c) => c.capitalSystem && c.capitalSystem.crisisMinutes === 5,
  );
  check(
    "5.4 the host choosing 5 minutes reaches the server's lobby",
    cfg &&
      JSON.stringify(cfg.capitalSystem) ===
        '{"enabled":true,"crisisMinutes":5}',
    JSON.stringify(cfg && cfg.capitalSystem),
  );
  await b.ev(
    `document.querySelector('host-lobby-modal select[data-crisis-minutes]').focus(); 1`,
  );
  await b.key("ArrowUp", "ArrowUp", 38);
  cfg = await waitServer(
    id,
    (c) => c.capitalSystem && c.capitalSystem.crisisMinutes === undefined,
  );
  check(
    "5.4 the host going back to 3 minutes clears the length on the server",
    cfg && JSON.stringify(cfg.capitalSystem) === '{"enabled":true}',
    JSON.stringify(cfg && cfg.capitalSystem),
  );
} catch (e) {
  console.log("ERR", e.stack || e.message);
  process.exitCode = 1;
}
summary();
b.close();
process.exit(process.exitCode ?? 0);
