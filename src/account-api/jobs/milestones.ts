import {
  LEVEL_MILESTONES,
  progressState,
} from "@openfront/shared/ProgressionRules";
import type { Pool } from "pg";
import { withTransaction } from "../db/tx";
import { unlockReward, type RewardEnv } from "../domain/progression";
import type { Logger } from "../logger";

/**
 * Gives every account the level rewards it has already earned. A reward is
 * normally created the moment a level is crossed, so a milestone added to
 * LEVEL_MILESTONES later (a new cosmetic at level 20, say) would never reach
 * an account that is already past it. This runs at start-up: for each
 * account's current run it creates the milestone rewards it is at or above.
 * The reward key is unique per account, so a repeat (every restart, a second
 * instance) creates nothing, and a reward already held is left alone.
 * Credits still wait for the player's claim, as for any level reward.
 */
export async function backfillLevelRewards(
  pool: Pool,
  env: RewardEnv,
): Promise<{ accounts: number; rewards: number }> {
  const { rows } = await pool.query<{
    user_id: string;
    lifetime: string;
    run: string;
    prestige: number;
  }>(
    `SELECT user_id, lifetime_xp::text AS lifetime, run_xp::text AS run, prestige
       FROM user_progress`,
  );
  let accounts = 0;
  let rewards = 0;
  for (const row of rows) {
    const { level } = progressState({
      lifetimeXp: Number(row.lifetime),
      runXp: Number(row.run),
      prestige: row.prestige,
    });
    const due = LEVEL_MILESTONES.filter((m) => m.level <= level);
    if (due.length === 0) continue;
    const created = await withTransaction(pool, async (tx) => {
      let n = 0;
      for (const milestone of due) {
        const id = await unlockReward(
          tx,
          row.user_id,
          {
            key: `level:p${row.prestige}:${milestone.level}`,
            kind: "level_milestone",
            credits: milestone.credits,
            flare: milestone.flare,
          },
          env,
        );
        if (id !== null) n += 1;
      }
      return n;
    });
    if (created > 0) {
      accounts += 1;
      rewards += created;
    }
  }
  return { accounts, rewards };
}

/** Runs the backfill once; a failure is logged and never stops the service. */
export function startMilestoneBackfill(
  pool: Pool,
  log: Pick<Logger, "info" | "error">,
  env: RewardEnv,
): void {
  void backfillLevelRewards(pool, env)
    .then((done) => {
      if (done.rewards > 0) log.info("level rewards backfilled", done);
    })
    .catch((error: unknown) => {
      log.error("level reward backfill failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
