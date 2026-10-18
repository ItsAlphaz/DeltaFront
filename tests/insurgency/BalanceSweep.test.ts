import { InsurgencyRegionStatus } from "@openfront/engine-api/game/GameUpdates";
import {
  CAPITAL_SPEC,
  captureTroopReward,
} from "@openfront/engine-lib/capital/CapitalRules";
import {
  fillPermille,
  regionBounds,
  regionGrid,
} from "@openfront/engine-lib/insurgency/InsurgencyRules";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import type { Game, Player } from "@openfront/engine/game/Game";
import type { Insurgency } from "@openfront/engine/game/InsurgencySystem";
import { appendFileSync, writeFileSync } from "node:fs";
import { buyCapital } from "../capital/helpers";
import { setup } from "../util/Setup";
import { SPEC, human, rect, startEconomy } from "./helpers";

/**
 * A balance sweep, not a test of behaviour: it plays a resistance against
 * occupiers of different strength under the REAL attack and economy rules and
 * writes tables for the pre-release playtest (docs/PreReleasePlaytest.md, rows
 * 2.2 and 2.4). It is skipped in the normal suite (it takes a few minutes).
 *
 *   BALANCE_SWEEP=1 BALANCE_OUT=/tmp/balance.md npx vitest tests/insurgency/BalanceSweep.test.ts --run
 *   (BALANCE_QUICK=1 plays two rows only, to time it.)
 *
 * "Held" runs keep the occupier's army at a fixed fraction of its maximum (the
 * "fill" the unrest rules read) however much it spends: how strong it is. That
 * is the worst case for the resistance, as a suppression or a counter-attack
 * costs the occupier nothing. "Free" runs let the army regenerate by the real
 * rules from the level a big assault leaves it at, which shows how long a
 * window the resistance gets.
 *
 * Two ways to play, both well informed (they read the occupier's army, as a
 * player who paid for intelligence would): "eager" launches an uprising the
 * moment a region allows it with everything in reserve; "patient" waits until
 * the reserve is at least as large as the garrison it would meet, and spends
 * on a base only where a base can help.
 */

const ENABLED = process.env.BALANCE_SWEEP === "1";
const QUICK = process.env.BALANCE_QUICK === "1";
const OUT = process.env.BALANCE_OUT ?? "/tmp/insurgency-balance.md";
const HORIZON = SPEC.survivalTicks + 20;

type Occupier = "passive" | "suppress" | "counter";
type Policy = "eager" | "patient";

interface Scenario {
  /** Side of the defender's square of land, in tiles. */
  aliceSide: number;
  /** The occupier's empire: width x height, east of the defender. */
  bobW: number;
  bobH: number;
  /** The occupier's army as a fraction of its maximum, held or the start of the regeneration. */
  fill: number;
  /** Hold the fill however much is spent. */
  hold: boolean;
  occupier: Occupier;
  policy: Policy;
  /** The resistance starts with this much gold instead of the minimum. */
  funds?: bigint;
}

interface Result {
  scenario: Scenario;
  startForce: number;
  startFunds: bigint;
  t50: number | null;
  peak: number;
  base: number | null;
  uprisings: number;
  committed: number;
  wonPeak: number;
  heldAtEnd: number;
  reclaimed: number;
  end: string;
  fill60: number | null;
  fill85: number | null;
}

const secs = (ticks: number | null) =>
  ticks === null ? "never" : String(Math.round(ticks / 10));
const shown = (n: number) => `${(n / 10 / 1000).toFixed(1)}K`;
const gold = (n: bigint) => `${Number(n / 1000n)}K`;

/** The occupier's tile in `region` nearest its middle, or null. */
function tileFor(game: Game, region: number, holder: Player): number | null {
  const b = regionBounds(
    regionGrid(game.width(), game.height(), SPEC.regionShift),
    region,
  );
  const cx = (b.x0 + b.x1) >> 1;
  const cy = (b.y0 + b.y1) >> 1;
  let best: number | null = null;
  let bestD = Infinity;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const t = game.ref(x, y);
      if (game.owner(t) !== holder || !game.isLand(t)) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
  }
  return best;
}

