import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type {
  VaultCard,
  VaultItemView,
  VaultView,
} from "@openfront/shared/VaultSchemas";
import { html, nothing, type TemplateResult } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { drawVault, fetchVault, getUserMe, type VaultDrawOutcome } from "./Api";
import { BaseModal } from "./components/BaseModal";
import "./components/CosmeticPreview";
import "./components/NotLoggedInWarning";
import { uiPageHeader, uiStatusChip } from "./components/ui/PageUi";
import {
  broadcastFreshUserMe,
  fetchCosmetics,
  resolveCosmetics,
  type ResolvedCosmetic,
} from "./Cosmetics";
import { showToast, translateText } from "./Utils";
import "./vault/VaultCollection";
import { itemFlare } from "./vault/VaultCollection";
import "./vault/VaultCount";
import { motionAllowed } from "./vault/VaultFx";
import "./vault/VaultPacks";
import { vaultIcons, watchInView } from "./vault/VaultParts";
import "./vault/VaultReveal";
import type { RevealMode, VaultReveal } from "./vault/VaultReveal";
import "./vault/VaultSky";
import type { VaultSky } from "./vault/VaultSky";
import { VAULT_CSS } from "./vault/VaultStyles";
import "./vault/VaultWheel";
import type { VaultWheel } from "./vault/VaultWheel";
import "./vault/VaultWheelOdds";

/** "05:12:33" */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The free spin comes back at the next UTC midnight: a day is how long its bar takes to fill. */
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Vault page: a spin wheel, a free daily spin and packs, all paid for with
 * Credits, which can only be earned by playing (docs/Vault.md). The page only
 * shows and animates: every price, chance and result comes from the server.
 * The wheel, the odds, the packs and the collection are components of their
 * own (src/client/vault/); this holds what they share: the account's state,
 * the draws and the reveal that follows them.
 */
@customElement("vault-modal")
export class VaultModal extends BaseModal {
  protected routerName = "vault";

  @state() private view: VaultView | null = null;
  @state() private loaded = false;
  @state() private busy = false;
  /** The wheel is turning. */
  @state() private spinning = false;
  @state() private reveal: RevealMode | null = null;
  @state() private now = Date.now();
  /** The wheel's segments lit up because the odds are being pointed at. */
  @state() private lit: readonly number[] = [];
  /** The balance shown: held back while a result is still being revealed, so it does not give it away. */
  @state() private shownBalance: number | null = null;

  private cosmetics: Awaited<ReturnType<typeof fetchCosmetics>> = null;
  private me: UserMeResponse | false = false;
  private resolved: ResolvedCosmetic[] = [];
  private ownedFlares: ReadonlySet<string> = new Set();
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private pendingBalance: number | null = null;

  @query("vault-wheel") private wheel?: VaultWheel;
  @query("vault-sky") private sky?: VaultSky;
  @query("vault-reveal") private revealEl?: VaultReveal;

  protected modalConfig() {
    return { ui: true };
  }

