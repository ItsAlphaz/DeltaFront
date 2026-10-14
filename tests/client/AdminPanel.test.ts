import type {
  AdminAuditList,
  AdminClanDetail,
  AdminClanList,
  AdminDashboard,
  AdminMe,
  AdminProgression,
  AdminSeasonList,
  AdminUserDetail,
  AdminUserList,
  AdminXpHistory,
} from "@openfront/shared/AdminSchemas";
import { permissionsOf } from "@openfront/shared/Permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api, showInGameConfirm } = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    api: {
      me: fn(),
      dashboard: fn(),
      server: fn(),
      users: fn(),
      user: fn(),
      userAudit: fn(),
      setVerified: fn(),
      setBareName: fn(),
      setRole: fn(),
      credits: fn(),
      item: fn(),
      ban: fn(),
      unban: fn(),
      revokeSessions: fn(),
      clans: fn(),
      clan: fn(),
      createOfficialClan: fn(),
      clanRename: fn(),
      clanRetag: fn(),
      clanOpen: fn(),
      clanTransfer: fn(),
      clanRemoveMember: fn(),
      clanBan: fn(),
      clanDelete: fn(),
      audit: fn(),
      progression: fn(),
      xpHistory: fn(),
      adjustXp: fn(),
      resetSeasonXp: fn(),
      seasons: fn(),
      createSeason: fn(),
      updateSeason: fn(),
      closeSeason: fn(),
    },
    showInGameConfirm: vi.fn(async (_m: string, _o?: unknown) => true),
  };
});
vi.mock("../../src/client/AdminApi", () => ({ adminApi: api }));
vi.mock("../../src/client/InGameModal", () => ({
  showInGameConfirm: (m: string, o?: unknown) => showInGameConfirm(m, o),
  showInGameAlert: vi.fn(async () => true),
}));

import { AdminModal } from "../../src/client/AdminModal";
import "../../src/client/admin/AdminAuditView";
import "../../src/client/admin/AdminClansView";
import "../../src/client/admin/AdminDashboardView";
import "../../src/client/admin/AdminProgressionCard";
import "../../src/client/admin/AdminSeasonsView";
import "../../src/client/admin/AdminServerView";
import "../../src/client/admin/AdminUsersView";

type Role = "owner" | "admin" | "mod";
const me = (role: Role): AdminMe => ({
  publicId: "STAFF00001",
  role,
  permissions: permissionsOf(role),
});
const ok = <T>(data: T) => ({ ok: true as const, data });
const NOW = "2026-10-14T12:00:00.000Z";

