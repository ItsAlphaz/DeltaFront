import {
  AdminActionResultSchema,
  AdminAuditListSchema,
  AdminClanDetailSchema,
  AdminClanListSchema,
  AdminDashboardSchema,
  AdminMeSchema,
  AdminProgressionSchema,
  AdminSeasonListSchema,
  AdminServerInfoSchema,
  AdminUserDetailSchema,
  AdminUserListSchema,
  AdminXpHistorySchema,
  type AdminActionResult,
  type AdminAuditList,
  type AdminClanDetail,
  type AdminClanList,
  type AdminDashboard,
  type AdminMe,
  type AdminProgression,
  type AdminSeasonList,
  type AdminServerInfo,
  type AdminUserDetail,
  type AdminUserList,
  type AdminXpHistory,
} from "@openfront/shared/AdminSchemas";
import type { z } from "zod";
import { getApiBase } from "./ApiBase";
import { getAuthHeader } from "./Auth";

/**
 * The client of the account API's `/admin` endpoints.
 *
 * Hiding a button is only presentation: every request is authorized by the API
 * from the signed-in account's role in the database, so a request made by an
 * account that is not staff is answered 401/403 whatever this client does. The
 * session travels in the Authorization header (no cookie), so a request cannot
 * be forged from another site.
 */

export type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; message?: string };

async function request<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  schema: z.ZodType<T>,
  body?: Record<string, unknown>,
): Promise<AdminResult<T>> {
  try {
    const authorization = await getAuthHeader();
    if (authorization === "") {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    const res = await fetch(`${getApiBase()}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (json ?? {}) as { error?: unknown; message?: unknown };
      return {
        ok: false,
        status: res.status,
        error: typeof err.error === "string" ? err.error : "failed",
        message: typeof err.message === "string" ? err.message : undefined,
      };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      console.error("admin API: unexpected response", path, parsed.error);
      return { ok: false, status: res.status, error: "bad_response" };
    }
    return { ok: true, data: parsed.data };
  } catch (e) {
    console.error("admin API request failed", path, e);
    return { ok: false, status: 0, error: "network" };
  }
}

const enc = encodeURIComponent;
const post = (path: string, body: Record<string, unknown>) =>
  request("POST", path, AdminActionResultSchema, body);

export const adminApi = {
  me: (): Promise<AdminResult<AdminMe>> =>
    request("GET", "/admin/me", AdminMeSchema),
  dashboard: (): Promise<AdminResult<AdminDashboard>> =>
    request("GET", "/admin/dashboard", AdminDashboardSchema),
  server: (): Promise<AdminResult<AdminServerInfo>> =>
    request("GET", "/admin/server", AdminServerInfoSchema),

  users: (q: string): Promise<AdminResult<AdminUserList>> =>
    request("GET", `/admin/users?q=${enc(q)}`, AdminUserListSchema),
  user: (publicId: string): Promise<AdminResult<AdminUserDetail>> =>
    request("GET", `/admin/users/${enc(publicId)}`, AdminUserDetailSchema),
  userAudit: (publicId: string): Promise<AdminResult<AdminAuditList>> =>
    request("GET", `/admin/users/${enc(publicId)}/audit`, AdminAuditListSchema),
  setVerified: (
    id: string,
    verified: boolean,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/verified`, { verified, reason }),
  setBareName: (
    id: string,
    enabled: boolean,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/bare-name`, { enabled, reason }),
  setRole: (
    id: string,
    role: "admin" | "mod" | "flagged" | "none",
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/role`, { role, reason, confirm: true }),
  credits: (
    id: string,
    amount: number,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/credits`, {
      amount,
      reason,
      confirm: amount < 0 ? true : undefined,
    }),
  item: (
    id: string,
    flare: string,
    grant: boolean,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/items`, {
      flare,
      grant,
      reason,
      confirm: grant ? undefined : true,
    }),
  ban: (
    id: string,
    category: string,
    days: number | null,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/ban`, {
      category,
      days,
      reason,
      confirm: true,
    }),
  unban: (
    id: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/unban`, { reason }),
  revokeSessions: (
    id: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/revoke-sessions`, { reason, confirm: true }),

  progression: (publicId: string): Promise<AdminResult<AdminProgression>> =>
    request(
      "GET",
      `/admin/users/${enc(publicId)}/progression`,
      AdminProgressionSchema,
    ),
  xpHistory: (
    publicId: string,
    page: number,
  ): Promise<AdminResult<AdminXpHistory>> =>
    request(
      "GET",
      `/admin/users/${enc(publicId)}/xp-history?page=${page}`,
      AdminXpHistorySchema,
    ),
  adjustXp: (
    id: string,
    action: "grant" | "revoke" | "set",
    amount: number,
    reason: string,
    countsForSeason: boolean,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/xp`, {
      action,
      amount,
      reason,
      countsForSeason,
      confirm: action === "grant" ? undefined : true,
    }),
  resetSeasonXp: (
    id: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/users/${enc(id)}/season-reset`, { reason, confirm: true }),

  seasons: (): Promise<AdminResult<AdminSeasonList>> =>
    request("GET", "/admin/seasons", AdminSeasonListSchema),
  createSeason: (input: {
    name: string;
    startsAt: string;
    endsAt: string;
  }): Promise<AdminResult<AdminActionResult>> => post("/admin/seasons", input),
  updateSeason: (
    id: string,
    patch: { name?: string; startsAt?: string; endsAt?: string },
  ): Promise<AdminResult<AdminActionResult>> =>
    request(
      "PATCH",
      `/admin/seasons/${enc(id)}`,
      AdminActionResultSchema,
      patch,
    ),
  closeSeason: (
    id: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/seasons/${enc(id)}/close`, { reason, confirm: true }),

  clans: (q: string): Promise<AdminResult<AdminClanList>> =>
    request("GET", `/admin/clans?q=${enc(q)}`, AdminClanListSchema),
  clan: (tag: string): Promise<AdminResult<AdminClanDetail>> =>
    request("GET", `/admin/clans/${enc(tag)}`, AdminClanDetailSchema),
  createOfficialClan: (input: {
    name: string;
    tag: string;
    description?: string;
    isOpen?: boolean;
    reason: string;
  }): Promise<AdminResult<AdminActionResult>> => post("/admin/clans", input),
  clanRename: (
    tag: string,
    name: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/rename`, { name, reason }),
  clanRetag: (
    tag: string,
    next: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/tag`, { tag: next, reason }),
  clanOpen: (
    tag: string,
    isOpen: boolean,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/open`, { isOpen, reason }),
  clanTransfer: (
    tag: string,
    targetPublicId: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/transfer`, {
      targetPublicId,
      reason,
      confirm: true,
    }),
  clanRemoveMember: (
    tag: string,
    publicId: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/members/${enc(publicId)}/remove`, {
      reason,
      confirm: true,
    }),
  clanBan: (
    tag: string,
    publicId: string,
    ban: boolean,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/bans/${enc(publicId)}`, {
      ban,
      reason,
      confirm: ban ? true : undefined,
    }),
  clanDelete: (
    tag: string,
    reason: string,
  ): Promise<AdminResult<AdminActionResult>> =>
    post(`/admin/clans/${enc(tag)}/delete`, { reason, confirm: true }),

  audit: (filter: {
    actor?: string;
    action?: string;
    target?: string;
    source?: string;
    before?: string;
  }): Promise<AdminResult<AdminAuditList>> => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined && v !== "") params.set(k, v);
    }
    return request(
      "GET",
      `/admin/audit?${params.toString()}`,
      AdminAuditListSchema,
    );
  },
};
