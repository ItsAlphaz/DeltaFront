import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ClanInfo } from "../../ClanApi";
import { translateText } from "../../Utils";
import "../CurrencyDisplay";
import { uiBadge, uiIcons } from "../ui/PageUi";
import { translateClanRole } from "./ClanShared";

/**
 * A clan as a selectable card (the Clans page): a tag tile, the name, the member
 * count, a role or status badge and a chevron. Selecting it only picks it: the
 * page's detail panel shows the clan and holds the "Open clan" action.
 */
@customElement("clan-card")
export class ClanCard extends LitElement {
  @property({ type: Object }) clan!: ClanInfo;
  @property() clanRole?: string;
  @property({ type: Boolean }) pending = false;
  @property({ type: Boolean }) selected = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.style.display = "block";
  }

  private onClick() {
    this.dispatchEvent(
      new CustomEvent("clan-select", {
        detail: {
          tag: this.clan.tag,
          clan: this.clan,
          role: this.clanRole ?? null,
          pending: this.pending,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Role (Leader gold, the rest neutral) or, for a clan you are not in, its status. */
  private renderBadge() {
    if (this.clanRole) {
      return uiBadge(
        translateClanRole(this.clanRole),
        this.clanRole === "leader" ? "gold" : "neutral",
      );
    }
    if (this.pending) {
      return uiBadge(translateText("clan_modal.request_pending"), "gold");
    }
    if (this.clan.isOpen) {
      return uiBadge(translateText("clan_modal.open"), "success");
    }
    return uiBadge(translateText("clan_modal.invite_only"), "neutral");
  }

  render() {
    const clan = this.clan;
    return html`
      <button
        type="button"
        data-clan-card=${clan.tag}
        aria-pressed=${this.selected ? "true" : "false"}
        @click=${() => this.onClick()}
        class="ui-focus group flex w-full cursor-pointer items-center gap-4 rounded-ui-card border bg-ui-surface p-4 text-left transition-colors ${this
          .selected
          ? "border-ui-accent ring-1 ring-ui-accent"
          : "border-ui-border hover:border-ui-border-hover"}"
      >
        <span
          class="ui-mono flex h-12 w-12 shrink-0 items-center justify-center rounded-ui-card bg-ui-gold/10 px-1 text-[12px] font-bold text-ui-gold"
          >${clan.tag}</span
        >
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="ui-body truncate font-bold text-ui-text"
            >${clan.name}</span
          >
          <span
            class="ui-body flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ui-muted"
          >
            <span
              >${translateText("clan_modal.member_count", {
                count: clan.memberCount ?? 0,
              })}</span
            >
            <!-- Balances ride along on the clan payload, with no extra request.
                 Renders nothing when the API reported neither. -->
            <currency-display
              compact
              .hard=${clan.hardBalance ?? null}
              .soft=${clan.softBalance ?? null}
            ></currency-display>
          </span>
        </span>
        ${this.renderBadge()}
        <span class="text-ui-muted transition-colors group-hover:text-ui-text"
          >${uiIcons.chevronRight()}</span
        >
      </button>
    `;
  }
}
