// SCRATCH (not for commit): simulates the proposed paid-first-capital design by
// patching the engine in memory, so no game code changes. Runs real AI nations.
import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  CAPITAL_SPEC,
  type CapitalSpec,
} from "@openfront/engine-lib/capital/CapitalRules";
import {
  AttackLogicInput,
  AttackLogicResult,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { CapitalSystem } from "@openfront/engine/game/CapitalSystem";
import { PlayerImpl } from "@openfront/engine/game/PlayerImpl";
import { StatsImpl } from "@openfront/engine/game/StatsImpl";
import type { Game, Player } from "@openfront/engine/game/Game";
import { TestConfig } from "../util/TestConfig";
import { setup } from "../util/Setup";

export interface Strategy {
  label: string;
  /** Cities built before saving starts. */
  preCities: number;
  /** Saving starts at this tick whatever the city count. */
  commitTick: number;
  never?: boolean;
}

export const S = {
  EARLY: { label: "EARLY", preCities: 0, commitTick: 0 },
  CITY1: { label: "CITY1", preCities: 1, commitTick: 99999 },
  CITY2: { label: "CITY2", preCities: 2, commitTick: 99999 },
  MID9: { label: "MID9", preCities: 99, commitTick: 5400 },
  LATE15: { label: "LATE15", preCities: 99, commitTick: 9000 },
  NEVER: { label: "NEVER", preCities: 99, commitTick: 0, never: true },
} satisfies Record<string, Strategy>;

export interface Bonuses {
  income: number;
  regen: number;
  maxTroops: number;
  atkLoss: number;
  /** Flat extra maximum troops while a capital stands. */
  maxFlat?: number;
  /** Percent off City/Port/Factory/DefensePost while a capital stands. */
  discount?: number;
  /** Flat gold per tick while a capital stands. */
  incomeFlat?: number;
}
export interface Ctx {
  proposal: boolean;
  strain: boolean;
  graceTicks: number;
  startGold: bigint;
  bonuses: Bonuses;
  strainSpec: { grace: number; per: number; cap: number };
  gate: boolean;
  nukesOn: Map<string, number>;
  nukesIntercepted: number;
  nukesLaunched: Map<string, number>;
  rampTicks: number;
  reg: Map<string, Strategy>;
  game: Game | null;
  attacker: Player | null;
  boughtAt: Map<string, number>;
  spawnEnd: number;
  firstBuilt: Map<string, Record<string, number>>;
}
export const CTX: Ctx = {
  proposal: true,
  strain: true,
  graceTicks: 6000,
  startGold: 200_000n,
  bonuses: { income: 10, regen: 25, maxTroops: 10, atkLoss: 10 },
  strainSpec: { grace: 6000, per: 3, cap: 30 },
  gate: true,
  nukesOn: new Map(),
  nukesIntercepted: 0,
  nukesLaunched: new Map(),
  rampTicks: 1800,
  reg: new Map(),
  game: null,
  attacker: null,
  boughtAt: new Map(),
  spawnEnd: 40,
  firstBuilt: new Map(),
};

const hasCap = (p: unknown): boolean =>
  CTX.game?.capitals()?.capitalOf(p as Player) != null;
/** 0..1: a bought capital ramps in from half strength over rampTicks. */
const share = (p: unknown): number => {
  const c = CTX.game?.capitals()?.capitalOf(p as Player);
  if (!c) return 0;
  if (!CTX.proposal) return 1;
  const age = CTX.game!.ticks() - c.foundedTick;
  return age >= CTX.rampTicks ? 1 : 0.5 + (0.5 * Math.max(0, age)) / CTX.rampTicks;
};
const DISC_TYPES = new Set<UnitType>([UnitType.City, UnitType.Port, UnitType.Factory, UnitType.DefensePost]);

class SimConfig extends TestConfig {
  startingGold(info: PlayerInfo): bigint {
    if (!CTX.proposal || info.playerType === PlayerType.Bot) return 0n;
    return CTX.startGold;
  }
  capitalSpec(): CapitalSpec {
    if (!CTX.proposal) return CAPITAL_SPEC;
    return {
      ...CAPITAL_SPEC,
      bonusIncomePercent: CTX.bonuses.income,
      bonusRegenPercent: CTX.bonuses.regen,
      replacementRampTicks: CTX.rampTicks,
    };
  }
  maxTroops(player: Parameters<EngineConfig["maxTroops"]>[0]): number {
    const base = super.maxTroops(player);
    if (!CTX.proposal || !hasCap(player)) return base;
    const sh = share(player);
    return Math.floor(
      (base * (100 + CTX.bonuses.maxTroops * sh)) / 100 +
        (CTX.bonuses.maxFlat ?? 0) * sh,
    );
  }
  goldAdditionRate(player: Parameters<EngineConfig["goldAdditionRate"]>[0]): bigint {
    const base = super.goldAdditionRate(player);
    if (!CTX.proposal || !hasCap(player) || !CTX.bonuses.incomeFlat) return base;
    return base + BigInt(Math.floor(CTX.bonuses.incomeFlat * share(player)));
  }
  private discCache = new Map<UnitType, ReturnType<EngineConfig["unitInfo"]>>();
  unitInfo(type: UnitType): ReturnType<EngineConfig["unitInfo"]> {
    const info = super.unitInfo(type);
    if (!DISC_TYPES.has(type)) return info;
    const hit = this.discCache.get(type);
    if (hit) return hit;
    const base = info.cost;
    const wrapped = {
      ...info,
      cost: (g: Game, p: Player, extra?: number) => {
        const c = base(g, p, extra);
        const d = CTX.bonuses.discount ?? 0;
        if (!CTX.proposal || d === 0 || !hasCap(p)) return c;
        return (c * BigInt(Math.floor(100 - d * share(p)))) / 100n;
      },
    } as ReturnType<EngineConfig["unitInfo"]>;
    this.discCache.set(type, wrapped);
    return wrapped;
  }
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    const r = EngineConfig.prototype.attackLogic.call(this, input);
    if (CTX.proposal && CTX.attacker !== null && hasCap(CTX.attacker)) {
      r.attackerTroopLoss =
        (r.attackerTroopLoss * (100 - CTX.bonuses.atkLoss)) / 100;
    }
    return r;
  }
}

