import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import type { MatchEvent } from "@openfront/engine-api/game/MatchEvents";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateEn } from "../util/translateEn";

vi.mock("../../src/client/Utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/client/Utils")>();
  const { translateEn } = await import("../util/translateEn");
  return { ...actual, translateText: translateEn };
});

import { MatchEventFeed } from "../../src/client/hud/layers/MatchEventFeed";
import {
  FEED_LIFETIME_TICKS,
  FEED_MAX_ROWS,
  MatchEventLog,
} from "../../src/client/matchevents/MatchEventLog";
import { PlaySoundEffectEvent } from "../../src/client/sound/Sounds";
import {
  USER_SETTINGS_CHANGED_EVENT,
  UserSettings,
} from "../../src/client/UserSettings";
import type { GameView } from "../../src/client/view";
import { makeGameView, makePlayerView } from "../util/viewStubs";

const clearSettings = () => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
};
const setSetting = (key: string, value: string) => {
  localStorage.setItem(`settings.${key}`, value);
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
  window.dispatchEvent(
    new CustomEvent(`${USER_SETTINGS_CHANGED_EVENT}:settings.${key}`),
  );
};

const gv = makeGameView({ myClientID: "me" });
function player(
  smallID: number,
  name: string,
  opts: {
    clan?: string;
    type?: PlayerType;
    staffRole?: "owner" | "admin" | "mod";
    verified?: boolean;
    clientID?: string | null;
  } = {},
) {
  return makePlayerView({
    game: gv,
    data: {
      id: `p${smallID}`,
      smallID,
      name,
      displayName: opts.clan ? `[${opts.clan}] ${name}` : name,
      clanTag: opts.clan ?? null,
      playerType: opts.type ?? PlayerType.Human,
      clientID: opts.clientID === undefined ? `c${smallID}` : opts.clientID,
    },
    cosmetics: { staffRole: opts.staffRole, verified: opts.verified },
  });
}

