// The CRISIS announcement at many sizes and densities, over different backgrounds, with reduced motion on/off
// (plan rows 4.2, 4.3, 4.6). Real Chrome, the real game; geometry from the page, contrast measured on real screenshots.
//   scripts/playtest/stack.sh node scripts/playtest/presentation.mjs sizes|backgrounds|motion|all [name,name...]
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUT,
  assault,
  openGame,
  regen,
  reporter,
  sleep,
  startMatch,
} from "./game.mjs";

const mode = process.argv[2] || "all";
const only = (process.argv[3] || "").split(",").filter(Boolean);
const R = reporter("presentation matrix");
const { check, note } = R;
const RESULTS = join(OUT, "presentation-results.jsonl");
writeFileSync(RESULTS, "");

const SIZES = [
  { name: "1080p", w: 1920, h: 1080, dpr: 1 },
  { name: "1440p", w: 2560, h: 1440, dpr: 1 },
  { name: "4k", w: 3840, h: 2160, dpr: 1 },
  { name: "ultrawide", w: 3440, h: 1440, dpr: 1 },
  { name: "laptop-768", w: 1366, h: 768, dpr: 1 },
  { name: "retina-720", w: 1280, h: 720, dpr: 2 },
  { name: "tablet-portrait", w: 768, h: 1024, dpr: 2, mobile: true },
  { name: "phone-portrait", w: 390, h: 844, dpr: 3, mobile: true },
  { name: "phone-landscape", w: 844, h: 390, dpr: 3, mobile: true },
];

// the in-page analysis: contrast of a piece of text against what is around its glyphs, on a real screenshot
const ANALYZE = `
window.__analyze = async (items, dpr) => {
  const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64; });
  const [ia, ib] = await Promise.all([load(window.__A), load(window.__B)]);
  const W = ia.naturalWidth, H = ia.naturalHeight;
  const mk = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); return x; };
  const xa = mk(ia), xb = mk(ib);
  const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const pct = (arr, p) => { if (!arr.length) return null; const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const dil = (m, w, h, r) => {
    const tmp = new Uint8Array(w * h), res = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { let cnt = 0; const row = y * w; for (let x = 0; x < w + r; x++) { if (x < w && m[row + x]) cnt++; if (x - 2 * r - 1 >= 0 && m[row + x - 2 * r - 1]) cnt--; const cx = x - r; if (cx >= 0 && cx < w) tmp[row + cx] = cnt > 0 ? 1 : 0; } }
    for (let x = 0; x < w; x++) { let cnt = 0; for (let y = 0; y < h + r; y++) { if (y < h && tmp[y * w + x]) cnt++; if (y - 2 * r - 1 >= 0 && tmp[(y - 2 * r - 1) * w + x]) cnt--; const cy = y - r; if (cy >= 0 && cy < h) res[cy * w + x] = cnt > 0 ? 1 : 0; } }
    return res;
  };
  const out = [];
  for (const it of items) {
    const x0 = Math.max(0, Math.floor(it.rect.x * dpr)), y0 = Math.max(0, Math.floor(it.rect.y * dpr));
    const w = Math.min(W - x0, Math.ceil(it.rect.w * dpr)), h = Math.min(H - y0, Math.ceil(it.rect.h * dpr));
    if (w <= 2 || h <= 2) { out.push({ name: it.name, error: 'empty rect' }); continue; }
    const A = xa.getImageData(x0, y0, w, h).data, B = xb.getImageData(x0, y0, w, h).data;
    const tc = hex(it.color), Lt = lum(...tc);
    const mask = new Uint8Array(w * h); let nText = 0;
    for (let i = 0; i < w * h; i++) { const d = Math.hypot(A[i * 4] - tc[0], A[i * 4 + 1] - tc[1], A[i * 4 + 2] - tc[2]); if (d < 40) { mask[i] = 1; nText++; } }
    const rad = Math.max(3, Math.round(3 * dpr)); const near = dil(mask, w, h, rad);
    const ringL = [], bgL = []; let br = 0, bg = 0, bb = 0;
    for (let i = 0; i < w * h; i++) {
      const rA = A[i * 4], gA = A[i * 4 + 1], bA = A[i * 4 + 2];
      if (near[i] && !mask[i] && Math.hypot(rA - tc[0], gA - tc[1], bA - tc[2]) > 110) ringL.push(lum(rA, gA, bA));
      bgL.push(lum(B[i * 4], B[i * 4 + 1], B[i * 4 + 2])); br += B[i * 4]; bg += B[i * 4 + 1]; bb += B[i * 4 + 2];
    }
    const ratio = (L1, L2) => { const a = Math.max(L1, L2), b2 = Math.min(L1, L2); return (a + 0.05) / (b2 + 0.05); };
    const ringMed = pct(ringL, 0.5), ringP95 = pct(ringL, 0.95), bgP95 = pct(bgL, 0.95), bgP5 = pct(bgL, 0.05);
    out.push({ name: it.name, textPx: nText, ringPx: ringL.length, bgMeanRGB: [Math.round(br / (w * h)), Math.round(bg / (w * h)), Math.round(bb / (w * h))],
      bgLumP5: bgP5, bgLumMed: pct(bgL, 0.5), bgLumP95: bgP95, ringLumMed: ringMed, ringLumP95: ringP95, textLum: Lt,
      contrastMedian: ringMed === null ? null : ratio(Lt, ringMed), contrastWorst: ringP95 === null ? null : ratio(Lt, ringP95), bareBackgroundWorst: ratio(Lt, bgP95) });
  }
  return out;
};
1`;

