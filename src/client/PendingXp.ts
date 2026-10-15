import { getUserMe, invalidateUserMe } from "./Api";
import { clearPendingXp, readPendingXp } from "./PendingXpStore";
import { pollGameXp } from "./ProgressionApi";
import { showToast, translateText } from "./Utils";

/**
 * Looks up the XP of a game the player left before it was settled (see
 * PendingXpStore): a toast says what was awarded (or forfeited) and the level in
 * the nav catches up.
 */

/** Whether this page is a game in progress (where the XP is still being played for). */
function onGamePage(): boolean {
  return /\/game\//.test(window.location.pathname);
}

export interface PendingXpDeps {
  poll: typeof pollGameXp;
  refreshUser: () => Promise<void>;
  toast: (message: string, color: "red" | "green") => void;
  now: () => number;
}

async function refreshNav(): Promise<void> {
  invalidateUserMe();
  const fresh = await getUserMe();
  if (fresh === false) return;
  // The nav's level and XP bar read this broadcast.
  document.dispatchEvent(
    new CustomEvent("userMeResponse", { detail: fresh, bubbles: true }),
  );
}

const defaultDeps: PendingXpDeps = {
  poll: pollGameXp,
  refreshUser: refreshNav,
  toast: showToast,
  now: Date.now,
};

/**
 * Looks up the remembered game's XP once, in the background. Never on a game
 * page (the XP is still being played for there). Always forgets the game
 * afterwards: a result is told once.
 */
export async function resolvePendingXp(
  deps: Partial<PendingXpDeps> = {},
): Promise<"awarded" | "forfeited" | "nothing"> {
  const d = { ...defaultDeps, ...deps };
  if (onGamePage()) return "nothing";
  const pending = readPendingXp(d.now());
  if (pending === null) {
    clearPendingXp();
    return "nothing";
  }
  const result = await d.poll(pending.gameId, { timeoutMs: 45_000 });
  clearPendingXp();
  if (result === null) return "nothing";
  if (result.eligible) {
    d.toast(
      translateText("progression.toast_awarded", {
        xp: result.breakdown.total.toLocaleString(),
      }),
      "green",
    );
    await d.refreshUser();
    return "awarded";
  }
  if (result.reason === "left_early") {
    d.toast(translateText("progression.toast_forfeited"), "red");
    return "forfeited";
  }
  return "nothing";
}