const players = new Map([
  [
    1,
    player(1, "Alphaz", { clan: "DELTA", staffRole: "owner", verified: true }),
  ],
  [2, player(2, "RedFox")],
  [3, player(3, "Me", { clientID: "me" })],
  [4, player(4, "Nova", { type: PlayerType.Nation, clientID: null })],
  [5, player(5, "Tribe", { type: PlayerType.Bot, clientID: null })],
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
const eliminated = (actor: number | null, target: number, tick: number) =>
  event({
    type: "player_eliminated",
    severity: "critical",
    actor,
    target,
    tick,
    meta: { targetKind: "player" },
  });

interface Harness {
  feed: MatchEventFeed;
  log: MatchEventLog;
  bus: EventBus;
  sounds: string[];
  clock: { now: number; catchingUp: boolean };
  settle(): Promise<void>;
}

async function mount(): Promise<Harness> {
  const log = new MatchEventLog();
  const clock = { now: 105, catchingUp: false };
  const game = {
    matchEvents: () => log,
    ticks: () => clock.now,
    isCatchingUp: () => clock.catchingUp,
    myPlayer: () => players.get(3),
    playerBySmallID: (id: number) =>
      players.get(id) ?? { isPlayer: () => false },
  } as unknown as GameView;
  const bus = new EventBus();
  const sounds: string[] = [];
  bus.on(PlaySoundEffectEvent, (e) => sounds.push(e.effect));
  const feed = new MatchEventFeed();
  feed.game = game;
  feed.eventBus = bus;
  document.body.append(feed);
  const settle = async () => {
    feed.tick();
    await feed.updateComplete;
  };
  await settle();
  return { feed, log, bus, sounds, clock, settle };
}

const rows = (h: Harness) => [
  ...h.feed.querySelectorAll<HTMLElement>(".match-feed-row"),
];

beforeEach(clearSettings);
afterEach(() => {
  document.body.innerHTML = "";
  clearSettings();
});

describe("<match-event-feed>", () => {
  it("draws nothing until something happens", async () => {
    const h = await mount();
    expect(rows(h)).toEqual([]);
    expect(h.feed.querySelector("[role=log]")).toBeNull();
  });

  it("shows events newest first, in DeltaFront's wording, with the badges the HUD draws", async () => {
    const h = await mount();
    h.log.ingest([
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 100 }),
      eliminated(1, 2, 103),
    ]);
    await h.settle();
    const [top, below] = rows(h);
    expect(top.textContent).toContain("eliminated");
    expect(top.textContent).toMatch(/\[DELTA\]\s*Alphaz.*eliminated.*RedFox/s);
    expect(below.textContent).toMatch(/formed an alliance with/);
    // The owner badge and the verified check are the same marks as everywhere else.
    expect(top.querySelector('svg[data-staff-role="owner"]')).not.toBeNull();
    expect(
      top.querySelector(
        `svg[aria-label="${translateEn("username.verified_player")}"]`,
      ),
    ).not.toBeNull();
    // RedFox has neither.
    const redfox = top.querySelectorAll("[data-match-event-player='2']")[0];
    expect(redfox.querySelector("svg")).toBeNull();
    expect(top.getAttribute("data-severity")).toBe("critical");
    expect(below.getAttribute("data-severity")).toBe("normal");
  });

  it("is a ticker that takes no clicks, and is labelled for assistive tech", async () => {
    const h = await mount();
    h.log.ingest([eliminated(1, 2, 103)]);
    await h.settle();
    const log = h.feed.querySelector("[role=log]")!;
    expect(log.className).toContain("pointer-events-none");
    expect(log.getAttribute("aria-label")).toBe("Match events");
  });

  it("never shows more than the maximum, however much happens", async () => {
    const h = await mount();
    const many: MatchEvent[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(
        event({
          type: "alliance_formed",
          actor: 1,
          target: 2,
          tick: 100 + (i % 4),
        }),
      );
    }
    h.log.ingest(many);
    await h.settle();
    expect(rows(h)).toHaveLength(FEED_MAX_ROWS);
  });

  it("lets rows go as they age, important ones last", async () => {
    const h = await mount();
    h.log.ingest([
      eliminated(1, 2, 100),
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 100 }),
    ]);
    await h.settle();
    expect(rows(h)).toHaveLength(2);
    h.clock.now = 100 + FEED_LIFETIME_TICKS.normal + 1;
    await h.settle();
    expect(rows(h).map((r) => r.getAttribute("data-severity"))).toEqual([
      "critical",
    ]);
    h.clock.now = 100 + FEED_LIFETIME_TICKS.critical + 1;
    await h.settle();
    expect(rows(h)).toEqual([]);
  });

  it("the full history stays in the log after the ticker has let it go", async () => {
    const h = await mount();
    h.log.ingest([eliminated(1, 2, 100)]);
    h.clock.now = 5000;
    await h.settle();
    expect(rows(h)).toEqual([]);
    expect(h.log.size()).toBe(1);
  });

  it("'Major only' keeps the ticker to the big moments", async () => {
    const h = await mount();
    h.log.ingest([
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 100 }),
      eliminated(1, 2, 101),
    ]);
    await h.settle();
    expect(rows(h)).toHaveLength(2);
    setSetting("eventFeedDetail", "major");
    await h.settle();
    expect(rows(h).map((r) => r.getAttribute("data-event-type"))).toEqual([
      "player_eliminated",
    ]);
  });

  it("'All' leaves out ordinary events that only concern nations and tribes", async () => {
    const h = await mount();
    h.log.ingest([
      event({ type: "alliance_formed", actor: 4, target: 5, tick: 100 }),
      event({ type: "alliance_formed", actor: 4, target: 2, tick: 101 }),
    ]);
    await h.settle();
    expect(rows(h)).toHaveLength(1);
    expect(rows(h)[0].textContent).toContain("RedFox");
  });

  it("is off when the setting is off, and draws nothing then", async () => {
    const h = await mount();
    h.log.ingest([eliminated(1, 2, 103)]);
    await h.settle();
    expect(rows(h)).toHaveLength(1);
    setSetting("eventFeed", "false");
    await h.settle();
    expect(rows(h)).toEqual([]);
    expect(h.feed.textContent?.trim()).toBe("");
    // The history is still being kept for the full log.
    expect(h.log.size()).toBe(1);
    setSetting("eventFeed", "true");
    await h.settle();
    expect(rows(h)).toHaveLength(1);
  });

  it("Anonymous Names: switching it on replaces the names already on screen", async () => {
    const h = await mount();
    h.log.ingest([eliminated(1, 2, 103)]);
    await h.settle();
    expect(rows(h)[0].textContent).toContain("Alphaz");
    expect(rows(h)[0].textContent).toContain("DELTA");

    setSetting("anonymousNames", "true");
    await h.settle();
    const row = rows(h)[0];
    expect(row.textContent).not.toContain("Alphaz");
    expect(row.textContent).not.toContain("RedFox");
    expect(row.textContent).not.toContain("DELTA");
    expect(row.querySelector("svg[data-staff-role]")).toBeNull();
    expect(
      row.querySelector(
        `svg[aria-label="${translateEn("username.verified_player")}"]`,
      ),
    ).toBeNull();
    expect(row.textContent).toContain("eliminated");
  });

  it("does not flicker through a backlog while the game is catching up", async () => {
    const h = await mount();
    h.clock.catchingUp = true;
    h.log.ingest([eliminated(1, 2, 103)]);
    await h.settle();
    expect(rows(h)).toEqual([]);
    h.clock.catchingUp = false;
    await h.settle();
    expect(rows(h)).toHaveLength(1);
  });

  it("collapsed runs show once, with their count", async () => {
    const h = await mount();
    for (let i = 0; i < 3; i++) {
      h.log.ingest([
        event({
          type: "player_eliminated",
          actor: 1,
          target: 5,
          tick: 100 + i,
          meta: { targetKind: "bot" },
        }),
      ]);
    }
    await h.settle();
    expect(rows(h)).toHaveLength(1);
    expect(rows(h)[0].textContent).toContain("3 tribes");
  });
});

