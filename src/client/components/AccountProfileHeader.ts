import type {
  ProgressionMe,
  UserMeResponse,
} from "@openfront/shared/ApiSchemas";
import { html, nothing, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { titleText } from "../Progression";
import { getDiscordAvatarUrl, translateText } from "../Utils";
import "./CurrencyDisplay";
import { ProfileHeaderBase } from "./ProfileHeaderBase";
import {
  initialOf,
  PH_CARD_CLASS,
  PH_SPACING,
  phAside,
  phAvatar,
  phClan,
  phIdentityBand,
  phPrestigeStrip,
  phProgressionBand,
  phStatus,
  type PhLevel,
} from "./ProfileHeaderView";
import { formatXp } from "./XpBar";

/**
 * The top of your own Account page: ONE card, in three bands with real space and
 * a full-width rule between them. It is the same profile header everyone's
 * Stats page has (ProfileHeaderView draws both, ProfileHeaderBase opens both),
 * plus what is yours alone.
 *
 *   identity     avatar + level chip · [CLAN] name ✓ · @handle · chips     Credits
 *   progression  LEVEL 47 · RANK · prestige
 *                next milestone                                  XP into level
 *                segmented XP bar, on its own row
 *   title        Display title / hint                              [select]
 *
 * The XP is a band of its own under a rule and a shade, with room above the
 * level line, so it never feels jammed against the avatar. On a narrow screen
 * every group stacks; the name truncates, tags and handles truncate, and the XP
 * figure wraps under the level line instead of pushing the card wider.
 *
 * It only draws: the title choice and the Prestige press are events
 * (`title-change` with the title id or null, `prestige-request`) for the page to
 * act on. The level, XP and Credits show at once from `player`; the titles to
 * choose from and the next milestone arrive with `progression`.
 */

/** The linked identity as the player knows it: "@alphaz", an email, a persona. */
export function linkedHandle(
  identity: UserMeResponse["user"] | null | undefined,
): { text: string; kind: "discord" | "google" | "email" | "steam" } | null {
  if (identity?.discord) {
    return { text: `@${identity.discord.username}`, kind: "discord" };
  }
  if (identity?.google) return { text: identity.google.email, kind: "google" };
  if (identity?.email) return { text: identity.email, kind: "email" };
  if (identity?.steam) {
    const name = identity.steam.personaName?.trim();
    return {
      text:
        name === undefined || name === ""
          ? translateText("steam_user_header.default_name")
          : name,
      kind: "steam",
    };
  }
  return null;
}

function avatarUrl(
  identity: UserMeResponse["user"] | null | undefined,
): string | null {
  if (identity?.discord) return getDiscordAvatarUrl(identity.discord);
  return identity?.steam?.avatarUrl ?? null;
}

@customElement("account-profile-header")
export class AccountProfileHeader extends ProfileHeaderBase {
  @property({ attribute: false }) player: UserMeResponse["player"] | null =
    null;
  // The linked sign-in identities (Discord, Google, email, Steam).
  @property({ attribute: false }) identity:
    | UserMeResponse["user"]
    | null
    | undefined = undefined;
  // Titles to pick from, once /progression/me has answered.
  @property({ attribute: false }) progression: ProgressionMe | null = null;
  @property({ type: Boolean }) prestigeable = false;
  @property({ type: Boolean }) savingTitle = false;

  protected flourishWanted(): boolean {
    return this.player !== null;
  }

  protected isLegend(): boolean {
    return this.player?.progress?.legend === true;
  }

  private renderHandle(): TemplateResult | typeof nothing {
    const handle = linkedHandle(this.identity);
    if (handle === null) return nothing;
    return html`<div
      data-ph-handle
      data-ph-handle-kind=${handle.kind}
      class="order-2 truncate text-base text-white/55"
      title=${handle.text}
    >
      ${handle.text}
    </div>`;
  }

  private renderTitleRow(selected: string | null): TemplateResult {
    const titles = this.progression?.titles ?? [];
    return html`<div
      data-ph-title-row
      class="relative flex flex-col gap-3 ${PH_SPACING.band} sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <div class="min-w-0">
        <div class="text-base font-bold text-white">
          ${translateText("progression.display_title")}
        </div>
        <div class="text-sm text-white/50">
          ${translateText("progression.display_title_hint")}
        </div>
      </div>
      <select
        data-ph-title-select
        aria-label=${translateText("progression.display_title")}
        class="df-input w-full shrink-0 sm:w-64"
        ?disabled=${this.savingTitle || this.progression === null}
        @change=${(e: Event) =>
          this.dispatchEvent(
            new CustomEvent<string | null>("title-change", {
              detail: (e.target as HTMLSelectElement).value || null,
              bubbles: true,
              composed: true,
            }),
          )}
      >
        <option value="" ?selected=${selected === null}>
          ${translateText("progression.title_none")}
        </option>
        ${titles.map(
          (id) =>
            html`<option value=${id} ?selected=${selected === id}>
              ${titleText(id, translateText)}
            </option>`,
        )}
      </select>
    </div>`;
  }

  render(): TemplateResult | typeof nothing {
    const player = this.player;
    if (player === null) return nothing;
    const progress = player.progress;
    const level: PhLevel | null = progress
      ? {
          level: progress.level,
          prestige: progress.prestige,
          legend: progress.legend,
        }
      : null;
    const username = player.username ?? null;
    const handle = linkedHandle(this.identity);
    const status = phStatus({
      username,
      verified: player.verified === true,
      staffRole: player.staffRole,
      ids: true,
      askForUsername: true,
    });
    const currency = player.currency;
    const milestone = this.progression?.nextMilestone ?? null;
    const selected = this.progression
      ? this.progression.selectedTitle
      : (progress?.title ?? null);

    return html`<section
      data-ph-root
      data-account-header
      class="${PH_CARD_CLASS} ${this.cardClasses()}"
    >
      ${this.renderBackdrop()}
      ${phIdentityBand({
        avatar: phAvatar({
          url: avatarUrl(this.identity),
          initial: initialOf(username ?? handle?.text.replace(/^@/, "")),
          level,
        }),
        identity: html`${phClan(player.clans?.[0]?.tag ?? null)}${status ===
        nothing
          ? html`<div
              data-ph-fallback-name
              class="order-1 truncate text-2xl font-black text-white"
            >
              ${handle?.text ?? ""}
            </div>`
          : status}${status === nothing ? nothing : this.renderHandle()}`,
        aside: currency
          ? phAside(
              "credits",
              translateText("account_modal.credits_label"),
              html`<currency-display
                large
                .countIn=${this.intro}
                .hard=${currency.hard}
                .soft=${currency.soft}
              ></currency-display>`,
            )
          : nothing,
      })}
      ${level === null || progress === undefined
        ? nothing
        : phProgressionBand({
            level,
            xpInLevel: progress.xpInLevel,
            xpForNext: progress.xpForNext,
            left:
              milestone === null
                ? nothing
                : html`<span data-ph-milestone
                    >${translateText("progression.next_milestone", {
                      level: milestone.level,
                      credits: formatXp(milestone.credits),
                    })}</span
                  >`,
            after:
              this.prestigeable && progress.canPrestige
                ? phPrestigeStrip(() =>
                    this.dispatchEvent(
                      new CustomEvent("prestige-request", {
                        bubbles: true,
                        composed: true,
                      }),
                    ),
                  )
                : nothing,
          })}
      ${progress === undefined || progress === null
        ? nothing
        : this.renderTitleRow(selected)}
    </section>`;
  }
}
