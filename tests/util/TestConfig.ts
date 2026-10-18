import { Tick, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  Config,
  NukeMagnitude,
} from "@openfront/engine-lib/configuration/Config";
import {
  AttackLogicInput,
  AttackLogicResult,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";

export class TestConfig extends EngineConfig {
  private _proximityBonusPortsNb: number = 0;
  private _defaultNukeSpeed: number = 4;
  private _spawnImmunityDuration: number = 0;
  private _nationSpawnImmunityDuration: number = 0;

  disableNavMesh(): boolean {
    return this.gameConfig().disableNavMesh ?? true;
  }

  radiusPortSpawn(): number {
    return 1;
  }

  proximityBonusPortsNb(totalPorts: number): number {
    return this._proximityBonusPortsNb;
  }

  // Specific to TestConfig
  setProximityBonusPortsNb(nb: number): void {
    this._proximityBonusPortsNb = nb;
  }

  nukeMagnitudes(_: UnitType): NukeMagnitude {
    return { inner: 1, outer: 1 };
  }

  setDefaultNukeSpeed(speed: number): void {
    this._defaultNukeSpeed = speed;
  }

  // Flat speed for all nuke types so test tick counts stay predictable.
  nukeSpeed(_: UnitType): number {
    return this._defaultNukeSpeed;
  }

  defaultNukeTargetableRange(): number {
    return 20;
  }

  deletionMarkDuration(): number {
    return 5;
  }

  defaultSamRange(): number {
    return 20;
  }

  samRange(level: number): number {
    return 20;
  }

  setSpawnImmunityDuration(duration: Tick) {
    this._spawnImmunityDuration = duration;
  }

  spawnImmunityDuration(): Tick {
    return this._spawnImmunityDuration;
  }

  setNationSpawnImmunityDuration(duration: Tick) {
    this._nationSpawnImmunityDuration = duration;
  }

  nationSpawnImmunityDuration(): Tick {
    return this._nationSpawnImmunityDuration;
  }

  /** Instant, so that a test that buys a capital has it at once (CapitalBuild.test.ts times the real one). */
  capitalBuildTicks(): number {
    return 0;
  }

  attackLogic(_input: AttackLogicInput): AttackLogicResult {
    return { attackerTroopLoss: 1, defenderTroopLoss: 1, tickFraction: 1 };
  }
}
/** A TestConfig whose capitals take as long to build as in the game. */
export class RealCapitalBuildConfig extends TestConfig {
  capitalBuildTicks(): number {
    return Config.prototype.capitalBuildTicks.call(this);
  }
}

export class UseRealAttackLogic extends TestConfig {
  attackLogic(input: AttackLogicInput): AttackLogicResult {
    return EngineConfig.prototype.attackLogic.call(this, input);
  }
}