const shotB64 = async (b) => {
  const r = await b.send("Page.captureScreenshot", {
    format: "png",
    optimizeForSpeed: true,
  });
  return r.result && r.result.data;
};

async function camera(g, kind) {
  if (kind === "default") return null;
  const found = await g.J(`(()=>{
    const rc = document.querySelector('resistance-command'); const game = rc.game; const W = game.width(), H = game.height();
    const me = window.__pl[window.__cid]; const sx = Math.floor(612071 % W), sy = Math.floor(612071 / W);
    const owned = (x, y) => { const t = game.ref(x, y); return game.ownerID(t) !== 0; };
    let best = null;
    for (let r = 10; r < 500 && !best; r += 6) {
      for (let k = 0; k < 360 && !best; k += 12) {
        const x = Math.round(sx + r * Math.cos(k * Math.PI / 180)), y = Math.round(sy + r * Math.sin(k * Math.PI / 180));
        if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) continue;
        const t = game.ref(x, y);
        if (${JSON.stringify(kind)} === 'sea') { if (game.isOcean(t) && game.magnitude(t) >= 6) best = { x, y }; }
        else { // snow: open land far from any owner
          if (!game.isLand(t)) continue; let ok = true; for (let dy = -12; dy <= 12 && ok; dy += 4) for (let dx = -12; dx <= 12; dx += 4) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) { ok = false; break; } const tt = game.ref(xx, yy); if (!game.isLand(tt) || owned(xx, yy)) { ok = false; break; } }
          if (ok) best = { x, y };
        }
      }
    }
    if (!best) return null;
    rc.transformHandler.onGoToPosition({ x: best.x, y: best.y });
    return best;
  })()`);
  await sleep(3500);
  return found;
}

