import type {
  AdminAuditList,
  AdminClanDetail,
  AdminClanList,
  AdminDashboard,
  AdminMe,
  AdminUserDetail,
  AdminUserList,
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
    expect(tabs(await open(ok(me("owner"))))).toEqual([
      "dashboard",
      "users",
      "clans",
      "audit",
      "server",
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
