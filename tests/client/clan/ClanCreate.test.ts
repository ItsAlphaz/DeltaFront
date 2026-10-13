import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import type { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/client/Api", () => ({
  getApiBase: vi.fn(() => "http://localhost:3000"),
  getUserMe: vi.fn(),
  invalidateUserMe: vi.fn(),
  getAudience: vi.fn(() => "localhost"),
}));
vi.mock("../../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => "Bearer test-token"),
  userAuth: vi.fn(async () => ({ jwt: "test-token" })),
}));
vi.mock("../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  ),
  showToast: vi.fn(),
  renderDuration: vi.fn(),
  getMapName: vi.fn(),
}));

import {
  approveClanRequest,
  createClan,
  disbandClan,
  joinClan,
  kickMember,
  leaveClan,
} from "../../../src/client/ClanApi";
import "../../../src/client/components/clan/ClanBrowseView";
import "../../../src/client/components/clan/ClanCreateForm";

const res = (status: number, data: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => data,
});
const stubFetch = (impl: (...args: unknown[]) => unknown) =>
  vi.stubGlobal("fetch", vi.fn(impl));

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const INFO = {
  name: "Wolves",
  tag: "WLF",
  description: "",
  isOpen: true,
  createdAt: "2026-01-01T00:00:00Z",
  memberCount: 1,
};

