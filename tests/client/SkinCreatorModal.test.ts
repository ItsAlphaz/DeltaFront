import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  SKIN_CREATOR_FLARE,
  decodeSkinGrid,
  encodeSkinGrid,
  type CustomSkin,
} from "@openfront/shared/CustomSkins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getUserMe: vi.fn(),
}));
vi.mock("../../src/client/CustomSkins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/CustomSkins")>()),
  saveCustomSkin: mocks.save,
  deleteCustomSkin: mocks.remove,
}));
vi.mock("../../src/client/InGameModal", () => ({
  showInGameConfirm: mocks.confirm,
  showInGameAlert: vi.fn(),
}));

import { getUserMe } from "../../src/client/Api";
import "../../src/client/SkinCreatorModal";
import type { SkinCreatorModal } from "../../src/client/SkinCreatorModal";
import { UserSettings } from "../../src/client/UserSettings";

const design = (slot: number, name: string): CustomSkin => ({
  slot,
  name,
  patternData: encodeSkinGrid({
    width: 8,
    height: 8,
    scale: 1,
    secondary: Array.from({ length: 64 }, (_, i) => i % 2 === 0),
  }),
  primaryColor: "#aa0000",
  secondaryColor: "#101010",
});

const account = (
  flares: string[],
  customSkins: CustomSkin[] = [],
): UserMeResponse =>
  ({
    user: {},
    player: { publicId: "p1", flares, customSkins },
  }) as unknown as UserMeResponse;

describe("<skin-creator-modal>", () => {
  let modal: SkinCreatorModal;

  async function open(me: UserMeResponse) {
    vi.mocked(getUserMe).mockResolvedValue(me);
    modal = document.createElement("skin-creator-modal") as SkinCreatorModal;
    modal.setAttribute("inline", "");
    document.body.appendChild(modal);
    await modal.updateComplete;
    modal.open();
    await vi.waitFor(() =>
      expect(
        modal.querySelector("[data-skin-slots], [data-skin-creator-locked]"),
      ).not.toBeNull(),
    );
  }

  const q = <T extends Element>(sel: string) => modal.querySelector<T>(sel);
  const click = async (sel: string) => {
    q<HTMLElement>(sel)!.click();
    await modal.updateComplete;
  };

  beforeEach(() => {
    localStorage.clear();
    mocks.save.mockReset();
    mocks.remove.mockReset();
    mocks.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    modal.remove();
  });

  it("is locked, with a way to the Store, for an account without the creator", async () => {
    await open(account(["pattern:grid_check"]));
    expect(q("[data-skin-creator-locked]")).not.toBeNull();
    expect(q("[data-skin-slots]")).toBeNull();
    expect(q('[data-ui-button="open-store"]')).not.toBeNull();
  });

  it("offers five slots to an owner, showing the saved ones", async () => {
    await open(
      account(
        [SKIN_CREATOR_FLARE],
        [design(0, "Night Watch"), design(3, "Dusk")],
      ),
    );
    expect(modal.querySelectorAll("[data-skin-slot]")).toHaveLength(5);
    expect(q('[data-skin-slot="0"]')!.textContent).toContain("Night Watch");
    expect(q('[data-skin-slot="3"]')!.textContent).toContain("Dusk");
    expect(q('[data-skin-slot="1"]')!.textContent).toContain(
      "skin_creator.new_design",
    );
    // the first slot is open in the editor, with its own name
    expect(q<HTMLInputElement>("[data-skin-name]")!.value).toBe("Night Watch");
  });

  it("saves the drawing as a design the server accepts, into the chosen slot", async () => {
    mocks.save.mockResolvedValue({ ok: true, customSkins: [] });
    await open(account([SKIN_CREATOR_FLARE]));
    await click('[data-skin-slot="2"]');
    const canvas = q<HTMLElement>("skin-editor-canvas")!;
    const grid = {
      width: 16,
      height: 16,
      scale: 1,
      secondary: Array.from({ length: 256 }, (_, i) => i < 10),
    };
    canvas.dispatchEvent(
      new CustomEvent("grid-change", { detail: grid, bubbles: true }),
    );
    await modal.updateComplete;
    await click('[data-ui-button="save"]');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const [slot, body] = mocks.save.mock.calls[0];
    expect(slot).toBe(2);
    expect(body.name).toBe("Design 3");
    expect(body.primaryColor).toBe("#e5383b");
    expect(decodeSkinGrid(body.patternData).secondary.slice(0, 11)).toEqual([
      ...Array(10).fill(true),
      false,
    ]);
  });

  it("will not save a name the server would refuse", async () => {
    await open(account([SKIN_CREATOR_FLARE]));
    const input = q<HTMLInputElement>("[data-skin-name]")!;
    input.value = "<b>x</b>";
    input.dispatchEvent(new Event("input"));
    await modal.updateComplete;
    expect(q<HTMLButtonElement>('[data-ui-button="save"]')!.disabled).toBe(
      true,
    );
    expect(modal.textContent).toContain("skin_creator.name_rules");
  });

  it("keeps unsaved work in a slot while another is open", async () => {
    await open(account([SKIN_CREATOR_FLARE], [design(0, "One")]));
    q<HTMLElement>("skin-editor-canvas")!.dispatchEvent(
      new CustomEvent("grid-change", {
        detail: {
          width: 8,
          height: 8,
          scale: 1,
          secondary: Array(64).fill(true),
        },
        bubbles: true,
      }),
    );
    await modal.updateComplete;
    expect(q('[data-skin-slot="0"]')!.textContent).toContain(
      "skin_creator.unsaved",
    );
    await click('[data-skin-slot="1"]');
    await click('[data-skin-slot="0"]');
    expect(q('[data-skin-slot="0"]')!.textContent).toContain(
      "skin_creator.unsaved",
    );
  });

  it("wears a saved design, and takes it off again", async () => {
    await open(account([SKIN_CREATOR_FLARE], [design(1, "Dusk")]));
    await click('[data-skin-slot="1"]');
    await click('[data-ui-button="wear"]');
    expect(new UserSettings().getSelectedCustomSkinSlot()).toBe(1);
    expect(q('[data-skin-slot="1"]')!.textContent).toContain(
      "skin_creator.worn",
    );
    await click('[data-ui-button="wear"]');
    expect(new UserSettings().getSelectedCustomSkinSlot()).toBeNull();
  });

  it("deletes after a confirmation, and not without one", async () => {
    mocks.remove.mockResolvedValue({ ok: true, customSkins: [] });
    await open(account([SKIN_CREATOR_FLARE], [design(0, "One")]));
    mocks.confirm.mockResolvedValueOnce(false);
    await click('[data-ui-button="delete"]');
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.remove).not.toHaveBeenCalled();
    await click('[data-ui-button="delete"]');
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(0));
  });

  it("shows the server's refusal instead of pretending it saved", async () => {
    mocks.save.mockResolvedValue({ ok: false, code: "not_owned" });
    await open(account([SKIN_CREATOR_FLARE]));
    await click('[data-ui-button="save"]');
    await vi.waitFor(() =>
      expect(q("[data-skin-message]")?.textContent).toContain(
        "skin_creator.not_owned",
      ),
    );
  });
});
