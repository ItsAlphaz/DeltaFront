import { beforeEach, describe, expect, it } from "vitest";

import "../../src/client/components/NavUtilityIcons";

type Mountable = HTMLElement & { updateComplete: Promise<unknown> };

async function mount(): Promise<Mountable> {
  const el = document.createElement("nav-utility-icons") as Mountable;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.currentPageId = "page-play";
});

// The bell, the question mark and the cogwheel each move while their button is
// hovered or focused. The motion is CSS (jsdom does not run it), so what can be
// checked here is that the parts it moves are in the icons and that the rules
// exist, switched off for reduced motion.
describe("the nav's animated icons", () => {
  const parts: [string, string[]][] = [
    ["page-news", ["nav-bell-body", "nav-bell-clapper"]],
    ["page-help", ["nav-help-ring", "nav-help-mark", "nav-help-dot"]],
    ["page-settings", ["nav-gear-body", "nav-gear-hub"]],
  ];

  it.each(parts)(
    "%s has the parts its animation moves",
    async (page, classes) => {
      const el = await mount();
      const button = el.querySelector(`button[data-page="${page}"]`);
      expect(button).not.toBeNull();
      expect(button!.querySelector("svg.nav-icon")).not.toBeNull();
      for (const name of classes) {
        expect(button!.querySelector(`.${name}`), name).not.toBeNull();
      }
    },
  );

  it("adds its rules once, with a reduced-motion override", async () => {
    await mount();
    await mount();
    const styles = document.querySelectorAll("#nav-utility-icon-styles");
    expect(styles).toHaveLength(1);
    const css = styles[0].textContent ?? "";
    for (const name of ["nav-bell-ring", "nav-help-draw", "nav-gear-hub"]) {
      expect(css).toContain(`@keyframes ${name}`);
    }
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });
});
