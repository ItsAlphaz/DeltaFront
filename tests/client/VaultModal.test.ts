import type { VaultView } from "@openfront/shared/VaultSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  fetchVault: vi.fn(),
  drawVault: vi.fn(),
  getUserMe: vi.fn(async () => false as const),
  broadcastFreshUserMe: vi.fn(),
}));

vi.mock("../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Cosmetics")>()),
  fetchCosmetics: vi.fn(async () => null),
}));

import { drawVault, fetchVault } from "../../src/client/Api";
import "../../src/client/VaultModal";
import type { VaultModal } from "../../src/client/VaultModal";
import { vaultView } from "./vaultFixtures";

const view = vaultView;

describe("VaultModal", () => {
  let modal: VaultModal;

  async function mount(v: VaultView | null) {
    vi.mocked(fetchVault).mockResolvedValue(v);
    modal = document.createElement("vault-modal") as VaultModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
    (modal as unknown as { onOpen(): void }).onOpen();
    await vi.waitFor(() => {
      expect((modal as unknown as { loaded: boolean }).loaded).toBe(true);
    });
    await modal.updateComplete;
  }

  beforeEach(() => {
    vi.mocked(fetchVault).mockReset();
    vi.mocked(drawVault).mockReset();
  });

  afterEach(() => {
    modal.remove();
  });

  it("shows the wheel's odds, the prices, and says Credits can't be bought", async () => {
    await mount(view());
    const rows = modal.querySelectorAll("[data-vault-wheel-odds] tr");
    expect(rows).toHaveLength(5);
    expect(rows[4].textContent).toContain("15%");
    expect(modal.querySelector("[data-vault-spin]")?.textContent).toContain(
      "150",
    );
    expect(modal.textContent).toContain("vault.credits_only");
    expect(modal.textContent).toContain("Recruit Pack");
  });

  it("offers the free daily spin when it is ready and spends it on click", async () => {
    await mount(view());
    const daily = modal.querySelector<HTMLButtonElement>("[data-vault-daily]")!;
    expect(daily.disabled).toBe(false);
    vi.mocked(drawVault).mockResolvedValue({ ok: false, code: "daily_used" });
    daily.click();
    await vi.waitFor(() => expect(drawVault).toHaveBeenCalledWith("daily"));
  });

  it("counts down to the next free spin while it is used", async () => {
    const nextAt = new Date(Date.now() + 3_725_000).toISOString();
    await mount(
      view({
        state: {
          pity: {},
          today: { packs: 0, spins: 0 },
          daily: { available: false, nextAt },
          balance: 5000,
        },
      }),
    );
    const daily = modal.querySelector<HTMLButtonElement>("[data-vault-daily]")!;
    expect(daily.disabled).toBe(true);
    expect(
      modal.querySelector("[data-vault-daily-state]")?.textContent,
    ).toContain("vault.daily_next");
  });

  it("tells the daily dot about the free spin", async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("vault-daily-changed", listener);
    await mount(view());
    window.removeEventListener("vault-daily-changed", listener);
    expect(seen[0]).toMatchObject({ available: true });
  });

  it("disables spinning when the balance is short or the daily limit is hit", async () => {
    await mount(
      view({
        state: {
          pity: {},
          today: { packs: 0, spins: 0 },
          daily: { available: false, nextAt: new Date().toISOString() },
          balance: 10,
        },
      }),
    );
    expect(
      modal.querySelector<HTMLButtonElement>("[data-vault-spin]")!.disabled,
    ).toBe(true);
  });
  it("shows the free spin's ring full and the claim button while it is ready", async () => {
    await mount(view());
    const daily = modal.querySelector("[data-vault-daily]")!;
    expect(daily.hasAttribute("data-ready")).toBe(true);
    expect(daily.querySelector(".vault-claim")).not.toBeNull();
    const bar = daily.querySelector(".vault-ring-bar")!;
    expect(bar.getAttribute("stroke-dashoffset")).toBe("0");
  });

  it("fills the ring as the day passes towards the next free spin", async () => {
    const nextAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
    await mount(
      view({
        state: {
          pity: {},
          today: { packs: 0, spins: 0 },
          daily: { available: false, nextAt },
          balance: 5000,
        },
      }),
    );
    const daily = modal.querySelector("[data-vault-daily]")!;
    expect(daily.hasAttribute("data-ready")).toBe(false);
    const bar = daily.querySelector(".vault-ring-bar")!;
    const circumference = 2 * Math.PI * 26;
    // six hours left of twenty-four: three quarters of the ring
    expect(
      Number(bar.getAttribute("stroke-dashoffset")) / circumference,
    ).toBeCloseTo(0.25, 2);
  });

  it("lights the wheel's segments while the odds are pointed at", async () => {
    await mount(view());
    const wheel = modal.querySelector("vault-wheel") as unknown as {
      highlight: number[];
    };
    expect(wheel.highlight).toEqual([]);
    const chip = modal.querySelector('[data-vault-legend="item:epic"]')!;
    chip.dispatchEvent(new MouseEvent("pointerenter"));
    await modal.updateComplete;
    expect(wheel.highlight).toEqual([2]);
    chip.dispatchEvent(new MouseEvent("pointerleave"));
    await modal.updateComplete;
    expect(wheel.highlight).toEqual([]);
  });

  it("opens a pack when its shelf says so", async () => {
    await mount(view());
    vi.mocked(drawVault).mockResolvedValue({ ok: false, code: "daily_limit" });
    modal
      .querySelector<HTMLButtonElement>('[data-vault-open="officer"]')!
      .click();
    await vi.waitFor(() =>
      expect(drawVault).toHaveBeenCalledWith("pack", "officer"),
    );
  });

  it("tells a guest to sign in instead of letting them spin", async () => {
    await mount(view({ state: null }));
    expect(
      modal.querySelector("[data-vault-daily-state]")?.textContent,
    ).toContain("vault.sign_in");
    expect(
      modal.querySelector<HTMLButtonElement>("[data-vault-spin]")!.disabled,
    ).toBe(true);
    expect(modal.querySelector("[data-vault-balance]")).toBeNull();
  });
});
