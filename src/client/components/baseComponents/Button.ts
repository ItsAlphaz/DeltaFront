import { LitElement, TemplateResult, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../../Utils";

type ButtonVariant = "primary" | "secondary" | "danger" | "warning" | "ghost";
type ButtonSize = "xs" | "sm" | "md" | "lg";
type ButtonWidth = "auto" | "block" | "blockDesktop" | "fill";
type IconPosition = "left" | "right" | "only";

@customElement("o-button")
export class OButton extends LitElement {
  @property() title = "";
  @property() translationKey = "";
  @property() variant: ButtonVariant = "primary";
  @property() size: ButtonSize = "md";
  @property() width: ButtonWidth = "auto";
  @property() iconPosition: IconPosition = "left";
  @property({ attribute: false }) icon?: TemplateResult;
  @property({ type: Boolean }) disable = false;
  @property({ type: Boolean }) submit = false;
  @property({ type: Boolean }) uppercase = true;

  createRenderRoot() {
    return this;
  }

  // The website's button (components/ui/PageUi.ts uiButton): Inter, 10px
  // corners, a flat accent fill for the one main action, a quiet surface for
  // the rest.
  private readonly BASE =
    "ui-focus font-ui font-semibold tracking-[0.06em] rounded-ui-card border border-transparent " +
    "transition-colors " +
    "text-center whitespace-normal break-words leading-tight overflow-hidden relative " +
    "disabled:cursor-not-allowed";

  private variantClasses(): string {
    switch (this.variant) {
      case "primary":
        return "bg-ui-accent hover:bg-ui-accent-soft text-white disabled:bg-ui-disabled disabled:text-ui-placeholder";
      case "secondary":
        return "bg-ui-surface border-ui-border-strong hover:border-ui-border-hover text-ui-text disabled:bg-ui-disabled disabled:text-ui-placeholder";
      case "danger":
        return "bg-ui-accent-tint border-ui-accent text-ui-accent-soft hover:bg-ui-accent/25 disabled:border-ui-border-strong disabled:bg-ui-disabled disabled:text-ui-placeholder";
      case "warning":
        return "bg-ui-gold hover:brightness-110 text-black disabled:bg-ui-disabled disabled:text-ui-placeholder";
      case "ghost":
        return "bg-transparent hover:bg-ui-surface text-ui-text disabled:text-ui-placeholder disabled:hover:bg-transparent";
    }
  }

  private sizeClasses(): string {
    if (this.iconPosition === "only") {
      switch (this.size) {
        case "xs":
          return "w-8 h-8 text-xs";
        case "sm":
          return "w-9 h-9 text-sm";
        case "md":
          return "w-11 h-11 text-base";
        case "lg":
          return "w-12 h-12 text-lg";
      }
    }
    switch (this.size) {
      case "xs":
        return "min-h-8 px-2.5 py-1 text-[12px]";
      case "sm":
        return "min-h-9 px-3 py-1.5 text-[13px]";
      case "md":
        return "min-h-11 px-4 py-2.5 text-[14px]";
      case "lg":
        return "min-h-[52px] px-6 py-3 text-[15px]";
    }
  }

  private widthClasses(): string {
    switch (this.width) {
      case "auto":
        return "inline-flex items-center justify-center gap-2";
      case "block":
        return "flex w-full items-center justify-center gap-2";
      case "blockDesktop":
        return "flex w-full items-center justify-center gap-2 lg:w-1/2 lg:mx-auto";
      case "fill":
        return "flex w-full h-full items-center justify-center gap-2";
    }
  }

  render() {
    const label =
      this.translationKey === ""
        ? this.title
        : translateText(this.translationKey);
    const iconOnly = this.iconPosition === "only";
    const casing = this.uppercase ? "uppercase" : "normal-case";
    const classes = `${this.BASE} ${casing} ${this.variantClasses()} ${this.sizeClasses()} ${this.widthClasses()}`;

    return html`
      <button
        class=${classes}
        ?disabled=${this.disable}
        type=${this.submit ? "submit" : "button"}
        aria-label=${iconOnly ? label : nothing}
      >
        ${this.icon && this.iconPosition !== "right" ? this.icon : nothing}
        ${iconOnly ? nothing : html`<span class="min-w-0">${label}</span>`}
        ${this.icon && this.iconPosition === "right" ? this.icon : nothing}
      </button>
    `;
  }
}
