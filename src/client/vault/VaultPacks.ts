import {
  VAULT_RARITIES,
  type VaultRarity,
  type VaultView,
} from "@openfront/shared/VaultSchemas";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import { RARITY_COLOR } from "./VaultFx";
import { renderPackArt } from "./VaultPackArt";
import {
  rarityName,
  vaultIcons,
  vaultSectionHead,
  watchInView,
} from "./VaultParts";
import { tone } from "./VaultPixel";
import { tiltLeave, tiltMove } from "./VaultTilt";

type Pack = VaultView["packs"][number];

/** Where the sparkles that rise from a pack under the pointer sit, as a share of the shelf. */
const SPARKS = [
  { x: "18%", y: "62%", d: "0s" },
  { x: "80%", y: "52%", d: "0.6s" },
  { x: "30%", y: "26%", d: "1.1s" },
  { x: "72%", y: "20%", d: "0.3s" },
];

/**
 * The shelf of packs: each a foil pack that floats, leans towards the pointer
 * and shines with a rainbow foil, with its price, the bad-luck guarantee as a
 * meter filling towards it, and the chances of every card folded under "Show
 * odds". Opening one says `vault-open-pack`; what it costs and gives is the
 * server's.
 */
@customElement("vault-packs")
export class VaultPacks extends LitElement {
  @property({ attribute: false }) view: VaultView | null = null;
  @property({ type: Boolean }) busy = false;

  @state() private openOdds: string | null = null;

  createRenderRoot() {
    return this;
  }

  protected updated() {
    watchInView(this);
  }

  render() {
    const view = this.view;
    if (view === null) return nothing;
    const state = view.state;
    return html`<section data-vault-packs class="flex flex-col gap-6">
      <div data-vault-in-view>
        ${vaultSectionHead({
          title: translateText("vault.packs"),
          blurb: translateText("vault.packs_blurb"),
          aside:
            state === null
              ? undefined
              : html`<span class="vault-chip" style=${tone("#fbbf24")}>
                  ${vaultIcons.clock(1)}
                  ${translateText("vault.packs_today", {
                    used: state.today.packs,
                    max: view.limits.packsPerDay,
                  })}
                </span>`,
        })}
      </div>
      <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        ${view.packs.map((pack, i) => this.renderPack(view, pack, i))}
      </div>
    </section>`;
  }

  private renderPack(
    view: VaultView,
    pack: Pack,
    index: number,
  ): TemplateResult {
    const color = RARITY_COLOR[pack.rarity];
    const state = view.state;
    const canPay = state !== null && state.balance >= pack.priceSoft;
    const limitHit =
      state !== null && state.today.packs >= view.limits.packsPerDay;
    const disabled = !pack.inSeason || !canPay || limitHit || this.busy;
    const showing = this.openOdds === pack.name;
    const hint = !pack.inSeason
      ? translateText("vault.out_of_season")
      : state === null
        ? translateText("vault.error_login")
        : limitHit
          ? translateText("vault.error_daily_limit")
          : !canPay
            ? translateText("vault.need_more", {
                amount: (pack.priceSoft - state.balance).toLocaleString(),
              })
            : null;
    return html`<div
      data-vault-pack=${pack.name}
      data-vault-in-view
      style="--d:${index * 0.12}s"
    >
      <article class="vault-pack-card" style=${tone(color)}>
        <div
          class="vault-pack-shelf"
          @pointermove=${(e: PointerEvent) => tiltMove(e, 13)}
          @pointerleave=${tiltLeave}
        >
          <span class="vault-pack-glow" aria-hidden="true"></span>
          ${SPARKS.map(
            (s) =>
              html`<span
                class="vault-pack-spark"
                aria-hidden="true"
                style="left:${s.x};top:${s.y};--d:${s.d}"
              ></span>`,
          )}
          <div
            class="vault-pack-float"
            ?data-away=${showing}
            style="--d:${index * -1.4}s"
          >
            <div class="vault-tilt" style="--tilt-hover-scale: 1.07">
              ${renderPackArt({ name: pack.displayName, rarity: pack.rarity })}
              <span class="vault-holo"></span><span class="vault-glare"></span>
            </div>
          </div>
          <div class="vault-pack-odds" ?data-open=${showing} ?inert=${!showing}>
            ${this.renderOdds(view, pack)}
          </div>
        </div>
        <div class="flex flex-1 flex-col gap-4 p-5 pt-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="truncate text-xl font-extrabold text-white">
                ${pack.displayName}
              </h3>
              ${pack.tagline === undefined
                ? nothing
                : html`<p class="mt-0.5 text-sm text-ui-muted">
                    ${pack.tagline}
                  </p>`}
            </div>
            <span class="vault-chip shrink-0" style=${tone(color)}
              >${translateText("vault.cards", {
                count: pack.slots.length,
              })}</span
            >
          </div>
          ${this.renderPity(pack, state?.pity[pack.name], state !== null)}
          <div class="mt-auto flex flex-col gap-2">
            <button
              type="button"
              data-vault-open=${pack.name}
              class="vault-btn vault-open vault-shine ui-focus"
              style=${tone(color)}
              ?disabled=${disabled}
              @click=${() =>
                this.dispatchEvent(
                  new CustomEvent("vault-open-pack", {
                    detail: pack.name,
                    bubbles: true,
                  }),
                )}
            >
              <span>${translateText("vault.open_pack")}</span>
              <span class="ui-mono flex items-center gap-1.5 text-[15px]"
                >${vaultIcons.coin(2)}${pack.priceSoft.toLocaleString()}</span
              >
            </button>
            ${hint === null
              ? nothing
              : html`<p class="text-xs text-ui-muted" data-vault-hint>
                  ${hint}
                </p>`}
            <button
              type="button"
              data-vault-odds-toggle
              class="vault-link ui-focus self-start rounded"
              aria-expanded=${showing ? "true" : "false"}
              @click=${() => (this.openOdds = showing ? null : pack.name)}
            >
              ${translateText(showing ? "vault.hide_odds" : "vault.show_odds")}
              ${vaultIcons.chevron()}
            </button>
          </div>
        </div>
      </article>
    </div>`;
  }

