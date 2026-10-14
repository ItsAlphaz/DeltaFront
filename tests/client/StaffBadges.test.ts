import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/client/components/PlayerName";
import {
  staffBadge,
  staffRoleLabel,
} from "../../src/client/components/ui/StaffBadge";
import { verifiedBadge } from "../../src/client/components/ui/VerifiedBadge";
import { PlayerStats } from "../../src/client/hud/layers/PlayerStats";
import { UserSettings } from "../../src/client/UserSettings";
import type { GameView, PlayerView } from "../../src/client/view";
import { visibleCosmetics } from "../../src/client/view/CosmeticVisibility";
import { stampStaffRole } from "../../src/server/Privilege";
import { makePlayerUpdate, makePlayerView } from "../util/viewStubs";

// translateText echoes its key in tests, so labels read as "staff.owner" etc.
const clearSettings = () => {
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
};

const STAFF = "svg[data-staff-role]";
const VERIFIED = 'svg[aria-label="username.verified_player"]';

describe("staffBadge", () => {
  const draw = (role: Parameters<typeof staffBadge>[0]) => {
    const host = document.createElement("div");
    render(staffBadge(role), host);
    return host;
  };

  it("draws a distinct, labelled mark for each role, and nothing for no role", () => {
    const shapes = new Set<string>();
    for (const role of ["owner", "admin", "mod"] as const) {
      const svg = draw(role).querySelector("svg")!;
      expect(svg.getAttribute("data-staff-role")).toBe(role);
      expect(svg.getAttribute("role")).toBe("img");
      expect(svg.getAttribute("aria-label")).toBe(`staff.${role}`);
      expect(svg.querySelector("title")?.textContent).toBe(`staff.${role}`);
      shapes.add(svg.innerHTML);
    }
    expect(shapes.size).toBe(3);
    expect(draw(null).querySelector("svg")).toBeNull();
    expect(draw(undefined).querySelector("svg")).toBeNull();
    expect(staffRoleLabel("owner")).toBe("staff.owner");
  });

  it("builds its shapes in the SVG namespace, so they actually draw", () => {
    // An html-tagged fragment inside <svg> yields HTML-namespace elements, which
    // paint nothing (caught in a real browser, invisible to a plain query).
    for (const role of ["owner", "admin", "mod"] as const) {
      const svg = draw(role).querySelector("svg")!;
      const paths = svg.querySelectorAll("path");
      expect(paths.length).toBeGreaterThan(0);
      for (const el of [...paths, svg.querySelector("title")!]) {
        expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
      }
    }
  });

  it("is not the verified check, and can be drawn decoratively", () => {
    const host = document.createElement("div");
    render(
      html`${staffBadge("owner", "w-4 h-4", null)}${verifiedBadge()}`,
      host,
    );
    const [staff, verified] = host.querySelectorAll("svg");
    expect(staff.getAttribute("aria-hidden")).toBe("true");
    expect(staff.getAttribute("aria-label")).toBeNull();
    expect(verified.getAttribute("data-staff-role")).toBeNull();
  });
});

describe("<player-name>: staff role and verification are separate", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mount(props: {
    username: string | null;
    verified?: boolean;
    staffRole?: "owner" | "admin" | "mod";
  }) {
    const el = document.createElement("player-name") as HTMLElement & {
      username: string | null;
      verified: boolean | undefined;
      staffRole: "owner" | "admin" | "mod" | undefined;
      publicId: string;
      updateComplete: Promise<boolean>;
    };
    el.publicId = "9EKyqPa9rm";
    el.username = props.username;
    el.verified = props.verified;
    el.staffRole = props.staffRole;
    document.body.append(el);
    await el.updateComplete;
    return el;
  }

  it("owner + verified shows both badges", async () => {
    const el = await mount({
      username: "Alphaz",
      verified: true,
      staffRole: "owner",
    });
    expect(el.querySelectorAll(STAFF)).toHaveLength(1);
    expect(el.querySelector(STAFF)?.getAttribute("data-staff-role")).toBe(
      "owner",
    );
    expect(el.querySelectorAll(VERIFIED)).toHaveLength(1);
  });

  it("each role alone shows only its own badge, and no verified check", async () => {
    for (const staffRole of ["owner", "admin", "mod"] as const) {
      const el = await mount({
        username: "Staff.0001",
        verified: false,
        staffRole,
      });
      expect(el.querySelector(STAFF)?.getAttribute("data-staff-role")).toBe(
        staffRole,
      );
      expect(el.querySelector(VERIFIED)).toBeNull();
      el.remove();
    }
  });

  it("verified alone shows no staff badge", async () => {
    const el = await mount({ username: "Aydin.4821", verified: true });
    expect(el.querySelector(STAFF)).toBeNull();
    expect(el.querySelector(VERIFIED)).not.toBeNull();
  });

  it("a bare username earns no badge of any kind when the server says otherwise", async () => {
    const el = await mount({ username: "Alphaz", verified: false });
    expect(el.querySelector(STAFF)).toBeNull();
    expect(el.querySelector(VERIFIED)).toBeNull();
  });

  it("a staff role is never worked out from a name: an admin-looking name gets nothing", async () => {
    for (const username of [
      "Admin",
      "Owner",
      "DeltaFront Owner",
      "Moderator.0001",
    ]) {
      const el = await mount({ username, verified: false });
      expect(el.querySelector(STAFF), username).toBeNull();
      el.remove();
    }
  });
});