let patched = false;
function patch() {
  if (patched) return;
  patched = true;
  const cs = CapitalSystem.prototype as any;
  const origDesignate = cs.designate;
  cs.designate = function () {
    if (!CTX.proposal) return origDesignate.call(this);
  };
  const origFound = cs.found;
  cs.found = function (player: Player, tile: number) {
    if (CTX.proposal) {
      const s = CTX.reg.get(player.name());
      if (s !== undefined && !saving(s, player)) return false;
    }
    const ok = origFound.call(this, player, tile);
    if (ok) CTX.boughtAt.set(player.name(), this.mg.ticks());
    return ok;
  };
  const strainPct = (mg: Game, player: Player): number => {
    if (!CTX.proposal || !CTX.strain) return 0;
    if (mg.capitals()!.capitalOf(player) !== null) return 0;
    const over = mg.ticks() - CTX.spawnEnd - CTX.strainSpec.grace;
    if (over < 0) return 0;
    return Math.min(CTX.strainSpec.cap, CTX.strainSpec.per * (1 + Math.floor(over / 600)));
  };
  const origIncome = cs.incomePercent;
  cs.incomePercent = function (player: Player) {
    return origIncome.call(this, player) - strainPct(this.mg, player);
  };
  const origRegen = cs.regenPercent;
  cs.regenPercent = function (player: Player) {
    return origRegen.call(this, player) - strainPct(this.mg, player);
  };
  const nsb = NationStructureBehavior.prototype as any;
  const origDo = nsb.doHandleStructures;
  nsb.doHandleStructures = function () {
    if (CTX.proposal) {
      const s = CTX.reg.get(this.player.name());
      if (s !== undefined && saving(s, this.player)) return false;
    }
    const before = snapUnits(this.player);
    const r = origDo.call(this);
    noteFirst(this.player, before);
    return r;
  };
  const pi = PlayerImpl.prototype as any;
  const origCan = pi.canBuildUnitType;
  pi.canBuildUnitType = function (t: UnitType, k: unknown) {
    if (
      CTX.proposal &&
      CTX.gate &&
      (t === UnitType.MissileSilo || t === UnitType.Airport) &&
      !hasCap(this)
    )
      return false;
    return origCan.call(this, t, k);
  };
  const st = StatsImpl.prototype as any;
  const oI = st.bombIntercept;
  st.bombIntercept = function (pl: Player, type: unknown, count: unknown) {
    CTX.nukesIntercepted += Number(count);
    return oI.call(this, pl, type, count);
  };
  const oLa = st.bombLaunch;
  st.bombLaunch = function (pl: Player, target: any, type: unknown) {
    CTX.nukesLaunched.set(pl.name(), (CTX.nukesLaunched.get(pl.name()) ?? 0) + 1);
    const tn = target?.name?.();
    if (tn) {
      const k = tn + (hasCap(target) ? "|cap" : "|nocap");
      CTX.nukesOn.set(k, (CTX.nukesOn.get(k) ?? 0) + 1);
    }
    return oLa.call(this, pl, target, type);
  };
  const ae = AttackExecution.prototype as any;
  const origTick = ae.tick;
  ae.tick = function (t: number) {
    CTX.attacker = this._owner;
    try {
      return origTick.call(this, t);
    } finally {
      CTX.attacker = null;
    }
  };
}

