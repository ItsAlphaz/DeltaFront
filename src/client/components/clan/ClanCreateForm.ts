import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type ClanInfo, createClan } from "../../ClanApi";
import { translateText } from "../../Utils";

/** Names and tags are checked again by the server; these limits only keep the inputs honest. */
const NAME_MAX = 35;
const TAG_MIN = 2;
const TAG_MAX = 5;
const DESCRIPTION_MAX = 200;

/**
 * The create-clan form (docs/DeltaFrontAccountsPlan.md 12.2). It sends the
 * fields and shows the server's verdict, including what the account is still
 * missing ("at least 3 days old", "10 completed games"); it decides nothing.
 * Raises `clan-created` with the new clan, or `create-cancel`.
 */
@customElement("clan-create-form")
export class ClanCreateForm extends LitElement {
  @property({ type: Boolean }) autofocusName = false;

  @state() private name = "";
  @state() private tag = "";
  @state() private description = "";
  @state() private isOpen = true;
  @state() private busy = false;
  @state() private error = "";

  createRenderRoot() {
    return this;
  }

  private get canSubmit(): boolean {
    return (
      !this.busy &&
      this.name.trim().length >= 3 &&
      this.tag.length >= TAG_MIN &&
      this.tag.length <= TAG_MAX
    );
  }

  private async submit(e: Event) {
    e.preventDefault();
    if (!this.canSubmit) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await createClan({
        name: this.name,
        tag: this.tag,
        description: this.description,
        isOpen: this.isOpen,
      });
      if ("error" in result) {
        this.error = translateText(result.error, result.params);
        return;
      }
      this.dispatchEvent(
        new CustomEvent<{ clan: ClanInfo }>("clan-created", {
          detail: { clan: result },
          bubbles: true,
          composed: true,
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  private cancel() {
    this.dispatchEvent(
      new CustomEvent("create-cancel", { bubbles: true, composed: true }),
    );
  }

  private field(label: string, input: unknown, hint = "") {
    return html`<label class="block space-y-1">
      <span class="text-xs font-bold uppercase tracking-wider text-white/60"
        >${label}</span
      >
      ${input}
      ${hint === ""
        ? ""
        : html`<span class="block text-[11px] text-white/40">${hint}</span>`}
    </label>`;
  }

  render() {
    const inputClass =
      "w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-white/20 text-sm focus:outline-none focus:ring-2 focus:ring-df-red/50 focus:border-df-red/50";
    return html`
      <form
        data-clan-create
        class="space-y-4 bg-white/5 border border-white/10 rounded-xl p-4"
        @submit=${(e: Event) => this.submit(e)}
      >
        <h3 class="text-sm font-bold uppercase tracking-wider text-white">
          ${translateText("clan_modal.create_title")}
        </h3>
        <p class="text-xs text-white/50">
          ${translateText("clan_modal.create_requirements")}
        </p>
        ${this.field(
          translateText("clan_modal.create_name_label"),
          html`<input
            data-create-name
            type="text"
            maxlength=${NAME_MAX}
            autocomplete="off"
            class=${inputClass}
            .value=${this.name}
            @input=${(e: Event) =>
              (this.name = (e.target as HTMLInputElement).value)}
          />`,
        )}
        ${this.field(
          translateText("clan_modal.create_tag_label"),
          html`<input
            data-create-tag
            type="text"
            maxlength=${TAG_MAX}
            autocomplete="off"
            autocapitalize="characters"
            class="${inputClass} uppercase tracking-widest"
            .value=${this.tag}
            @input=${(e: Event) => {
              const input = e.target as HTMLInputElement;
              this.tag = input.value
                .replace(/[^a-zA-Z0-9]/g, "")
                .toUpperCase()
                .slice(0, TAG_MAX);
              input.value = this.tag;
            }}
          />`,
          translateText("clan_modal.create_tag_hint"),
        )}
        ${this.field(
          translateText("clan_modal.create_description_label"),
          html`<textarea
            data-create-description
            rows="2"
            maxlength=${DESCRIPTION_MAX}
            class=${inputClass}
            .value=${this.description}
            @input=${(e: Event) =>
              (this.description = (
                e.target as HTMLTextAreaElement
              ).value.replace(/[\r\n]+/g, " "))}
          ></textarea>`,
        )}
        <label class="flex items-center gap-2 text-sm text-white/80">
          <input
            data-create-open
            type="checkbox"
            class="accent-[#e31b23]"
            .checked=${this.isOpen}
            @change=${(e: Event) =>
              (this.isOpen = (e.target as HTMLInputElement).checked)}
          />
          ${translateText("clan_modal.create_open_label")}
        </label>
        ${this.error === ""
          ? ""
          : html`<p
              data-create-error
              role="alert"
              class="text-sm font-medium text-red-400"
            >
              ${this.error}
            </p>`}
        <div class="flex gap-3">
          <button
            type="button"
            @click=${() => this.cancel()}
            class="flex-1 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white/70 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 transition-all"
          >
            ${translateText("clan_modal.create_cancel")}
          </button>
          <button
            data-create-submit
            type="submit"
            ?disabled=${!this.canSubmit}
            class="flex-1 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white bg-df-red hover:bg-df-red-bright rounded-lg transition-all disabled:opacity-40 disabled:pointer-events-none"
          >
            ${translateText("clan_modal.create_submit")}
          </button>
        </div>
      </form>
    `;
  }
}
