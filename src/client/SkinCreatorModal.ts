import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  CUSTOM_SKIN_GRID_SIZES,
  CUSTOM_SKIN_NAME,
  CUSTOM_SKIN_NAME_MAX,
  CustomSkinBodySchema,
  MAX_CUSTOM_SKINS,
  MAX_CUSTOM_SKIN_SCALE,
  decodeSkinGrid,
  encodeSkinGrid,
  type CustomSkin,
  type SkinGrid,
} from "@openfront/shared/CustomSkins";
import type { PlayerPattern } from "@openfront/shared/WireSchemas";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { renderPatternPreview } from "./components/PatternPreview";
import "./components/SkinEditorCanvas";
import type { SkinEditorTool } from "./components/SkinEditorCanvas";
import {
  uiBadge,
  uiButton,
  uiSegmented,
  uiTwoColumn,
} from "./components/ui/PageUi";
import {
  canCreateSkins,
  customSkinsOf,
  deleteCustomSkin,
  saveCustomSkin,
  wearCustomSkin,
} from "./CustomSkins";
import { showInGameConfirm } from "./InGameModal";
import { ProfileMenuModal } from "./ProfileMenuModal";
import {
  blankGrid,
  flipGrid,
  invertGrid,
  resizeGrid,
  sameGrid,
} from "./SkinEditorOps";
import { UserSettings } from "./UserSettings";
import { translateText } from "./Utils";

/** What the editor holds for one slot while the window is open, saved or not. */
interface Draft {
  name: string;
  grid: SkinGrid;
  primaryColor: string;
  secondaryColor: string;
}

const DEFAULT_PRIMARY = "#e5383b";
const DEFAULT_SECONDARY = "#101010";
const DEFAULT_SIZE = 16;
const DEFAULT_SCALE = 1;
const HISTORY_LIMIT = 60;

const newDraft = (slot: number): Draft => ({
  name: `Design ${slot + 1}`,
  grid: blankGrid(DEFAULT_SIZE, DEFAULT_SCALE),
  primaryColor: DEFAULT_PRIMARY,
  secondaryColor: DEFAULT_SECONDARY,
});

const draftOf = (skin: CustomSkin): Draft => ({
  name: skin.name,
  grid: decodeSkinGrid(skin.patternData),
  primaryColor: skin.primaryColor,
  secondaryColor: skin.secondaryColor,
});

const patternOf = (draft: Draft): PlayerPattern => ({
  name: "preview",
  patternData: encodeSkinGrid(draft.grid),
  colorPalette: {
    name: "custom",
    primaryColor: draft.primaryColor,
    secondaryColor: draft.secondaryColor,
  },
});

/**
 * "Create Your Own": the window where an account that bought the shop item
 * draws its own territory skins. Up to five designs, each a small grid of two
 * colours that tiles across the territory. A design is kept on the account when
 * it is saved, and worn by choosing it here (or in the Inventory).
 *
 * Unsaved work is kept per slot while the window stays open, so moving between
 * slots never loses a drawing.
 */
@customElement("skin-creator-modal")
export class SkinCreatorModal extends ProfileMenuModal {
  protected routerName = "skin-creator";
  protected titleKey = "skin_creator.title";

  @state() private activeSlot = 0;
  @state() private drafts = new Map<number, Draft>();
  @state() private undoStacks = new Map<number, SkinGrid[]>();
  @state() private tool: SkinEditorTool = "draw";
  // A new grid is all primary, so the first stroke should paint the other colour.
  @state() private secondaryBrush = true;
  @state() private busy = false;
  @state() private message: { text: string; error: boolean } | null = null;
  @state() private worn: number | null = null;

  protected modalConfig() {
    return { maxWidth: "1080px" };
  }

