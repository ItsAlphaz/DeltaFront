// Add global mocks or configuration here if needed
import "vitest-canvas-mock";
// Registers the per-test DOM teardown. Imported here, and not from individual
// test files, so its hooks are registered before any test file's own -- see the
// hook-order note in that file.
import "./domTeardown";

// ServerEnv.gitCommit() throws when unset; the dev server sets GIT_COMMIT=DEV,
// so tests exercising server code (e.g. the lobby feed) mirror that.
process.env.GIT_COMMIT ??= "DEV";

// DeltaFront ships with every account-backend feature off (see
// packages/shared/src/AccountFeatures.ts). The inherited suite tests the full
// product, so it runs with them on; tests of the shipped default turn
// individual flags off themselves. Reset before each test so a flag one test
// flips can never leak into the next.
import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { beforeEach } from "vitest";
// What the code ships with, captured before the hook below turns them on.
(globalThis as Record<string, unknown>).__SHIPPED_ACCOUNT_FEATURES__ = {
  ...ACCOUNT_FEATURES,
};
beforeEach(() => {
  Object.assign(ACCOUNT_FEATURES, {
    accounts: true,
    store: true,
    inventory: true,
    ranked: true,
    clans: true,
    leaderboards: true,
    payments: true,
    friends: true,
    progression: true,
    tribes: true,
    trustedLobbies: true,
  });
});
