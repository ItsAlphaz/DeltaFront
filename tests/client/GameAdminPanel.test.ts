import { GameType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showInGameConfirm } = vi.hoisted(() => ({
  showInGameConfirm: vi.fn(async (_m: string, _o?: unknown) => true),
}));
vi.mock("../../src/client/InGameModal", () => ({
  showInGameConfirm: (m: string, o?: unknown) => showInGameConfirm(m, o),
  showInGameAlert: vi.fn(async () => true),
}));

import { GameAdminPanel } from "../../src/client/hud/layers/GameAdminPanel";
import { SendKickPlayerIntentEvent } from "../../src/client/LobbyEvents";
import { GoToPlayerEvent } from "../../src/client/TransformHandler";
import {
  PauseGameIntentEvent,
  SendAdminCommandIntentEvent,
} from "../../src/client/Transport";
import { UserSettings } from "../../src/client/UserSettings";
import type { GameView, PlayerView } from "../../src/client/view";
import { makePlayerUpdate, makePlayerView } from "../util/viewStubs";

const clearSettings = () => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
};

function player(
  id: string,
  over: {
    human?: boolean;
    staffRole?: "owner" | "admin" | "mod";
    verified?: boolean;
  } = {},
): PlayerView {
  const view = makePlayerView({
    data: makePlayerUpdate({ id, name: id, displayName: id, clientID: id }),
    cosmetics: { staffRole: over.staffRole, verified: over.verified },
  });
  return Object.assign(view, {
    id: () => id,
    clientID: () => (over.human === false ? null : `cid${id}`.slice(0, 8)),
    type: () => (over.human === false ? PlayerType.Bot : PlayerType.Human),
    isAlive: () => true,
    gold: () => 1000n,
    troops: () => 500,
    numTilesOwned: () => 10,
  });
}

function setup(
  opts: {
    role: string | null;
    gameType?: GameType;
    listed?: boolean;
  } = { role: null },
) {
  const me = player("meplayer", { staffRole: "owner" });
  const victim = player("victim01");
  const bot = player("botplyr1", { human: false });
  const game = {
    playerViews: () => [me, victim, bot],
    myPlayer: () => me,
    gameID: () => "game1234",
    ticks: () => 42,
    config: () => ({
      gameConfig: () => ({ gameType: opts.gameType ?? GameType.Private }),
      listed: opts.listed ?? false,
      maxTroops: () => 9999,
    }),
  } as unknown as GameView;
  const bus = new EventBus();
  const emitted: unknown[] = [];
  for (const E of [
    SendAdminCommandIntentEvent,
    SendKickPlayerIntentEvent,
    GoToPlayerEvent,
    PauseGameIntentEvent,
  ]) {
    bus.on(E as never, ((e: unknown) => emitted.push(e)) as never);
  }
  const panel = new GameAdminPanel();
  panel.game = game;
  panel.eventBus = bus;
  panel.setRole(opts.role);
  document.body.append(panel);
  panel.init();
  return { panel, emitted, me, victim, bot };
}

