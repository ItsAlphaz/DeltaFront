import { html, TemplateResult } from "lit";
import { uiIconButtonClasses, uiIcons } from "./PageUi";

export interface ModalHeaderProps {
  title?: string | TemplateResult;
  titleContent?: TemplateResult;
  onBack: (event: MouseEvent) => void;
  ariaLabel?: string;
  rightContent?: TemplateResult;
  leftClassName?: string;
  buttonClassName?: string;
  titleClassName?: string;
  padded?: boolean;
  showDivider?: boolean;
}

// The account pages' header (PageUi.ts uiPageHeader): 76px tall, a 44px back
// button, the title in the page-title scale.
const DEFAULT_WRAPPER_CLASS = "flex flex-wrap items-center gap-2 shrink-0";
const DEFAULT_DIVIDER_CLASS = "border-b border-ui-border";
const DEFAULT_PADDING_CLASS = "min-h-[76px] px-4 py-3 lg:px-6";
const DEFAULT_LEFT_CLASS = "flex items-center gap-4 flex-1 min-w-0";
const DEFAULT_BUTTON_CLASS = uiIconButtonClasses;
export const DEFAULT_TITLE_CLASS =
  "ui-title text-ui-text break-words hyphens-auto";

const withClasses = (...classes: Array<string | undefined>) =>
  classes.filter(Boolean).join(" ");

export const modalHeader = ({
  title,
  titleContent,
  onBack,
  ariaLabel = "Back",
  rightContent,
  leftClassName,
  buttonClassName,
  titleClassName,
  padded = true,
  showDivider = true,
}: ModalHeaderProps): TemplateResult => {
  const wrapperClass = withClasses(
    DEFAULT_WRAPPER_CLASS,
    showDivider ? DEFAULT_DIVIDER_CLASS : undefined,
    padded ? DEFAULT_PADDING_CLASS : undefined,
  );
  const leftClass = withClasses(DEFAULT_LEFT_CLASS, leftClassName);
  const buttonClass = withClasses(DEFAULT_BUTTON_CLASS, buttonClassName);
  const resolvedTitleClass = withClasses(DEFAULT_TITLE_CLASS, titleClassName);

  return html`
    <div class="${wrapperClass}">
      <div class="${leftClass}">
        <button
          @click=${onBack}
          class="${buttonClass}"
          aria-label="${ariaLabel}"
        >
          ${uiIcons.back()}
        </button>
        ${titleContent ??
        html`<span class="${resolvedTitleClass}">${title}</span>`}
      </div>
      ${rightContent ?? ""}
    </div>
  `;
};