async function scenario(label, spec, o = {}) {
  const g = await openGame({
    viewport: { width: spec.w, height: spec.h },
    dpr: spec.dpr,
    mobile: spec.mobile,
    reducedMotion: o.reducedMotion,
  });
  const res = {
    label,
    spec,
    camera: o.camera || "default",
    reducedMotion: !!o.reducedMotion,
  };
  try {
    await g.ev(ANALYZE);
    const vp = await g.J(
      `[innerWidth, innerHeight, devicePixelRatio, document.documentElement.scrollWidth, document.documentElement.scrollHeight, matchMedia('(prefers-reduced-motion: reduce)').matches]`,
    );
    res.viewport = {
      w: vp[0],
      h: vp[1],
      dpr: vp[2],
      scrollW: vp[3],
      scrollH: vp[4],
      reduced: vp[5],
    };
    const { inject } = await startMatch(g);
    await regen(g);
    if (o.camera) res.cameraAt = await camera(g, o.camera);
    const cap = await assault(g, inject);
    if (!cap) throw new Error("no capture");
    // the hold: the title at full size
    let hold = null;
    for (let i = 0; i < 40 && !hold; i++) {
      const f = await g.J(
        `(()=>{ const r=document.querySelector('crisis-overlay')?.shadowRoot; const t=r&&r.querySelector('.title'); const d=r&&r.querySelector('.dock'); if(!t||!d) return null; const b=t.getBoundingClientRect(); const cs=getComputedStyle(t); const sub=r.querySelector('.sub'); const sb=sub&&sub.getBoundingClientRect(); return {ph:d.dataset.crisisPhase, op:+cs.opacity, title:{x:b.left,y:b.top,w:b.width,h:b.height}, sub: sb?{x:sb.left,y:sb.top,w:sb.width,h:sb.height,op:+getComputedStyle(sub).opacity}:null, color:cs.color, subColor: sub?getComputedStyle(sub).color:null} })()`,
      );
      if (f && f.ph === "announce" && f.op >= 0.99 && f.sub && f.sub.op >= 0.99)
        hold = f;
      else await sleep(60);
    }
    res.hold = hold;
    if (hold) {
      const A = await shotB64(g.b);
      const hold2 = await g.J(
        `(()=>{ const r=document.querySelector('crisis-overlay')?.shadowRoot; const t=r&&r.querySelector('.title'); if(!t) return null; const b=t.getBoundingClientRect(); return {x:b.left,y:b.top,w:b.width,h:b.height} })()`,
      );
      await g.ev(
        `window.__A = ${JSON.stringify(A)}; (()=>{ const o=document.querySelector('crisis-overlay'); o.style.visibility='hidden'; return 1 })()`,
      );
      await sleep(150);
      const B = await shotB64(g.b);
      await g.ev(
        `window.__B = ${JSON.stringify(B)}; document.querySelector('crisis-overlay').style.visibility=''; 1`,
      );
      res.holdAfter = hold2;
      writeFileSync(
        join(OUT, `presentation-${label}-with.png`),
        Buffer.from(A, "base64"),
      );
      writeFileSync(
        join(OUT, `presentation-${label}-without.png`),
        Buffer.from(B, "base64"),
      );
      const rgb = (c) => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || "");
        return m
          ? "#" +
              [m[1], m[2], m[3]]
                .map((v) => (+v).toString(16).padStart(2, "0"))
                .join("")
          : "#ffffff";
      };
      const items = [
        { name: "title", rect: hold.title, color: rgb(hold.color) },
        {
          name: "subtitle",
          rect: {
            x: hold.sub.x + hold.sub.w * 0.2,
            y: hold.sub.y,
            w: hold.sub.w * 0.6,
            h: hold.sub.h,
          },
          color: rgb(hold.subColor),
        },
      ];
      const rawC = await g.ev(
        `(async()=>JSON.stringify(await window.__analyze(${JSON.stringify(items)}, ${vp[2]})))()`,
        60000,
      );
      try {
        res.contrast = JSON.parse(rawC);
      } catch {
        res.contrast = [{ name: "title", error: String(rawC).slice(0, 120) }];
      }
    }
    await sleep(8500);
    const rec = await g.J(`window.__rec || []`);
    res.phases = [...new Set(rec.map((f) => f.ph))].join(">");
    const sc = await g.J(
      `[document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight, !!document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.dock')]`,
    );
    res.scrollInGame = {
      scrollW: sc[0],
      scrollH: sc[1],
      w: sc[2],
      h: sc[3],
      dockUp: sc[4],
    };
    res.scrollCulprits =
      sc[1] > sc[3] + 1 || sc[0] > sc[2] + 1
        ? await g.J(
            `(()=>{ const out=[]; for (const e of document.body.querySelectorAll('*')) { const cs=getComputedStyle(e); if (cs.position==='fixed') continue; const r=e.getBoundingClientRect(); if (r.bottom>innerHeight+1 || r.right>innerWidth+1) out.push(e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+'.'+String(e.className).slice(0,30)+' ['+Math.round(r.right)+','+Math.round(r.bottom)+'] '+cs.position); } return out.slice(0,10) })()`,
          )
        : [];
    const last = rec[rec.length - 1];
    res.docked = last && {
      dock: last.dock,
      title: last.title,
      time: last.time,
    };
    // the title's motion: how much it moves and scales during the announcement
    const ann = rec.filter((f) => f.ph === "announce" && f.title);
    res.motion = ann.length
      ? {
          frames: ann.length,
          minW: Math.min(...ann.map((f) => f.title.w)),
          maxW: Math.max(...ann.map((f) => f.title.w)),
          xs: [
            Math.min(...ann.map((f) => f.title.x)),
            Math.max(...ann.map((f) => f.title.x)),
          ],
          maxEdge: Math.max(...rec.map((f) => f.edge || 0)),
          maxFlash: Math.max(...rec.map((f) => f.flash || 0)),
        }
      : null;
    // does the docked panel collide with other HUD?
    res.overlaps = await g.J(
      `(()=>{ const d=document.querySelector('crisis-overlay')?.shadowRoot?.querySelector('.dock'); if(!d) return null; const a=d.getBoundingClientRect(); const out=[]; for (const e of document.body.querySelectorAll('*')) { if (!e.tagName.includes('-') || e.tagName==='CRISIS-OVERLAY' || e.tagName==='CAPITAL-MARKERS' || e.tagName==='REGION-OVERLAY') continue; const cs=getComputedStyle(e); if (cs.display==='none' || cs.visibility==='hidden' || cs.pointerEvents==='none') continue; const b=e.getBoundingClientRect(); if (b.width<8||b.height<8||b.width*b.height>0.6*innerWidth*innerHeight) continue; const ox=Math.min(a.right,b.right)-Math.max(a.left,b.left), oy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top); if (ox>2&&oy>2) out.push({tag:e.tagName.toLowerCase(), rect:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)], overlap:[Math.round(ox),Math.round(oy)]}); } return {dock:[Math.round(a.left),Math.round(a.top),Math.round(a.width),Math.round(a.height)], hits: out.slice(0,8)} })()`,
    );
    await g.b.shot(`presentation-${label}`);
  } catch (e) {
    res.error = e.message;
  }
  appendFileSync(RESULTS, JSON.stringify(res) + "\n");
  g.close();
  return res;
}