describe("createClan (POST /clans)", () => {
  it("sends the fields and returns the clan the server made", async () => {
    stubFetch(() => res(201, INFO));
    expect(
      await createClan({
        name: "Wolves",
        tag: "WLF",
        description: "x",
        isOpen: false,
      }),
    ).toEqual(INFO);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/clans");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Wolves",
      tag: "WLF",
      description: "x",
      isOpen: false,
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("never sends a role, an owner or anything else: only what the form collected", async () => {
    stubFetch(() => res(201, INFO));
    await createClan({ name: "Wolves", tag: "WLF" });
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(Object.keys(body).sort()).toEqual(["name", "tag"]);
  });

  it.each([
    [
      403,
      { code: "ACCOUNT_TOO_NEW", required: 3, current: 1 },
      "clan_modal.create_error_account_too_new",
      { days: 3, current: 1 },
    ],
    [
      403,
      { code: "NOT_ENOUGH_GAMES", required: 10, current: 4 },
      "clan_modal.create_error_not_enough_games",
      { games: 10, current: 4 },
    ],
    [
      403,
      { code: "ALREADY_IN_CLAN" },
      "clan_modal.error_already_in_clan",
      undefined,
    ],
    [
      403,
      { code: "LOGIN_REQUIRED" },
      "clan_modal.sign_in_for_clans",
      undefined,
    ],
    [403, { code: "BANNED" }, "clan_modal.error_banned", undefined],
    [
      400,
      { code: "INVALID_NAME" },
      "clan_modal.create_error_invalid_name",
      undefined,
    ],
    [
      400,
      { code: "INVALID_TAG" },
      "clan_modal.create_error_invalid_tag",
      undefined,
    ],
    [
      400,
      { code: "NAME_PROFANE" },
      "clan_modal.create_error_profane",
      undefined,
    ],
    [
      400,
      { code: "INVALID_DESCRIPTION" },
      "clan_modal.create_error_invalid_description",
      undefined,
    ],
    [
      409,
      { code: "NAME_TAKEN" },
      "clan_modal.create_error_name_taken",
      undefined,
    ],
    [
      409,
      { code: "TAG_TAKEN" },
      "clan_modal.create_error_tag_taken",
      undefined,
    ],
    [409, { code: "TAG_HELD" }, "clan_modal.create_error_tag_held", undefined],
    [401, {}, "clan_modal.sign_in_for_clans", undefined],
    [429, {}, "clan_modal.error_rate_limited_generic", undefined],
    [500, {}, "clan_modal.create_error_failed", undefined],
    [
      418,
      { code: "SOMETHING_NEW" },
      "clan_modal.create_error_failed",
      undefined,
    ],
  ])("maps %i %j to %s", async (status, body, key, params) => {
    stubFetch(() => res(status, body));
    expect(await createClan({ name: "Wolves", tag: "WLF" })).toEqual(
      params === undefined ? { error: key } : { error: key, params },
    );
  });

  it("reports a network failure and a malformed success", async () => {
    stubFetch(() => {
      throw new Error("down");
    });
    expect(await createClan({ name: "Wolves", tag: "WLF" })).toEqual({
      error: "clan_modal.error_network",
    });
    stubFetch(() => res(201, { nope: true }));
    expect(await createClan({ name: "Wolves", tag: "WLF" })).toEqual({
      error: "clan_modal.create_error_failed",
    });
  });
});

describe("one clan at a time, and the other new codes, on the existing calls", () => {
  it("joinClan: 409 ALREADY_IN_CLAN gets its own message, not 'already a member'", async () => {
    stubFetch(() =>
      res(409, { code: "ALREADY_IN_CLAN", message: "Already in a clan" }),
    );
    expect(await joinClan("TST")).toEqual({
      error: "clan_modal.error_already_in_clan",
    });
  });

  it("joinClan: a pending request is still told apart by its message", async () => {
    stubFetch(() =>
      res(409, {
        code: "REQUEST_PENDING",
        message: "Join request already pending",
      }),
    );
    expect(await joinClan("TST")).toEqual({
      error: "clan_modal.error_request_pending",
    });
  });

  it("joinClan: a guest (403 LOGIN_REQUIRED) is asked to sign in", async () => {
    stubFetch(() => res(403, { code: "LOGIN_REQUIRED" }));
    expect(await joinClan("TST")).toEqual({
      error: "clan_modal.sign_in_for_clans",
    });
  });

  it("leaveClan: a leader with members is told to transfer first", async () => {
    stubFetch(() => res(409, { code: "TRANSFER_REQUIRED" }));
    expect(await leaveClan("TST")).toEqual({
      error: "clan_modal.error_transfer_required",
    });
  });

  it("approving a request for someone who joined elsewhere says so", async () => {
    stubFetch(() => res(409, { code: "ALREADY_IN_CLAN" }));
    expect(await approveClanRequest("TST", "abc123")).toEqual({
      error: "clan_modal.error_already_in_clan",
    });
    stubFetch(() => res(409, { code: "ACCOUNT_UNAVAILABLE" }));
    expect(await approveClanRequest("TST", "abc123")).toEqual({
      error: "clan_modal.error_account_unavailable",
    });
  });

  it("other failures stay generic, a 401 asks to sign in, a 429 says to wait", async () => {
    stubFetch(() => res(403, { code: "FORBIDDEN" }));
    expect(await kickMember("TST", "abc123")).toEqual({
      error: "clan_modal.error_failed",
    });
    stubFetch(() => res(401));
    expect(await disbandClan("TST")).toEqual({
      error: "clan_modal.sign_in_for_clans",
    });
    stubFetch(() => res(429, { code: "RATE_LIMITED" }));
    expect(await kickMember("TST", "abc123")).toEqual({
      error: "clan_modal.error_rate_limited_generic",
    });
  });
});

describe("the create form", () => {
  async function mountForm() {
    const el = document.createElement("clan-create-form") as LitElement;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }
  const type = async (el: LitElement, selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
    return input;
  };
  const submit = () =>
    document.querySelector<HTMLButtonElement>("[data-create-submit]")!;

  it("states no numbers of its own (the server names what is missing)", async () => {
    const el = await mountForm();
    expect(el.textContent).not.toMatch(/\b(3|10)\b/);
  });

  it("keeps Create disabled until there is a name of 3+ characters and a tag of 2 to 5", async () => {
    const el = await mountForm();
    expect(submit().disabled).toBe(true);
    await type(el, "[data-create-name]", "Wo");
    await type(el, "[data-create-tag]", "WL");
    expect(submit().disabled).toBe(true);
    await type(el, "[data-create-name]", "Wolves");
    expect(submit().disabled).toBe(false);
    await type(el, "[data-create-tag]", "W");
    expect(submit().disabled).toBe(true);
  });

  it("turns the tag into upper case letters and digits, whatever is typed", async () => {
    const el = await mountForm();
    const tag = await type(el, "[data-create-tag]", "w-l f!1x9z");
    expect(tag.value).toBe("WLF1X");
  });

  it("sends what was typed and raises clan-created with the new clan", async () => {
    stubFetch(() => res(201, INFO));
    const el = await mountForm();
    const created = vi.fn();
    el.addEventListener("clan-created", created);
    await type(el, "[data-create-name]", "Wolves");
    await type(el, "[data-create-tag]", "wlf");
    await type(el, "[data-create-description]", "line one\nline two");
    const open = el.querySelector<HTMLInputElement>("[data-create-open]")!;
    open.checked = false;
    open.dispatchEvent(new Event("change"));
    submit().click();
    await vi.waitFor(() => expect(created).toHaveBeenCalled());
    expect((created.mock.calls[0][0] as CustomEvent).detail.clan).toEqual(INFO);
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      name: "Wolves",
      tag: "WLF",
      description: "line one line two",
      isOpen: false,
    });
  });

  it("shows the requirement the server reports, with the numbers it sends, and stays open", async () => {
    stubFetch(() =>
      res(403, { code: "NOT_ENOUGH_GAMES", required: 10, current: 7 }),
    );
    const el = await mountForm();
    const created = vi.fn();
    el.addEventListener("clan-created", created);
    await type(el, "[data-create-name]", "Wolves");
    await type(el, "[data-create-tag]", "WLF");
    submit().click();
    await vi.waitFor(() =>
      expect(el.querySelector("[data-create-error]")).not.toBeNull(),
    );
    expect(el.querySelector("[data-create-error]")!.textContent).toContain(
      "clan_modal.create_error_not_enough_games",
    );
    expect(el.querySelector("[data-create-error]")!.textContent).toContain(
      '"games":10',
    );
    expect(el.querySelector("[data-create-error]")!.textContent).toContain(
      '"current":7',
    );
    expect(created).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false); // can fix and retry
  });

  it("raises create-cancel from Cancel", async () => {
    const el = await mountForm();
    const cancelled = vi.fn();
    el.addEventListener("create-cancel", cancelled);
    el.querySelectorAll<HTMLButtonElement>("button")[0].click();
    expect(cancelled).toHaveBeenCalled();
  });
});

