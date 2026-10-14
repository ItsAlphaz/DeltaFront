import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));

import {
  CurrencyDisplay,
  formatCurrencyAmount,
} from "../../../src/client/components/CurrencyDisplay";

async function renderDisplay(props: Partial<CurrencyDisplay>) {
  if (!customElements.get("currency-display")) {
    customElements.define("currency-display", CurrencyDisplay);
  }
  const el = document.createElement("currency-display") as CurrencyDisplay;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("formatCurrencyAmount", () => {
  it("formats a player wallet number", () => {
    expect(formatCurrencyAmount(1000)).toBe((1000).toLocaleString());
  });

  it("formats a zero rather than dropping it", () => {
    expect(formatCurrencyAmount(0)).toBe("0");
    expect(formatCurrencyAmount("0")).toBe("0");
  });

  it("groups thousands for a bigint string", () => {
    expect(formatCurrencyAmount("1000")).toBe((1000).toLocaleString());
  });

  it("formats a value past Number.MAX_SAFE_INTEGER without losing precision", () => {
    // 9007199254740993 is not representable as a double; via Number() this
    // would come back as ...992.
    expect(formatCurrencyAmount("9007199254740993")).toBe(
      BigInt("9007199254740993").toLocaleString(),
    );
    expect(formatCurrencyAmount("9007199254740993")).not.toBe(
      formatCurrencyAmount("9007199254740992"),
    );
  });

  it("returns null for an absent amount so callers can hide the widget", () => {
    // null is what GET /public/clan/:clanTag serves for an unregistered tag.
    expect(formatCurrencyAmount(null)).toBeNull();
    expect(formatCurrencyAmount(undefined)).toBeNull();
  });

  it("returns null for an empty string instead of BigInt's 0n", () => {
    expect(formatCurrencyAmount("")).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(formatCurrencyAmount("1.5")).toBeNull();
    expect(formatCurrencyAmount("abc")).toBeNull();
    expect(formatCurrencyAmount(NaN)).toBeNull();
  });
});

describe("currency-display", () => {
  it("renders both sides for a player wallet (numbers)", async () => {
    const el = await renderDisplay({ hard: 5, soft: 1000 });
    expect(el.querySelector("plutonium-icon")).toBeTruthy();
    expect(el.querySelector("credits-icon")).toBeTruthy();
    expect(el.textContent).toContain((1000).toLocaleString());
  });

  it("renders bigint-string clan balances exactly", async () => {
    const el = await renderDisplay({ hard: "0", soft: "9007199254740993" });
    expect(el.textContent).toContain(
      BigInt("9007199254740993").toLocaleString(),
    );
  });

  it("hides only the side that has no amount", async () => {
    const el = await renderDisplay({ hard: null, soft: "150" });
    expect(el.querySelector("plutonium-icon")).toBeNull();
    expect(el.querySelector("credits-icon")).toBeTruthy();
  });

  it("renders nothing at all when neither side has an amount", async () => {
    const el = await renderDisplay({ hard: null, soft: null });
    expect(el.querySelector("credits-icon")).toBeNull();
    expect(el.querySelector("plutonium-icon")).toBeNull();
    expect(el.textContent?.trim()).toBe("");
  });

  it("still renders a zero balance", async () => {
    const el = await renderDisplay({ hard: "0", soft: "0" });
    expect(el.querySelector("credits-icon")).toBeTruthy();
    expect(el.textContent).toContain("0");
  });

  it("uses smaller icons in compact mode", async () => {
    const full = await renderDisplay({ hard: 5, soft: 5, compact: false });
    const compact = await renderDisplay({ hard: 5, soft: 5, compact: true });
    const size = (el: CurrencyDisplay) =>
      (el.querySelector("plutonium-icon") as HTMLElement & { size: number })
        .size;
    expect(size(compact)).toBeLessThan(size(full));
  });
});

describe("Credits (the one currency of DeltaFront V1)", () => {
  it("without payments only Credits are shown: the premium slot is hidden even when it holds a number", async () => {
    ACCOUNT_FEATURES.payments = false;
    const el = await renderDisplay({ hard: 0, soft: 350 });
    expect(el.querySelector("plutonium-icon")).toBeNull();
    expect(el.querySelector("credits-icon")).toBeTruthy();
    expect(el.textContent).toContain((350).toLocaleString());
    expect(el.querySelector("[title='cosmetics.hard']")).toBeNull();
    expect(el.querySelector("[title='cosmetics.soft']")).toBeTruthy();
  });

  it("with payments on the premium slot returns", async () => {
    ACCOUNT_FEATURES.payments = true;
    const el = await renderDisplay({ hard: 5, soft: 1 });
    expect(el.querySelector("plutonium-icon")).toBeTruthy();
  });

  it("is labelled Credits in the text, and the old names are gone", () => {
    const root = path.resolve(__dirname, "../../..");
    const en = JSON.parse(
      fs.readFileSync(path.join(root, "resources/lang/en.json"), "utf8"),
    );
    expect(en.cosmetics.soft).toBe("Credits");
    expect(
      fs.existsSync(path.join(root, "resources/images/CreditsIcon.svg")),
    ).toBe(true);
    // OpenFront's bottle-cap artwork and component are not used.
    expect(
      fs.existsSync(path.join(root, "resources/images/BottleCapIcon.svg")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(root, "src/client/components/CapIcon.ts")),
    ).toBe(false);
  });

  it("the icon states its name through the translated label", async () => {
    await import("../../../src/client/components/CreditsIcon");
    const el = document.createElement("credits-icon");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(el.querySelector("img")?.getAttribute("alt")).toBe("cosmetics.soft");
    expect(el.querySelector("img")?.getAttribute("src")).toContain(
      "CreditsIcon.svg",
    );
  });
});

describe("<currency-display large> (the account header's Credits)", () => {
  it("shows the balance as the big number, with the Credits coin", async () => {
    const el = await renderDisplay({ soft: 998_200, hard: 0, large: true });
    expect(el.textContent).toContain((998_200).toLocaleString());
    const number = [...el.querySelectorAll("span")].find((s) =>
      s.textContent?.includes((998_200).toLocaleString()),
    )!;
    expect(number.className).toContain("text-3xl");
    expect(number.className).toContain("tabular-nums");
    expect(el.querySelector("credits-icon")).not.toBeNull();
  });

  it("keeps the standard size without it, and ignores it in compact mode", async () => {
    const plain = await renderDisplay({ soft: 5 });
    expect(plain.innerHTML).not.toContain("text-3xl");
    const compact = await renderDisplay({
      soft: 5,
      large: true,
      compact: true,
    });
    expect(compact.innerHTML).not.toContain("text-3xl");
  });

  it("still shows a zero balance", async () => {
    const el = await renderDisplay({ soft: 0, large: true });
    expect(el.textContent).toContain("0");
    expect(el.querySelector("credits-icon")).not.toBeNull();
  });
});