/** What the occupier's part of `region` holds: its army spread over its land. */
function garrison(game: Game, region: number, holder: Player): number {
  const b = regionBounds(
    regionGrid(game.width(), game.height(), SPEC.regionShift),
    region,
  );
  let here = 0;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (game.owner(game.ref(x, y)) === holder) here++;
    }
  }
  return Math.floor(
    (holder.troops() * here) / Math.max(1, holder.numTilesOwned()),
  );
}

function resistanceActs(
  game: Game,
  alice: Player,
  bob: Player,
  ins: Insurgency,
  policy: Policy,
): void {
  const sys = game.insurgency()!;
  const now = game.ticks();
  const occupied = ins.regions.filter(
    (r) => r.status === InsurgencyRegionStatus.Occupied,
  );
  const strong =
    fillPermille(bob.troops(), game.config().maxTroops(bob)) >=
    SPEC.unrestHighFillPermille;

  // A base in the most restless region that has none. A base only helps where
  // the occupier is not strong, so the patient player does not buy one then.
  const wantBase = policy === "eager" || !strong || alice.numTilesOwned() === 0;
  if (
    wantBase &&
    ins.bases.length < SPEC.maxBases &&
    ins.funds >= SPEC.baseCost + SPEC.uprisingCost
  ) {
    const r = occupied
      .filter(
        (x) =>
          x.unrest >= SPEC.baseMinUnrest &&
          !ins.bases.some((b) => b.region === x.id),
      )
      .sort((a, b) => b.unrest - a.unrest)[0];
    const tile = r === undefined ? null : tileFor(game, r.id, bob);
    if (tile !== null) sys.foundBase(alice, tile);
  }

  // An uprising with everything in reserve.
  for (const r of occupied) {
    if (r.unrest < SPEC.uprisingMinUnrest || now < r.cooldownUntil) continue;
    if (ins.ops.some((o) => o.region === r.id)) continue;
    if (ins.ops.length >= SPEC.maxOperations) break;
    if (ins.available < SPEC.uprisingMinTroops) break;
    if (ins.funds < SPEC.uprisingCost) break;
    if (policy === "patient" && ins.available < garrison(game, r.id, bob)) {
      continue;
    }
    sys.uprising(alice, r.id, ins.available);
  }

  // Recruit with what is not needed for an uprising.
  const pending = ins.recruits.reduce((a, x) => a + x.troops, 0);
  const total =
    ins.available + pending + ins.ops.reduce((a, o) => a + o.committed, 0);
  const room = ins.capacity - total;
  const spare = ins.funds - SPEC.uprisingCost;
  if (spare > 0n && ins.recruits.length < SPEC.maxPendingRecruits) {
    const batch = Math.min(room, Number(spare / SPEC.recruitGoldPerTroop));
    if (batch >= SPEC.recruitMinTroops) sys.recruit(alice, Math.floor(batch));
  }
}

function occupierActs(
  game: Game,
  alice: Player,
  bob: Player,
  ins: Insurgency,
  kind: Occupier,
): void {
  const sys = game.insurgency()!;
  if (kind === "suppress") {
    for (const r of ins.regions) {
      if (r.status === InsurgencyRegionStatus.Occupied) {
        sys.suppress(bob, alice, r.id);
      }
    }
  } else if (kind === "counter" && alice.numTilesOwned() > 0) {
    game.addExecution(
      new AttackExecution(Math.floor(bob.troops() / 4), bob, alice.id(), null),
    );
  }
}

/** Capitals give all their bonuses from the first tick, so a fill is a fill of the real maximum. */
class FullStrengthEngineConfig extends EngineConfig {
  capitalSpec() {
    return { ...CAPITAL_SPEC, rampTicks: 1 };
  }
}