describe("in-game: PlayerView.staffBadgeRole", () => {
  beforeEach(clearSettings);
  afterEach(clearSettings);

  it("is the role the server stamped, for every role, and null otherwise", () => {
    for (const staffRole of ["owner", "admin", "mod"] as const) {
      expect(
        makePlayerView({ cosmetics: { staffRole } }).staffBadgeRole(),
      ).toBe(staffRole);
    }
    expect(makePlayerView({ cosmetics: {} }).staffBadgeRole()).toBeNull();
  });

  it("is independent of the verified check", () => {
    const both = makePlayerView({
      cosmetics: { staffRole: "owner", verified: true },
    });
    expect(both.staffBadgeRole()).toBe("owner");
    expect(both.showsVerifiedBadge()).toBe(true);
    const staffOnly = makePlayerView({ cosmetics: { staffRole: "admin" } });
    expect(staffOnly.staffBadgeRole()).toBe("admin");
    expect(staffOnly.showsVerifiedBadge()).toBe(false);
  });

  it("is never worked out from the name", () => {
    const view = makePlayerView({
      data: makePlayerUpdate({ name: "Owner", displayName: "Owner" }),
      cosmetics: {},
    });
    expect(view.staffBadgeRole()).toBeNull();
  });

  it("is hidden beside an anonymized name", () => {
    localStorage.setItem("settings.anonymousNames", "true");
    expect(
      makePlayerView({ cosmetics: { staffRole: "owner" } }).staffBadgeRole(),
    ).toBeNull();
  });

  it("survives the cosmetics visibility filters like the verified badge does", () => {
    const cosmetics = { staffRole: "admin" as const, verified: true };
    expect(visibleCosmetics(cosmetics, { showFrom: "self" }, "other")).toEqual({
      verified: true,
      staffRole: "admin",
    });
    expect(visibleCosmetics(cosmetics, {}, "other")).toEqual(cosmetics);
  });

  it("a client's own cosmetics claim cannot set it: the server overwrites it at join", () => {
    const sent = { staffRole: "owner" as const };
    stampStaffRole(sent, undefined);
    expect(makePlayerView({ cosmetics: sent }).staffBadgeRole()).toBeNull();
  });
});

describe("in-game leaderboard (player-stats)", () => {
  beforeEach(clearSettings);
  afterEach(() => {
    document.body.innerHTML = "";
    clearSettings();
  });

  function statPlayer(
    id: string,
    tiles: number,
    cosmetics: { verified?: boolean; staffRole?: "owner" | "admin" | "mod" },
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

  async function mount(players: PlayerView[]) {
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

  it("shows each player's staff badge beside the name, with verified separate", async () => {
    const el = await mount([
      statPlayer("the-owner", 90, { staffRole: "owner", verified: true }),
      statPlayer("the-admin", 80, { staffRole: "admin" }),
      statPlayer("the-mod", 70, { staffRole: "mod" }),
      statPlayer("verified-only", 60, { verified: true }),
      statPlayer("nobody", 50, {}),
    ]);
    const rows = [...el.querySelectorAll(".stats-table-row")];
    const badges = (row: Element) => ({
      staff: row.querySelector(STAFF)?.getAttribute("data-staff-role") ?? null,
      verified: row.querySelector(VERIFIED) !== null,
    });
    expect(rows.map(badges)).toEqual([
      { staff: "owner", verified: true },
      { staff: "admin", verified: false },
      { staff: "mod", verified: false },
      { staff: null, verified: true },
      { staff: null, verified: false },
    ]);
  });

  it("does not guess a role from a staff-looking name", async () => {
    const el = await mount([
      statPlayer("Owner", 90, {}),
      statPlayer("Admin", 80, {}),
    ]);
    expect(el.querySelector(STAFF)).toBeNull();
  });

  it("shows no staff badge while names are anonymized", async () => {
    localStorage.setItem("settings.anonymousNames", "true");
    const el = await mount([
      statPlayer("the-owner", 90, { staffRole: "owner" }),
    ]);
    expect(el.querySelector(STAFF)).toBeNull();
  });
});
