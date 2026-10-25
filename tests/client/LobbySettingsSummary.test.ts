import { Difficulty, GameType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";
import { translateText } from "../../src/client/Utils";
import { testGameConfig } from "../util/Wire";

const difficultyLabel = translateText("difficulty.difficulty");
const hasDifficulty = (items: { label: string }[]) =>
  items.some((item) => item.label === difficultyLabel);

// The difficulty is the nations' difficulty: with nations off it means nothing,
// so the summary must not list it.
describe("the lobby summary's difficulty tag", () => {
  const hard = {
    gameType: GameType.Private,
    difficulty: Difficulty.Hard,
  } as const;

  it("is listed for a private lobby with nations and a non-Easy difficulty", () => {
    const items = notableLobbySettings(
      testGameConfig({ ...hard, nations: 4 }),
      null,
    );
    expect(hasDifficulty(items)).toBe(true);
  });

  it("is left out when nations are disabled", () => {
    const items = notableLobbySettings(
      testGameConfig({ ...hard, nations: "disabled" }),
      null,
    );
    expect(hasDifficulty(items)).toBe(false);
  });
});
