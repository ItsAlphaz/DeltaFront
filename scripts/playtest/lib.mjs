// A small Chrome DevTools Protocol harness for the playtest scripts: one headed
// Chrome on a throw-away profile, a safe evaluate, and real mouse and key events.
// Nothing here is part of the game; see README.md.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where screenshots, logs and result files go (never the repository). */
export const OUT =
  process.env.PLAYTEST_OUT ?? join(tmpdir(), "deltafront-playtest-out");
mkdirSync(OUT, { recursive: true });

let nextPort = 9400 + Math.floor(Math.random() * 400);

/**
 * Starts Chrome and connects to it.
 *   width, height  the window's size (the page's viewport is whatever the desktop gives it)
 *   mute           false to let the page make sound (the default mutes, for scripts)
 *   args           more Chrome flags
 */
export async function launch(o = {}) {
  const port = o.port ?? nextPort++;
  const profile =
    o.profile ??
    join(tmpdir(), `deltafront-playtest-profile-${Date.now()}-${port}`);
  const args = [
    "--no-sandbox",
    `--window-size=${o.width ?? 1280},${o.height ?? 800}`,
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...(o.mute === false ? [] : ["--mute-audio"]),
    ...(o.args ?? []),
    "about:blank",
  ];
  const log = openSync(join(OUT, `chrome-${port}.log`), "w");
  const chrome = spawn("google-chrome-stable", args, {
    stdio: ["ignore", log, log],
  });
  writeFileSync(join(OUT, `chrome-${port}.pid`), String(chrome.pid));
  let targets;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const events = [];
  const consoleLog = [];
  const listeners = [];
  let closed = false;
  ws.onclose = () => {
    closed = true;
    for (const [, r] of pending) r({ error: { message: "ws closed" } });
    pending.clear();
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => {
      if (closed) return r({ error: { message: "ws closed" } });
      const i = ++id;
      pending.set(i, r);
      ws.send(
        JSON.stringify({
          id: i,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
      return;
    }
    events.push(d);
    if (events.length > 5000) events.shift();
    for (const l of listeners) l(d);
    if (d.method === "Target.attachedToTarget") {
      send("Runtime.enable", {}, d.params.sessionId);
    }
    if (d.method === "Runtime.consoleAPICalled") {
      const t = d.params.args
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      consoleLog.push(d.params.type + ": " + t);
      if (consoleLog.length > 2000) consoleLog.shift();
    }
  };
  /** Evaluate in the page, awaiting a promise, with a timeout; {error} on failure. */
  const ev = async (expression, ms = 15000) => {
    const r = await Promise.race([
      send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      sleep(ms).then(() => ({ timeout: true })),
    ]);
    if (r.timeout) return { error: "timeout" };
    if (r.error) return { error: r.error.message };
    const x = r.result?.exceptionDetails;
    return x
      ? { error: x.exception?.description || x.text }
      : r.result?.result?.value;
  };
  const close = () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
    try {
      process.kill(chrome.pid);
    } catch {
      // already gone
    }
  };
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
      ...extra,
    });
  /** A real mouse click at viewport coordinates. */
  const clickAt = async (x, y) => {
    await mouse("mouseMoved", x, y, { button: "none", clickCount: 0 });
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
  };
  const key = async (k, code, vk) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: k,
        code,
        windowsVirtualKeyCode: vk,
      });
    }
  };
  /** Saves a screenshot to OUT/<name>.png. */
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r.result) {
      writeFileSync(
        join(OUT, `${name}.png`),
        Buffer.from(r.result.data, "base64"),
      );
    }
    return !!r.result;
  };
  return {
    send,
    ev,
    close,
    events,
    consoleLog,
    chrome,
    port,
    mouse,
    clickAt,
    key,
    shot,
    onEvent: (f) => listeners.push(f),
    isClosed: () => closed,
  };
}