const open = async (panel: GameAdminPanel) => {
  await panel.updateComplete;
  panel.querySelector<HTMLButtonElement>("#game-admin-toggle")!.click();
  await panel.updateComplete;
};
const select = async (panel: GameAdminPanel, id: string) => {
  const rows = [...panel.querySelectorAll("tbody tr")];
  const row = rows.find((r) => r.textContent?.includes(id))!;
  (row as HTMLElement).click();
  await panel.updateComplete;
};
const button = (panel: GameAdminPanel, label: string) =>
  [...panel.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

describe("<game-admin-panel>", () => {
  beforeEach(() => {
    clearSettings();
    showInGameConfirm.mockClear();
    showInGameConfirm.mockResolvedValue(true);
  });
  afterEach(() => {
    document.body.innerHTML = "";
    clearSettings();
  });

  it("draws nothing at all for anyone who is not staff", async () => {
    for (const role of [null, "flagged", "banned", "user", "", "OWNER"]) {
      const { panel } = setup({ role });
      await panel.updateComplete;
      expect(
        panel.querySelector("#game-admin-toggle"),
        String(role),
      ).toBeNull();
      expect(panel.querySelector("#game-admin-panel")).toBeNull();
      panel.remove();
    }
  });

  it("the backquote key opens it for staff and does nothing for anyone else", async () => {
    const key = () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote" }));
    const staff = setup({ role: "admin" });
    await staff.panel.updateComplete;
    key();
    await staff.panel.updateComplete;
    expect(staff.panel.querySelector("#game-admin-panel")).not.toBeNull();
    staff.panel.remove();

    const plain = setup({ role: null });
    key();
    await plain.panel.updateComplete;
    expect(plain.panel.querySelector("#game-admin-panel")).toBeNull();
  });

  it("a moderator can look and kick, and sees none of the state-changing tools", async () => {
    const { panel } = setup({ role: "mod" });
    await open(panel);
    await select(panel, "victim01");
    expect(button(panel, "game_admin.go_to")).toBeDefined();
    expect(button(panel, "game_admin.kick")).toBeDefined();
    expect(button(panel, "game_admin.eliminate")).toBeUndefined();
    expect(button(panel, "game_admin.force_win")).toBeUndefined();
    expect(panel.querySelector("#game-admin-amount")).toBeNull();
  });

  it("an admin can also eliminate, but not change resources or force a winner", async () => {
    const { panel } = setup({ role: "admin" });
    await open(panel);
    await select(panel, "victim01");
    expect(button(panel, "game_admin.eliminate")).toBeDefined();
    expect(button(panel, "game_admin.force_win")).toBeUndefined();
    expect(panel.querySelector("#game-admin-amount")).toBeNull();
  });

  it("the owner sees every tool", async () => {
    const { panel } = setup({ role: "owner" });
    await open(panel);
    await select(panel, "victim01");
    for (const label of [
      "game_admin.go_to",
      "game_admin.kick",
      "game_admin.eliminate",
      "game_admin.force_win",
      "game_admin.gold_give",
      "game_admin.troops_set",
    ]) {
      expect(button(panel, label), label).toBeDefined();
    }
  });

  it("buttons send the intents: camera, kick, resources (troops in HUD units), elimination", async () => {
    const { panel, emitted, victim } = setup({ role: "owner" });
    await open(panel);
    await select(panel, "victim01");

    button(panel, "game_admin.go_to")!.click();
    button(panel, "game_admin.gold_give")!.click();
    button(panel, "game_admin.troops_give")!.click();
    await panel.updateComplete;
    button(panel, "game_admin.eliminate")!.click();
    button(panel, "game_admin.kick")!.click();
    await vi.waitFor(() => expect(emitted).toHaveLength(5));

    const commands = emitted.filter(
      (e): e is SendAdminCommandIntentEvent =>
        e instanceof SendAdminCommandIntentEvent,
    );
    expect(commands.map((c) => [c.command, c.target, c.amount])).toEqual([
      ["give_gold", victim, 1000],
      // The engine counts troops x10; the panel speaks in HUD units.
      ["give_troops", victim, 10_000],
      ["eliminate", victim, undefined],
    ]);
    expect(emitted.some((e) => e instanceof GoToPlayerEvent)).toBe(true);
    expect(emitted.some((e) => e instanceof SendKickPlayerIntentEvent)).toBe(
      true,
    );
  });

  it("asks before anything destructive, and a no sends nothing", async () => {
    showInGameConfirm.mockResolvedValue(false);
    const { panel, emitted } = setup({ role: "owner" });
    await open(panel);
    await select(panel, "victim01");
    button(panel, "game_admin.eliminate")!.click();
    button(panel, "game_admin.kick")!.click();
    button(panel, "game_admin.force_win")!.click();
    await vi.waitFor(() => expect(showInGameConfirm).toHaveBeenCalledTimes(3));
    expect(emitted).toHaveLength(0);
  });

  it("only humans can be kicked, and not oneself", async () => {
    const { panel } = setup({ role: "owner" });
    await open(panel);
    await select(panel, "botplyr1");
    expect(button(panel, "game_admin.kick")).toBeUndefined();
    await select(panel, "meplayer");
    expect(button(panel, "game_admin.kick")).toBeUndefined();
  });

  it("an amount that is not a number sends nothing", async () => {
    const { panel, emitted } = setup({ role: "owner" });
    await open(panel);
    await select(panel, "victim01");
    const input = panel.querySelector<HTMLInputElement>("#game-admin-amount")!;
    input.value = "lots";
    input.dispatchEvent(new Event("input"));
    await panel.updateComplete;
    expect(button(panel, "game_admin.gold_give")!.disabled).toBe(true);
    button(panel, "game_admin.gold_give")!.click();
    expect(emitted).toHaveLength(0);
  });

  it("marks the game admin-modified once a command is sent, and says so", async () => {
    const { panel } = setup({ role: "owner" });
    await open(panel);
    expect(panel.querySelector("#game-admin-modified")).toBeNull();
    await select(panel, "victim01");
    button(panel, "game_admin.gold_give")!.click();
    await panel.updateComplete;
    expect(panel.querySelector("#game-admin-modified")).not.toBeNull();
  });

  it("in a public game an admin is not offered state-changing tools, and is told why; kicking still is", async () => {
    const { panel } = setup({ role: "admin", gameType: GameType.Public });
    await open(panel);
    await select(panel, "victim01");
    expect(
      panel.querySelector("#game-admin-public-note")?.textContent,
    ).toContain("game_admin.public_note");
    expect(
      panel.querySelector("#game-admin-public-note")?.textContent,
    ).not.toContain("public_note_owner");
    expect(button(panel, "game_admin.kick")).toBeDefined();
    expect(button(panel, "game_admin.eliminate")).toBeUndefined();
    expect(button(panel, "game_admin.force_win")).toBeUndefined();
    expect(panel.querySelector("#game-admin-amount")).toBeNull();
  });

  it("a moderator in a public game gets no mutation controls either", async () => {
    const { panel } = setup({ role: "mod", gameType: GameType.Public });
    await open(panel);
    await select(panel, "victim01");
    expect(button(panel, "game_admin.eliminate")).toBeUndefined();
    expect(panel.querySelector("#game-admin-amount")).toBeNull();
  });

  it("the owner is offered every tool in a public game, with a note that it marks the game", async () => {
    const { panel, emitted } = setup({
      role: "owner",
      gameType: GameType.Public,
    });
    await open(panel);
    await select(panel, "victim01");
    expect(
      panel.querySelector("#game-admin-public-note")?.textContent,
    ).toContain("game_admin.public_note_owner");
    expect(button(panel, "game_admin.eliminate")).toBeDefined();
    expect(button(panel, "game_admin.force_win")).toBeDefined();
    expect(panel.querySelector("#game-admin-amount")).not.toBeNull();
    button(panel, "game_admin.gold_give")!.click();
    expect(emitted.some((e) => e instanceof SendAdminCommandIntentEvent)).toBe(
      true,
    );
  });

  it("a listed game counts as public for the panel too", async () => {
    const { panel } = setup({
      role: "admin",
      gameType: GameType.Private,
      listed: true,
    });
    await open(panel);
    await select(panel, "victim01");
    expect(button(panel, "game_admin.eliminate")).toBeUndefined();
    expect(panel.querySelector("#game-admin-public-note")).not.toBeNull();
  });

  it("the game tab shows the facts, and pause only for those who may pause", async () => {
    const admin = setup({ role: "admin" });
    await open(admin.panel);
    button(admin.panel, "game_admin.tab_game")!.click();
    await admin.panel.updateComplete;
    expect(
      admin.panel.querySelector("#game-admin-game")?.textContent,
    ).toContain("game1234");
    expect(button(admin.panel, "game_admin.pause")).toBeDefined();
    button(admin.panel, "game_admin.pause")!.click();
    expect(admin.emitted.some((e) => e instanceof PauseGameIntentEvent)).toBe(
      true,
    );
    admin.panel.remove();

    const mod = setup({ role: "mod" });
    await open(mod.panel);
    button(mod.panel, "game_admin.tab_game")!.click();
    await mod.panel.updateComplete;
    expect(button(mod.panel, "game_admin.pause")).toBeUndefined();
  });

  it("the testing tools refill the owner's own resources", async () => {
    const { panel, emitted, me } = setup({ role: "owner" });
    await open(panel);
    button(panel, "game_admin.tab_tools")!.click();
    await panel.updateComplete;
    button(panel, "game_admin.refill_gold")!.click();
    button(panel, "game_admin.refill_troops")!.click();
    const commands = emitted as SendAdminCommandIntentEvent[];
    expect(commands.map((c) => [c.command, c.target === me])).toEqual([
      ["set_gold", true],
      ["set_troops", true],
    ]);
  });

  it("shows each player's staff badge in the list", async () => {
    const { panel } = setup({ role: "owner" });
    await open(panel);
    expect(
      panel.querySelectorAll('svg[data-staff-role="owner"]').length,
    ).toBeGreaterThan(0);
  });
});
