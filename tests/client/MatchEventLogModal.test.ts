import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import type { MatchEvent } from "@openfront/engine-api/game/MatchEvents";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/client/Utils")>();
  const { translateEn } = await import("../util/translateEn");
  return { ...actual, translateText: translateEn };
});

import {
  MatchEventLogModal,
  ShowMatchEventLogEvent,
  clockLabel,
} from "../../src/client/hud/layers/MatchEventLogModal";
import {
  FEED_MAX_ROWS,
  MatchEventLog,
  liveFeedRows,
} from "../../src/client/matchevents/MatchEventLog";
import { GoToPlayerEvent } from "../../src/client/TransformHandler";
import { UserSettings } from "../../src/client/UserSettings";
import type { GameView } from "../../src/client/view";
import { makeGameView, makePlayerView } from "../util/viewStubs";

const gv = makeGameView({ myClientID: "me" });
const mk = (smallID: number, name: string, extra: object = {}) =>
  makePlayerView({
    game: gv,
    data: {
      id: `p${smallID}`,
      smallID,
      name,
      displayName: name,
      clientID: `c${smallID}`,
      playerType: PlayerType.Human,
    },
    cosmetics: extra,
  });
const players = new Map([
  [1, mk(1, "Alphaz", { staffRole: "owner" })],
  [2, mk(2, "RedFox")],
]);

let seq = 0;
const event = (
  over: Partial<MatchEvent> & Pick<MatchEvent, "type">,
): MatchEvent => ({
  seq: seq++,
  tick: 100,
  severity: "normal",
  actor: null,
  target: null,
  meta: {},
  ...over,
});

async function mount() {
  const log = new MatchEventLog();
  const game = {
    matchEvents: () => log,
    ticks: () => 5000,
    myPlayer: () => null,
    playerBySmallID: (id: number) =>
      players.get(id) ?? { isPlayer: () => false },
  } as unknown as GameView;
  const bus = new EventBus();
  const goTo: unknown[] = [];
  bus.on(GoToPlayerEvent, (e) => goTo.push(e));
  const modal = new MatchEventLogModal();
  modal.game = game;
  modal.eventBus = bus;
  document.body.append(modal);
  modal.init();
  return { modal, log, bus, goTo };
}

const lines = (m: MatchEventLogModal) => [
  ...m.querySelectorAll<HTMLElement>("li[data-event-type]"),
];
const open = async (h: Awaited<ReturnType<typeof mount>>) => {
  h.bus.emit(new ShowMatchEventLogEvent(true));
  await h.modal.updateComplete;
};