  private onUserMe = (event: Event) => {
    this.userMeResponse = (event as CustomEvent<UserMeResponse | false>).detail;
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe);
  }

  disconnectedCallback() {
    document.removeEventListener("userMeResponse", this.onUserMe);
    super.disconnectedCallback();
  }

  protected onOpenExtra(): void {
    this.drafts = new Map();
    this.undoStacks = new Map();
    this.message = null;
    this.secondaryBrush = true;
    this.activeSlot = 0;
    this.worn = new UserSettings().getSelectedCustomSkinSlot();
  }

  private saved(slot: number): CustomSkin | undefined {
    return customSkinsOf(this.userMeResponse).find((s) => s.slot === slot);
  }

  private draft(slot = this.activeSlot): Draft {
    const held = this.drafts.get(slot);
    if (held !== undefined) return held;
    const saved = this.saved(slot);
    return saved === undefined ? newDraft(slot) : draftOf(saved);
  }

  private setDraft(patch: Partial<Draft>, slot = this.activeSlot): void {
    this.drafts = new Map(this.drafts).set(slot, {
      ...this.draft(slot),
      ...patch,
    });
    this.message = null;
  }

  private isDirty(slot: number): boolean {
    const held = this.drafts.get(slot);
    if (held === undefined) return false;
    const saved = this.saved(slot);
    if (saved === undefined) {
      return !sameGrid(held.grid, blankGrid(held.grid.width, held.grid.scale));
    }
    const was = draftOf(saved);
    return !(
      held.name === was.name &&
      held.primaryColor === was.primaryColor &&
      held.secondaryColor === was.secondaryColor &&
      sameGrid(held.grid, was.grid)
    );
  }

  // ---- history

  private remember(grid: SkinGrid): void {
    const stack = [...(this.undoStacks.get(this.activeSlot) ?? []), grid];
    this.undoStacks = new Map(this.undoStacks).set(
      this.activeSlot,
      stack.slice(-HISTORY_LIMIT),
    );
  }

  private undo(): void {
    const stack = this.undoStacks.get(this.activeSlot) ?? [];
    const previous = stack[stack.length - 1];
    if (previous === undefined) return;
    this.undoStacks = new Map(this.undoStacks).set(
      this.activeSlot,
      stack.slice(0, -1),
    );
    this.setDraft({ grid: previous });
  }

  /** A whole-picture change, undoable as one step. */
  private change(grid: SkinGrid): void {
    this.remember(this.draft().grid);
    this.setDraft({ grid });
  }

  // ---- actions

  private selectSlot(slot: number): void {
    this.activeSlot = slot;
    this.message = null;
  }

  private async save(): Promise<void> {
    const draft = this.draft();
    const body = {
      name: draft.name.trim(),
      patternData: encodeSkinGrid(draft.grid),
      primaryColor: draft.primaryColor,
      secondaryColor: draft.secondaryColor,
    };
    if (!CustomSkinBodySchema.safeParse(body).success) {
      this.message = {
        text: translateText("skin_creator.invalid"),
        error: true,
      };
      return;
    }
    this.busy = true;
    const result = await saveCustomSkin(this.activeSlot, body);
    this.busy = false;
    if (result.ok) {
      this.drafts = new Map(this.drafts);
      this.drafts.delete(this.activeSlot);
      this.message = {
        text: translateText("skin_creator.saved"),
        error: false,
      };
      return;
    }
    this.message = {
      text: translateText(
        result.code === "not_owned"
          ? "skin_creator.not_owned"
          : "skin_creator.save_failed",
      ),
      error: true,
    };
  }

  private async deleteDesign(): Promise<void> {
    const confirmed = await showInGameConfirm(
      translateText("skin_creator.delete_body", { name: this.draft().name }),
      {
        heading: translateText("skin_creator.delete_heading"),
        variant: "warning",
        confirmText: translateText("skin_creator.delete"),
      },
    );
    if (!confirmed) return;
    this.busy = true;
    const result = await deleteCustomSkin(this.activeSlot);
    this.busy = false;
    if (result.ok) {
      this.drafts = new Map(this.drafts);
      this.drafts.delete(this.activeSlot);
      this.undoStacks = new Map(this.undoStacks);
      this.undoStacks.delete(this.activeSlot);
      this.worn = new UserSettings().getSelectedCustomSkinSlot();
      this.message = {
        text: translateText("skin_creator.deleted"),
        error: false,
      };
    } else {
      this.message = {
        text: translateText("skin_creator.save_failed"),
        error: true,
      };
    }
  }

  private toggleWear(): void {
    const wearing = this.worn === this.activeSlot;
    wearCustomSkin(wearing ? undefined : this.activeSlot);
    this.worn = wearing ? null : this.activeSlot;
  }

  // ---- rendering

  protected renderSignedIn(userMe: UserMeResponse): TemplateResult {
    if (!canCreateSkins(userMe)) return this.renderLocked();
    return uiTwoColumn({
      content: html`<div class="flex flex-col gap-6 p-6">
        ${this.renderSlots()} ${this.renderEditor()}
      </div>`,
      detail: this.renderSide(),
    });
  }

  private renderLocked(): TemplateResult {
    return html`<div class="p-6">
      <div
        data-skin-creator-locked
        class="flex flex-col items-center gap-4 rounded-ui-panel border border-ui-border bg-ui-surface p-10 text-center"
      >
        <h2 class="ui-heading text-ui-text">
          ${translateText("skin_creator.locked_title")}
        </h2>
        <p class="ui-body max-w-md text-ui-muted">
          ${translateText("skin_creator.locked_body")}
        </p>
        ${uiButton({
          label: translateText("skin_creator.locked_cta"),
          variant: "primary",
          name: "open-store",
          onClick: () => {
            this.close();
            window.location.hash = "modal=store&tab=cosmetics";
          },
        })}
      </div>
    </div>`;
  }

  private renderSlots(): TemplateResult {
    return html`<section data-skin-slots>
      <h2 class="ui-label mb-3">${translateText("skin_creator.slots")}</h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
        ${Array.from({ length: MAX_CUSTOM_SKINS }, (_, slot) =>
          this.renderSlot(slot),
        )}
      </div>
    </section>`;
  }

  private renderSlot(slot: number): TemplateResult {
    const saved = this.saved(slot);
    const held = this.drafts.get(slot);
    const selected = slot === this.activeSlot;
    const shown = held ?? (saved === undefined ? undefined : draftOf(saved));
    return html`<button
      type="button"
      data-skin-slot=${slot}
      aria-pressed=${selected ? "true" : "false"}
      class="ui-focus relative flex min-w-0 flex-col overflow-hidden rounded-ui-card border bg-ui-surface text-left transition-colors cursor-pointer ${selected
        ? "border-ui-accent ring-1 ring-ui-accent"
        : "border-ui-border hover:border-ui-border-hover"}"
      @click=${() => this.selectSlot(slot)}
    >
      <span
        class="flex aspect-square items-center justify-center overflow-hidden bg-ui-ground"
      >
        ${shown === undefined
          ? html`<span class="ui-label text-ui-muted"
              >${translateText("skin_creator.empty_slot")}</span
            >`
          : renderPatternPreview(patternOf(shown), 120, 120)}
      </span>
      <span class="flex items-center justify-between gap-2 px-3 py-2">
        <span class="ui-body min-w-0 truncate text-ui-text"
          >${shown?.name ?? translateText("skin_creator.new_design")}</span
        >
        <span class="flex shrink-0 gap-1">
          ${this.worn === slot
            ? uiBadge(translateText("skin_creator.worn"), "success")
            : nothing}
          ${this.isDirty(slot)
            ? uiBadge(translateText("skin_creator.unsaved"), "gold")
            : nothing}
        </span>
      </span>
    </button>`;
  }

  private renderEditor(): TemplateResult {
    const draft = this.draft();
    const history = this.undoStacks.get(this.activeSlot) ?? [];
    const sizeOptions = CUSTOM_SKIN_GRID_SIZES.map((size) => ({
      key: String(size),
      label: String(size),
    }));
    const tileOptions = Array.from(
      { length: MAX_CUSTOM_SKIN_SCALE + 1 },
      (_, scale) => ({
        key: String(scale),
        label: translateText(`skin_creator.tile_${scale}`),
      }),
    );
    return html`<section
      data-skin-editor
      class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]"
    >
      <div class="min-w-0">
        <skin-editor-canvas
          .grid=${draft.grid}
          .primaryColor=${draft.primaryColor}
          .secondaryColor=${draft.secondaryColor}
          .tool=${this.tool}
          .secondaryBrush=${this.secondaryBrush}
          @stroke-start=${(e: CustomEvent<SkinGrid>) => this.remember(e.detail)}
          @grid-change=${(e: CustomEvent<SkinGrid>) =>
            this.setDraft({ grid: e.detail })}
        ></skin-editor-canvas>
        <p class="ui-body mt-2 text-[12px] text-ui-muted">
          ${translateText("skin_creator.hint")}
        </p>
      </div>
      <div class="flex flex-col gap-5">
        <div>
          <h3 class="ui-label mb-2">
            ${translateText("skin_creator.colours")}
          </h3>
          ${this.renderColour("primary", draft.primaryColor, false)}
          ${this.renderColour("secondary", draft.secondaryColor, true)}
        </div>
        <div>
          <h3 class="ui-label mb-2">${translateText("skin_creator.tools")}</h3>
          ${uiSegmented({
            options: [
              { key: "draw", label: translateText("skin_creator.draw") },
              { key: "fill", label: translateText("skin_creator.fill") },
            ],
            value: this.tool,
            onChange: (tool) => (this.tool = tool as SkinEditorTool),
            ariaLabel: translateText("skin_creator.tools"),
            name: "skin-tool",
          })}
          <div class="mt-2 grid grid-cols-4 gap-1">
            ${uiButton({
              label: translateText("skin_creator.undo"),
              variant: "text",
              disabled: history.length === 0,
              name: "undo",
              onClick: () => this.undo(),
            })}
            ${uiButton({
              label: translateText("skin_creator.invert"),
              variant: "text",
              name: "invert",
              onClick: () => this.change(invertGrid(draft.grid)),
            })}
            ${uiButton({
              label: translateText("skin_creator.flip"),
              variant: "text",
              name: "flip",
              onClick: () => this.change(flipGrid(draft.grid)),
            })}
            ${uiButton({
              label: translateText("skin_creator.clear"),
              variant: "text",
              name: "clear",
              onClick: () =>
                this.change(
                  blankGrid(
                    draft.grid.width,
                    draft.grid.scale,
                    this.secondaryBrush,
                  ),
                ),
            })}
          </div>
        </div>
        <div>
          <h3 class="ui-label mb-2">${translateText("skin_creator.size")}</h3>
          ${uiSegmented({
            options: sizeOptions,
            value: String(draft.grid.width),
            onChange: (key) => this.change(resizeGrid(draft.grid, Number(key))),
            ariaLabel: translateText("skin_creator.size"),
            fill: true,
            name: "skin-size",
          })}
        </div>
        <div>
          <h3 class="ui-label mb-2">${translateText("skin_creator.tile")}</h3>
          ${uiSegmented({
            options: tileOptions,
            value: String(draft.grid.scale),
            onChange: (key) =>
              this.setDraft({ grid: { ...draft.grid, scale: Number(key) } }),
            ariaLabel: translateText("skin_creator.tile"),
            fill: true,
            name: "skin-tile",
          })}
        </div>
      </div>
    </section>`;
  }

  private renderColour(
    which: "primary" | "secondary",
    value: string,
    secondary: boolean,
  ) {
    const selected = this.secondaryBrush === secondary;
    return html`<div class="mb-2 flex items-center gap-3">
      <button
        type="button"
        data-skin-brush=${which}
        aria-pressed=${selected ? "true" : "false"}
        class="ui-focus flex min-h-11 flex-1 items-center gap-3 rounded-ui-card border px-3 text-left transition-colors cursor-pointer ${selected
          ? "border-ui-accent bg-ui-accent-tint"
          : "border-ui-border bg-ui-surface hover:border-ui-border-hover"}"
        @click=${() => (this.secondaryBrush = secondary)}
      >
        <span
          class="h-5 w-5 shrink-0 rounded-sm border border-white/30"
          style="background:${value}"
        ></span>
        <span class="ui-body text-ui-text"
          >${translateText(`skin_creator.${which}`)}</span
        >
      </button>
      <input
        type="color"
        data-skin-colour=${which}
        aria-label=${translateText(`skin_creator.${which}_colour`)}
        class="h-11 w-11 shrink-0 cursor-pointer rounded-ui-card border border-ui-border bg-transparent p-1"
        .value=${value}
        @input=${(e: Event) =>
          this.setDraft(
            which === "primary"
              ? {
                  primaryColor: (
                    e.target as HTMLInputElement
                  ).value.toLowerCase(),
                }
              : {
                  secondaryColor: (
                    e.target as HTMLInputElement
                  ).value.toLowerCase(),
                },
          )}
      />
    </div>`;
  }

  private renderSide(): TemplateResult {
    const draft = this.draft();
    const saved = this.saved(this.activeSlot);
    const dirty = this.isDirty(this.activeSlot);
    const nameOk =
      draft.name.trim().length > 0 && CUSTOM_SKIN_NAME.test(draft.name.trim());
    return html`<aside
      data-skin-side
      class="flex w-full shrink-0 flex-col gap-5 border-t border-ui-border bg-ui-surface p-6 lg:w-[300px] lg:border-l lg:border-t-0"
    >
      <div>
        <h3 class="ui-label mb-2">${translateText("skin_creator.preview")}</h3>
        <div
          data-skin-preview
          class="aspect-square w-full overflow-hidden rounded-ui-card border border-ui-border bg-ui-ground"
        >
          ${renderPatternPreview(patternOf(draft), 260, 260)}
        </div>
      </div>
      <label class="flex flex-col gap-2">
        <span class="ui-label">${translateText("skin_creator.name")}</span>
        <input
          type="text"
          data-skin-name
          maxlength=${CUSTOM_SKIN_NAME_MAX}
          class="ui-focus min-h-11 rounded-ui-card border border-ui-border-strong bg-ui-ground px-3 text-ui-text"
          .value=${draft.name}
          @input=${(e: Event) =>
            this.setDraft({ name: (e.target as HTMLInputElement).value })}
        />
        ${nameOk
          ? nothing
          : html`<span class="text-[12px] text-ui-accent-soft"
              >${translateText("skin_creator.name_rules")}</span
            >`}
      </label>
      ${this.message === null
        ? nothing
        : html`<p
            data-skin-message
            class="ui-body text-[13px] ${this.message.error
              ? "text-ui-accent-soft"
              : "text-ui-success"}"
            role="status"
          >
            ${this.message.text}
          </p>`}
      <div class="mt-auto flex flex-col gap-3">
        ${uiButton({
          label: translateText(
            this.busy ? "skin_creator.saving" : "skin_creator.save",
          ),
          variant: "primary",
          block: true,
          name: "save",
          disabled: this.busy || !nameOk || (saved !== undefined && !dirty),
          onClick: () => void this.save(),
        })}
        ${saved === undefined
          ? nothing
          : html`${uiButton({
              label: translateText(
                this.worn === this.activeSlot
                  ? "skin_creator.take_off"
                  : "skin_creator.wear",
              ),
              block: true,
              name: "wear",
              disabled: this.busy,
              onClick: () => this.toggleWear(),
            })}
            ${uiButton({
              label: translateText("skin_creator.delete"),
              variant: "text",
              block: true,
              name: "delete",
              disabled: this.busy,
              onClick: () => void this.deleteDesign(),
            })}`}
      </div>
    </aside>`;
  }
}
