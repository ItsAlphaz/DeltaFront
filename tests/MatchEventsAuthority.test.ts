import { IntentSchema } from "@openfront/engine-api/Schemas";
import { ClientMessageSchema } from "@openfront/shared/WireSchemas";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * The match feed is the engine's account of what happened. A client has no way
 * to put a line in it: there is no message or intent that carries one, and the
 * only code that creates a MatchEvent update is the engine's own tracker.
 */

const ROOT = path.resolve(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

describe("nobody but the engine makes match events", () => {
  it("no client message or intent carries an event or feed text", () => {
    const intentTypes = IntentSchema.options.map(
      (o) => o.shape.type.value as string,
    );
    expect(
      intentTypes.filter((t) => /event|feed|kill|announce/i.test(t)),
    ).toEqual([]);
    for (const type of ["match_event", "event", "feed", "kill_feed"]) {
      expect(
        IntentSchema.safeParse({ type, text: "Alphaz eliminated RedFox" })
          .success,
      ).toBe(false);
      expect(
        ClientMessageSchema.safeParse({
          type,
          event: { type: "player_eliminated", actor: 1, target: 2 },
        }).success,
      ).toBe(false);
    }
    expect(
      ClientMessageSchema.safeParse({
        type: "intent",
        intent: { type: "match_event", text: "Alphaz eliminated RedFox" },
      }).success,
    ).toBe(false);
  });

  it("the only code that creates a MatchEvent update is the engine's tracker", () => {
    const producers = sourceFiles(ROOT)
      .filter((f) => !f.includes(`${path.sep}tests${path.sep}`))
      .filter((f) =>
        /GameUpdateType\.MatchEvent\b/.test(fs.readFileSync(f, "utf8")),
      )
      .map(rel)
      .sort();
    // The tracker emits; the rest only read: the client's view and log, and the replay's collector.
    const creators = producers.filter((f) =>
      /type:\s*GameUpdateType\.MatchEvent\s*,/.test(
        fs.readFileSync(path.join(ROOT, f), "utf8"),
      ),
    );
    expect(creators).toEqual(["packages/engine/src/game/MatchEvents.ts"]);
    // The server and the shared wire code never touch them.
    expect(producers.filter((f) => f.startsWith("src/server/"))).toEqual([]);
    expect(producers.filter((f) => f.startsWith("packages/shared/"))).toEqual(
      [],
    );
  });

  it("the tracker is reached only from engine code that performs the transition", () => {
    const callers = sourceFiles(path.join(ROOT, "packages"))
      .filter((f) => /matchEvents\(\)/.test(fs.readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(callers).toEqual([
      "packages/engine/src/execution/AdminCommandExecution.ts",
      "packages/engine/src/execution/PlayerExecution.ts",
      "packages/engine/src/game/Game.ts",
      "packages/engine/src/game/GameImpl.ts",
    ]);
    // And no client or server code calls into it.
    for (const f of [
      ...sourceFiles(path.join(ROOT, "src/server")),
      ...sourceFiles(path.join(ROOT, "src/client")),
    ]) {
      const code = fs.readFileSync(f, "utf8");
      expect(code, rel(f)).not.toMatch(
        /\.matchEvents\(\)\.(claimKill|playerDied|allianceFormed|allianceBroken|adminAction|gameEnding|gameStarted)/,
      );
    }
  });
});
