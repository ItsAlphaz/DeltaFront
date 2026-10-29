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

function view(overrides: Partial<VaultView> = {}): VaultView {
  return {
    wheel: {
      spinPrice: 150,
      segments: [
        {
          id: "c50",
          label: "50",
          prize: { kind: "credits", amount: 50 },
          percent: 60,
        },
        {
          id: "c2000",
          label: "JACKPOT",
          prize: { kind: "credits", amount: 2000 },
          percent: 40,
        },
      ],
      items: [],
    },
    packs: [
      {
        name: "recruit",
        displayName: "Recruit Pack",
        tagline: "Three cards.",
        priceSoft: 120,
        rarity: "uncommon",
        inSeason: true,
        pity: { rareAfter: 6 },
        slots: [{ common: 1 }],
        items: [],
      },
    ],
    dupeCredits: { common: 10 },
    limits: { paidSpinsPerDay: 100, packsPerDay: 50 },
    state: {
      pity: {},
      today: { packs: 0, spins: 0 },
      daily: {
        available: true,
        nextAt: new Date(Date.now() + 1e6).toISOString(),
      },
      balance: 5000,
    },
    ...overrides,
  };
}

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
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("40%");
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
});