  connectedCallback() {
    super.connectedCallback();
    // the page is set in pixels (VAULT_CSS), header and all
    this.classList.add("vault-px");
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

  protected updated() {
    watchInView(this);
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
    this.ownedFlares = new Set(
      this.me === false ? [] : (this.me.player.flares ?? []),
    );
    this.requestUpdate();
  }

  private find = (item: {
    type: VaultItemView["type"];
    name: string;
    colorPalette?: string | undefined;
  }): ResolvedCosmetic | null => {
    // effects are keyed by their effect type first (`effect:nukeTrail:name`),
    // which the Vault's items don't carry: match them by name
    if (item.type === "effect") {
      return (
        this.resolved.find(
          (r) => r.type === "effect" && r.key.endsWith(`:${item.name}`),
        ) ?? null
      );
    }
    const key = itemFlare(item);
    return this.resolved.find((r) => r.key === key) ?? null;
  };

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
    this.lit = [];
    this.spinning = true;
    await this.wheel?.spinTo(result.segment);
    this.spinning = false;
    // a beat on the segment it stopped on, before the overlay takes over
    if (motionAllowed()) await sleep(850);
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

  /** The hero's sky glows where the pointer is. */
  private onHeroMove = (event: PointerEvent) => {
    const sky = this.sky;
    if (sky === undefined) return;
    const rect = sky.getBoundingClientRect();
    sky.setPointer({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  // ---- rendering -------------------------------------------------------------

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: translateText("vault.title"),
      backLabel: translateText("common.back"),
      onBack: () => this.close(),
      status: html`${this.signedIn
          ? uiStatusChip(
              html`<span data-vault-balance class="flex items-center gap-2"
                >${vaultIcons.coin(2)}<vault-count
                  .value=${this.balance}
                ></vault-count
              ></span>`,
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
    return html`<style>
        ${VAULT_CSS}
      </style>
      <div class="mx-auto flex max-w-[1240px] flex-col gap-14 p-4 sm:p-8">
        ${this.renderHero(view)}
        <vault-packs
          .view=${view}
          .busy=${this.busy}
          @vault-open-pack=${(e: CustomEvent<string>) =>
            void this.openPack(e.detail)}
        ></vault-packs>
        <vault-collection
          .view=${view}
          .owned=${this.ownedFlares}
          .resolve=${this.find}
        ></vault-collection>
        <p
          class="flex items-start justify-center gap-2 pb-2 text-center text-xs text-ui-muted"
        >
          ${vaultIcons.shield(2)}
          <span class="max-w-[70ch]"
            >${translateText("vault.credits_only")}</span
          >
        </p>
      </div>
      <vault-reveal
        .mode=${this.reveal}
        .resolve=${(card: VaultCard) => this.find(card)}
        .canAgain=${this.canAffordAgain()}
        @vault-close=${() => void this.closeReveal()}
        @vault-again=${() => void this.againHandler()}
      ></vault-reveal>`;
  }

  /** The stage: the wheel with the sky behind it, and beside it the daily spin, the spin and the odds. */
  private renderHero(view: VaultView): TemplateResult {
    const state = view.state;
    const canPay = state !== null && state.balance >= view.wheel.spinPrice;
    const limitHit =
      state !== null && state.today.spins >= view.limits.paidSpinsPerDay;
    const spinHint =
      state === null
        ? translateText("vault.error_login")
        : limitHit
          ? translateText("vault.error_daily_limit")
          : !canPay
            ? translateText("vault.need_more", {
                amount: (view.wheel.spinPrice - state.balance).toLocaleString(),
              })
            : null;
    return html`<section
      data-vault-wheel-section
      class="vault-hero"
      ?data-spinning=${this.spinning}
      @pointermove=${this.onHeroMove}
      @pointerleave=${() => this.sky?.setPointer(null)}
    >
      <div class="vault-bg" aria-hidden="true">
        <vault-sky ?spinning=${this.spinning}></vault-sky>
        <div class="vault-gridlines"></div>
      </div>
      <div
        class="grid items-center gap-8 p-5 sm:p-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-12 lg:p-10"
      >
        <div class="vault-stage vault-rise" style="--d:.05s">
          <vault-wheel
            class="block w-full"
            .segments=${view.wheel.segments}
            .highlight=${this.lit}
          ></vault-wheel>
        </div>
        <div class="flex min-w-0 flex-col gap-6">
          <div class="vault-rise" style="--d:.12s">
            <div class="vault-eyebrow">
              ${translateText("vault.hero_eyebrow")}
            </div>
            <h2 class="vault-headline mt-2 pb-1">
              ${translateText("vault.hero_title")}
            </h2>
            <p class="ui-body mt-3 max-w-[44ch] text-white/65">
              ${translateText("vault.wheel_blurb")}
            </p>
          </div>
          <div class="vault-rise" style="--d:.22s">
            ${this.renderDaily(view)}
          </div>
          <div class="vault-rise flex flex-col gap-2" style="--d:.32s">
            <button
              type="button"
              data-vault-spin
              class="vault-btn vault-spin vault-shine ui-focus"
              ?disabled=${!canPay || limitHit || this.busy}
              @click=${() => void this.spin("spin")}
            >
              <span class="flex flex-col items-start leading-tight">
                <span class="text-[20px] font-bold uppercase tracking-[0.08em]"
                  >${translateText("vault.spin")}</span
                >
                ${state === null
                  ? nothing
                  : html`<span class="text-xs opacity-80"
                      >${translateText("vault.spins_today", {
                        used: state.today.spins,
                        max: view.limits.paidSpinsPerDay,
                      })}</span
                    >`}
              </span>
              <span class="ui-mono flex items-center gap-2 text-2xl font-bold"
                >${vaultIcons.coin(
                  2,
                )}${view.wheel.spinPrice.toLocaleString()}</span
              >
            </button>
            ${spinHint === null
              ? nothing
              : html`<p class="text-xs text-white/55" data-vault-hint>
                  ${spinHint}
                </p>`}
          </div>
          <div class="vault-rise" style="--d:.42s">
            <vault-wheel-odds
              .segments=${view.wheel.segments}
              .packs=${view.packs}
              @vault-highlight=${(e: CustomEvent<number[]>) =>
                (this.lit = e.detail)}
            ></vault-wheel-odds>
          </div>
        </div>
      </div>
    </section>`;
  }

  /** The free daily spin: a gift and a bar of blocks that fills as the day passes towards the next one, gold and blinking while it is waiting. */
  private renderDaily(view: VaultView): TemplateResult {
    const daily = view.state?.daily;
    const ready = daily?.available === true;
    const msLeft =
      daily === undefined
        ? 0
        : Math.max(0, Date.parse(daily.nextAt) - this.now);
    const progress =
      daily === undefined ? 0 : ready ? 1 : 1 - Math.min(1, msLeft / DAY_MS);
    return html`<button
      type="button"
      data-vault-daily
      class="vault-daily vault-panel ui-focus"
      ?data-ready=${ready && !this.busy}
      ?disabled=${!ready || this.busy}
      @click=${() => void this.spin("daily")}
    >
      <span class="vault-daily-icon"
        ><span class="vault-daily-gift">${vaultIcons.gift(3)}</span></span
      >
      <span class="flex min-w-0 flex-1 flex-col gap-1.5">
        <span class="text-sm font-bold uppercase tracking-[0.2em] text-white/60"
          >${translateText("vault.daily_title")}</span
        >
        <span
          data-vault-daily-state
          class="ui-mono text-2xl font-bold text-white"
          aria-label=${daily === undefined || ready
            ? nothing
            : translateText("vault.daily_next", { time: clock(msLeft) })}
        >
          ${daily === undefined
            ? translateText("vault.sign_in")
            : ready
              ? translateText("vault.daily_free")
              : html`<span class="mr-2 text-sm font-semibold text-white/55"
                    >${translateText("vault.daily_next_label")}</span
                  >${clock(msLeft)}`}
        </span>
        <span
          class="vault-blocks"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow=${Math.round(progress * 100)}
          ?data-full=${ready && !this.busy}
          style="--p:${progress * 100}%;--rc:${ready ? "#fbbf24" : "#8b8b95"}"
          ><i></i
        ></span>
        <span class="flex items-center gap-2 text-xs text-white/45"
          >${vaultIcons.clock(1)}${translateText("vault.daily_resets")}</span
        >
      </span>
      ${ready && !this.busy
        ? html`<span class="vault-claim vault-shine max-[430px]:hidden"
            >${translateText("vault.claim")}</span
          >`
        : nothing}
    </button>`;
  }
}