describe("<match-event-feed> sound", () => {
  it("is silent unless the player turned it on", async () => {
    const h = await mount();
    h.log.ingest([eliminated(1, 2, 104)]);
    await h.settle();
    expect(h.sounds).toEqual([]);
  });

  it("plays one quiet cue for a critical event, and not again within the cooldown", async () => {
    setSetting("eventFeedSound", "true");
    const h = await mount();
    h.log.ingest([eliminated(1, 2, 104)]);
    await h.settle();
    expect(h.sounds).toEqual(["message"]);
    h.clock.now = 108;
    h.log.ingest([eliminated(1, 4, 107)]);
    await h.settle();
    expect(h.sounds).toEqual(["message"]);
    h.clock.now = 200;
    h.log.ingest([eliminated(2, 4, 199)]);
    await h.settle();
    expect(h.sounds).toEqual(["message", "message"]);
  });

  it("does not play for ordinary events, and not for the player's own (those have their cues)", async () => {
    setSetting("eventFeedSound", "true");
    const h = await mount();
    h.log.ingest([
      event({ type: "alliance_formed", actor: 1, target: 2, tick: 104 }),
      eliminated(1, 3, 104), // the player was eliminated
    ]);
    await h.settle();
    expect(h.sounds).toEqual([]);
  });

  it("a betrayal between others has its own cue; a backlog has none", async () => {
    setSetting("eventFeedSound", "true");
    const h = await mount();
    h.log.ingest([
      event({
        type: "alliance_broken",
        severity: "major",
        actor: 1,
        target: 2,
        tick: 104,
        meta: { cause: "broken" },
      }),
    ]);
    await h.settle();
    expect(h.sounds).toEqual(["alliance-broken"]);
    h.sounds.length = 0;
    h.clock.now = 5000;
    h.log.ingest([eliminated(1, 2, 100)]); // long ago (a replayed backlog)
    await h.settle();
    expect(h.sounds).toEqual([]);
  });
});
