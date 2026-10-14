import type { Pool } from "pg";
import { PROGRESSION } from "../domain/constants";
import { archiveDueSeasons } from "../domain/progressionOps";
import type { Logger } from "../logger";

/**
 * Closes seasons that ended: after the grace period for late game results,
 * each player's final level and rank are stored and the season is archived
 * (see archiveSeason). Runs on every instance; an advisory lock lets only one
 * do the work, and a repeat changes nothing.
 */
export function startSeasonJob(
  pool: Pool,
  log: Pick<Logger, "info" | "error">,
): () => void {
  const run = async () => {
    try {
      const archived = await archiveDueSeasons(pool);
      if (archived.length > 0) {
        log.info("seasons archived", { seasons: archived });
      }
    } catch (error) {
      log.error("season archive failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  void run();
  const timer = setInterval(() => void run(), PROGRESSION.seasonJobMs);
  timer.unref();
  return () => clearInterval(timer);
}
