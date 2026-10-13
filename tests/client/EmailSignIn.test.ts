import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestMagicLinkMock } = vi.hoisted(() => ({
  requestMagicLinkMock: vi.fn(),
}));
vi.mock("../../src/client/Auth", () => ({
  requestMagicLink: requestMagicLinkMock,
}));
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

import { EmailSignIn } from "../../src/client/components/EmailSignIn";

describe("the email sign-in form", () => {
  let form: EmailSignIn;
  const input = () =>
    form.querySelector<HTMLInputElement>('input[type="email"]')!;
  const button = () =>
    form.querySelector<
      HTMLElement & { disable: boolean; translationKey: string }
    >("o-button")!;
  const status = () => form.querySelector<HTMLElement>("[data-email-status]")!;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input"));
    await form.updateComplete;
  };
  const submit = async () => {
    button().dispatchEvent(new Event("click"));
    await vi.waitFor(() =>
      expect(status().dataset.emailStatus).not.toBe("sending"),
    );
    await form.updateComplete;
  };

  beforeEach(async () => {
    requestMagicLinkMock.mockReset();
    if (!customElements.get("email-sign-in"))
      customElements.define("email-sign-in", EmailSignIn);
    form = document.createElement("email-sign-in") as EmailSignIn;
    document.body.appendChild(form);
    await form.updateComplete;
  });
  afterEach(() => form.remove());

  it("starts as an empty address field and a send button, with a live status region", () => {
    expect(input()).not.toBeNull();
    expect(input().autocomplete).toBe("email");
    expect(button().translationKey).toBe("account_modal.get_magic_link");
    expect(status().getAttribute("role")).toBe("status");
    expect(status().getAttribute("aria-live")).toBe("polite");
    expect(status().textContent?.trim()).toBe("");
  });

  it("asks for an address, and for a plausible one, without calling the server", async () => {
    await submit();
    expect(status().textContent).toContain("account_modal.enter_email_address");
    expect(status().dataset.emailStatus).toBe("error");
    await type("not-an-address");
    expect(status().textContent?.trim()).toBe(""); // typing clears the complaint
    await submit();
    expect(status().textContent).toContain("account_modal.invalid_email");
    expect(requestMagicLinkMock).not.toHaveBeenCalled();
  });

  it("shows a sending state (button disabled and relabelled, input locked) and ignores a second click", async () => {
    let finish!: (value: unknown) => void;
    requestMagicLinkMock.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    await type("ann@example.com");
    button().dispatchEvent(new Event("click"));
    await form.updateComplete;
    expect(status().dataset.emailStatus).toBe("sending");
    expect(button().disable).toBe(true);
    expect(button().translationKey).toBe("account_modal.sending_magic_link");
    expect(input().disabled).toBe(true);
    button().dispatchEvent(new Event("click"));
    expect(requestMagicLinkMock).toHaveBeenCalledTimes(1);
    finish({ status: "sent" });
    await vi.waitFor(() => expect(status().dataset.emailStatus).toBe("sent"));
  });

  it("success is the same generic message for every address, and does not repeat the address", async () => {
    requestMagicLinkMock.mockResolvedValue({ status: "sent" });
    await type("  ann@example.com ");
    await submit();
    expect(requestMagicLinkMock).toHaveBeenCalledWith("ann@example.com");
    expect(status().dataset.emailStatus).toBe("sent");
    expect(status().textContent).toContain("account_modal.magic_link_sent");
    expect(status().textContent).not.toContain("ann@example.com");
    expect(button().disable).toBe(false); // can ask again (the server limits it)
  });

  it.each([
    ["invalid_email", "account_modal.invalid_email"],
    ["rate_limited", "account_modal.magic_link_rate_limited"],
    ["failed", "account_modal.magic_link_failed"],
  ])(
    "shows the %s answer as an error that does not mention the address",
    async (code, key) => {
      requestMagicLinkMock.mockResolvedValue({ status: code });
      await type("ann@example.com");
      await submit();
      expect(status().dataset.emailStatus).toBe("error");
      expect(status().textContent).toContain(key);
      expect(status().textContent).not.toContain("ann@example.com");
      expect(button().disable).toBe(false);
    },
  );

  it("submits with Enter", async () => {
    requestMagicLinkMock.mockResolvedValue({ status: "sent" });
    await type("ann@example.com");
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(requestMagicLinkMock).toHaveBeenCalledTimes(1),
    );
  });
});
