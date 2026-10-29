import type { VaultView } from "@openfront/shared/VaultSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/client/vault/VaultCollection";
import "../../src/client/vault/VaultCount";
import "../../src/client/vault/VaultPacks";
import "../../src/client/vault/VaultWheelOdds";
import { groupSegments } from "../../src/client/vault/VaultWheelOdds";
import { vaultView, withState } from "./vaultFixtures";

const mounted: HTMLElement[] = [];

async function mount<T extends HTMLElement>(
  tag: string,
  props: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag);
  Object.assign(el, props);
  document.body.appendChild(el);
  mounted.push(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as T;
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.unstubAllGlobals();
});

describe("the wheel's odds", () => {
  it("groups the segments by what they give, in a fixed order, adding their chances", () => {
    const groups = groupSegments(vaultView().wheel.segments);
    expect(groups.map((g) => [g.key, g.percent, g.indexes])).toEqual([
      ["credits", 65, [0, 4]],
      ["pack", 5, [3]],
      ["item:rare", 20, [1]],
      ["item:epic", 10, [2]],
    ]);
  });

  it("says which segments a legend chip is about while it is pointed at", async () => {
    const odds = await mount("vault-wheel-odds", {
      segments: vaultView().wheel.segments,
      packs: vaultView().packs,
    });
    const seen: number[][] = [];
    odds.addEventListener("vault-highlight", (e) =>
      seen.push((e as CustomEvent<number[]>).detail),
    );
    const chip = odds.querySelector('[data-vault-legend="credits"]')!;
    chip.dispatchEvent(new MouseEvent("pointerenter"));
    chip.dispatchEvent(new MouseEvent("pointerleave"));
    expect(seen).toEqual([[0, 4], []]);
  });

  it("keeps the full table folded until asked, one row per segment", async () => {
    const odds = await mount("vault-wheel-odds", {
      segments: vaultView().wheel.segments,
      packs: vaultView().packs,
    });
    const drawer = odds.querySelector(".vault-drawer")!;
    expect(odds.querySelectorAll("[data-vault-wheel-odds] tr")).toHaveLength(5);
    expect(drawer.hasAttribute("data-open")).toBe(false);
    odds.querySelector<HTMLButtonElement>("[data-vault-odds-toggle]")!.click();
    await (odds as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(drawer.hasAttribute("data-open")).toBe(true);
    // the free pack is named after the pack it opens
    expect(odds.textContent).toContain("vault.prize_pack");
  });
});

describe("the packs", () => {
  it("shows the bad-luck guarantee as a meter that fills towards it", async () => {
    const packs = await mount("vault-packs", {
      view: withState({ pity: { recruit: { sinceRare: 4, sinceEpic: 0 } } }),
    });
    const meter = packs.querySelector<HTMLElement>(
      '[data-vault-pack="recruit"] .vault-meter',
    )!;
    // 4 of the 6 packs have gone by
    expect(meter.getAttribute("aria-valuenow")).toBe("4");
    expect(meter.getAttribute("aria-valuemax")).toBe("6");
    expect(meter.style.getPropertyValue("--p")).toContain("66.6");
    expect(meter.hasAttribute("data-full")).toBe(false);
  });

  it("lights the meter when the next pack is the sure one", async () => {
    const packs = await mount("vault-packs", {
      view: withState({ pity: { recruit: { sinceRare: 5, sinceEpic: 0 } } }),
    });
    const meter = packs.querySelector(
      '[data-vault-pack="recruit"] .vault-meter',
    )!;
    expect(meter.hasAttribute("data-full")).toBe(true);
    expect(
      packs.querySelector('[data-vault-pack="recruit"] [data-vault-pity]')
        ?.textContent,
    ).toContain("vault.pity_next");
  });

  it("opens a pack by name, and not when the Credits are short", async () => {
    const packs = await mount("vault-packs", {
      view: withState({ balance: 200 }),
    });
    const opened: string[] = [];
    packs.addEventListener("vault-open-pack", (e) =>
      opened.push((e as CustomEvent<string>).detail),
    );
    packs
      .querySelector<HTMLButtonElement>('[data-vault-open="recruit"]')!
      .click();
    const officer = packs.querySelector<HTMLButtonElement>(
      '[data-vault-open="officer"]',
    )!;
    expect(officer.disabled).toBe(true);
    // and it says what is missing
    expect(
      packs.querySelector('[data-vault-pack="officer"] [data-vault-hint]')
        ?.textContent,
    ).toContain("vault.need_more");
    expect(opened).toEqual(["recruit"]);
  });

  it("shows a guest the guarantee as a plain promise and cannot be opened", async () => {
    const packs = await mount("vault-packs", {
      view: vaultView({ state: null }),
    });
    expect(
      packs.querySelector<HTMLButtonElement>('[data-vault-open="recruit"]')!
        .disabled,
    ).toBe(true);
    expect(packs.textContent).toContain("vault.pity_within");
  });

  it("shows a pack's odds over the pack, one pack at a time", async () => {
    const packs = await mount("vault-packs", { view: vaultView() });
    const overlay = (name: string) =>
      packs.querySelector(`[data-vault-pack="${name}"] .vault-pack-odds`)!;
    packs
      .querySelector<HTMLButtonElement>(
        '[data-vault-pack="recruit"] [data-vault-odds-toggle]',
      )!
      .click();
    await (packs as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(overlay("recruit").hasAttribute("data-open")).toBe(true);
    packs
      .querySelector<HTMLButtonElement>(
        '[data-vault-pack="officer"] [data-vault-odds-toggle]',
      )!
      .click();
    await (packs as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(overlay("recruit").hasAttribute("data-open")).toBe(false);
    expect(overlay("officer").hasAttribute("data-open")).toBe(true);
  });
});

describe("the collection", () => {
  const owned = new Set(["crown:kraken_crown"]);
  const mountCollection = (view: VaultView = vaultView()) =>
    mount("vault-collection", { view, owned });
  const items = (el: HTMLElement) =>
    [...el.querySelectorAll("[data-vault-item]")].map(
      (i) => (i as HTMLElement).dataset.vaultItem,
    );
  const settle = (el: HTMLElement) =>
    (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

  it("lists the rare-and-better pieces, the best first, and counts the ones won", async () => {
    const el = await mountCollection();
    // the common flag and the uncommon one are for the shop
    expect(items(el)).toEqual(["wyrm_banner", "kraken_crown", "paisley_drift"]);
    expect(
      el.querySelector("[data-vault-collection-count]")?.textContent?.trim(),
    ).toBe("1 / 3");
    expect(
      el
        .querySelector('[data-vault-item="kraken_crown"]')
        ?.getAttribute("data-owned"),
    ).toBe("true");
  });

  it("filters by what is won and by rarity", async () => {
    const el = await mountCollection();
    el.querySelector<HTMLButtonElement>('[data-key="missing"]')!.click();
    await settle(el);
    expect(items(el)).toEqual(["wyrm_banner", "paisley_drift"]);
    el.querySelector<HTMLButtonElement>('[data-key="all"]')!.click();
    el.querySelector<HTMLButtonElement>('[data-vault-rarity="epic"]')!.click();
    await settle(el);
    expect(items(el)).toEqual(["kraken_crown"]);
    // pressing the chip again lets go
    el.querySelector<HTMLButtonElement>('[data-vault-rarity="epic"]')!.click();
    await settle(el);
    expect(items(el)).toHaveLength(3);
  });

  it("says when nothing matches", async () => {
    const el = await mountCollection();
    el.querySelector<HTMLButtonElement>('[data-key="owned"]')!.click();
    el.querySelector<HTMLButtonElement>(
      '[data-vault-rarity="legendary"]',
    )!.click();
    await settle(el);
    expect(el.querySelector("[data-vault-collection-empty]")).not.toBeNull();
  });

  it("names the colour of a skin that comes in several", async () => {
    const el = await mountCollection();
    // the palette's own name, without the Vault's prefix
    expect(
      el
        .querySelector('[data-vault-item="paisley_drift"] [data-vault-variant]')
        ?.textContent?.trim(),
    ).toBe("Indigo Saffron");
    expect(
      el.querySelector('[data-vault-item="kraken_crown"] [data-vault-variant]'),
    ).toBeNull();
  });

  it("says where each piece is found", async () => {
    const el = await mountCollection();
    const where = (name: string) =>
      el.querySelector(`[data-vault-item="${name}"] [data-vault-sources]`)
        ?.textContent;
    // in the wheel and in two packs
    expect(where("kraken_crown")).toContain("vault.source_wheel");
    expect(where("kraken_crown")).toContain("vault.source_packs");
    // in one pack: its name
    expect(where("wyrm_banner")).toContain("Officer Pack");
  });
});

describe("the balance", () => {
  function frames() {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    return queue;
  }
  const text = (el: HTMLElement) =>
    el.querySelector("[data-vault-count]")?.textContent;
  const settle = (el: HTMLElement) =>
    (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

  it("shows its first value as it is", async () => {
    const el = await mount("vault-count", { value: 1200 });
    expect(text(el)).toBe("1,200");
    expect(el.querySelector("[data-vault-delta]")).toBeNull();
  });

  it("counts to a new value and shows the change beside it", async () => {
    const queue = frames();
    const el = await mount<HTMLElement & { value: number }>("vault-count", {
      value: 100,
    });
    el.value = 350;
    await settle(el);
    expect(el.querySelector("[data-vault-delta]")?.textContent).toBe("+250");
    // the count runs to its end
    queue.shift()!(performance.now() + 10_000);
    await settle(el);
    expect(text(el)).toBe("350");
  });

  it("shows a spend as a loss", async () => {
    frames();
    const el = await mount<HTMLElement & { value: number }>("vault-count", {
      value: 500,
    });
    el.value = 350;
    await settle(el);
    const delta = el.querySelector("[data-vault-delta]")!;
    expect(delta.textContent).toBe("−150");
    expect(delta.classList.contains("vault-delta-down")).toBe(true);
  });

  it("jumps straight to the value for reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const el = await mount<HTMLElement & { value: number }>("vault-count", {
      value: 100,
    });
    el.value = 350;
    await settle(el);
    expect(text(el)).toBe("350");
    expect(el.querySelector("[data-vault-delta]")).toBeNull();
  });
});
