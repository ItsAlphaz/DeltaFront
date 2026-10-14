import { GameMode } from "@openfront/engine-api/game/GameTypes";
import type { ClientInfo } from "@openfront/shared/WireSchemas";
import { beforeEach, describe, expect, it } from "vitest";
import "../../../src/client/components/LobbyPlayerView";
import type { LobbyTeamView } from "../../../src/client/components/LobbyPlayerView";
import { UserSettings } from "../../../src/client/UserSettings";

const client = (
  clientID: string,
  overrides: Partial<ClientInfo> = {},
): ClientInfo => ({
  clientID,
  username: clientID,
  clanTag: null,
  ...overrides,
});

async function mount(clients: ClientInfo[], currentClientID = "me") {
  const view = document.createElement("lobby-player-view") as LobbyTeamView;
  view.gameMode = GameMode.FFA;
  view.currentClientID = currentClientID;
  view.clients = clients;
  document.body.append(view);
  await view.updateComplete;
  return view;
}
const roles = (view: LobbyTeamView) =>
  [...view.querySelectorAll("svg[data-staff-role]")].map((s) =>
    s.getAttribute("data-staff-role"),
  );

describe("lobby list staff badges", () => {
  beforeEach(() => {
    localStorage.clear();
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    document.body.replaceChildren();
  });

  it("shows each player's server-stamped staff badge, beside verified, never inferred", async () => {
    const view = await mount([
      client("me", { staffRole: "owner", verified: true }),
      client("adm", { staffRole: "admin" }),
      client("mod", { staffRole: "mod" }),
      client("Owner"), // a staff-looking name is just a name
      client("vrf", { verified: true }),
    ]);
    expect(roles(view)).toEqual(["owner", "admin", "mod"]);
    // The verified check still draws for the two verified players.
    expect(
      view.querySelectorAll('svg[aria-label="username.verified_heading"]'),
    ).toHaveLength(2);
  });

  it("hides other players' badges while the viewer has anonymous names on, but not their own", async () => {
    localStorage.setItem("settings.anonymousNames", "true");
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    const view = await mount([
      client("me", { staffRole: "owner" }),
      client("adm", { staffRole: "admin" }),
    ]);
    expect(roles(view)).toEqual(["owner"]);
  });
});