function judge(res) {
  const L = res.label;
  if (res.error) return check(`${L}: ran`, false, res.error);
  const { viewport: v, hold, docked } = res;
  check(
    `${L}: the announcement runs ${res.reducedMotion ? "announce > active (reduced motion skips the flight)" : "announce > docking > active"}`,
    res.phases ===
      (res.reducedMotion ? "announce>active" : "announce>docking>active"),
    res.phases,
  );
  const sg = res.scrollInGame || {};
  check(
    `${L}: in the game, no horizontal or vertical page scroll appears`,
    sg.scrollW <= sg.w + 1 && sg.scrollH <= sg.h + 1,
    `${sg.scrollW}x${sg.scrollH} in ${sg.w}x${sg.h}; before the match (the homepage) ${v.scrollW}x${v.scrollH}; culprits ${JSON.stringify(res.scrollCulprits)}`,
  );
  if (hold) {
    const t = hold.title;
    check(
      `${L}: the title is fully on screen at its hold`,
      t.x >= -1 && t.y >= -1 && t.x + t.w <= v.w + 1 && t.y + t.h <= v.h + 1,
      JSON.stringify(t) + ` in ${v.w}x${v.h}`,
    );
    check(
      `${L}: the title is centred (within 3% of the width)`,
      Math.abs(t.x + t.w / 2 - v.w / 2) <= 0.03 * v.w,
      `centre ${Math.round(t.x + t.w / 2)} vs ${v.w / 2}`,
    );
    const s = hold.sub;
    check(
      `${L}: the subtitle is fully on screen, under the title`,
      s.x >= -1 &&
        s.x + s.w <= v.w + 1 &&
        s.y + s.h <= v.h + 1 &&
        s.y >= t.y + t.h * 0.5,
      JSON.stringify(s),
    );
    if (res.reducedMotion) {
      // the title fades in at the same place and size: it does not scale or travel during the announcement
      const m = res.motion;
      check(
        `${L}: reduced motion: the title neither scales nor travels during the announcement`,
        m && m.maxW - m.minW <= 2 && m.xs[1] - m.xs[0] <= 2,
        JSON.stringify(m),
      );
      check(
        `${L}: reduced motion: no flash`,
        res.motion.maxFlash < 0.05,
        `flash ${res.motion.maxFlash}`,
      );
    } else {
      check(
        `${L}: the title scales in (it is bigger at its hold than at its start)`,
        res.motion && res.motion.maxW > res.motion.minW * 1.5,
        JSON.stringify(res.motion),
      );
    }
  } else check(`${L}: a hold frame was found`, false, "none");
  if (docked) {
    const d = docked.dock;
    check(
      `${L}: the docked panel is fully on screen at the right edge`,
      d && d.x >= 0 && d.x + d.w <= v.w + 1 && d.y >= 0 && d.y + d.h <= v.h + 1,
      JSON.stringify(d),
    );
  }
  if (res.overlaps && res.overlaps.hits) {
    const bad = res.overlaps.hits.filter(
      (h) => !["game-right-sidebar"].includes(h.tag) || true,
    );
    check(
      `${L}: the docked panel overlaps no other HUD element`,
      bad.length === 0,
      JSON.stringify(bad),
    );
  }
  for (const c of res.contrast || []) {
    if (c.error) {
      check(`${L}: contrast of the ${c.name}`, false, c.error);
      continue;
    }
    const large = c.name === "title" ? 3 : 3; // both are large text (title ~100 px bold, subtitle >= 14 px bold letterspaced); WCAG large text needs 3:1
    check(
      `${L}: the ${c.name} reads: contrast against what surrounds its glyphs (median ${c.contrastMedian && c.contrastMedian.toFixed(1)}, worst ${c.contrastWorst && c.contrastWorst.toFixed(1)}; bare map would give ${c.bareBackgroundWorst.toFixed(1)})`,
      c.textPx > 20 && c.contrastMedian >= large,
      `text px ${c.textPx}, ring px ${c.ringPx}, bg mean rgb ${c.bgMeanRGB}`,
    );
  }
}

const sel = (list) =>
  only.length ? list.filter((s) => only.includes(s.name)) : list;
if (mode === "sizes" || mode === "all")
  for (const sp of sel(SIZES)) {
    note("size " + sp.name);
    judge(await scenario(sp.name, sp));
  }
if (mode === "backgrounds" || mode === "all")
  for (const cam of ["default", "sea", "snow"]) {
    note("background " + cam);
    judge(await scenario("bg-" + cam, SIZES[0], { camera: cam }));
  }
if (mode === "motion" || mode === "all") {
  note("reduced motion");
  judge(await scenario("reduced-motion", SIZES[0], { reducedMotion: true }));
  judge(
    await scenario("reduced-motion-phone", SIZES[7], { reducedMotion: true }),
  );
}
R.summary();
process.exit(0);
