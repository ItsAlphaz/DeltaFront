import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  VAULT_RARITIES,
  rarityRank,
  type VaultCard,
  type VaultItemView,
  type VaultRarity,
  type VaultView,
} from "@openfront/shared/VaultSchemas";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { drawVault, fetchVault, getUserMe, type VaultDrawOutcome } from "./Api";
import { BaseModal } from "./components/BaseModal";
import { cosmeticDisplayName } from "./components/CosmeticPresentation";
import "./components/CosmeticPreview";
import "./components/CreditsIcon";
import "./components/NotLoggedInWarning";
import { uiButton, uiPageHeader, uiStatusChip } from "./components/ui/PageUi";
import {
  broadcastFreshUserMe,
  fetchCosmetics,
  resolveCosmetics,
  type ResolvedCosmetic,
} from "./Cosmetics";
import { showToast, translateText } from "./Utils";
import { RARITY_COLOR, rarityPower } from "./vault/VaultFx";
import "./vault/VaultReveal";
import type { RevealMode, VaultReveal } from "./vault/VaultReveal";
import "./vault/VaultWheel";
import type { VaultWheel } from "./vault/VaultWheel";

const rarityName = (rarity: VaultRarity): string =>
  translateText(`cosmetics.${rarity}`);

/** "05:12:33" */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * The Vault page: a spin wheel, a free daily spin and packs, all paid for with
 * Credits, which can only be earned by playing (docs/Vault.md). The page only
 * shows and animates: every price, chance and result comes from the server.
 */
@customElement("vault-modal")
export class VaultModal extends BaseModal {
  protected routerName = "vault";

  @state() private view: VaultView | null = null;
  @state() private loaded = false;
  @state() private busy = false;
  @state() private reveal: RevealMode | null = null;
  @state() private now = Date.now();
  @state() private openOdds: string | null = null;
  /** The balance shown: held back while a result is still being revealed, so it does not give it away. */
  @state() private shownBalance: number | null = null;

  private cosmetics: Awaited<ReturnType<typeof fetchCosmetics>> = null;
  private me: UserMeResponse | false = false;
  private resolved: ResolvedCosmetic[] = [];
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private pendingBalance: number | null = null;

  @query("vault-wheel") private wheel?: VaultWheel;
  @query("vault-reveal") private revealEl?: VaultReveal;