describe("the browse view's create button", () => {
  type Browse = LitElement & { canCreate: boolean; openCreate: boolean };
  async function mountBrowse(
    props: Partial<Pick<Browse, "canCreate" | "openCreate">>,
  ) {
    stubFetch(() => res(200, { results: [], total: 0, page: 1, limit: 20 }));
    const el = document.createElement("clan-browse-view") as Browse;
    Object.assign(el, props);
    document.body.appendChild(el);
    // the list loads first (a spinner shows until then)
    await vi.waitFor(() => expect(el.querySelector("input")).not.toBeNull());
    await el.updateComplete;
    return el;
  }

  it("offers Create clan only to a player who can create one", async () => {
    const without = await mountBrowse({ canCreate: false });
    expect(without.querySelector("[data-create-clan-start]")).toBeNull();
    without.remove();
    const withIt = await mountBrowse({ canCreate: true });
    expect(withIt.querySelector("[data-create-clan-start]")).not.toBeNull();
    expect(withIt.querySelector("clan-create-form")).toBeNull();
  });

  it("opens the form on click, and closes it on cancel", async () => {
    const el = await mountBrowse({ canCreate: true });
    el.querySelector<HTMLButtonElement>("[data-create-clan-start]")!.click();
    await el.updateComplete;
    expect(el.querySelector("clan-create-form")).not.toBeNull();
    el.querySelector("clan-create-form")!.dispatchEvent(
      new CustomEvent("create-cancel", { bubbles: true }),
    );
    await el.updateComplete;
    expect(el.querySelector("clan-create-form")).toBeNull();
  });

  it("opens with the form showing when asked to (from My Clans)", async () => {
    const el = await mountBrowse({ canCreate: true, openCreate: true });
    await el.updateComplete;
    expect(el.querySelector("clan-create-form")).not.toBeNull();
  });

  it("never shows the form to someone who cannot create, even when asked", async () => {
    const el = await mountBrowse({ canCreate: false, openCreate: true });
    expect(el.querySelector("clan-create-form")).toBeNull();
  });
});

describe("what the clan UI offers in V1", () => {
  it("keeps the clan donation UI behind payments (the donation currency is premium)", () => {
    expect(
      (globalThis as Record<string, unknown>).__SHIPPED_ACCOUNT_FEATURES__,
    ).toMatchObject({ payments: false, clans: false });
    expect(typeof ACCOUNT_FEATURES.payments).toBe("boolean");
  });
});