function saving(s: Strategy, player: Player): boolean {
  if (s.never) return false;
  if (CTX.game?.capitals()?.capitalOf(player)) return false;
  const now = CTX.game!.ticks();
  const cities = player.units(UnitType.City).length;
  return cities >= s.preCities || now >= s.commitTick;
}

const WATCH = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Airport,
  UnitType.DefensePost,
] as const;
function snapUnits(p: Player) {
  const o: Record<string, number> = {};
  for (const u of WATCH) o[u] = p.units(u).length;
  return o;
}
function noteFirst(p: Player, before: Record<string, number>) {
  const rec = CTX.firstBuilt.get(p.name())!;
  const now = CTX.game!.ticks();
  for (const u of WATCH) {
    if (rec[u] === undefined && p.units(u).length > before[u]) rec[u] = now;
  }
}

export interface Seat {
  strategy: Strategy;
  difficulty?: Difficulty;
}
export interface Sample {
  min: number;
  name: string;
  label: string;
  alive: boolean;
  tiles: number;
  troops: number;
  maxTroops: number;
  gold: number;
  cities: number;
  posts: number;
  ports: number;
  factories: number;
  silos: number;
  sams: number;
  airports: number;
  capital: boolean;
}
export interface RunResult {
  samples: Sample[];
  boughtAtMin: Record<string, number | null>;
  firstBuilt: Record<string, Record<string, number>>;
  winnerHint: string;
  nukes?: { on: Record<string, number>; intercepted: number; launched: number };
}

