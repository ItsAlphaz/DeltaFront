import { WirePlayerSchema } from "@openfront/shared/WireSchemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/client/components/PlayerName";
import { PlayerStats } from "../../src/client/hud/layers/PlayerStats";
import { UserSettings } from "../../src/client/UserSettings";
import type { GameView, PlayerView } from "../../src/client/view";
import { resolveVerifiedJoin } from "../../src/server/Privilege";
import { makePlayerUpdate, makePlayerView } from "../util/viewStubs";

const clearSettings = () => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
};

// What the game server hands every client for a join it approved: the
// cosmetics object after resolveVerifiedJoin, through the wire schema.
function approvedCosmetics(
  intent: boolean,
  joinName: string,
  account: Parameters<typeof resolveVerifiedJoin>[2],
) {
  const cosmetics: { verified?: boolean } = intent ? { verified: true } : {};
  resolveVerifiedJoin(cosmetics, joinName, account);
  return WirePlayerSchema.parse({
    clientID: "clientA01",
    username: joinName,
    clanTag: null,
    cosmetics,
  }).cosmetics;
}

const verifiedAccount = {
  username: "Aydin.4821",
  usernameBase: "Aydin",
  usernameStatus: "unclaimed",
  verified: true,
};

describe("PlayerView.showsVerifiedBadge", () => {
  beforeEach(clearSettings);
  afterEach(clearSettings);

  it("is true for a player the server approved as verified", () => {
    const view = makePlayerView({ cosmetics: { verified: true } });
    expect(view.showsVerifiedBadge()).toBe(true);
  });

  it("is false without the server's approval", () => {
    expect(makePlayerView({ cosmetics: {} }).showsVerifiedBadge()).toBe(false);
    expect(
      makePlayerView({ cosmetics: { verified: false } }).showsVerifiedBadge(),
    ).toBe(false);
  });

  it("is never derived from the name: a dotless or premium-looking name earns nothing", () => {
    const view = makePlayerView({
      data: makePlayerUpdate({
        name: "RyanTheGreat",
        displayName: "RyanTheGreat",
      }),
      cosmetics: {},
    });
    expect(view.showsVerifiedBadge()).toBe(false);
  });

  it("hides the check beside an anonymized name", () => {
    localStorage.setItem("settings.anonymousNames", "true");
    const view = makePlayerView({ cosmetics: { verified: true } });
    expect(view.showsVerifiedBadge()).toBe(false);
  });
});

describe("verified state from the join to the in-game badge", () => {
  beforeEach(clearSettings);
  afterEach(clearSettings);

  it("a manually verified account joining under its own suffixed name keeps the check in the game player", () => {
    const cosmetics = approvedCosmetics(true, "Aydin.4821", verifiedAccount);
    expect(cosmetics?.verified).toBe(true);
    expect(makePlayerView({ cosmetics }).showsVerifiedBadge()).toBe(true);
  });

  it("a different name strips the check before it reaches the game", () => {
    const cosmetics = approvedCosmetics(true, "Barack Obama", verifiedAccount);
    expect(cosmetics?.verified).toBeUndefined();
    expect(makePlayerView({ cosmetics }).showsVerifiedBadge()).toBe(false);
  });

  it("a spoofed claim from an unverified account (admin or not) never reaches the game", () => {
    const account = { ...verifiedAccount, verified: false, role: "admin" };
    const cosmetics = approvedCosmetics(true, "Aydin.4821", account as never);
    expect(cosmetics?.verified).toBeUndefined();
    expect(makePlayerView({ cosmetics }).showsVerifiedBadge()).toBe(false);
  });

  it("the premium bare-name path still reaches the game", () => {
    const cosmetics = approvedCosmetics(true, "RyanTheGreat", {
      username: "RyanTheGreat",
      usernameBase: "RyanTheGreat",
      usernameStatus: "premium",
    });
    expect(makePlayerView({ cosmetics }).showsVerifiedBadge()).toBe(true);
  });
});

