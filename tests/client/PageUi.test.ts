import { html, render } from "lit";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  tierForRarity,
  uiBadge,
  uiButton,
  uiChip,
  uiDetailPanel,
  uiDetailRows,
  uiIconButton,
  uiIcons,
  uiItemCard,
  uiPageHeader,
  uiSearch,
  uiSegmented,
  uiSwitchRow,
  uiTabs,
  uiTwoColumn,
  uiValueRow,
} from "../../src/client/components/ui/PageUi";

// The account pages' shared components (docs: the UI kit). They are template
// functions, so each is rendered into a div and read back.

let host: HTMLDivElement;
function mount(template: unknown): HTMLDivElement {
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  render(template as never, host);
  return host;
}
afterEach(() => host?.remove());

const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;

describe("the design tokens", () => {
  const css = readFileSync("src/client/styles.css", "utf8");
  it.each([
    ["--color-ui-ground", "#0b0b0c"],
    ["--color-ui-surface", "#141416"],
    ["--color-ui-panel", "#0f0f11"],
    ["--color-ui-border", "#1e1e22"],
    ["--color-ui-border-strong", "#26262a"],
    ["--color-ui-border-hover", "#3a3a40"],
    ["--color-ui-text", "#f2f2f3"],
    ["--color-ui-muted", "#9a9aa2"],
    ["--color-ui-placeholder", "#7c7c84"],
    ["--color-ui-accent", "#e5383b"],
    ["--color-ui-accent-soft", "#f07174"],
    ["--color-ui-success", "#4ade80"],
    ["--color-ui-gold", "#facc15"],
    ["--color-ui-tier-green", "#3fa37a"],
    ["--color-ui-tier-blue", "#4a7be0"],
    ["--color-ui-tier-purple", "#9b5de5"],
    ["--color-ui-tier-gray", "#8a8a92"],
    ["--radius-ui-card", "10px"],
    ["--radius-ui-modal", "16px"],
  ])("%s is %s", (name, value) => {
    expect(css).toMatch(new RegExp(`${name}:\\s*${value}\\b`));
  });

  it("has the accent tint and the Inter / JetBrains Mono faces", () => {
    expect(css).toContain("--color-ui-accent-tint: rgba(229, 56, 59, 0.14)");
    expect(css).toMatch(/--font-ui:\s*"Inter"/);
    expect(css).toMatch(/--font-ui-mono:\s*"JetBrains Mono"/);
  });

  it("has the type scale: title 20/700, heading 15/700, label 11/600, body 14/500", () => {
    for (const [name, size, weight] of [
      [".ui-title", "20px", "700"],
      [".ui-heading", "15px", "700"],
      [".ui-label", "11px", "600"],
      [".ui-body", "14px", "500"],
    ]) {
      const rule = css.slice(css.indexOf(`${name} {`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body, name).toContain(`font-size: ${size}`);
      expect(body, name).toContain(`font-weight: ${weight}`);
    }
  });

  it("the shared components and the redesigned pages hard-code no colour", () => {
    for (const file of [
      "src/client/components/ui/PageUi.ts",
      "src/client/Store.ts",
    ]) {
      const source = readFileSync(file, "utf8")
        // comments may quote a colour; code may not
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], file).toEqual([]);
    }
  });
});

