// The splash stamp: a Minecraft-style splash line on the main menu, drawn as a
// red rubber-stamp dispatch at the logo's top-right corner. Self-contained so
// it is easy to remove: delete this file and the one `SPLASH-STAMP` line in
// PlayPage.ts. The lines are flavour text in English on purpose (like a splash
// text, they are not translated).
import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { PublicGames } from "@openfront/shared/WireSchemas";
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { lastUserMeResponse } from "../UserMeBroadcast";
import { getMapName } from "../Utils";

const MAX_LINE = 40;
const RARE_ODDS = 50;
const LIVE_SHARE = 0.35;

const STATIC_LINES = [
  "Nobody asked. We came anyway.",
  "Your border is a suggestion.",
  "Troops are cheap. Pride isn't.",
  "Retreat is just fast flanking.",
  "Bring snacks. This takes a while.",
  "Coastline looks tasty today.",
  "Diplomacy expires in 3... 2...",
  "Your capital called. It's scared.",
  "Gold wins wars. So do boats.",
  "Trust no one. Especially allies.",
  "Boats don't sink themselves.",
  "Spawn smart. Die dramatically.",
  "Skill issue not detected. Yet.",
  "Painting the map your colour.",
  "Hold the line. Or don't.",
  "Conquer first. Apologize never.",
  "Bold of you to expand there.",
  "One more game. Famous last words.",
  "The map is small. Think bigger.",
  "Allies are temporary. Land isn't.",
  "Flags are for planting.",
  "Fortune favours the loud.",
  "Outnumbered? Cute.",
  "Zero regrets. Maximum territory.",
  "Your neighbours look soft.",
  "Eat the border. Ask later.",
];

const RARE_LINES = [
  "Legendary dispatch. Frame it.",
  "You found the golden stamp.",
  "1 in 50. Go buy a lottery ticket.",
  "Supreme Commander energy.",
  "Rarest line in the empire.",
  "Today, history remembers you.",
];

const FIREFOX_LINE = "Firefox detected. Godspeed.";

interface Live {
  lobbies: PublicGames | null;
  level: number | null;
}

const live: Live = { lobbies: null, level: null };

function liveLines(): string[] {
  const lines: string[] = [];
  const games = Object.values(live.lobbies?.games ?? {}).flat();
  if (games.length > 0) {
    lines.push(
      games.length === 1
        ? "1 match inbound. Get ready."
        : `${games.length} matches inbound. Get ready.`,
    );
    const fullest = Math.max(...games.map((g) => g.numClients));
    if (fullest > 0) {
      lines.push(
        fullest === 1
          ? "1 soldier is already waiting."
          : `${fullest} soldiers already waiting.`,
      );
    }
    for (const game of games) {
      const map = getMapName(game.gameConfig?.gameMap);
      if (map) lines.push(`Next drop: ${map}`, `${map} is calling.`);
    }
  }
  if (live.level !== null) {
    lines.push(`Level ${live.level}. Not bad, recruit.`);
  }
  return lines.filter((line) => line.length < MAX_LINE);
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** One random dispatch: `rare` is the gold list, 1 time in RARE_ODDS. */
export function rollSplash(): { text: string; rare: boolean } {
  if (Math.random() * RARE_ODDS < 1) {
    return { text: pick(RARE_LINES), rare: true };
  }
  const liveOnes = liveLines();
  if (liveOnes.length > 0 && Math.random() < LIVE_SHARE) {
    return { text: pick(liveOnes), rare: false };
  }
  const pool =
    typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent)
      ? [...STATIC_LINES, FIREFOX_LINE]
      : STATIC_LINES;
  return { text: pick(pool), rare: false };
}

// The ink: noise thresholded to speckled holes, used as the stamp's mask.
const INK_MASK = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' seed='7'/>" +
    "<feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.2 2.45'/></filter>" +
    "<rect width='100%' height='100%' filter='url(#n)'/></svg>",
)}")`;