  protected modalConfig() {
    return { ui: true };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe);
    this.clockTimer = setInterval(() => this.tick(), 1000);
  }

  disconnectedCallback() {
    document.removeEventListener("userMeResponse", this.onUserMe);
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
    super.disconnectedCallback();
  }

  protected onOpen(): void {
    void this.load();
  }

  private onUserMe = (event: Event) => {
    this.me = (event as CustomEvent<UserMeResponse | false>).detail;
    this.rebuild();
  };

  private tick() {
    if (!this.isModalOpen && !this.inline) return;
    this.now = Date.now();
    const daily = this.view?.state?.daily;
    // the free spin is back: ask again, so the button wakes up on its own
    if (
      daily !== undefined &&
      !daily.available &&
      this.now >= Date.parse(daily.nextAt) &&
      !this.busy
    ) {
      void this.load();
    }
  }

  private async load() {
    const [view, cosmetics, me] = await Promise.all([
      fetchVault(),
      fetchCosmetics(),
      getUserMe(),
    ]);
    this.view = view;
    this.cosmetics = cosmetics;
    this.me = me;
    this.shownBalance = view?.state?.balance ?? null;
    if (view?.state) {
      // the nav's dot follows the free spin
      window.dispatchEvent(
        new CustomEvent("vault-daily-changed", {
          detail: {
            available: view.state.daily.available,
            nextAt: view.state.daily.nextAt,
          },
        }),
      );
    }
    this.rebuild();
    this.loaded = true;
  }

  private rebuild() {
    this.resolved = resolveCosmetics(this.cosmetics, this.me, null);
    this.requestUpdate();
  }

  private find = (item: {
    type: VaultItemView["type"];
    name: string;
    colorPalette?: string | undefined;
  }): ResolvedCosmetic | null => {
    const key =
      item.colorPalette === undefined
        ? `${item.type}:${item.name}`
        : `${item.type}:${item.name}:${item.colorPalette}`;
    // effects are keyed by their effect type first (`effect:nukeTrail:name`),
    // which the Vault's items don't carry: match them by name
    if (item.type === "effect") {
      return (
        this.resolved.find(
          (r) => r.type === "effect" && r.key.endsWith(`:${item.name}`),
        ) ?? null
      );
    }
    return this.resolved.find((r) => r.key === key) ?? null;
  };

  private owns(item: VaultItemView): boolean {
    if (this.me === false) return false;
    const flare =
      item.colorPalette === undefined
        ? `${item.type}:${item.name}`
        : `${item.type}:${item.name}:${item.colorPalette}`;
    return (this.me.player.flares ?? []).includes(flare);
  }

  private get balance(): number {
    return this.shownBalance ?? this.view?.state?.balance ?? 0;
  }

  private get signedIn(): boolean {
    return this.view?.state !== null && this.view?.state !== undefined;
  }

  // ---- actions ---------------------------------------------------------------

  private problem(outcome: Extract<VaultDrawOutcome, { ok: false }>) {
    const key =
      {
        insufficient_balance: "vault.error_insufficient",
        daily_used: "vault.error_daily_used",
        daily_limit: "vault.error_daily_limit",
        login_required: "vault.error_login",
        not_found: "vault.error_not_found",
        failed: "vault.error_failed",
      }[outcome.code] ?? "vault.error_failed";
    showToast(translateText(key), "red");
    if (
      outcome.code === "daily_used" ||
      outcome.code === "insufficient_balance"
    ) {
      void this.load();
    }
  }

  private async spin(kind: "spin" | "daily") {
    if (this.busy || this.view === null) return;
    this.busy = true;
    const outcome = await drawVault(kind);
    if (!outcome.ok) {
      this.busy = false;
      this.problem(outcome);
      return;
    }
    if (!("segment" in outcome.result)) {
      this.busy = false;
      return;
    }
    const result = outcome.result;
    this.pendingBalance = outcome.balance;
    // the wheel turns first, then the prize is shown
    await this.updateComplete;
    await this.wheel?.spinTo(result.segment);
    const prize = result.prize;
    if (prize.kind === "credits") {
      this.reveal = {
        kind: "credits",
        amount: result.creditsWon,
        jackpot: prize.amount >= 1000,
      };
    } else if (prize.kind === "item" && result.card !== undefined) {
      this.reveal = {
        kind: "card",
        title: translateText("vault.you_won"),
        card: result.card,
      };
    } else if (result.pack !== undefined) {
      this.reveal = this.packReveal(result.pack.pack, result.pack.cards);
    }
    this.busy = false;
  }

  private packReveal(pack: string, cards: VaultCard[]): RevealMode {
    const info = this.view?.packs.find((p) => p.name === pack);
    return {
      kind: "pack",
      pack,
      name: info?.displayName ?? pack,
      rarity: info?.rarity ?? "common",
      cards,
    };
  }

  private async openPack(name: string) {
    if (this.busy) return;
    this.busy = true;
    const outcome = await drawVault("pack", name);
    this.busy = false;
    if (!outcome.ok) {
      this.problem(outcome);
      return;
    }
    if (!("cards" in outcome.result)) return;
    this.pendingBalance = outcome.balance;
    this.reveal = this.packReveal(name, outcome.result.cards);
  }

  private async closeReveal() {
    this.reveal = null;
    if (this.pendingBalance !== null) this.shownBalance = this.pendingBalance;
    this.pendingBalance = null;
    await broadcastFreshUserMe();
    await this.load();
  }

  private againHandler = async () => {
    const mode = this.reveal;
    this.reveal = null;
    if (mode?.kind === "pack") {
      if (this.pendingBalance !== null) this.shownBalance = this.pendingBalance;
      await this.openPack(mode.pack);
    } else {
      await this.closeReveal();
    }
  };

  private canAffordAgain(): boolean {
    const mode = this.reveal;
    if (mode?.kind !== "pack" || this.view === null) return false;
    const pack = this.view.packs.find((p) => p.name === mode.pack);
    const balance = this.pendingBalance ?? this.balance;
    const state = this.view.state;
    return (
      pack !== undefined &&
      pack.inSeason &&
      balance >= pack.priceSoft &&
      state !== null &&
      state.today.packs + 1 < this.view.limits.packsPerDay
    );
  }

  // ---- rendering -------------------------------------------------------------

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: translateText("vault.title"),
      backLabel: translateText("common.back"),
      onBack: () => this.close(),
      status: html`${this.signedIn
          ? uiStatusChip(
              html`<span data-vault-balance class="flex items-center gap-2"
                ><credits-icon .size=${18}></credits-icon
                >${this.balance.toLocaleString()}</span
              >`,
            )
          : ""}<not-logged-in-warning></not-logged-in-warning>`,
    });
  }

  protected renderBody(): TemplateResult {
    if (!this.loaded) {
      return html`<div class="p-10 text-center text-ui-muted">
        ${translateText("vault.loading")}
      </div>`;
    }
    const view = this.view;
    if (view === null) {
      return html`<div
        data-vault-unavailable
        class="p-10 text-center text-ui-muted"
      >
        ${translateText("vault.unavailable")}
      </div>`;
    }
    return html`<div
        class="mx-auto flex max-w-[1240px] flex-col gap-10 p-4 sm:p-8"
      >
        ${this.renderWheelSection(view)} ${this.renderPacks(view)}
        ${this.renderCollection(view)}
      </div>
      <vault-reveal
        .mode=${this.reveal}
        .resolve=${(card: VaultCard) => this.find(card)}
        .canAgain=${this.canAffordAgain()}
        @vault-close=${() => void this.closeReveal()}
        @vault-again=${() => void this.againHandler()}
      ></vault-reveal>`;
  }

  private renderWheelSection(view: VaultView): TemplateResult {
    const state = view.state;
    const daily = state?.daily;
    const dailyReady = daily?.available === true;
    const msLeft =
      daily === undefined
        ? 0
        : Math.max(0, Date.parse(daily.nextAt) - this.now);
    const canPay = state !== null && state.balance >= view.wheel.spinPrice;
    const limitHit =
      state !== null && state.today.spins >= view.limits.paidSpinsPerDay;
    return html`<section
      data-vault-wheel-section
      class="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start"
    >
      <div class="flex flex-col items-center gap-5">
        <vault-wheel
          class="block w-full"
          .segments=${view.wheel.segments}
        ></vault-wheel>
        <div class="flex w-full max-w-[540px] flex-col gap-3 sm:flex-row">
          <button
            type="button"
            data-vault-daily
            class="ui-focus relative flex-1 overflow-hidden rounded-ui-card px-5 py-4 text-left transition ${dailyReady &&
            !this.busy
              ? "bg-gradient-to-r from-amber-400 to-orange-500 text-black shadow-[0_0_28px_#f59e0b88] hover:brightness-110"
              : "cursor-not-allowed border border-ui-border bg-ui-surface text-ui-muted"}"
            ?disabled=${!dailyReady || this.busy}
            @click=${() => void this.spin("daily")}
          >
            <div class="text-xs font-black uppercase tracking-[0.2em]">
              ${translateText("vault.daily_title")}
            </div>
            <div class="ui-mono mt-1 text-lg font-bold" data-vault-daily-state>
              ${!this.signedIn
                ? translateText("vault.sign_in")
                : dailyReady
                  ? translateText("vault.daily_free")
                  : translateText("vault.daily_next", { time: clock(msLeft) })}
            </div>
          </button>
          <button
            type="button"
            data-vault-spin
            class="ui-focus flex-1 rounded-ui-card bg-ui-accent px-5 py-4 text-left text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            ?disabled=${!canPay || limitHit || this.busy}
            @click=${() => void this.spin("spin")}
          >
            <div class="text-xs font-black uppercase tracking-[0.2em]">
              ${translateText("vault.spin")}
            </div>
            <div class="ui-mono mt-1 flex items-center gap-2 text-lg font-bold">
              <credits-icon .size=${18}></credits-icon
              >${view.wheel.spinPrice.toLocaleString()}
            </div>
          </button>
        </div>
        ${limitHit
          ? html`<p class="text-sm text-ui-muted">
              ${translateText("vault.error_daily_limit")}
            </p>`
          : nothing}
      </div>
      <div class="flex flex-col gap-4">
        <h2 class="ui-title text-ui-text">
          ${translateText("vault.wheel_odds")}
        </h2>
        <p class="ui-body text-ui-muted">
          ${translateText("vault.wheel_blurb")}
        </p>
        <table data-vault-wheel-odds class="w-full text-sm">
          <tbody>
            ${view.wheel.segments.map((s) => {
              const prize = s.prize;
              const color =
                prize.kind === "item"
                  ? RARITY_COLOR[prize.rarity]
                  : prize.kind === "pack"
                    ? "#38bdf8"
                    : "#fbbf24";
              const label =
                prize.kind === "credits"
                  ? translateText("vault.prize_credits", {
                      amount: prize.amount.toLocaleString(),
                    })
                  : prize.kind === "item"
                    ? translateText("vault.prize_item", {
                        rarity: rarityName(prize.rarity),
                      })
                    : translateText("vault.prize_pack", {
                        pack:
                          view.packs.find((p) => p.name === prize.pack)
                            ?.displayName ?? prize.pack,
                      });
              return html`<tr class="border-b border-ui-border/60">
                <td class="py-2 pr-3">
                  <span
                    class="inline-block h-3 w-3 rounded-sm"
                    style="background:${color}"
                  ></span>
                </td>
                <td class="py-2 font-semibold text-ui-text">${label}</td>
                <td class="ui-mono py-2 text-right text-ui-muted">
                  ${s.percent}%
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
        <p class="text-xs text-ui-muted">
          ${translateText("vault.credits_only")}
        </p>
      </div>
    </section>`;
  }

  private renderPacks(view: VaultView): TemplateResult {
    return html`<section data-vault-packs class="flex flex-col gap-4">
      <h2 class="ui-title text-ui-text">${translateText("vault.packs")}</h2>
      <p class="ui-body text-ui-muted">${translateText("vault.packs_blurb")}</p>
      <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        ${view.packs.map((pack) => {
          const color = RARITY_COLOR[pack.rarity];
          const state = view.state;
          const pity = state?.pity[pack.name];
          const canPay = state !== null && state.balance >= pack.priceSoft;
          const limitHit =
            state !== null && state.today.packs >= view.limits.packsPerDay;
          const showing = this.openOdds === pack.name;
          return html`<article
            data-vault-pack=${pack.name}
            class="flex flex-col overflow-hidden rounded-ui-card border bg-ui-surface"
            style="border-color:${color}88; box-shadow: 0 0 24px ${color}22;"
          >
            <div
              class="relative flex h-40 items-center justify-center overflow-hidden"
              style="background: radial-gradient(circle at 50% 40%, ${color}66, #12101f 75%);"
            >
              <div class="text-center">
                <div
                  class="text-5xl text-white"
                  style="filter: drop-shadow(0 0 14px ${color})"
                >
                  ✦
                </div>
                <div
                  class="mt-1 text-[11px] font-black uppercase tracking-[0.25em]"
                  style="color:${color}"
                >
                  ${translateText("vault.cards", { count: pack.slots.length })}
                </div>
              </div>
            </div>
            <div class="flex flex-1 flex-col gap-3 p-4">
              <div>
                <h3 class="text-lg font-bold text-ui-text">
                  ${pack.displayName}
                </h3>
                ${pack.tagline === undefined
                  ? nothing
                  : html`<p class="text-sm text-ui-muted">${pack.tagline}</p>`}
              </div>
              ${pack.pity.rareAfter !== undefined ||
              pack.pity.epicAfter !== undefined
                ? html`<p class="text-xs text-ui-muted" data-vault-pity>
                    ${pack.pity.rareAfter !== undefined
                      ? translateText("vault.pity_rare", {
                          left: Math.max(
                            1,
                            pack.pity.rareAfter - (pity?.sinceRare ?? 0),
                          ),
                        })
                      : translateText("vault.pity_epic", {
                          left: Math.max(
                            1,
                            (pack.pity.epicAfter ?? 0) - (pity?.sinceEpic ?? 0),
                          ),
                        })}
                  </p>`
                : nothing}
              <div class="mt-auto flex items-center gap-2">
                ${uiButton({
                  label: translateText("vault.open_pack"),
                  variant: "primary",
                  disabled: !pack.inSeason || !canPay || limitHit || this.busy,
                  onClick: () => void this.openPack(pack.name),
                  name: `open-${pack.name}`,
                })}
                <span
                  class="ui-mono ml-auto flex items-center gap-1.5 text-base font-bold text-ui-text"
                  ><credits-icon .size=${16}></credits-icon
                  >${pack.priceSoft.toLocaleString()}</span
                >
              </div>
              <button
                type="button"
                data-vault-odds-toggle
                class="ui-focus self-start text-xs font-bold uppercase tracking-widest text-ui-muted hover:text-ui-text"
                @click=${() => (this.openOdds = showing ? null : pack.name)}
              >
                ${translateText(
                  showing ? "vault.hide_odds" : "vault.show_odds",
                )}
              </button>
              ${showing ? this.renderOdds(view, pack) : nothing}
            </div>
          </article>`;
        })}
      </div>
    </section>`;
  }

  private renderOdds(
    view: VaultView,
    pack: VaultView["packs"][number],
  ): TemplateResult {
    return html`<div
      data-vault-odds
      class="flex flex-col gap-3 rounded-lg bg-black/20 p-3 text-xs"
    >
      ${pack.slots.map(
        (slot, i) =>
          html`<div>
            <div class="mb-1 font-bold uppercase tracking-widest text-ui-muted">
              ${translateText("vault.card_n", { n: i + 1 })}
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              ${VAULT_RARITIES.filter((r) => (slot[r] ?? 0) > 0).map(
                (r) =>
                  html`<span class="ui-mono" style="color:${RARITY_COLOR[r]}"
                    >${rarityName(r)} ${slot[r]}%</span
                  >`,
              )}
            </div>
          </div>`,
      )}
      <div class="border-t border-ui-border pt-2 text-ui-muted">
        ${translateText("vault.dupes_pay", {
          common: view.dupeCredits.common,
          legendary: view.dupeCredits.legendary,
        })}
      </div>
    </div>`;
  }

  private renderCollection(view: VaultView): TemplateResult {
    const seen = new Set<string>();
    const items = [
      ...view.wheel.items,
      ...view.packs.flatMap((p) => p.items),
    ].filter((item) => {
      const key = `${item.type}:${item.name}:${item.colorPalette ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      // the cards worth chasing: rare and up. The cheap ones are in the shop.
      return rarityRank(item.rarity) >= rarityRank("rare");
    });
    items.sort(
      (a, b) =>
        rarityRank(b.rarity) - rarityRank(a.rarity) ||
        a.name.localeCompare(b.name),
    );
    const owned = items.filter((i) => this.owns(i)).length;
    return html`<section data-vault-collection class="flex flex-col gap-4">
      <div class="flex items-end justify-between gap-4">
        <div>
          <h2 class="ui-title text-ui-text">
            ${translateText("vault.collection")}
          </h2>
          <p class="ui-body text-ui-muted">
            ${translateText("vault.collection_blurb")}
          </p>
        </div>
        <div
          class="ui-mono text-lg font-bold text-ui-text"
          data-vault-collection-count
        >
          ${owned} / ${items.length}
        </div>
      </div>
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        ${items.map((item) => {
          const resolved = this.find(item);
          const have = this.owns(item);
          const color = RARITY_COLOR[item.rarity];
          return html`<div
            data-vault-item=${item.name}
            data-owned=${have ? "true" : "false"}
            class="relative flex flex-col overflow-hidden rounded-ui-card border bg-ui-surface"
            style="border-color:${color}${have ? "" : "55"}; ${rarityPower(
              item.rarity,
            ) >= 4
              ? `box-shadow: 0 0 18px ${color}33;`
              : ""}"
          >
            <div
              class="relative aspect-[4/3] p-3 ${have
                ? ""
                : "opacity-40 saturate-50"}"
            >
              ${resolved === null
                ? nothing
                : html`<cosmetic-preview
                    .resolved=${resolved}
                  ></cosmetic-preview>`}
            </div>
            <div class="px-3 pb-3 text-center">
              <div class="truncate text-sm font-bold text-ui-text">
                ${resolved === null ? item.name : cosmeticDisplayName(resolved)}
              </div>
              <div
                class="text-[10px] font-black uppercase tracking-[0.18em]"
                style="color:${color}"
              >
                ${rarityName(item.rarity)}${have
                  ? ` · ${translateText("vault.owned")}`
                  : ""}
              </div>
            </div>
          </div>`;
        })}
      </div>
    </section>`;
  }
}