async function play(sc: Scenario): Promise<Result> {
  const game = await setup(
    "big_plains",
    { capitalSystem: { enabled: true } },
    [human("alice"), human("bob")],
    undefined,
    FullStrengthEngineConfig,
  );
  const alice = game.player("alice");
  const bob = game.player("bob");
  const A = sc.aliceSide;
  rect(game, alice, 0, 0, A - 1, A - 1);
  // The capital on the east side, so that taking the east takes it.
  alice.setSpawnTile(game.ref(A - 6, A >> 1));
  rect(game, bob, A, 0, A + sc.bobW - 1, sc.bobH - 1);
  bob.setSpawnTile(game.ref(A + (sc.bobW >> 1), sc.bobH >> 1));
  startEconomy(game, alice, bob);
  // Past the spawn immunity, so that attacks on either side are allowed.
  for (let i = 0; i < game.config().spawnImmunityDuration() + 2; i++) {
    game.executeNextTick();
  }
  // Everyone has bought a capital (alice's on the east side, where she chose it).
  for (const p of [alice, bob]) buyCapital(game, p);
  alice.setTroops(game.config().maxTroops(alice));
  const fillTroops = () => Math.floor(sc.fill * game.config().maxTroops(bob));
  bob.setTroops(fillTroops());

  // The fall: the capital goes first (the resistance takes stock of the land
  // she holds at that moment), then the occupier takes the east 60 % of it.
  // He reaches it by a corridor from his border: a lone tile of his inside her
  // land would be an enclave, which the enclosure rule hands straight back.
  const capital = game.capitals()!.capitalOf(alice)!;
  const capitalY = game.y(capital.tile);
  for (let x = game.x(capital.tile); x < A; x++) {
    bob.conquer(game.ref(x, capitalY));
  }
  game.executeNextTick();
  const ins = game.insurgency()!.of(alice);
  if (ins === null) throw new Error("no resistance started");
  if (sc.funds !== undefined) ins.funds = sc.funds;
  rect(game, bob, Math.floor(A * 0.4), 0, A - 1, A - 1);
  const before = alice.numTilesOwned();

  const r: Result = {
    scenario: sc,
    startForce: ins.startingTroops,
    startFunds: ins.funds,
    t50: null,
    peak: 0,
    base: null,
    uprisings: 0,
    committed: 0,
    wonPeak: 0,
    heldAtEnd: 0,
    reclaimed: 0,
    end: `alive at ${Math.round(HORIZON / 600)} min`,
    fill60: null,
    fill85: null,
  };
  const seenOps = new Set<number>();
  const t0 = game.ticks();
  while (game.ticks() - t0 < HORIZON && ins.status === "active") {
    if (sc.hold) bob.setTroops(fillTroops());
    const now = game.ticks() - t0;
    const top = Math.max(0, ...ins.regions.map((x) => x.unrest));
    r.peak = Math.max(r.peak, top);
    if (r.t50 === null && top >= SPEC.uprisingMinUnrest) r.t50 = now;
    if (r.base === null && ins.bases.length > 0) r.base = now;
    const fill = fillPermille(bob.troops(), game.config().maxTroops(bob));
    if (r.fill60 === null && fill >= SPEC.unrestMidFillPermille) r.fill60 = now;
    if (r.fill85 === null && fill >= SPEC.unrestHighFillPermille)
      r.fill85 = now;
    if (now % 10 === 0) resistanceActs(game, alice, bob, ins, sc.policy);
    if (now % 50 === 0 && now > 0) {
      occupierActs(game, alice, bob, ins, sc.occupier);
    }
    for (const op of ins.ops) {
      if (!seenOps.has(op.id)) {
        seenOps.add(op.id);
        r.uprisings++;
        r.committed += op.committed;
      }
    }
    r.wonPeak = Math.max(r.wonPeak, alice.numTilesOwned() - before);
    game.executeNextTick();
  }
  r.reclaimed = ins.reclaimed;
  r.heldAtEnd = alice.numTilesOwned() - before;
  if (ins.status === "ended") {
    r.end = `${ins.endReason} at ${secs(ins.endTick - t0)} s`;
  }
  return r;
}