const STYLE = `
splash-stamp {
  display: none;
}
@media (min-width: 1024px) {
  splash-stamp {
    display: block;
    position: relative;
    z-index: 5;
    order: -1;
    height: 0;
    width: calc(var(--df-logo) * 4.2);
    max-width: 100%;
    pointer-events: none;
  }
}
splash-stamp .splash-stamp {
  --stamp: #e53935;
  position: absolute;
  top: 0;
  right: 0;
  width: max-content;
  max-width: 9.5em;
  padding: 0.18em 0.5em 0.1em;
  border: 3px solid var(--stamp);
  border-radius: 3px;
  color: var(--stamp);
  font-family: var(--font-pixel);
  font-size: clamp(11px, calc(var(--df-logo) * 0.15), 24px);
  line-height: 1.15;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: center;
  white-space: normal;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  transform: translate(22%, -118%) rotate(-12deg);
  -webkit-mask-image: ${INK_MASK};
  mask-image: ${INK_MASK};
  -webkit-mask-size: 160px 160px;
  mask-size: 160px 160px;
}
splash-stamp .splash-stamp[data-rare] {
  --stamp: #f5c542;
}
splash-stamp .splash-stamp:focus-visible {
  outline: 2px solid var(--stamp);
  outline-offset: 3px;
}
`;

const SLAM = [
  { transform: "translate(22%, -118%) rotate(-12deg) scale(3)", opacity: 0 },
  {
    transform: "translate(22%, -118%) rotate(-12deg) scale(0.9)",
    opacity: 1,
    offset: 0.55,
  },
  {
    transform: "translate(24%, -118%) rotate(-12deg) scale(1.06)",
    offset: 0.68,
  },
  {
    transform: "translate(20%, -116%) rotate(-12deg) scale(0.98)",
    offset: 0.8,
  },
  {
    transform: "translate(22.5%, -118%) rotate(-12deg) scale(1.01)",
    offset: 0.9,
  },
  { transform: "translate(22%, -118%) rotate(-12deg) scale(1)", opacity: 1 },
];

@customElement("splash-stamp")
export class SplashStamp extends LitElement {
  @state() private text = "";
  @state() private rare = false;

  createRenderRoot() {
    return this;
  }

  private onLobbies = (e: Event) => {
    live.lobbies =
      (e as CustomEvent<{ payload: PublicGames }>).detail?.payload ?? null;
  };

  private onUserMe = (e: Event) => {
    live.level = levelOf((e as CustomEvent<UserMeResponse | false>).detail);
  };

  connectedCallback() {
    super.connectedCallback();
    if (!document.getElementById("splash-stamp-style")) {
      const style = document.createElement("style");
      style.id = "splash-stamp-style";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    document.addEventListener("public-lobbies-update", this.onLobbies);
    document.addEventListener("userMeResponse", this.onUserMe);
    const last = lastUserMeResponse();
    if (last) live.level = levelOf(last.response);
    this.reroll();
  }

  disconnectedCallback() {
    document.removeEventListener("public-lobbies-update", this.onLobbies);
    document.removeEventListener("userMeResponse", this.onUserMe);
    super.disconnectedCallback();
  }

  private reroll() {
    const { text, rare } = rollSplash();
    this.text = text;
    this.rare = rare;
    void this.updateComplete.then(() => this.slam());
  }

  private slam() {
    const stamp = this.querySelector<HTMLElement>(".splash-stamp");
    if (!stamp || typeof stamp.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    stamp.getAnimations().forEach((a) => a.cancel());
    stamp.animate(SLAM, { duration: 350, easing: "ease-out" });
  }

  render() {
    return html`<div
      class="splash-stamp"
      role="button"
      tabindex="0"
      translate="no"
      ?data-rare=${this.rare}
      @click=${() => this.reroll()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.reroll();
        }
      }}
    >
      ${this.text}
    </div>`;
  }
}

function levelOf(me: UserMeResponse | false): number | null {
  return me ? (me.player?.progress?.level ?? null) : null;
}