  /** The bad-luck guarantee: a meter filling towards the pack that is sure to hold a better card. */
  private renderPity(
    pack: Pack,
    pity: { sinceRare: number; sinceEpic: number } | undefined,
    signedIn: boolean,
  ): TemplateResult | typeof nothing {
    const rows: { tier: VaultRarity; after: number; since: number }[] = [];
    if (pack.pity.rareAfter !== undefined) {
      rows.push({
        tier: "rare",
        after: pack.pity.rareAfter,
        since: pity?.sinceRare ?? 0,
      });
    }
    if (pack.pity.epicAfter !== undefined) {
      rows.push({
        tier: "epic",
        after: pack.pity.epicAfter,
        since: pity?.sinceEpic ?? 0,
      });
    }
    if (rows.length === 0) return nothing;
    return html`<div class="flex flex-col gap-2.5" data-vault-pity>
      ${rows.map((row) => {
        const left = Math.max(1, row.after - row.since);
        const color = RARITY_COLOR[row.tier];
        const next = signedIn && left === 1;
        return html`<div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-1.5 text-xs">
            <span style="color:${color}">${vaultIcons.shield(1)}</span>
            <span class="font-bold text-white/85"
              >${!signedIn
                ? translateText("vault.pity_within", {
                    rarity: rarityName(row.tier),
                    after: row.after,
                  })
                : next
                  ? translateText("vault.pity_next", {
                      rarity: rarityName(row.tier),
                    })
                  : translateText("vault.pity_in", {
                      rarity: rarityName(row.tier),
                      left,
                    })}</span
            >
          </div>
          <div
            class="vault-meter"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax=${row.after}
            aria-valuenow=${signedIn ? row.after - left : 0}
            ?data-full=${next}
            style="--rc:${color};--p:${signedIn
              ? ((row.after - left) / row.after) * 100
              : 0}%"
          >
            <i></i>
          </div>
        </div>`;
      })}
    </div>`;
  }

  /** The chances of each card of the pack, by rarity (shown over the pack, in place of it). */
  private renderOdds(view: VaultView, pack: Pack): TemplateResult {
    return html`<div
      data-vault-odds
      class="flex min-h-full flex-col justify-center gap-3 text-xs"
    >
      <div
        class="text-[10px] font-black uppercase tracking-[0.22em] text-white/50"
      >
        ${translateText("vault.odds_title")}
      </div>
      ${pack.slots.map((slot, i) => {
        const rarities = VAULT_RARITIES.filter((r) => (slot[r] ?? 0) > 0);
        return html`<div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-3">
            <span class="font-bold uppercase tracking-widest text-white/70"
              >${translateText("vault.card_n", { n: i + 1 })}</span
            >
            <span
              class="ui-mono flex flex-wrap justify-end gap-x-2.5 text-[11px]"
            >
              ${rarities.map(
                (r) =>
                  html`<span style="color:${RARITY_COLOR[r]}"
                    >${rarityName(r)} ${slot[r]}%</span
                  >`,
              )}
            </span>
          </div>
          <div class="vault-bar" style="height:6px">
            ${rarities.map(
              (r) =>
                html`<i
                  style="--w:${slot[r]};--c:${RARITY_COLOR[r]}"
                  title="${rarityName(r)} ${slot[r]}%"
                ></i>`,
            )}
          </div>
        </div>`;
      })}
      <p class="border-t border-white/10 pt-2.5 leading-snug text-white/55">
        ${translateText("vault.dupes_pay", {
          common: view.dupeCredits.common,
          legendary: view.dupeCredits.legendary,
        })}
      </p>
    </div>`;
  }
}