describe("buttons", () => {
  it("primary is the accent fill, 52px and uppercase as a block action", () => {
    mount(uiButton({ label: "Buy for 800", variant: "primary", block: true }));
    const b = q("button");
    expect(b.dataset.variant).toBe("primary");
    expect(b.className).toContain("bg-ui-accent");
    expect(b.className).toContain("h-[52px]");
    expect(b.className).toContain("uppercase");
    expect(b.className).toContain("ui-focus");
  });

  it("secondary is surface and strong border; disabled has its own background", () => {
    mount(uiButton({ label: "Store", variant: "secondary", disabled: true }));
    const b = q<HTMLButtonElement>("button");
    expect(b.className).toContain("bg-ui-surface");
    expect(b.className).toContain("border-ui-border-strong");
    expect(b.className).toContain("disabled:bg-ui-disabled");
    expect(b.disabled).toBe(true);
  });

  it("is a real button that calls back on click", () => {
    const onClick = vi.fn();
    mount(uiButton({ label: "Go", onClick }));
    q("button").click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(q("button").getAttribute("type")).toBe("button");
  });

  it("an icon button is 44px square and is named", () => {
    mount(uiIconButton({ icon: uiIcons.back(), ariaLabel: "Back" }));
    const b = q("button");
    expect(b.className).toContain("h-11");
    expect(b.className).toContain("w-11");
    expect(b.getAttribute("aria-label")).toBe("Back");
    // the arrow is a real SVG (a nested fragment must be in the SVG namespace)
    expect(b.querySelector("path")?.namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
  });
});

describe("segmented control and tabs", () => {
  const options = [
    { key: "a", label: "Atom" },
    { key: "h", label: "Hydrogen" },
  ];
  it("marks the selected option and reports a change", () => {
    const onChange = vi.fn();
    mount(uiSegmented({ options, value: "a", onChange, ariaLabel: "Bomb" }));
    const [atom, hydro] = [...host.querySelectorAll("button")];
    expect(atom.getAttribute("aria-pressed")).toBe("true");
    expect(hydro.getAttribute("aria-pressed")).toBe("false");
    expect(q("[data-ui=segmented]").getAttribute("aria-label")).toBe("Bomb");
    hydro.click();
    expect(onChange).toHaveBeenCalledWith("h");
  });

  it("underline tabs are a tablist that scrolls sideways, with the accent underline on the selected one", () => {
    const onChange = vi.fn();
    mount(uiTabs({ tabs: options, value: "h", onChange, ariaLabel: "Types" }));
    const list = q("[role=tablist]");
    expect(list.className).toContain("overflow-x-auto");
    const [atom, hydro] = [...host.querySelectorAll<HTMLElement>("[role=tab]")];
    expect(hydro.getAttribute("aria-selected")).toBe("true");
    expect(hydro.className).toContain("border-ui-accent");
    expect(atom.className).toContain("border-transparent");
    atom.click();
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("a chip toggles and shows its state", () => {
    const onToggle = vi.fn();
    mount(uiChip({ label: "Port", selected: true, onToggle, strike: true }));
    const chip = q("button");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.className).toContain("bg-ui-accent-tint");
    expect(chip.className).toContain("line-through");
    chip.click();
    expect(onToggle).toHaveBeenCalled();
  });
});

describe("inputs", () => {
  it("search is an input with an accessible name and reports what is typed", () => {
    const onInput = vi.fn();
    mount(
      uiSearch({
        value: "",
        placeholder: "Search maps",
        ariaLabel: "Search maps",
        onInput,
      }),
    );
    const input = q<HTMLInputElement>("input");
    expect(input.getAttribute("aria-label")).toBe("Search maps");
    input.value = "eu";
    input.dispatchEvent(new Event("input"));
    expect(onInput).toHaveBeenCalledWith("eu");
  });

  it("a switch row is a switch input in a label", () => {
    const onChange = vi.fn();
    mount(uiSwitchRow({ label: "Bots", checked: false, onChange }));
    const input = q<HTMLInputElement>("input");
    expect(input.getAttribute("role")).toBe("switch");
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("a switch row positions its hidden input inside its own label, so clicking it never scrolls the page away", () => {
    // The input is visually hidden (sr-only is position:absolute with no offsets).
    // Unless its label is the positioned parent it sits wherever the browser
    // puts it, and a real click, which focuses it, scrolls the page's
    // overflow-hidden shell out from under the modal: a blank screen.
    mount(uiSwitchRow({ label: "Bots", checked: false, onChange: vi.fn() }));
    const input = q<HTMLInputElement>("input");
    expect(input.className).toContain("sr-only");
    expect(input.closest("label")!.className).toMatch(/(^|\s)relative(\s|$)/);
  });

  it("a value row is a checkbox with a number beside it, disabled until checked", () => {
    const onValue = vi.fn();
    mount(
      uiValueRow({
        label: "Max timer",
        checked: false,
        value: 3,
        unit: "min",
        onToggle: () => {},
        onValue,
      }),
    );
    expect(q<HTMLInputElement>("input[type=number]").disabled).toBe(true);
    expect(q("input[type=number]").className).toContain("ui-mono");
  });
});

describe("cards and badges", () => {
  it("an item card: tier stripe on top, preview, name and meta; selected is the accent border and ring", () => {
    mount(
      uiItemCard({
        preview: html`<i></i>`,
        name: "Galaxy Ring",
        meta: "800",
        tier: "purple",
        selected: true,
        onSelect: () => {},
      }),
    );
    const card = q("button");
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(card.className).toContain("border-ui-accent");
    expect(card.className).toContain("ring-1");
    const stripe = q("[data-ui=tier-stripe]");
    expect(stripe.className).toContain("h-[3px]");
    expect(stripe.className).toContain("bg-ui-tier-purple");
    // never a coloured card background
    expect(card.className).toContain("bg-ui-surface");
  });

  it("scales a square cosmetic preview to the preview box's height, so the whole image shows", () => {
    mount(
      uiItemCard({
        preview: html`<cosmetic-preview></cosmetic-preview>`,
        name: "Gilded Majesty",
        onSelect: () => {},
      }),
    );
    // the box is 4:3 and the artwork a square: it must take the box's height
    // (it used to take the width and was cut off at the bottom)
    const box = q("cosmetic-preview").parentElement!;
    expect(box.className).toContain("aspect-[4/3]");
    expect(box.className).toContain("overflow-hidden");
    expect(box.className).toContain("[&_[data-cosmetic-preview]]:h-full");
    expect(box.className).toContain("[&_[data-cosmetic-preview]]:w-auto");
    expect(box.className).toContain(
      "[&_[data-cosmetic-preview]]:aspect-square",
    );
    expect(box.className).toContain("[&_[data-cosmetic-preview]]:max-w-full");
  });

  it("an unselected card has the neutral border and no ring", () => {
    mount(
      uiItemCard({
        preview: html``,
        name: "x",
        tier: "gray",
        onSelect: () => {},
      }),
    );
    expect(q("button").className).not.toContain("ring-1");
    expect(q("button").className).toContain("border-ui-border");
  });

  it("maps the catalog's rarities onto the four tiers", () => {
    expect(tierForRarity("common")).toBe("gray");
    expect(tierForRarity(undefined)).toBe("gray");
    expect(tierForRarity("uncommon")).toBe("green");
    expect(tierForRarity("rare")).toBe("blue");
    expect(tierForRarity("epic")).toBe("purple");
    expect(tierForRarity("legendary")).toBe("purple");
  });

  it("a badge is a pill, not a button", () => {
    mount(uiBadge("Owned", "success"));
    expect(q("[data-ui=badge]").tagName).toBe("SPAN");
    expect(q("[data-ui=badge]").className).toContain("rounded-full");
    expect(q("[data-ui=badge]").dataset.tone).toBe("success");
  });
});

describe("the page shell", () => {
  it("the header is 76px with a back button, the title, controls and a status chip", () => {
    const onBack = vi.fn();
    mount(
      uiPageHeader({
        title: "Store",
        backLabel: "Back",
        onBack,
        controls: html`<span data-x="controls"></span>`,
        status: html`<span data-x="status"></span>`,
      }),
    );
    const header = q("[data-ui=page-header]");
    expect(header.className).toContain("h-[76px]");
    expect(q("h1").textContent).toBe("Store");
    expect(q("h1").className).toContain("ui-title");
    expect(q("[data-x=controls]")).toBeTruthy();
    expect(q("[data-x=status]").parentElement?.className).toContain("ml-auto");
    q("[aria-label=Back]").click();
    expect(onBack).toHaveBeenCalled();
  });

  it("two columns: the panel is 340px from lg up and stacks under the content below it", () => {
    mount(
      uiTwoColumn({
        content: html`<p>content</p>`,
        detail: uiDetailPanel({ body: html`<p>detail</p>` }),
      }),
    );
    const columns = q("[data-ui=two-column]");
    expect(columns.className).toContain("flex-col");
    expect(columns.className).toContain("lg:flex-row");
    const panel = q("[data-ui=detail-panel]");
    expect(panel.className).toContain("lg:w-[340px]");
    expect(panel.className).toContain("flex-col");
  });

  it("the detail panel pins its one action at the bottom", () => {
    mount(
      uiDetailPanel({
        body: html`<p>body</p>`,
        action: uiButton({ label: "Buy", variant: "primary", block: true }),
      }),
    );
    const action = q("[data-ui=detail-action]");
    expect(action.className).toContain("mt-auto");
    expect(action.querySelectorAll("button")).toHaveLength(1);
  });

  it("detail rows are label and value pairs", () => {
    mount(uiDetailRows([{ label: "Price", value: "800" }]));
    expect(q("dt").textContent).toBe("Price");
    expect(q("dd").textContent?.trim()).toBe("800");
    expect(q("dd").className).toContain("ui-mono");
  });
});
