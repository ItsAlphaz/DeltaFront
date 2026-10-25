export const Platform = (() => {
  // Evaluated on every call, never cached: a jsdom environment can be torn
  // down while lit still has a microtask-scheduled render queued, so a flag
  // captured at module load would outlive the globals it describes.
  const isBrowser = () =>
    typeof window !== "undefined" && typeof navigator !== "undefined";

  const normalizePlatform = (platform: string): string => {
    const normalized = platform.toLowerCase();
    if (normalized.includes("windows")) return "Windows";
    if (
      normalized.includes("iphone") ||
      normalized.includes("ipad") ||
      normalized.includes("ipod") ||
      normalized.includes("ios")
    ) {
      return "iOS";
    }
    if (
      normalized.includes("mac") ||
      normalized.includes("macintosh") ||
      normalized.includes("macos")
    ) {
      return "macOS";
    }
    if (normalized.includes("android")) return "Android";
    if (normalized.includes("chrome os")) return "Linux";
    if (normalized.includes("linux")) return "Linux";
    return "Unknown";
  };

  // OS Extraction
  const extractOS = (): string => {
    if (!isBrowser()) return "Unknown";

    const uaData = (navigator as any).userAgentData;
    if (uaData?.platform) {
      return normalizePlatform(uaData.platform);
    }

    const ua = navigator.userAgent;
    if (/windows nt/i.test(ua)) return "Windows";
    if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
    if (
      /mac os x/i.test(ua) &&
      ((navigator.maxTouchPoints ?? 0) > 1 || /ipad/i.test(ua))
    ) {
      return "iOS";
    }
    if (/mac os x/i.test(ua)) return "macOS";
    if (/android/i.test(ua)) return "Android";
    if (/linux/i.test(ua)) return "Linux";
    return "Unknown";
  };

  const currentOS = extractOS();

  // Environment Extraction
  const performElectronCheck = (): boolean => {
    // Renderer process
    if (
      typeof window !== "undefined" &&
      typeof (window as any).process === "object" &&
      (window as any).process.type === "renderer"
    ) {
      return true;
    }

    // Main process
    if (
      typeof process !== "undefined" &&
      typeof process.versions === "object" &&
      !!process.versions.electron
    ) {
      return true;
    }

    // Detect the user agent when the `nodeIntegration` option is set to false
    if (
      isBrowser() &&
      typeof navigator.userAgent === "string" &&
      navigator.userAgent.indexOf("Electron") >= 0
    ) {
      return true;
    }

    return false;
  };

  const isMac = currentOS === "macOS";

  // A touch device may still have a keyboard (a tablet with a cover, a
  // touchscreen laptop). `(pointer: coarse)` cannot tell, so the first key
  // pressed outside a text field says so: on-screen keyboards type into
  // fields, a real one is also used on the page itself.
  const KEYBOARD_FLAG = "__hasKeyboard";
  const isTextEntry = (event: KeyboardEvent): boolean => {
    const target = (event.composedPath?.()[0] ?? event.target) as
      | HTMLElement
      | null
      | undefined;
    if (target === null || target === undefined) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable === true
    );
  };
  if (isBrowser() && typeof window.addEventListener === "function") {
    window.addEventListener(
      "keydown",
      (event) => {
        if (isTextEntry(event)) return;
        (window as unknown as Record<string, unknown>)[KEYBOARD_FLAG] = true;
      },
      true,
    );
  }

  return {
    os: currentOS,
    isMac,
    isWindows: currentOS === "Windows",
    isIOS: currentOS === "iOS",
    isAndroid: currentOS === "Android",
    isLinux: currentOS === "Linux",
    isElectron: performElectronCheck(),

    get isMobileWidth(): boolean {
      return isBrowser() ? window.innerWidth < 768 : false;
    },

    get isTabletWidth(): boolean {
      return isBrowser()
        ? window.innerWidth >= 768 && window.innerWidth < 1024
        : false;
    },

    get isDesktopWidth(): boolean {
      return isBrowser() ? window.innerWidth >= 1024 : false;
    },

    /** Touch devices (phones, tablets) report a coarse primary pointer. */
    get isTouch(): boolean {
      return (
        isBrowser() &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches
      );
    },

    /**
     * Whether a keyboard is in use: always on a device that is not touch, and
     * on a touch device once a key has been pressed outside a text field.
     */
    get hasKeyboard(): boolean {
      if (!this.isTouch) return true;
      return (
        isBrowser() &&
        (window as unknown as Record<string, unknown>)[KEYBOARD_FLAG] === true
      );
    },
  };
})();