function row(x: Result): string {
  const s = x.scenario;
  return [
    s.aliceSide * s.aliceSide,
    s.bobW * s.bobH,
    `${Math.round(s.fill * 100)} % ${s.hold ? "held" : "free"}`,
    s.occupier,
    s.policy,
    `${shown(x.startForce)} / ${gold(x.startFunds)}`,
    secs(x.t50),
    x.peak,
    secs(x.base),
    `${x.uprisings} (${shown(x.committed)})`,
    x.wonPeak,
    x.heldAtEnd,
    x.reclaimed,
    s.hold ? "-" : `${secs(x.fill60)} / ${secs(x.fill85)}`,
    x.end,
  ].join(" | ");
}

const HEAD = [
  "| her tiles | his tiles | his army | occupier | played | start force / purse | unrest 50 at (s) | peak unrest | base at (s) | uprisings (troops) | tiles won (peak) | held at end | regions reclaimed | his army 60 % / 85 % at (s) | end |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

async function section(title: string, grid: Scenario[]): Promise<Result[]> {
  appendFileSync(OUT, `\n## ${title}\n\n${HEAD}\n`);
  const results: Result[] = [];
  for (const sc of QUICK ? grid.slice(0, 2) : grid) {
    const x = await play(sc);
    results.push(x);
    appendFileSync(OUT, `| ${row(x)} |\n`);
  }
  return results;
}

describe.skipIf(!ENABLED)("balance sweep", () => {
  test("plays a resistance against occupiers of every strength", async () => {
    writeFileSync(
      OUT,
      `# Insurgency balance sweep (${new Date().toISOString().slice(0, 10)})\n\n` +
        `Real attack and economy rules; ${Math.round(HORIZON / 600)} minutes of game time per row, from the fall of the capital. ` +
        "The defender loses the east 60 % of her land (capital included); the occupier is east of her. " +
        "Troops are shown as the game shows them (engine units / 10). The purse is the minimum 100K unless stated. " +
        '"held": the occupier\'s army is kept at that share of its maximum however much it spends (worst case for the resistance). ' +
        '"free": its army starts there and regenerates by the real rules. ' +
        "Both ways to play read the occupier's army (as a player who bought intelligence would).\n",
    );
    let rows = 0;

    // 1. Constant strength: who the occupier is, what it does, how the resistance plays.
    const held: Scenario[] = [];
    for (const occupier of ["passive", "suppress"] as Occupier[]) {
      for (const [bobW, bobH] of [
        [55, 55],
        [130, 115],
      ]) {
        for (const fill of [0.15, 0.4, 0.7, 0.95]) {
          for (const policy of ["eager", "patient"] as Policy[]) {
            held.push({
              aliceSide: 64,
              bobW,
              bobH,
              fill,
              hold: true,
              occupier,
              policy,
            });
          }
        }
      }
    }
    rows += (
      await section(
        "1. The occupier's strength held constant (defender 4,096 tiles)",
        held,
      )
    ).length;

    // 2. Free running: right after a big assault, the army regenerates.
    const free: Scenario[] = [];
    for (const fill of [0.2, 0.5]) {
      for (const occupier of ["passive", "suppress", "counter"] as Occupier[]) {
        for (const policy of ["eager", "patient"] as Policy[]) {
          free.push({
            aliceSide: 64,
            bobW: 55,
            bobH: 55,
            fill,
            hold: false,
            occupier,
            policy,
          });
        }
      }
    }
    rows += (
      await section(
        "2. The occupier's army regenerating from where an assault leaves it",
        free,
      )
    ).length;

    // 3. The defender's size and purse, against a middling occupier.
    const sizes: Scenario[] = [];
    for (const aliceSide of [32, 64, 90]) {
      for (const funds of [undefined, 500_000n]) {
        sizes.push({
          aliceSide,
          bobW: 55,
          bobH: 55,
          fill: 0.4,
          hold: true,
          occupier: "passive",
          policy: "patient",
          funds,
        });
      }
    }
    rows += (
      await section(
        "3. The defender's size and purse (occupier held at 40 %, passive)",
        sizes,
      )
    ).length;

    expect(rows).toBeGreaterThan(0);
  }, 1_800_000);

  test("writes the costs, limits and rewards tables", async () => {
    const sp = SPEC;
    const cs = CAPITAL_SPEC;
    const sh = (n: number) => Math.floor(n / 10).toLocaleString("en-US");
    const g = (n: bigint) => n.toLocaleString("en-US");
    const min = (ticks: number) => `${ticks / 600} min`;
    const sec = (ticks: number) => `${ticks / 10} s`;

    // Income and regeneration, measured under the real rules.
    const measure = async (side: number) => {
      const game = await setup(
        "big_plains",
        { capitalSystem: { enabled: true } },
        [human("alice")],
        undefined,
        EngineConfig,
      );
      const alice = game.player("alice");
      rect(game, alice, 0, 0, side - 1, side - 1);
      alice.setSpawnTile(game.ref(side >> 1, side >> 1));
      startEconomy(game, alice);
      for (let i = 0; i < game.config().spawnImmunityDuration() + 2; i++) {
        game.executeNextTick();
      }
      const max = game.config().maxTroops(alice);
      alice.setTroops(Math.floor(max / 2));
      const gold0 = alice.gold();
      const troops0 = alice.troops();
      for (let i = 0; i < 600; i++) game.executeNextTick();
      return {
        tiles: side * side,
        max,
        gold: alice.gold() - gold0,
        regen: alice.troops() - troops0,
        reward: captureTroopReward(cs, max, Math.floor(max / 2)),
      };
    };
    const sizes = [await measure(32), await measure(64), await measure(100)];

    const out: string[] = [];
    out.push(
      "\n## 4. Costs and limits (generated from INSURGENCY_SPEC and CAPITAL_SPEC)\n",
    );
    out.push(
      "Troops are as the game shows them (engine units / 10); gold as is.\n",
    );
    out.push("| What | Cost | Needs / limits | Effect |");
    out.push("| --- | --- | --- | --- |");
    const rows: string[][] = [
      [
        "The resistance (free, automatic)",
        "-",
        `a human with a capital that falls, an army of at least ${sh(sp.startTroopsMin * 10)} shown, one region of at least ${sp.minRegionTiles} tiles; once per player per match`,
        `${sp.startTroopsPercent} % of the fallen army (at most ${sh(sp.startTroopsMax)} shown) is taken from it and rises; total manpower is capped at ${sp.capacityMultiplier}x that`,
      ],
      [
        "Starting purse",
        "-",
        `${sp.startFundsPercentOfGoldEarned} % of all the gold the player ever earned, at least ${g(sp.startFundsMin)}, at most ${g(sp.startFundsMax)}`,
        `then ${sp.incomeSharePercent} % of the owner's income is moved to it while they hold land, ${g(sp.incomeShareMax)} in all; ${g(sp.reclaimFunds)} per region reclaimed`,
      ],
      [
        "Recruit",
        `${sp.recruitGoldPerTroop * 10n} gold per shown troop`,
        `batches of at least ${sh(sp.recruitMinTroops)} shown; at most ${sp.maxPendingRecruits} pending; within the capacity`,
        `arrive after ${sec(sp.recruitTicks)}`,
      ],
      [
        "Base",
        `${g(sp.baseCost)} gold`,
        `a region with unrest of at least ${sp.baseMinUnrest}; one per region; at most ${sp.maxBases}`,
        `+${sp.unrestBaseStep} unrest per update there (not against a strong occupier); an uprising there breaks in next to it; gives a landless player a place to stand`,
      ],
      [
        "Uprising",
        `${g(sp.uprisingCost)} gold + the troops`,
        `unrest of at least ${sp.uprisingMinUnrest}; at least ${sh(sp.uprisingMinTroops)} shown; at most ${sp.maxOperations} at once; ${sec(sp.regionCooldownTicks)} cooldown per region`,
        "an ordinary attack inside the region; survivors come home",
      ],
      [
        "Intel",
        `${g(sp.intelCost)} gold`,
        `${sec(sp.intelCooldownTicks)} cooldown`,
        `exact unrest and garrison of a region for ${sec(sp.intelFreshTicks)}, then only the band`,
      ],
      [
        "Suppress (the occupier)",
        `${sp.suppressPercent} % of its army (at least ${sh(sp.suppressMinTroops)} shown) for ${sec(sp.suppressTicks)}`,
        `at most ${sp.suppressMax} at once; one per region`,
        `${sp.unrestSuppressStep} unrest per update; a base there loses ${sp.suppressBaseDamage} integrity per update; an uprising there loses ${sp.suppressOpAttritionPercent} % of its troops per update; ${sp.suppressReturnPercent} % of the troops come home`,
      ],
      [
        "How long it lasts",
        "-",
        `${min(sp.survivalTicks)}, +${min(sp.survivalExtensionTicks)} for each region reclaimed, never past ${min(sp.survivalMaxTicks)}`,
        `a landless player has ${min(sp.limboTicks)} to win a tile back; a warning ${sec(sp.warnTicks)} before either end`,
      ],
      [
        "Buy a capital (the first, or a replacement)",
        `${g(cs.cost)} gold`,
        `no wait for the first, ${sec(cs.replacementDelayTicks)} after a fall for a replacement; on owned land, off the border; not during the spawn phase`,
        `bonuses start at ${cs.rampStartPercent} % and reach 100 % in ${min(cs.rampTicks)}`,
      ],
      [
        "CRISIS (the owner of a captured capital)",
        "-",
        "3 or 5 minutes, chosen for the match",
        `income and troop regeneration at ${cs.crisisIncomePercent} % / ${cs.crisisRegenPercent} %; a standing capital gives +${cs.bonusIncomePercent} % / +${cs.bonusRegenPercent} % and +${cs.bonusMaxTroops.toLocaleString("en-US")} maximum troops`,
      ],
    ];
    for (const r of rows) out.push(`| ${r.join(" | ")} |`);

    out.push(
      "\n## 5. Capture rewards against ordinary income (measured under the real rules)\n",
    );
    out.push(
      `Capturing a capital pays the captor ${g(cs.captureGold)} gold (${g(cs.captureGoldReplacement)} for a replacement) and ${cs.captureTroopsPercent} % of its maximum army (never past the maximum), once per defender and captor pair, ever. ` +
        "Income and regeneration below are one minute for a player of that size, with no cities or ports, army at half.\n",
    );
    out.push(
      "| land (tiles) | gold per minute | the capture gold is worth | max army (shown) | troop reward (shown) | regeneration per minute (shown) | the troop reward is worth |",
    );
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const m of sizes) {
      const perMin = Number(m.gold);
      const regen = Math.floor(m.regen / 10);
      out.push(
        `| ${m.tiles.toLocaleString("en-US")} | ${g(m.gold)} | ${(Number(cs.captureGold) / perMin).toFixed(1)} min of income | ${sh(m.max)} | ${sh(m.reward)} | ${regen.toLocaleString("en-US")} | ${((m.reward / 10 / Math.max(1, regen)) * 60).toFixed(0)} s of regeneration |`,
      );
    }
    out.push(
      "\nExperience points: 40 per captured human capital, at most 3 a match, once per owner, only after the first two minutes; the per-match tripwire is 1,500 (the true maximum is 1,275).\n",
    );
    appendFileSync(OUT, out.join("\n") + "\n");
    expect(sizes.length).toBe(3);
  }, 120_000);
});
