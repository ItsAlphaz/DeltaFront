// Injected into every page before its own scripts run (Page.addScriptToEvaluateOnNewDocument).
// It only OBSERVES the game, and queues extra intents for solo matches; it
// changes nothing else. What it collects, all on `window`:
//
//   __log     [{t, k, v}] sounds ("audio-start" with its length and the tick), the level at
//             the speakers ("out-peak"), capital events ("capital"), "injected", page errors
//   __tick    the tick of the latest update; __lastTick the same (kept for both uses)
//   __stats   {smallID: {tiles, gold, troops}} from the packed player updates
//   __trace   [[tick, troops, gold]] of the player whose smallID is __mySmall, every update
//   __pl      {clientID: {id, small, capitalTile, crisisStart, crisisEnd, alive, out, ...}}
//   __msgs    [{tick, wall, m, pid, p, mt}] the match's display messages (first 3000)
//   __ins     {ownerSmallID: InsurgencyView} the latest view of every resistance
//   __wins    [{tick, wall}] a Win update has arrived
//   __hash    {tick: hash} every state hash the engine reports (every 10 ticks)
//   __rec     per-frame record of the CRISIS overlay, for ~9.5 s after a capture
//   __timer   a record of the CRISIS overlay every 200 ms while it is up
//   __inject  intents queued here ride the next solo "turn" (solo matches only: in a
//             real match an injected intent would reach one client and desync it)
(() => {
  if (window.__hooked) return;
  window.__hooked = true;
  window.__log = [];
  const L = (k, v) =>
    window.__log.push({ t: Math.round(performance.now()), k, v });

  // ---- sounds: every one the page starts, and a meter on what reaches the speakers
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    L("audio-start", {
      dur: this.buffer ? +this.buffer.duration.toFixed(2) : null,
      ctx: this.context.state,
      rate: +this.playbackRate.value.toFixed(2),
      tick: window.__tick,
      wall: Date.now(),
    });
    return origStart.apply(this, a);
  };
  const analysers = new WeakMap();
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const res = origConnect.call(this, dest, ...rest);
    try {
      if (
        dest instanceof AudioDestinationNode &&
        !analysers.has(this.context)
      ) {
        const an = this.context.createAnalyser();
        an.fftSize = 2048;
        origConnect.call(this, an);
        analysers.set(this.context, an);
        const buf = new Float32Array(an.fftSize);
        setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let p = 0;
          for (const v of buf) p = Math.max(p, Math.abs(v));
          if (p > 0.0005) L("out-peak", { p: +p.toFixed(4), wall: Date.now() });
        }, 100);
      }
    } catch (e) {
      L("meter-err", String(e));
    }
    return res;
  };

  // ---- every update the game worker sends, and intents for it
  const OriginalWorker = window.Worker;
  window.Worker = function (...args) {
    const w = new OriginalWorker(...args);
    const post = w.postMessage.bind(w);
    w.postMessage = function (m, t) {
      if (m && m.type === "turn" && m.turn && window.__inject?.length) {
        const add = window.__inject.splice(0);
        m.turn.intents.push(...add);
        L("injected", {
          tick: window.__tick,
          n: add.length,
          what: add.map((x) => x.type),
        });
      }
      return post(m, t);
    };
    w.addEventListener("message", (e) => {
      const d = e.data;
      if (!d) return;
      const list = d.gameUpdates || (d.gameUpdate ? [d.gameUpdate] : []);
      for (const g of list) {
        const u = g.updates;
        if (!u) continue;
        window.__tick = g.tick;
        window.__lastTick = g.tick;
        // [smallID, tiles, gold, troops, goldEarned] quads
        const ps = g.packedPlayerUpdates;
        if (ps && ps.length) {
          const S = (window.__stats ||= {});
          for (let q = 0; q + 4 < ps.length; q += 5) {
            S[ps[q]] = { tiles: ps[q + 1], gold: ps[q + 2], troops: ps[q + 3] };
            if (ps[q] === window.__mySmall) {
              const T = (window.__trace ||= []);
              T.push([g.tick, ps[q + 3], ps[q + 2]]);
              if (T.length > 30000) T.shift();
            }
          }
        }
        // update types, by their index in GameUpdateType
        for (const m of u[3] || []) {
          const a = (window.__msgs ||= []);
          if (a.length < 3000) {
            a.push({
              tick: g.tick,
              wall: Date.now(),
              m: m.message,
              pid: m.playerID,
              p: m.params,
              mt: m.messageType,
            });
          }
        }
        if (u[12]?.length) {
          (window.__wins ||= []).push({ tick: g.tick, wall: Date.now() });
        }
        for (const h of u[13] || []) (window.__hash ||= {})[h.tick] = h.hash;
        for (const ce of u[26] || []) {
          if (ce.kind === "captured") {
            window.__recUntil = performance.now() + 9500;
          }
          L("capital", {
            wall: Date.now(),
            tick: g.tick,
            kind: ce.kind,
            owner: ce.owner,
            captor: ce.captor,
            id: ce.capitalId,
            gold: String(ce.rewardGold),
            troops: ce.rewardTroops,
            crisisEnd: ce.crisisEndTick,
          });
        }
        for (const st of u[27] || [])
          (window.__ins ||= {})[st.view.owner] = st.view;
        for (const p of u[2] || []) {
          const r = ((window.__byId ||= {})[p.id] ||= {});
          if (p.clientID) {
            r.clientID = p.clientID;
            (window.__pl ||= {})[p.clientID] = r;
          }
          r.id = p.id;
          if (p.smallID !== undefined) r.small = p.smallID;
          if (p.capitalTile !== undefined) r.capitalTile = p.capitalTile;
          if (p.crisisStartTick !== undefined)
            r.crisisStart = p.crisisStartTick;
          if (p.crisisEndTick !== undefined) r.crisisEnd = p.crisisEndTick;
          if (p.isAlive !== undefined) r.alive = p.isAlive;
          if (p.outgoingAttacks !== undefined) {
            r.out = p.outgoingAttacks.map((a) => ({
              id: a.id,
              t: a.targetID,
              tr: Math.round(a.troops),
              ret: a.retreating,
            }));
          }
          if (p.troops !== undefined) r.troops = p.troops;
          if (p.gold !== undefined) r.gold = String(p.gold);
          if (p.tilesOwned !== undefined) r.tiles = p.tilesOwned;
          if (p.clientID && p.smallID !== undefined) {
            (window.__small ||= {})[p.clientID] = p.smallID;
            if (p.clientID === window.__cid) window.__mySmall = p.smallID;
          }
        }
      }
    });
    return w;
  };
  window.Worker.prototype = OriginalWorker.prototype;

  // ---- the CRISIS overlay: every frame for ~9.5 s after a capture, and every 200 ms while it is up
  const snap = (root, now) => {
    const dock = root.querySelector(".dock");
    if (!dock) return null;
    const q = (s) => root.querySelector(s);
    const rect = (e) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const op = (e) => (e ? +(+getComputedStyle(e).opacity).toFixed(2) : null);
    return {
      t: Math.round(now),
      wall: Date.now(),
      tick: window.__tick,
      ph: dock.dataset.crisisPhase,
      lvl: dock.dataset.crisisLevel,
      cls: dock.className,
      title: rect(q(".title")),
      titleOp: op(q(".title")),
      sub: rect(q(".sub")),
      subOp: op(q(".sub")),
      dock: rect(dock),
      edge: op(q(".edge")),
      flash: op(q(".flash")),
      time: q(".time")?.textContent.trim() ?? null,
      status: q(".status")?.textContent.trim(),
    };
  };
  requestAnimationFrame(function frame(now) {
    if (window.__recUntil && now < window.__recUntil) {
      const root = document.querySelector("crisis-overlay")?.shadowRoot;
      const r = root && snap(root, now);
      if (r) (window.__rec ||= []).push(r);
    }
    requestAnimationFrame(frame);
  });
  setInterval(() => {
    const root = document.querySelector("crisis-overlay")?.shadowRoot;
    const r = root && snap(root, performance.now());
    if (!r) return;
    const a = (window.__timer ||= []);
    a.push(r);
    if (a.length > 8000) a.shift();
  }, 200);

  window.addEventListener("error", (e) => L("error", String(e.message)));
  window.addEventListener("unhandledrejection", (e) =>
    L("rejection", String(e.reason)),
  );
})();