// Real PlayerViews (so name() and showsVerifiedBadge() are the shipped ones);
// only the stat getters the table sorts on are pinned.
function statPlayer(
  id: string,
  tiles: number,
  cosmetics: { verified?: boolean },
): PlayerView {
  const view = makePlayerView({
    data: makePlayerUpdate({ id, name: id, displayName: id }),
    cosmetics,
  });
  return Object.assign(view, {
    id: () => id,
    smallID: () => 0,
    numTilesOwned: () => tiles,
    gold: () => BigInt(tiles),
    tradeGold: () => 0,
    trainGold: () => 0,
    piracyGold: () => 0,
    goldEarned: () => 0,
    troops: () => tiles,
    totalUnitLevels: () => tiles,
    isAlive: () => true,
    isOnSameTeam: () => false,
  });
}

async function mountStats(players: PlayerView[]): Promise<PlayerStats> {
  const game = {
    myPlayer: () => null,
    playerViews: () => players,
    config: () => ({ maxTroops: () => 100 }),
    ticks: () => 600,
    numLandTiles: () => 100,
    numTilesWithFallout: () => 0,
  } as unknown as GameView;
  const el = new PlayerStats();
  el.game = game;
  el.visible = true;
  document.body.append(el);
  el.refresh();
  await el.updateComplete;
  return el;
}

const BADGE = 'svg[aria-label="username.verified_player"]';

describe("in-game leaderboard (player-stats)", () => {
  beforeEach(clearSettings);
  afterEach(() => {
    document.body.innerHTML = "";
    clearSettings();
  });

  it("draws the check on the server-approved player's row and nowhere else", async () => {
    const el = await mountStats([
      statPlayer("verified-one", 90, { verified: true }),
      statPlayer("plain-one", 50, {}),
    ]);
    const rows = [...el.querySelectorAll(".stats-table-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("verified-one");
    expect(rows[0].querySelectorAll(BADGE)).toHaveLength(1);
    expect(rows[1].textContent).toContain("plain-one");
    expect(rows[1].querySelector(BADGE)).toBeNull();
    // The badge sits in the player-name cell, beside the name.
    const nameCell = [...rows[0].querySelectorAll('[role="cell"]')].find((c) =>
      c.textContent?.includes("verified-one"),
    );
    expect(nameCell?.querySelector(BADGE)).not.toBeNull();
  });

  it("does not infer the check from the name", async () => {
    const el = await mountStats([statPlayer("RyanTheGreat", 90, {})]);
    expect(el.querySelector(BADGE)).toBeNull();
  });

  it("works for a suffixed manually verified name", async () => {
    const el = await mountStats([
      statPlayer("Aydin.4821", 90, { verified: true }),
    ]);
    expect(el.querySelector(".stats-table-row")?.textContent).toContain(
      "Aydin.4821",
    );
    expect(el.querySelectorAll(BADGE)).toHaveLength(1);
  });
});

describe("<player-name> on account surfaces", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function render(props: {
    username: string | null;
    verified?: boolean;
  }) {
    const el = document.createElement("player-name") as HTMLElement & {
      username: string | null;
      verified: boolean;
      publicId: string;
      updateComplete: Promise<boolean>;
    };
    el.publicId = "9EKyqPa9rm";
    el.username = props.username;
    el.verified = props.verified ?? false;
    document.body.append(el);
    await el.updateComplete;
    return el;
  }

  it("shows the check for the server flag on a suffixed name", async () => {
    const el = await render({ username: "Aydin.4821", verified: true });
    expect(el.querySelector(BADGE)).not.toBeNull();
  });

  it("shows no check for a suffixed name without the flag", async () => {
    const el = await render({ username: "Aydin.4821" });
    expect(el.querySelector(BADGE)).toBeNull();
  });

  it("still recognises the bare-name (premium) claim", async () => {
    const el = await render({ username: "RyanTheGreat" });
    expect(el.querySelector(BADGE)).not.toBeNull();
  });
});
