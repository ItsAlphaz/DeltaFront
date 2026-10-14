import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Api", () => ({ updateUsername: vi.fn() }));
vi.mock("../../src/client/InGameModal", () => ({
  showInGameConfirm: vi.fn(async () => true),
  showInGameAlert: vi.fn(async () => true),
}));
vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string) => key,
}));

import "../../src/client/components/UsernamePanel";
import type { UsernamePanel } from "../../src/client/components/UsernamePanel";

async function mount(
  overrides: Record<string, unknown>,
): Promise<UsernamePanel> {
  const el = document.createElement("username-panel") as UsernamePanel;
  el.player = {
    publicId: "9EKyqPa9rm",
    username: null,
    usernameBase: null,
    usernameStatus: "unclaimed",
    nextUsernameChangeAt: null,
    ...overrides,
  } as unknown as UserMeResponse["player"];
  document.body.append(el);
  await el.updateComplete;
  return el;
}

describe("username panel for a bare-name entitlement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tells an entitled account it can claim a bare username", async () => {
    const el = await mount({ bareUsernameEnabled: true });
    expect(el.textContent).toContain(
      "account_modal.username_bare_entitled_notice",
    );
  });

  it("shows ordinary accounts nothing of the kind, whatever their role or verification", async () => {
    for (const extra of [{}, { verified: true }, { role: "admin" }]) {
      document.body.innerHTML = "";
      const el = await mount({ bareUsernameEnabled: false, ...extra });
      expect(el.textContent).not.toContain(
        "account_modal.username_bare_entitled_notice",
      );
    }
  });

  it("stops nagging once the bare name is held", async () => {
    const el = await mount({
      bareUsernameEnabled: true,
      username: "Alphaz",
      usernameBase: "Alphaz",
    });
    expect(el.textContent).not.toContain(
      "account_modal.username_bare_entitled_notice",
    );
  });

  it("an entitled, verified account without a name sees both notes", async () => {
    const el = await mount({ bareUsernameEnabled: true, verified: true });
    expect(el.textContent).toContain("account_modal.verified_needs_username");
    expect(el.textContent).toContain(
      "account_modal.username_bare_entitled_notice",
    );
  });
});

describe("username panel for a verified account", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("explains that a verified account needs an account username for its badge", async () => {
    const el = await mount({ verified: true });
    expect(el.textContent).toContain("account_modal.verified_needs_username");
  });

  it("says nothing of the kind to an unverified account, or once a name exists", async () => {
    expect((await mount({ verified: false })).textContent).not.toContain(
      "account_modal.verified_needs_username",
    );
    document.body.innerHTML = "";
    const named = await mount({
      verified: true,
      username: "Aydin.4821",
      usernameBase: "Aydin",
    });
    expect(named.textContent).not.toContain(
      "account_modal.verified_needs_username",
    );
  });
});
