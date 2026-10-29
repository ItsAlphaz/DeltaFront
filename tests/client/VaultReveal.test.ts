import { describe, expect, it } from "vitest";
import "../../src/client/vault/VaultReveal";
import type { VaultReveal } from "../../src/client/vault/VaultReveal";

async function mountPack(): Promise<VaultReveal> {
  const reveal = document.createElement("vault-reveal") as VaultReveal;
  reveal.mode = {
    kind: "pack",
    pack: "officer",
    name: "Officer Pack",
    rarity: "epic",
    cards: [],
  };
  document.body.appendChild(reveal);
  await reveal.updateComplete;
  return reveal;
}

describe("VaultReveal tilt", () => {
  it("the sealed pack leans towards the pointer and lets go when it leaves", async () => {
    const reveal = await mountPack();
    const tilt = reveal.querySelector<HTMLElement>(".vr-tilt")!;
    const host = tilt.parentElement!;
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 400 }) as DOMRect;

    host.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 200, clientY: 0 }),
    );
    expect(tilt.hasAttribute("data-tilting")).toBe(true);
    // the right edge turns it one way, the top edge the other
    expect(parseFloat(tilt.style.getPropertyValue("--tilt-y"))).toBeGreaterThan(
      0,
    );
    expect(parseFloat(tilt.style.getPropertyValue("--tilt-x"))).toBeGreaterThan(
      0,
    );

    host.dispatchEvent(new MouseEvent("pointerleave"));
    expect(tilt.hasAttribute("data-tilting")).toBe(false);
    expect(tilt.style.getPropertyValue("--tilt-y")).toBe("0deg");
    reveal.remove();
  });
});