const USER: AdminUserDetail = {
  id: "uuid-1",
  publicId: "TARGET0001",
  username: "Target.0001",
  usernameBase: "Target",
  kind: "registered",
  role: null,
  verified: false,
  bareUsernameEnabled: false,
  holdsBareName: false,
  createdAt: NOW,
  lastSeenAt: NOW,
  deletionRequestedAt: null,
  credits: "100",
  liveSessions: 1,
  identities: [],
  items: [],
  clans: [],
  bans: [],
};
const USER_LIST: AdminUserList = {
  users: [
    {
      publicId: USER.publicId,
      username: USER.username,
      kind: "registered",
      role: null,
      verified: false,
      createdAt: NOW,
      lastSeenAt: NOW,
      banned: false,
    },
  ],
};
const CLAN: AdminClanDetail = {
  tag: "DELTA",
  name: "DeltaFront",
  isOpen: true,
  members: 1,
  createdAt: NOW,
  description: "",
  pendingRequests: 0,
  bans: [],
  membersList: [
    {
      publicId: "STAFF00001",
      username: "Alphaz",
      role: "leader",
      verified: true,
      staffRole: "owner",
      joinedAt: NOW,
    },
  ],
  events: [],
};
const CLANS: AdminClanList = {
  clans: [
    {
      tag: "DELTA",
      name: "DeltaFront",
      isOpen: true,
      members: 1,
      createdAt: NOW,
    },
  ],
};
const DASH: AdminDashboard = {
  version: "0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  uptimeSeconds: 120,
  health: { database: "ok", migrations: "ok", signingKey: "ok" },
  counts: {
    registeredUsers: 7,
    guests: 3,
    newUsers24h: 2,
    newUsers7d: 5,
    activeAccounts5m: 4,
    liveGames: 1,
    activeBans: 0,
    clans: 1,
  },
  recentRegistrations: [],
  recentBans: [],
  servers: [],
};
const AUDIT: AdminAuditList = { entries: [], nextBefore: null };
const PROGRESSION: AdminProgression = {
  registered: true,
  lifetimeXp: 123_456,
  runXp: 23_060,
  level: 20,
  rank: "corporal",
  prestige: 1,
  legend: false,
  title: "veteran",
  season: { number: 1, name: "Opening", xp: 7850, level: 4 },
  challenges: [
    {
      id: "d_win_1",
      period: "daily",
      progress: 0,
      target: 1,
      completed: false,
    },
  ],
  flaggedGames: [
    { gameId: "ab123456", flags: ["repeat_group"], xp: 60, at: NOW },
  ],
};
const HISTORY: AdminXpHistory = {
  entries: [
    {
      id: "1",
      amount: 750,
      source: "match",
      refType: "game",
      refId: "ab123456",
      reason: null,
      actor: null,
      lifetimeAfter: 750,
      runAfter: 750,
      createdAt: NOW,
    },
  ],
  page: 1,
  hasMore: false,
};
const SEASONS: AdminSeasonList = {
  seasons: [
    {
      id: "2",
      number: 2,
      name: "Winter",
      startsAt: NOW,
      endsAt: "2030-01-01T00:00:00.000Z",
      archivedAt: null,
      current: true,
      rewardFlares: {},
      players: 12,
    },
    {
      id: "1",
      number: 1,
      name: "Opening",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
      current: false,
      rewardFlares: {},
      players: 90,
    },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  showInGameConfirm.mockReset();
  showInGameConfirm.mockResolvedValue(true);
  api.users.mockResolvedValue(ok(USER_LIST));
  api.user.mockResolvedValue(ok(USER));
  api.userAudit.mockResolvedValue(ok(AUDIT));
  api.clans.mockResolvedValue(ok(CLANS));
  api.clan.mockResolvedValue(ok(CLAN));
  api.dashboard.mockResolvedValue(ok(DASH));
  api.audit.mockResolvedValue(ok(AUDIT));
  api.progression.mockResolvedValue(ok(PROGRESSION));
  api.xpHistory.mockResolvedValue(ok(HISTORY));
  api.seasons.mockResolvedValue(ok(SEASONS));
  for (const f of [
    api.adjustXp,
    api.resetSeasonXp,
    api.createSeason,
    api.updateSeason,
    api.closeSeason,
  ]) {
    f.mockResolvedValue(ok({ ok: true, message: "done", changed: true }));
  }
  for (const f of [
    api.setVerified,
    api.setBareName,
    api.setRole,
    api.credits,
    api.item,
    api.ban,
    api.unban,
    api.revokeSessions,
    api.createOfficialClan,
    api.clanDelete,
    api.clanRename,
    api.clanTransfer,
  ]) {
    f.mockResolvedValue(ok({ ok: true, message: "done", changed: true }));
  }
});
afterEach(() => {
  document.body.innerHTML = "";
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function mountUsers(role: Role) {
  const el = document.createElement("admin-users-view") as HTMLElement & {
    me: AdminMe;
    updateComplete: Promise<boolean>;
  };
  el.me = me(role);
  document.body.append(el);
  await el.updateComplete;
  await tick();
  await el.updateComplete;
  (el.querySelector("tbody tr") as HTMLElement).click();
  await tick();
  await el.updateComplete;
  return el;
}
const btn = (root: Element, label: string) =>
  [...root.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
const setReason = async (
  el: HTMLElement & { updateComplete: Promise<boolean> },
  text: string,
) => {
  const input = el.querySelector<HTMLInputElement>("#admin-reason")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  await el.updateComplete;
};

describe("<admin-modal>", () => {
  async function open(result: unknown) {
    api.me.mockResolvedValue(result);
    const modal = new AdminModal();
    modal.setAttribute("inline", "");
    document.body.append(modal);
    await modal.updateComplete;
    (modal as unknown as { onOpen(): void }).onOpen();
    await tick();
    await modal.updateComplete;
    return modal;
  }
  const tabs = (m: AdminModal) =>
    (m as unknown as { modalConfig(): { tabs?: Array<{ key: string }> } })
      .modalConfig()
      .tabs?.map((t) => t.key);

  it("an account the API refuses sees only a denial, and no panel", async () => {
    const modal = await open({ ok: false, status: 403, error: "forbidden" });
    expect(modal.querySelector("#admin-denied")).not.toBeNull();
    expect(tabs(modal)).toBeUndefined();
    expect(modal.querySelector("admin-users-view")).toBeNull();
    expect(api.users).not.toHaveBeenCalled();
  });

  it("a signed-out visitor is told to sign in", async () => {
    const modal = await open({ ok: false, status: 401, error: "unauthorized" });
    expect(modal.querySelector("#admin-denied")?.textContent).toContain(
      "admin_panel.error_signed_out",
    );
  });

  it("tabs follow the role: a moderator has no server page, an admin and the owner do", async () => {
    expect(tabs(await open(ok(me("mod"))))).toEqual([
      "dashboard",
      "users",
      "clans",
      "audit",
    ]);
    expect(tabs(await open(ok(me("admin"))))).toEqual([
      "dashboard",
      "users",
      "clans",
      "audit",
      "server",
    ]);
    // seasons are the owner's alone
    expect(tabs(await open(ok(me("owner"))))).toEqual([
      "dashboard",
      "users",
      "clans",
      "audit",
      "server",
      "seasons",
    ]);
  });

  it("shows the role badge and label of the signed-in staff member", async () => {
    const modal = await open(ok(me("owner")));
    expect(modal.querySelector('svg[data-staff-role="owner"]')).not.toBeNull();
    expect(modal.textContent).toContain("staff.owner");
  });
});

describe("<admin-users-view>", () => {
  it("a moderator sees the ban controls and none of the others", async () => {
    const el = await mountUsers("mod");
    expect(el.querySelector("#admin-ban-category")).not.toBeNull();
    expect(btn(el, "admin_panel.verify")).toBeUndefined();
    expect(btn(el, "admin_panel.grant_bare_name")).toBeUndefined();
    expect(btn(el, "admin_panel.revoke_sessions")).toBeUndefined();
    expect(el.querySelector("#admin-role")).toBeNull();
    expect(el.querySelector("#admin-credits")).toBeNull();
    expect(el.querySelector("#admin-flare")).toBeNull();
  });

  it("an admin sees every account action, but may only offer moderator, flag or no role", async () => {
    const el = await mountUsers("admin");
    expect(btn(el, "admin_panel.verify")).toBeDefined();
    expect(btn(el, "admin_panel.grant_bare_name")).toBeDefined();
    expect(btn(el, "admin_panel.revoke_sessions")).toBeDefined();
    const roles = [...el.querySelectorAll("#admin-role option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(roles).toEqual(["mod", "flagged", "none"]);
  });

  it("the owner can also offer the admin role, and never owner", async () => {
    const el = await mountUsers("owner");
    const roles = [...el.querySelectorAll("#admin-role option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(roles).toEqual(["admin", "mod", "flagged", "none"]);
  });

  it("nothing is sent without a reason", async () => {
    const el = await mountUsers("admin");
    btn(el, "admin_panel.verify")!.click();
    await tick();
    expect(api.setVerified).not.toHaveBeenCalled();
    expect(el.querySelector("#admin-notice")?.textContent).toContain(
      "admin_panel.reason_required",
    );
  });

  it("sends the change with its reason, then shows the result", async () => {
    const el = await mountUsers("admin");
    await setReason(el, "owner asked");
    btn(el, "admin_panel.verify")!.click();
    await vi.waitFor(() =>
      expect(api.setVerified).toHaveBeenCalledWith(
        "TARGET0001",
        true,
        "owner asked",
      ),
    );
    await vi.waitFor(() =>
      expect(el.querySelector("#admin-notice")?.textContent).toContain("done"),
    );
  });

  it("a destructive action asks first, and a no sends nothing", async () => {
    const el = await mountUsers("admin");
    await setReason(el, "cleanup");
    showInGameConfirm.mockResolvedValueOnce(false);
    btn(el, "admin_panel.revoke_sessions")!.click();
    await vi.waitFor(() => expect(showInGameConfirm).toHaveBeenCalledTimes(1));
    expect(api.revokeSessions).not.toHaveBeenCalled();
    btn(el, "admin_panel.revoke_sessions")!.click();
    await vi.waitFor(() =>
      expect(api.revokeSessions).toHaveBeenCalledWith("TARGET0001", "cleanup"),
    );
  });

  it("a ban asks first and sends the category and days", async () => {
    const el = await mountUsers("mod");
    await setReason(el, "cheating");
    const category = el.querySelector<HTMLInputElement>("#admin-ban-category")!;
    category.value = "cheating";
    category.dispatchEvent(new Event("input"));
    await (el as unknown as { updateComplete: Promise<boolean> })
      .updateComplete;
    btn(el, "admin_panel.ban")!.click();
    await vi.waitFor(() =>
      expect(api.ban).toHaveBeenCalledWith(
        "TARGET0001",
        "cheating",
        null,
        "cheating",
      ),
    );
    expect(showInGameConfirm).toHaveBeenCalled();
  });

  it("an API refusal is shown as such, not as success", async () => {
    api.setVerified.mockResolvedValue({
      ok: false,
      status: 403,
      error: "TARGET_PROTECTED",
    });
    const el = await mountUsers("admin");
    await setReason(el, "try");
    btn(el, "admin_panel.verify")!.click();
    await vi.waitFor(() =>
      expect(el.querySelector("#admin-notice")?.textContent).toContain(
        "admin_panel.error_TARGET_PROTECTED",
      ),
    );
  });

  it("an account's staff role and verification show as separate chips", async () => {
    api.user.mockResolvedValue(ok({ ...USER, role: "owner", verified: true }));
    const el = await mountUsers("owner");
    const detail = el.querySelector("#admin-user-detail")!;
    expect(detail.textContent).toContain("admin_panel.chip_owner");
    expect(detail.textContent).toContain("admin_panel.chip_verified");
  });
});

describe("<admin-progression-card>", () => {
  async function mountCard(role: Role) {
    const el = document.createElement(
      "admin-progression-card",
    ) as HTMLElement & {
      me: AdminMe;
      publicId: string;
      updateComplete: Promise<boolean>;
    };
    el.me = me(role);
    el.publicId = "TARGET0001";
    document.body.append(el);
    await el.updateComplete;
    await tick();
    await el.updateComplete;
    return el;
  }
  const fill = async (
    el: HTMLElement & { updateComplete: Promise<boolean> },
    amount: string,
    reason: string,
  ) => {
    const [xp, why] = [
      ...el.querySelectorAll<HTMLInputElement>("[data-admin-xp-tools] input"),
    ];
    xp.value = amount;
    xp.dispatchEvent(new Event("input"));
    why.value = reason;
    why.dispatchEvent(new Event("input"));
    await el.updateComplete;
  };

  it("shows level, rank, prestige, XP, season, challenges and review flags", async () => {
    const el = await mountCard("mod");
    expect(el.querySelector("[data-admin-level]")?.textContent).toContain("20");
    expect(el.querySelector("[data-admin-level]")?.textContent).toContain(
      "progression.rank_corporal",
    );
    expect(el.querySelector("[data-admin-run-xp]")?.textContent).toBe("23,060");
    expect(el.querySelector("[data-admin-lifetime-xp]")?.textContent).toBe(
      "123,456",
    );
    expect(el.textContent).toContain("Opening");
    expect(el.textContent).toContain("d_win_1");
    expect(el.textContent).toContain("repeat_group");
  });

  it("a moderator can look but has no tools and no history", async () => {
    const el = await mountCard("mod");
    expect(el.querySelector("[data-admin-xp-tools]")).toBeNull();
    expect(el.querySelector("[data-admin-xp-history]")).toBeNull();
    expect(api.xpHistory).not.toHaveBeenCalled();
  });

  it("an admin can grant and revoke but not set; the owner can do all three", async () => {
    let el = await mountCard("admin");
    expect(el.querySelector("[data-admin-xp-grant]")).not.toBeNull();
    expect(el.querySelector("[data-admin-xp-revoke]")).not.toBeNull();
    expect(el.querySelector("[data-admin-xp-set]")).toBeNull();
    expect(el.querySelector("[data-admin-xp-history]")).not.toBeNull();
    el.remove();
    el = await mountCard("owner");
    expect(el.querySelector("[data-admin-xp-set]")).not.toBeNull();
  });

  it("nothing is sent without a reason or with a bad amount", async () => {
    const el = await mountCard("admin");
    await fill(el, "100", "");
    (el.querySelector("[data-admin-xp-grant]") as HTMLButtonElement).click();
    await tick();
    expect(api.adjustXp).not.toHaveBeenCalled();
    expect(el.textContent).toContain("admin_panel.reason_required");
    await fill(el, "abc", "because");
    (el.querySelector("[data-admin-xp-grant]") as HTMLButtonElement).click();
    await tick();
    expect(api.adjustXp).not.toHaveBeenCalled();
    expect(el.textContent).toContain("admin_panel.xp_invalid");
  });

  it("sends a grant with its reason, and reloads", async () => {
    const el = await mountCard("admin");
    await fill(el, "500", "tournament prize");
    (el.querySelector("[data-admin-xp-grant]") as HTMLButtonElement).click();
    await tick();
    expect(api.adjustXp).toHaveBeenCalledWith(
      "TARGET0001",
      "grant",
      500,
      "tournament prize",
      false,
    );
    expect(api.progression).toHaveBeenCalledTimes(2);
    expect(showInGameConfirm).not.toHaveBeenCalled();
  });

  it("a revoke asks first, and a no sends nothing", async () => {
    const el = await mountCard("admin");
    await fill(el, "50", "cheating");
    showInGameConfirm.mockResolvedValueOnce(false);
    (el.querySelector("[data-admin-xp-revoke]") as HTMLButtonElement).click();
    await tick();
    expect(showInGameConfirm).toHaveBeenCalledOnce();
    expect(api.adjustXp).not.toHaveBeenCalled();
    (el.querySelector("[data-admin-xp-revoke]") as HTMLButtonElement).click();
    await tick();
    expect(api.adjustXp).toHaveBeenCalledWith(
      "TARGET0001",
      "revoke",
      50,
      "cheating",
      false,
    );
  });

  it("an API refusal is shown, not reported as success", async () => {
    api.adjustXp.mockResolvedValue({
      ok: false,
      status: 409,
      error: "INSUFFICIENT",
    });
    const el = await mountCard("admin");
    await fill(el, "50", "cheating");
    (el.querySelector("[data-admin-xp-revoke]") as HTMLButtonElement).click();
    await tick();
    expect(el.querySelector("[role=status]")?.className).toContain("df-red");
  });

  it("says so for a guest", async () => {
    api.progression.mockResolvedValue(
      ok({ ...PROGRESSION, registered: false }),
    );
    const el = await mountCard("owner");
    expect(el.textContent).toContain("admin_panel.xp_guest");
    expect(el.querySelector("[data-admin-xp-tools]")).toBeNull();
  });
});

describe("<admin-seasons-view>", () => {
  async function mountSeasons() {
    const el = document.createElement("admin-seasons-view") as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    document.body.append(el);
    await el.updateComplete;
    await tick();
    await el.updateComplete;
    return el;
  }
  const typeInto = async (
    el: HTMLElement & { updateComplete: Promise<boolean> },
    index: number,
    value: string,
  ) => {
    const input = el.querySelectorAll<HTMLInputElement>("#admin-seasons input")[
      index
    ];
    input.value = value;
    input.dispatchEvent(new Event("input"));
    await el.updateComplete;
  };

  it("lists the running and archived seasons, and closing is offered for the running one only", async () => {
    const el = await mountSeasons();
    expect(el.querySelectorAll("[data-admin-season]")).toHaveLength(2);
    const running = el.querySelector('[data-admin-season="2"]')!;
    const archived = el.querySelector('[data-admin-season="1"]')!;
    expect(running.textContent).toContain("admin_panel.season_running");
    expect(running.querySelector("button")).not.toBeNull();
    expect(archived.textContent).toContain("admin_panel.season_archived");
    expect(archived.querySelector("button")).toBeNull();
  });

  it("creates a season from a name and two dates", async () => {
    const el = await mountSeasons();
    await typeInto(el, 0, "Spring");
    await typeInto(el, 1, "2031-03-01T00:00");
    await typeInto(el, 2, "2031-06-01T00:00");
    (
      el.querySelector("[data-admin-season-create]") as HTMLButtonElement
    ).click();
    await tick();
    expect(api.createSeason).toHaveBeenCalledWith({
      name: "Spring",
      startsAt: new Date("2031-03-01T00:00").toISOString(),
      endsAt: new Date("2031-06-01T00:00").toISOString(),
    });
  });

  it("refuses to create without a name or dates", async () => {
    const el = await mountSeasons();
    (
      el.querySelector("[data-admin-season-create]") as HTMLButtonElement
    ).click();
    await tick();
    expect(api.createSeason).not.toHaveBeenCalled();
    expect(el.textContent).toContain("admin_panel.season_invalid");
  });

  it("closing needs a reason and a confirmation", async () => {
    const el = await mountSeasons();
    const close = () =>
      (
        el.querySelector('[data-admin-season="2"] button') as HTMLButtonElement
      ).click();
    close();
    await tick();
    expect(api.closeSeason).not.toHaveBeenCalled();
    expect(el.textContent).toContain("admin_panel.reason_required");
    await typeInto(el, 3, "wrapping up early");
    showInGameConfirm.mockResolvedValueOnce(false);
    close();
    await tick();
    expect(api.closeSeason).not.toHaveBeenCalled();
    close();
    await tick();
    expect(api.closeSeason).toHaveBeenCalledWith("2", "wrapping up early");
  });
});

describe("<admin-clans-view>", () => {
  async function mountClans(role: Role) {
    const el = document.createElement("admin-clans-view") as HTMLElement & {
      me: AdminMe;
      updateComplete: Promise<boolean>;
    };
    el.me = me(role);
    document.body.append(el);
    await el.updateComplete;
    await tick();
    await el.updateComplete;
    (el.querySelector("tbody tr") as HTMLElement).click();
    await tick();
    await el.updateComplete;
    return el;
  }

  it("official clan creation is offered to admins and owners, not moderators", async () => {
    for (const [role, shown] of [
      ["mod", false],
      ["admin", true],
      ["owner", true],
    ] as const) {
      document.body.innerHTML = "";
      const el = await mountClans(role);
      expect(el.querySelector("#admin-create-clan") !== null, role).toBe(shown);
    }
  });

  it("deleting a clan is the owner's alone", async () => {
    expect(
      (await mountClans("admin")).querySelector("#admin-clan-delete"),
    ).toBeNull();
    expect(
      (await mountClans("mod")).querySelector("#admin-clan-delete"),
    ).toBeNull();
    expect(
      (await mountClans("owner")).querySelector("#admin-clan-delete"),
    ).not.toBeNull();
  });

  it("the member list shows each member's staff badge and verified check", async () => {
    const el = await mountClans("owner");
    const row = el.querySelector("#admin-clan-detail tbody tr")!;
    expect(row.querySelector('svg[data-staff-role="owner"]')).not.toBeNull();
    expect(
      row.querySelector('svg[aria-label="username.verified_player"]'),
    ).not.toBeNull();
  });

  it("creates the official clan with a reason", async () => {
    const el = await mountClans("owner");
    const fill = async (sel: string, v: string) => {
      const i = el.querySelector<HTMLInputElement>(sel)!;
      i.value = v;
      i.dispatchEvent(new Event("input"));
      await el.updateComplete;
    };
    await fill("#admin-new-clan-name", "DeltaFront");
    await fill("#admin-new-clan-tag", "delta");
    await fill("#admin-clan-reason", "the official clan");
    el.querySelector<HTMLFormElement>("#admin-create-clan")!.dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(api.createOfficialClan).toHaveBeenCalledWith({
        name: "DeltaFront",
        tag: "delta",
        description: undefined,
        reason: "the official clan",
      }),
    );
  });
});

describe("<admin-audit-view>", () => {
  async function mountAudit(role: Role) {
    const el = document.createElement("admin-audit-view") as HTMLElement & {
      me: AdminMe;
      updateComplete: Promise<boolean>;
    };
    el.me = me(role);
    document.body.append(el);
    await el.updateComplete;
    await tick();
    await el.updateComplete;
    return el;
  }

  it("tells a moderator the view is limited, and not an admin", async () => {
    expect((await mountAudit("mod")).textContent).toContain(
      "admin_panel.audit_mod_note",
    );
    expect((await mountAudit("admin")).textContent).not.toContain(
      "admin_panel.audit_mod_note",
    );
  });

  it("lists entries with actor, role, source and details, and secrets are never shown here (the API redacts them)", async () => {
    api.audit.mockResolvedValue(
      ok({
        entries: [
          {
            id: "1",
            actor: "9EKyqPa9rm",
            actorRole: "owner",
            source: "game",
            action: "game:command",
            targetType: "game",
            targetId: "abcd1234",
            details: {
              reason: "testing",
              command: "give_gold",
              token: "[redacted]",
            },
            createdAt: NOW,
          },
        ],
        nextBefore: null,
      }),
    );
    const el = await mountAudit("owner");
    const text = el.textContent ?? "";
    for (const part of [
      "9EKyqPa9rm",
      "owner",
      "game",
      "game:command",
      "abcd1234",
      "testing",
      "give_gold",
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe("<admin-dashboard-view>", () => {
  it("shows the release, the commit and the counts", async () => {
    const el = document.createElement("admin-dashboard-view") as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    document.body.append(el);
    await tick();
    await el.updateComplete;
    const text = el.textContent ?? "";
    expect(text).toContain("0123456");
    for (const n of ["7", "3", "4"]) expect(text).toContain(n);
    expect(el.querySelector("#admin-dashboard")).not.toBeNull();
  });
});

describe("admin panel text", () => {
  it("every refusal code the panel knows has its own line in en.json", async () => {
    const { KNOWN_ERROR_CODES } =
      await import("../../src/client/admin/AdminUi");
    const en = (await import("../../resources/lang/en.json"))
      .default as unknown as {
      admin_panel: Record<string, string>;
    };
    for (const code of KNOWN_ERROR_CODES) {
      expect(en.admin_panel[`error_${code}`], code).toBeTruthy();
    }
  });
});
