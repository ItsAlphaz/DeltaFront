import { ACCOUNT_FEATURES } from "@openfront/shared/AccountFeatures";
import { ReactiveController, ReactiveControllerHost } from "lit";
import { fetchVault } from "../Api";
import { APP_VERSION } from "../AppVersion";
import { getCosmeticsHash } from "../Cosmetics";
import { getGamesPlayed } from "../Utils";

const HELP_SEEN_KEY = "helpSeen";
const STORE_SEEN_HASH_KEY = "storeSeenHash";
const NEWS_SEEN_VERSION_KEY = "newsSeenVersion";

function normalizedVersion(): string {
  const trimmed = APP_VERSION.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/**
 * Shared dot state for the nav.
 *
 * One store, not one per component: the dots are prioritised against each
 * other (news > store > help), and the affordances now live in different
 * components — the bell and "?" in <nav-utility-icons>, the store in the nav
 * bars. With per-component state, dismissing the bell left the other
 * components' copy of `hasNewVersion` set, so the store dot stayed suppressed
 * until a reload.
 */
class NavNotificationsStore {
  private hosts = new Set<ReactiveControllerHost>();
  private loaded = false;

  private _helpSeen = false;
  private _hasNewCosmetics = false;
  private _hasNewVersion = false;
  // The Vault: whether the catalog has one (the nav item shows only then) and
  // whether the account's free daily spin is waiting.
  private _vaultExists = false;
  private _vaultDaily = false;
  private _vaultTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(host: ReactiveControllerHost): void {
    this.hosts.add(host);
    this.load();
  }

  unsubscribe(host: ReactiveControllerHost): void {
    this.hosts.delete(host);
  }

  private notify(): void {
    for (const host of this.hosts) host.requestUpdate();
  }

  // Read once per page load; every later subscriber reuses the result.
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    this._helpSeen = localStorage.getItem(HELP_SEEN_KEY) === "true";

    getCosmeticsHash()
      .then((hash: string | null) => {
        const seenHash = localStorage.getItem(STORE_SEEN_HASH_KEY);
        this._hasNewCosmetics = hash !== null && hash !== seenHash;
        this.notify();
      })
      .catch(() => {});

    if (ACCOUNT_FEATURES.store) {
      void this.refreshVault();
      document.addEventListener(
        "userMeResponse",
        () => void this.refreshVault(),
      );
      window.addEventListener("vault-daily-changed", this.onVaultDaily);
    }

    const currentVersion = normalizedVersion();
    const seenVersion = localStorage.getItem(NEWS_SEEN_VERSION_KEY);
    this._hasNewVersion =
      seenVersion !== null && seenVersion !== currentVersion;
    if (seenVersion === null) {
      localStorage.setItem(NEWS_SEEN_VERSION_KEY, currentVersion);
    }
  }

  private onVaultDaily = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ available: boolean; nextAt: string }>
    ).detail;
    this.setVaultDaily(detail.available, detail.nextAt);
  };

  private setVaultDaily(available: boolean, nextAt: string | null): void {
    this._vaultDaily = available;
    if (this._vaultTimer !== null) clearTimeout(this._vaultTimer);
    this._vaultTimer = null;
    // the free spin comes back at the next UTC midnight: look again then
    if (!available && nextAt !== null) {
      const wait = Math.max(1000, Date.parse(nextAt) - Date.now() + 1500);
      this._vaultTimer = setTimeout(
        () => void this.refreshVault(),
        Math.min(wait, 2 ** 31 - 1),
      );
    }
    this.notify();
  }

  private async refreshVault(): Promise<void> {
    try {
      const view = await fetchVault();
      this._vaultExists = view !== null;
      this.setVaultDaily(
        view?.state?.daily.available === true,
        view?.state?.daily.nextAt ?? null,
      );
    } catch {
      // the nav stays as it was
    }
  }

  /** The Vault nav item: shown once the catalog is known to have one. */
  showVault(): boolean {
    return ACCOUNT_FEATURES.store && this._vaultExists;
  }

  /** A dot on it while the free daily spin is waiting. */
  showVaultDot(): boolean {
    return this.showVault() && this._vaultDaily;
  }

  // Only show one dot at a time to prevent
  // overwhelming users. Priority: News > Store > Help.
  showNewsDot(): boolean {
    return this._hasNewVersion;
  }

  showStoreDot(): boolean {
    // The dot sits on the Store nav item; without a store there is nothing to
    // point at, and it must not hide the help dot either.
    return (
      ACCOUNT_FEATURES.store && this._hasNewCosmetics && !this.showNewsDot()
    );
  }

  showHelpDot(): boolean {
    return (
      getGamesPlayed() < 10 &&
      !this._helpSeen &&
      !this.showNewsDot() &&
      !this.showStoreDot()
    );
  }

  onNewsClick = (): void => {
    this._hasNewVersion = false;
    localStorage.setItem(NEWS_SEEN_VERSION_KEY, normalizedVersion());
    this.notify();
  };

  onStoreClick = (): void => {
    this._hasNewCosmetics = false;
    getCosmeticsHash()
      .then((hash: string | null) => {
        if (hash !== null) {
          localStorage.setItem(STORE_SEEN_HASH_KEY, hash);
        }
      })
      .catch(() => {});
    this.notify();
  };

  onHelpClick = (): void => {
    localStorage.setItem(HELP_SEEN_KEY, "true");
    this._helpSeen = true;
    this.notify();
  };

  /** Test seam: drop all state so a fresh load re-reads localStorage. */
  reset(): void {
    this.hosts.clear();
    this.loaded = false;
    this._helpSeen = false;
    this._hasNewCosmetics = false;
    this._hasNewVersion = false;
    this._vaultExists = false;
    this._vaultDaily = false;
    if (this._vaultTimer !== null) clearTimeout(this._vaultTimer);
    this._vaultTimer = null;
  }
}

export const navNotifications = new NavNotificationsStore();

/**
 * Host-facing view of {@link navNotifications}: keeps the component subscribed
 * for its lifetime and forwards the dot queries and click handlers.
 */
export class NavNotificationsController implements ReactiveController {
  private host: ReactiveControllerHost;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    navNotifications.subscribe(this.host);
  }

  hostDisconnected(): void {
    navNotifications.unsubscribe(this.host);
  }

  showNewsDot(): boolean {
    return navNotifications.showNewsDot();
  }

  showStoreDot(): boolean {
    return navNotifications.showStoreDot();
  }

  showHelpDot(): boolean {
    return navNotifications.showHelpDot();
  }

  showVault(): boolean {
    return navNotifications.showVault();
  }

  showVaultDot(): boolean {
    return navNotifications.showVaultDot();
  }

  onNewsClick = (): void => navNotifications.onNewsClick();
  onStoreClick = (): void => navNotifications.onStoreClick();
  onHelpClick = (): void => navNotifications.onHelpClick();
}