export async function runScenario(o: {
  seats: Seat[];
  radius: number;
  proposal: boolean;
  gameID: string;
  minutes: number;
  difficulty: Difficulty;
  rotate?: number;
  map?: string;
  randomSpawn?: boolean;
  bonuses?: Bonuses;
  strain?: boolean;
  strainSpec?: Ctx["strainSpec"];
  gate?: boolean;
  startGold?: bigint;
  sampleMins?: number[];
}): Promise<RunResult> {
  patch();
  CTX.proposal = o.proposal;
  CTX.bonuses = o.bonuses ?? { income: 10, regen: 25, maxTroops: 10, atkLoss: 10 };
  CTX.strain = o.strain ?? true;
  CTX.strainSpec = o.strainSpec ?? { grace: 6000, per: 3, cap: 30 };
  CTX.gate = o.gate ?? true;
  CTX.nukesOn = new Map();
  CTX.nukesIntercepted = 0;
  CTX.nukesLaunched = new Map();
  CTX.startGold = o.startGold ?? 200_000n;
  const mins = new Set(o.sampleMins ?? [5, 10, 15, 20]);
  CTX.reg = new Map();
  CTX.boughtAt = new Map();
  CTX.firstBuilt = new Map();
  const K = o.seats.length;
  const nations = o.seats.map((seat, i) => {
    const k = (i + (o.rotate ?? 0)) % K;
    const ang = (2 * Math.PI * k) / K;
    const x = Math.round(100 + o.radius * Math.cos(ang));
    const y = Math.round(100 + o.radius * Math.sin(ang));
    const name = `${seat.strategy.label}#${i}`;
    CTX.reg.set(name, seat.strategy);
    CTX.firstBuilt.set(name, {});
    return new Nation(
      o.randomSpawn ? undefined : new Cell(x, y),
      new PlayerInfo(name, PlayerType.Nation, null, name),
    );
  });
  const game = await setup(
    o.map ?? "big_plains",
    {
      capitalSystem: { enabled: true },
      difficulty: o.difficulty,
    } as never,
    [],
    undefined,
    SimConfig,
    false,
    nations,
  );
  CTX.game = game;
  for (const n of nations) game.addExecution(new NationExecution(o.gameID, n));
  for (let t = 0; t < 40; t++) game.executeNextTick();
  game.endSpawnPhase();
  CTX.spawnEnd = game.ticks();
  const samples: Sample[] = [];
  const total = o.minutes * 600;
  const take = (min: number) => {
    for (const p of game.allPlayers()) {
      if (p.type() !== PlayerType.Nation) continue;
      const s = CTX.reg.get(p.name())!;
      samples.push({
        min,
        name: p.name(),
        label: s.label,
        alive: p.isAlive(),
        tiles: p.numTilesOwned(),
        troops: Math.round(p.troops()),
        maxTroops: Math.round(game.config().maxTroops(p)),
        gold: Math.round(Number(p.gold()) / 1000),
        cities: p.units(UnitType.City).length,
        posts: p.units(UnitType.DefensePost).length,
        ports: p.units(UnitType.Port).length,
        factories: p.units(UnitType.Factory).length,
        silos: p.units(UnitType.MissileSilo).length,
        sams: p.units(UnitType.SAMLauncher).length,
        airports: p.units(UnitType.Airport).length,
        capital: game.capitals()?.capitalOf(p) != null,
      });
    }
  };
  for (let t = 1; t <= total; t++) {
    game.executeNextTick();
    if (t % 600 === 0 && mins.has(t / 600)) take(t / 600);
  }
  const boughtAtMin: Record<string, number | null> = {};
  for (const n of nations) {
    const b = CTX.boughtAt.get(n.playerInfo.name);
    boughtAtMin[n.playerInfo.name] =
      b === undefined ? null : +((b - CTX.spawnEnd) / 600).toFixed(2);
  }
  const firstBuilt: RunResult["firstBuilt"] = {};
  for (const [k, v] of CTX.firstBuilt) firstBuilt[k] = v;
  return {
    samples,
    boughtAtMin,
    firstBuilt,
    winnerHint: "",
    nukes: {
      on: Object.fromEntries(CTX.nukesOn),
      intercepted: CTX.nukesIntercepted,
      launched: [...CTX.nukesLaunched.values()].reduce((a, b) => a + b, 0),
    },
  };
}