beforeEach(() => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("<match-event-log-modal>", () => {
  it("is closed until asked for, and opens and closes on the bus", async () => {
    const h = await mount();
    expect(h.modal.querySelector("[data-match-event-log]")).toBeNull();
    await open(h);
    expect(h.modal.querySelector("[data-match-event-log]")).not.toBeNull();
    h.bus.emit(new ShowMatchEventLogEvent(false));
    await h.modal.updateComplete;
    expect(h.modal.querySelector("[data-match-event-log]")).toBeNull();
  });

  it("closes on Escape, on the Close button and on a click outside", async () => {
    const h = await mount();
    for (const close of [
      () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      () => h.modal.querySelector<HTMLButtonElement>("header button")!.click(),
      () =>
        h.modal
          .querySelector<HTMLElement>("[data-match-event-log]")!
          .parentElement!.click(),
    ]) {
      await open(h);
      expect(h.modal.querySelector("[data-match-event-log]")).not.toBeNull();
      close();
      await h.modal.updateComplete;
      expect(h.modal.querySelector("[data-match-event-log]")).toBeNull();
    }
  });

  it("lists the whole match, newest first, with a game clock", async () => {
    const h = await mount();
    h.log.ingest([
      event({ type: "game_started", tick: 40 }),
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 340 }),
      event({
        type: "player_eliminated",
        severity: "critical",
        actor: 1,
        target: 2,
        tick: 1240,
        meta: { targetKind: "player" },
      }),
    ]);
    await open(h);
    const rows = lines(h.modal);
    expect(rows.map((r) => r.getAttribute("data-event-type"))).toEqual([
      "player_eliminated",
      "alliance_formed",
      "game_started",
    ]);
    // Counted from the match start: tick 1240 is 120 s in.
    expect(rows[0].textContent).toContain("2:00");
    expect(rows[1].textContent).toContain("0:30");
    expect(rows[0].textContent).toMatch(/Alphaz.*eliminated.*RedFox/s);
    expect(h.modal.textContent).toContain("3 events");
  });

  it("keeps the long history the ticker lets go of", async () => {
    const h = await mount();
    const many: MatchEvent[] = [];
    for (let i = 0; i < 80; i++) {
      many.push(
        event({ type: "alliance_formed", actor: 1, target: 2, tick: 10 + i }),
      );
    }
    h.log.ingest(many);
    expect(
      liveFeedRows(h.log, 5000, { detail: "all", involvesHuman: () => true }),
    ).toEqual([]);
    expect(FEED_MAX_ROWS).toBeLessThan(80);
    await open(h);
    expect(lines(h.modal)).toHaveLength(80);
  });

  it("filters: All, Combat, Diplomacy, Territory, System", async () => {
    const h = await mount();
    h.log.ingest([
      event({ type: "game_started", tick: 10 }),
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 20 }),
      event({
        type: "player_eliminated",
        severity: "critical",
        actor: 1,
        target: 2,
        tick: 30,
        meta: { targetKind: "player" },
      }),
      event({
        type: "major_territory_loss",
        severity: "major",
        target: 2,
        tick: 40,
        meta: { percent: 50 },
      }),
      event({
        type: "largest_nation_changed",
        severity: "major",
        actor: 1,
        tick: 50,
        meta: { share: 10 },
      }),
    ]);
    await open(h);
    const tab = (f: string) =>
      h.modal.querySelector<HTMLButtonElement>(`[data-filter="${f}"]`)!;
    const types = () =>
      lines(h.modal).map((r) => r.getAttribute("data-event-type"));
    expect(
      [...h.modal.querySelectorAll("[data-filter]")].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["All", "Combat", "Diplomacy", "Territory", "System"]);
    expect(types()).toHaveLength(5);

    tab("combat").click();
    await h.modal.updateComplete;
    expect(types()).toEqual(["player_eliminated"]);
    tab("diplomacy").click();
    await h.modal.updateComplete;
    expect(types()).toEqual(["alliance_formed"]);
    tab("territory").click();
    await h.modal.updateComplete;
    expect(types()).toEqual(["largest_nation_changed", "major_territory_loss"]);
    tab("system").click();
    await h.modal.updateComplete;
    expect(types()).toEqual(["game_started"]);
    expect(tab("system").getAttribute("aria-selected")).toBe("true");
    tab("all").click();
    await h.modal.updateComplete;
    expect(types()).toHaveLength(5);
  });

  it("says so when nothing has happened", async () => {
    const h = await mount();
    await open(h);
    expect(h.modal.textContent).toContain("Nothing has happened yet.");
  });

  it("shows new events while it is open", async () => {
    const h = await mount();
    await open(h);
    expect(lines(h.modal)).toHaveLength(0);
    h.log.ingest([
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 20 }),
    ]);
    await h.modal.updateComplete;
    expect(lines(h.modal)).toHaveLength(1);
  });

  it("a line with a player takes the camera to them (the one it happened to, else who did it)", async () => {
    const h = await mount();
    h.log.ingest([
      event({ type: "game_started", tick: 10 }),
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 20 }),
      event({
        type: "largest_nation_changed",
        severity: "major",
        actor: 1,
        tick: 30,
      }),
    ]);
    await open(h);
    const rows = lines(h.modal);
    rows[0].click(); // largest nation: actor only
    expect((h.goTo[0] as GoToPlayerEvent).player).toBe(players.get(1));
    await open(h);
    lines(h.modal)[1].click(); // alliance: the target
    expect((h.goTo[1] as GoToPlayerEvent).player).toBe(players.get(2));
    await open(h);
    lines(h.modal)[2].click(); // no player: nothing happens
    expect(h.goTo).toHaveLength(2);
  });
});

describe("clockLabel", () => {
  it("counts game time from the match start, in m:ss and h:mm:ss", () => {
    expect(clockLabel(100, 100)).toBe("0:00");
    expect(clockLabel(100 + 650, 100)).toBe("1:05");
    expect(clockLabel(100 + 36000 + 10 * 61, 100)).toBe("1:01:01");
    expect(clockLabel(50, 100)).toBe("0:00");
  });
});
