import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/client/hud/layers/CrisisOverlay";
import type { CrisisOverlay } from "../../../src/client/hud/layers/CrisisOverlay";
import { PlaySoundEffectEvent } from "../../../src/client/sound/Sounds";
import type { GameView } from "../../../src/client/view";

/** A game the overlay can read: only what the engine says, and the clock. */
function makeGame() {
  const s = {
    ticks: 1_000,
    catchingUp: false,
    alive: true,
    /** No land, but a resistance holds the player in the game. */
    limbo: false,
    start: 1_000,
    end: 1_000 + 1_800,
    hasCrisis: true,
    updates: {} as Record<number, unknown[]>,
    me: true,
  };
  const game = {
    ticks: () => s.ticks,
    isCatchingUp: () => s.catchingUp,
    updatesSinceLastTick: () => s.updates,
    myPlayer: () =>
      s.me
        ? {
            hasCrisis: () => s.hasCrisis,
            isAlive: () => s.alive,
            isInLimbo: () => s.limbo,
            crisisStartTick: () => s.start,
            crisisEndTick: () => s.end,
          }
        : null,
  } as unknown as GameView;
  return { s, game };
}

describe("CrisisOverlay", () => {
  let overlay: CrisisOverlay;
  let bus: EventBus;
  let sounds: string[];
  let s: ReturnType<typeof makeGame>["s"];
  let animations: { el: Element; keyframes: Keyframe[]; options: object }[];

  const root = () => overlay.shadowRoot!;
  const q = <T extends Element>(sel: string) => root().querySelector<T>(sel);
  const text = (sel: string) => q(sel)?.textContent?.trim();
  const phase = () => q("section")?.getAttribute("data-crisis-phase");
  const step = async (ticks = 0) => {
    s.ticks += ticks;
    overlay.tick();
    await overlay.updateComplete;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    // WAAPI is not in jsdom: record what is asked of it, and let it finish on cue.
    Element.prototype.animate = function (
      this: Element,
      keyframes: Keyframe[],
      options: object,
    ) {
      const a = { onfinish: null as null | (() => void), cancel() {} };
      animations.push({ el: this, keyframes, options });
      (a as { finish?: () => void }).finish = () => a.onfinish?.();
      return a as unknown as Animation;
    } as never;
    Element.prototype.getAnimations = (() => []) as never;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
    })) as never;

    const made = makeGame();
    s = made.s;
    overlay = document.createElement("crisis-overlay") as CrisisOverlay;
    bus = new EventBus();
    sounds = [];
    bus.on(PlaySoundEffectEvent, (e) => sounds.push(e.effect));
    overlay.game = made.game;
    overlay.eventBus = bus;
    document.body.appendChild(overlay);
  });

  afterEach(() => {
    overlay.remove();
    vi.useRealTimers();
  });

  it("draws nothing while there is no crisis", async () => {
    s.hasCrisis = false;
    await step();
    expect(root().querySelector("section")).toBeNull();
    expect(sounds).toEqual([]);
  });

  it("announces a crisis that has just begun: CRISIS, YOUR CAPITAL HAS FALLEN, and the stinger", async () => {
    await step();
    expect(phase()).toBe("announce");
    expect(text(".title")).toBe("crisis.title");
    expect(text(".sub")).toBe("crisis.capital_has_fallen");
    expect(q(".edge")!.classList.contains("on")).toBe(true);
    expect(q(".flash")!.classList.contains("on")).toBe(true);
    expect(sounds).toEqual(["crisis-capital-lost"]);
    // The title scales into view, settling at the screen's centre.
    const entrance = animations.find((a) => a.el.classList.contains("title"))!;
    const transforms = entrance.keyframes.map((k) => String(k.transform));
    expect(transforms[0]).toContain("scale(");
    expect(transforms[transforms.length - 1]).toContain("scale(");
    // The map jolts, once.
    // (no canvas in this test: the shake is skipped, not an error)
  });

  it("flies the same title to the panel, then reveals CAPITAL LOST, the time and TIME REMAINING", async () => {
    await step();
    const title = q(".title")!;
    // Still announcing: the information is not yet shown.
    expect(q(".info")!.classList.contains("show")).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000); // the hold is over: it flies
    await overlay.updateComplete;
    expect(phase()).toBe("docking");
    expect(text(".sub")).toBe("crisis.capital_has_fallen"); // still fading out
    expect(q(".sub")!.classList.contains("out")).toBe(true);
    const flight = animations[animations.length - 1];
    expect(flight.el).toBe(title);
    expect(String(flight.keyframes[0].transform)).toContain("scale(");
    expect(String(flight.keyframes[1].transform)).toBe("none");

    // The flight ends: the panel is up.
    await vi.advanceTimersByTimeAsync(1_600);
    await overlay.updateComplete;
    expect(phase()).toBe("active");
    expect(q(".sub")).toBeNull();
    expect(q(".info")!.classList.contains("show")).toBe(true);
    expect(text(".status")).toBe("crisis.capital_lost");
    expect(text(".time")).toBe("03:00");
    expect(text(".label")).toBe("crisis.time_remaining");
    // It is the same element all along: nothing was removed and replaced.
    expect(q(".title")).toBe(title);
    expect(text(".title")).toBe("crisis.title");
    expect(q(".dock")!.classList.contains("docked")).toBe(true);
  });

  it("shows the crisis's own length, not an example", async () => {
    s.end = s.start + 3_000; // the five-minute crisis
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await overlay.updateComplete;
    expect(text(".time")).toBe("05:00");
  });

  it("counts down from the match's ticks, and holds when the match does", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(10);
    expect(text(".time")).toBe("02:59");
    const fill = () => q<HTMLElement>(".fill")!.style.transform;
    expect(fill()).toContain("scaleX(0.994");
    // The game is paused: no ticks, so the clock does not move.
    await step(0);
    await step(0);
    expect(text(".time")).toBe("02:59");
    await step(590);
    expect(text(".time")).toBe("02:00");
    expect(fill()).toContain("scaleX(0.666");
  });

  it("shows no announcement after a reconnect, only the panel with the right time", async () => {
    // The crisis began 90 seconds ago; this client has just caught up.
    s.start = s.ticks - 900;
    s.end = s.start + 1_800;
    await step();
    expect(phase()).toBe("active");
    expect(q(".sub")).toBeNull();
    expect(text(".time")).toBe("01:30");
    expect(sounds).toEqual([]); // no stinger, no warning
    expect(animations.filter((a) => a.el.classList.contains("title"))).toEqual(
      [],
    );
  });

  it("stays quiet while the game is catching up, even for a crisis from this very tick", async () => {
    s.catchingUp = true;
    await step();
    expect(phase()).toBe("active");
    expect(sounds).toEqual([]);
  });

  it("does not announce the same crisis twice, but does a new one", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(10);
    await step(10);
    expect(sounds.filter((x) => x === "crisis-capital-lost")).toHaveLength(1);
    // The replacement capital falls: a new crisis begins.
    s.start = s.ticks;
    s.end = s.start + 1_800;
    await step();
    expect(phase()).toBe("announce");
    expect(sounds.filter((x) => x === "crisis-capital-lost")).toHaveLength(2);
  });

  it("warns at 60 s with one pulse and one sound, never flashing the screen", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(1_200 - 10); // 61 s left
    const before = sounds.length;
    expect(q("section")!.getAttribute("data-crisis-level")).toBe("running");
    await step(10); // 60 s
    expect(q("section")!.getAttribute("data-crisis-level")).toBe("warning");
    expect(sounds.slice(before)).toEqual(["crisis-warning"]);
    expect(q(".dock")!.className).toMatch(/pulse-[01]/);
    await step(10);
    await step(10);
    expect(sounds.filter((x) => x === "crisis-warning")).toHaveLength(1);
    // The announcement's screen effects are over; nothing flashes again.
    expect(q(".flash")!.classList.contains("on")).toBe(false);
    expect(q(".edge")!.classList.contains("on")).toBe(false);
  });

  it("turns urgent at 10 s without flashing the whole screen", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(1_700 - 10); // 11 s
    expect(q("section")!.getAttribute("data-crisis-level")).toBe("warning");
    await step(10);
    expect(q("section")!.getAttribute("data-crisis-level")).toBe("urgent");
    expect(q(".dock")!.classList.contains("level-urgent")).toBe(true);
    expect(q(".flash")!.classList.contains("on")).toBe(false);
    expect(q(".edge")!.classList.contains("on")).toBe(false);
  });

  it("does not play the warning for a client that arrives with 30 s left", async () => {
    s.start = s.ticks - 1_500;
    s.end = s.start + 1_800;
    await step();
    await step(10);
    expect(sounds).toEqual([]);
    expect(q("section")!.getAttribute("data-crisis-level")).toBe("warning");
  });

  it("ends into a completed state, then leaves, and eliminates no one", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(1_799); // 1 s left
    expect(text(".time")).toBe("00:01");
    await step(1);
    expect(phase()).toBe("over");
    expect(text(".title")).toBe("crisis.over");
    expect(text(".status")).toBe("crisis.penalties_lifted");
    expect(text(".time")).toBe("00:00");
    expect(sounds.filter((x) => x === "crisis-over")).toHaveLength(1);
    await step(10);
    expect(sounds.filter((x) => x === "crisis-over")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_100);
    await overlay.updateComplete;
    expect(root().querySelector("section")).toBeNull();
    // It does not come back for the same crisis.
    await step(10);
    expect(root().querySelector("section")).toBeNull();
  });

  it("is gone when the match ends or the player is out", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(10);
    expect(root().querySelector("section")).not.toBeNull();
    s.alive = false;
    await step(10);
    expect(root().querySelector("section")).toBeNull();

    s.alive = true;
    s.start = s.ticks;
    s.end = s.start + 1_800;
    await step();
    expect(root().querySelector("section")).not.toBeNull();
    s.updates = { [GameUpdateType.Win]: [{}] };
    await step(10);
    expect(root().querySelector("section")).toBeNull();
  });

  it("keeps showing the crisis of a player with no land whose resistance goes on", async () => {
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    await step(10);
    expect(root().querySelector("section")).not.toBeNull();
    // The last land went with the capital, but they are not out of the game.
    s.alive = false;
    s.limbo = true;
    await step(10);
    expect(root().querySelector("section")).not.toBeNull();
    expect(phase()).toBe("active");
    // Once the resistance is over too, there is nobody left to be in crisis.
    s.limbo = false;
    await step(10);
    expect(root().querySelector("section")).toBeNull();
  });

  it("backs the words under the title with a dark band, so they read on snow as on sea", () => {
    const css = String(
      (overlay.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    const sub = css.match(/\.sub\s*{([^}]*)}/)![1];
    // A band that fades at both ends behind pale text, and an outline.
    expect(sub).toMatch(/background:\s*linear-gradient/);
    expect(sub).toMatch(/rgba\(10,\s*5,\s*0,\s*0\.7\d?\)/);
    expect(sub).toMatch(/text-shadow:[^;]*rgba\(0,\s*0,\s*0,\s*0\.9/);
  });

  it("outlines the title itself in dark, so its orange reads on snow (measured at about 1.2 to 1 without)", () => {
    const css = String(
      (overlay.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    const title = css.match(/\.title\s*{([^}]*)}/)![1];
    // The outline is in em, so it scales with the title through the announcement.
    expect(title).toMatch(
      /-webkit-text-stroke:\s*[\d.]+em\s+rgba\(\d+,\s*\d+,\s*\d+,\s*0\.[89]/,
    );
    // Drawn outside the fill, so it never eats into the letters.
    expect(title).toMatch(/paint-order:\s*stroke fill/);
  });

  it("makes the title's box as wide as its letters, so centring the box centres the letters", () => {
    // Measured in Chrome: the box was as wide as the panel with the letters at its
    // left edge, so the announcement put the box at the centre and the word far
    // to the left of it (jsdom has no layout: this is the CSS that prevents it).
    const css = String(
      (overlay.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    const title = css.match(/\.title\s*{([^}]*)}/)![1];
    expect(title).toMatch(/width:\s*fit-content/);
  });

  it("makes the title's box as wide as its letters, so centring the box centres the letters", () => {
    // Measured in Chrome: the box was as wide as the panel with the letters at its
    // left edge, so the announcement put the box at the centre and the word far
    // to the left of it (jsdom has no layout: this is the CSS that prevents it).
    const css = String(
      (overlay.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    const title = css.match(/\.title\s*{([^}]*)}/)![1];
    expect(title).toMatch(/width:\s*fit-content/);
  });

  it("takes no pointer events, so it never gets between the player and the front", () => {
    const css = String(
      (overlay.constructor as unknown as { styles: { cssText: string } }).styles
        .cssText,
    );
    expect(css).toMatch(/:host\s*{[^}]*pointer-events:\s*none/);
  });

  it("keeps nothing holding the title once its animations end: none fills forwards", async () => {
    // Measured in Chrome: a finished fill:forwards flight sometimes kept the
    // announcement's transform on the title, big at the centre, for good.
    await step();
    await vi.advanceTimersByTimeAsync(5_000);
    const titleAnims = animations.filter((a) =>
      a.el.classList.contains("title"),
    );
    expect(titleAnims.length).toBeGreaterThanOrEqual(2); // entrance and flight
    for (const a of titleAnims) {
      expect(a.options).not.toHaveProperty("fill");
    }
  });

  describe("the size of the title in reduced motion", () => {
    const realRect = Element.prototype.getBoundingClientRect;
    const realWidth = window.innerWidth;
    const realHeight = window.innerHeight;
    afterEach(() => {
      Element.prototype.getBoundingClientRect = realRect;
      Object.defineProperty(window, "innerWidth", {
        value: realWidth,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: realHeight,
        configurable: true,
      });
    });

    // The title is 150 px wide in its panel; the announcement scales it.
    async function announcedWidth(width: number, height: number) {
      window.matchMedia = ((query: string) => ({
        matches: query.includes("reduce"),
        media: query,
      })) as never;
      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: height,
        configurable: true,
      });
      Element.prototype.getBoundingClientRect = function (this: Element) {
        return this.classList.contains("title")
          ? ({
              left: 1000,
              top: 140,
              width: 150,
              height: 28,
              right: 1150,
              bottom: 168,
              x: 1000,
              y: 140,
            } as DOMRect)
          : realRect.call(this);
      };
      await step();
      const title = q<HTMLElement>(".title")!;
      const scale = Number(/scale\(([\d.]+)\)/.exec(title.style.transform)![1]);
      return 150 * scale;
    }

    it("follows the window: resized during the announcement, the title is placed again", async () => {
      await announcedWidth(1000, 800);
      const title = q<HTMLElement>(".title")!;
      const dx = () =>
        Number(/translate\(([-\d.]+)px/.exec(title.style.transform)![1]);
      const before = dx();
      Object.defineProperty(window, "innerWidth", {
        value: 1400,
        configurable: true,
      });
      window.dispatchEvent(new Event("resize"));
      // The title sits at x = 1000..1150 in its panel; the middle of the screen moved by 200.
      expect(dx() - before).toBeCloseTo(200, 0);
    });

    it("leaves no offset behind once it has docked, whatever happened on the way", async () => {
      await announcedWidth(1000, 800);
      const title = q<HTMLElement>(".title")!;
      await vi.advanceTimersByTimeAsync(5_000);
      await overlay.updateComplete;
      expect(phase()).toBe("active");
      // Something (a stale layout, a second placement) puts one back...
      title.style.transform = "translate(-300px, 40px) scale(6)";
      await step(1);
      // ...and the next tick takes it off.
      expect(title.style.transform).toBe("");
    });

    it("is a third of a wide screen", async () => {
      expect(await announcedWidth(1920, 1080)).toBeCloseTo(1920 * 0.34, 0);
    });

    it("is never a smaller headline than the one in the panel, however narrow the screen", async () => {
      // A phone's third would be 133 px: smaller than the 150 px title it flies to.
      const w = await announcedWidth(390, 844);
      expect(w).toBeGreaterThanOrEqual(219.5);
      expect(w).toBeLessThanOrEqual(390 * 0.8);
    });
  });

  it("with reduced motion: the same words, but no scale, flash or flight", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
    })) as never;
    await step();
    expect(phase()).toBe("announce");
    expect(text(".sub")).toBe("crisis.capital_has_fallen");
    const titleAnims = animations.filter((a) =>
      a.el.classList.contains("title"),
    );
    // Only a fade: no transform keyframes at all.
    expect(
      titleAnims.every((a) => a.keyframes.every((k) => !("transform" in k))),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(3_100);
    await overlay.updateComplete;
    expect(phase()).toBe("active");
    expect(text(".time")).toBe("03:00");
  });
});
