import { InsurgencyRegionStatus } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import {
  LIFE_MS,
  RegionEffects,
  SHAKE_MS,
  marches,
  type Seen,
  type Words,
} from "../../../src/client/resistance/RegionEffects";

const words: Words = {
  troops: (n) => `${n / 10}`,
  band: (b) => `band${b}`,
  fx: (k) => `fx_${k}`,
};

function area(over: Partial<Seen> = {}): Seen {
  return {
    id: 1,
    status: InsurgencyRegionStatus.Occupied,
    band: 0,
    hasBase: false,
    hasOperation: false,
    suppressed: false,
    suppressTroops: 0,
    operationTroops: 0,
    note: "",
    ...over,
  };
}

function watch(first: Seen, next: Seen, quiet = false) {
  const fx = new RegionEffects(words);
  fx.observe([first], 0, false);
  fx.observe([next], 100, quiet);
  return fx;
}

describe("RegionEffects", () => {
  it("shows nothing on the first look at an area", () => {
    const fx = new RegionEffects(words);
    fx.observe([area({ suppressed: true, hasBase: true })], 0, false);
    expect(fx.active(10)).toHaveLength(0);
  });

  it("shows nothing while the game is catching up, and does not replay it later", () => {
    const fx = watch(area(), area({ suppressed: true }), true);
    expect(fx.active(120)).toHaveLength(0);
    fx.observe([area({ suppressed: true })], 200, false);
    expect(fx.active(220)).toHaveLength(0);
  });

  it("a suppression shows the troops it cost, with a shake", () => {
    const fx = watch(
      area({ suppressTroops: 45_700 }),
      area({ suppressed: true, suppressTroops: 40_000 }),
    );
    const [e] = fx.active(150);
    expect(e.kind).toBe("suppress");
    expect(e.text).toBe("🛡 -4570");
    expect(e.shakeMs).toBe(SHAKE_MS);
    expect(fx.shake(1, 200, false)).not.toEqual({ dx: 0, dy: 0 });
  });

  it("a hideout, an uprising, a won-back area and a report each say so", () => {
    const base = watch(area(), area({ hasBase: true }));
    expect(base.active(150)[0].kind).toBe("base");
    const up = watch(
      area(),
      area({ hasOperation: true, operationTroops: 300 }),
    );
    expect(up.active(150)[0].text).toBe("⚔ -30");
    const won = watch(area(), area({ status: InsurgencyRegionStatus.Held }));
    expect(won.active(150)[0].kind).toBe("won");
    const note = watch(area(), area({ note: "5 soldiers" }));
    expect(note.active(150)[0].kind).toBe("report");
  });

  it("a hideout lost and a band going up are told too", () => {
    const lost = watch(area({ hasBase: true }), area());
    expect(lost.active(150)[0].kind).toBe("base_lost");
    const angrier = watch(area({ band: 1 }), area({ band: 2 }));
    expect(angrier.active(150)[0].sub).toBe("band2");
  });

  it("effects end after their life", () => {
    const fx = watch(area(), area({ hasBase: true }));
    expect(fx.active(100 + LIFE_MS - 1)).toHaveLength(1);
    expect(fx.active(100 + LIFE_MS)).toHaveLength(0);
  });

  it("the shake dies away and is none in reduced motion", () => {
    const fx = watch(area(), area({ hasBase: true }));
    const early = Math.abs(fx.shake(1, 110, false).dx);
    expect(early).toBeGreaterThan(0);
    expect(fx.shake(1, 100 + SHAKE_MS, false)).toEqual({ dx: 0, dy: 0 });
    expect(fx.shake(1, 110, true)).toEqual({ dx: 0, dy: 0 });
    expect(fx.shake(2, 110, false)).toEqual({ dx: 0, dy: 0 });
  });

  it("the flash fades", () => {
    const fx = watch(area(), area({ hasBase: true }));
    const [e] = fx.active(100);
    expect(fx.flash(e, 100)).toBe(1);
    expect(fx.flash(e, 100 + 700)).toBe(0);
  });

  it("marching borders: one per thing going on, the uprising fastest", () => {
    expect(
      marches({ hasOperation: false, suppressed: false, hasBase: false }),
    ).toEqual([]);
    const all = marches({
      hasOperation: true,
      suppressed: true,
      hasBase: true,
    });
    expect(all).toHaveLength(3);
    expect(Math.abs(all[0].speed)).toBeGreaterThan(Math.abs(all[1].speed));
    expect(all[1].speed).toBeLessThan(0);
  });
});
