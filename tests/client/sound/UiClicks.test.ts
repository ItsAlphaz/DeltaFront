import { describe, expect, it } from "vitest";
import {
  isUiClick,
  UI_CLICK_VARIANTS,
} from "../../../src/client/sound/UiClicks";

/** Dispatches a click on `target` and reports what the listener decided. */
function clickOn(
  target: Element,
  trusted = true,
  mount: Element = target,
): boolean {
  let result = false;
  document.body.appendChild(mount);
  document.addEventListener(
    "click",
    (e) => {
      // jsdom events are always untrusted and isTrusted cannot be redefined,
      // so stand in for a real pointer press with a view of the same event.
      const view = new Proxy(e, {
        get(target, prop) {
          if (prop === "isTrusted") return trusted;
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      result = isUiClick(view);
    },
    { once: true, capture: true },
  );
  target.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  );
  mount.remove();
  return result;
}

describe("isUiClick", () => {
  it("accepts buttons, links and anything inside them", () => {
    const button = document.createElement("button");
    expect(clickOn(button)).toBe(true);

    const link = document.createElement("a");
    link.href = "/play";
    expect(clickOn(link)).toBe(true);

    const outer = document.createElement("div");
    outer.setAttribute("role", "button");
    const inner = document.createElement("span");
    outer.appendChild(inner);
    expect(clickOn(inner, true, outer)).toBe(true);
  });

  it("ignores disabled controls", () => {
    const button = document.createElement("button");
    button.disabled = true;
    expect(clickOn(button)).toBe(false);

    const aria = document.createElement("div");
    aria.setAttribute("role", "button");
    aria.setAttribute("aria-disabled", "true");
    expect(clickOn(aria)).toBe(false);
  });

  it("ignores sliders, which have their own cue", () => {
    const range = document.createElement("input");
    range.type = "range";
    expect(clickOn(range)).toBe(false);
  });

  it("ignores plain content and the canvas", () => {
    expect(clickOn(document.createElement("div"))).toBe(false);
    expect(clickOn(document.createElement("canvas"))).toBe(false);
  });

  it("ignores clicks that code dispatched", () => {
    expect(clickOn(document.createElement("button"), false)).toBe(false);
  });
});

describe("UI_CLICK_VARIANTS", () => {
  it("only names click cues", () => {
    for (const name of UI_CLICK_VARIANTS) expect(name).toMatch(/^click-\d$/);
  });
});
