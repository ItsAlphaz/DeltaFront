import { CAPITAL_SPEC } from "@openfront/engine-lib/capital/CapitalRules";
import { occupationDefensePercent } from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { UseRealAttackLogic } from "../util/TestConfig";
import {
  SPEC,
  captureCapital,
  insurgentWorld,
  makeRestless,
  occupyRegion0,
  regionOf,
  run,
} from "./helpers";

/**
 * Land the raider has just taken is hard to retake by simply attacking, and eases as
 * the people turn against it (docs/Insurgency.md): that is what makes the resistance
 * the way back, not a smaller copy of the attack the owner can already make.
 */
async function occupied() {
  const w = await insurgentWorld({}, UseRealAttackLogic);
  captureCapital(w);
  occupyRegion0(w);
  return w;
}

describe("the occupier's extra defence", () => {
  test("is by the area's unrest band: most when calm, none in revolt", () => {
    expect(
      [0, 24, 25, 49, 50, 74, 75, 99, 100].map((u) =>
        occupationDefensePercent(SPEC, u),
      ),
    ).toEqual([200, 200, 140, 140, 80, 80, 30, 30, 0]);
  });

  test("applies to the owner's attacks on occupied land, and to nobody else's", async () => {
    const w = await occupied();
    const sys = w.game.insurgency()!;
    const region = regionOf(w.game, w.alice);
    region.unrest = 10;
    const inside = w.game.ref(10, 5); // bob holds it
    expect(w.game.owner(inside)).toBe(w.bob);
    expect(sys.occupationDefensePercent(w.alice, inside)).toBe(200);
    // Not the occupier's own attacks, nor a bystander's.
    expect(sys.occupationDefensePercent(w.bob, inside)).toBe(0);
    expect(sys.occupationDefensePercent(w.carol, inside)).toBe(0);
    // Not land the owner still holds, nor a region that is not occupied.
    expect(sys.occupationDefensePercent(w.alice, w.game.ref(10, 28))).toBe(0);
    // It eases with unrest, and the view tells the panel.
    for (const [unrest, pct] of [
      [30, 140],
      [60, 80],
      [80, 30],
      [100, 0],
    ] as const) {
      region.unrest = unrest;
      expect(sys.occupationDefensePercent(w.alice, inside)).toBe(pct);
    }
  });

  test("ordinary attacks pay for it: the same attack wins less land the calmer the area", async () => {
    const won = async (unrest: number) => {
      const w = await occupied();
      makeRestless(w.game, w.alice, unrest);
      w.alice.setTroops(300_000);
      w.bob.setTroops(300_000);
      const before = w.alice.numTilesOwned();
      w.game.addExecution(
        new AttackExecution(w.alice.troops() / 2, w.alice, w.bob.id(), null),
      );
      run(w.game, 120);
      return w.alice.numTilesOwned() - before;
    };
    const calm = await won(0);
    const revolt = await won(100);
    expect(revolt).toBeGreaterThan(calm * 1.3);
  });
});

describe("winning land back shortens the CRISIS", () => {
  test("by 30 seconds for each area won back for the first time, never past now", async () => {
    const w = await occupied();
    const caps = w.game.capitals()!;
    const end = caps.crisisOf(w.alice)!.endTick;
    expect(end).toBeGreaterThan(w.game.ticks() + 600);
    // Alice takes her land back by force.
    for (let y = 0; y < 22; y++)
      for (let x = 0; x < 32; x++) w.alice.conquer(w.game.ref(x, y));
    run(w.game, SPEC.unrestInterval * 2);
    const after = caps.crisisOf(w.alice)!.endTick;
    expect(after).toBe(end - SPEC.reclaimCrisisReductionTicks);
    // The same area lost and won again pays nothing more.
    occupyRegion0(w);
    for (let y = 0; y < 22; y++)
      for (let x = 0; x < 32; x++) w.alice.conquer(w.game.ref(x, y));
    run(w.game, SPEC.unrestInterval * 2);
    expect(caps.crisisOf(w.alice)!.endTick).toBe(after);
  });

  test("the CRISIS can never end before the tick it is shortened in, and a finished one is left alone", async () => {
    const w = await occupied();
    const caps = w.game.capitals()!;
    expect(caps.shortenCrisis(w.alice, 1_000_000)).toBe(true);
    expect(caps.crisisOf(w.alice)!.endTick).toBe(w.game.ticks());
    run(w.game, 5);
    expect(caps.inCrisis(w.alice)).toBe(false);
    expect(caps.shortenCrisis(w.alice, 300)).toBe(false);
    expect(caps.shortenCrisis(w.bob, 300)).toBe(false); // none to shorten
    void CAPITAL_SPEC;
  });
});
