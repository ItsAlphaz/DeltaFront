import {
  AIRPORT_RANGE_TILES,
  AIRPORT_REARM_TICKS,
} from "@openfront/engine-lib/configuration/Config";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import {
  DESKTOP_TUTORIAL_VIDEO_URL,
  textDirection,
  translateText,
  TUTORIAL_VIDEO_URL,
} from "../client/Utils";
import { BaseModal } from "./components/BaseModal";
import "./components/Difficulties";
import { uiButtonClasses, uiPageHeader } from "./components/ui/PageUi";
import { Platform } from "./Platform";
import { TroubleshootingModal } from "./TroubleshootingModal";
import { UserSettings } from "./UserSettings";

@customElement("help-modal")
export class HelpModal extends BaseModal {
  protected routerName = "help";

  @state() private keybinds: Record<string, string> = this.getKeybinds();
  @query("#tutorial-video-iframe") private videoIframe?: HTMLIFrameElement;
  @query("#tutorial-video-player") private videoPlayer?: HTMLVideoElement;

  private getKeybinds(): Record<string, string> {
    return new UserSettings().keybinds(Platform.isMac);
  }

  private getKeyLabel(code: string): string {
    if (!code) return "";

    const specialLabels: Record<string, string> = {
      ShiftLeft: "⇧ Shift",
      ShiftRight: "⇧ Shift",
      ControlLeft: "Ctrl",
      ControlRight: "Ctrl",
      AltLeft: "Alt",
      AltRight: "Alt",
      MetaLeft: "⌘",
      MetaRight: "⌘",
      Space: "Space",
      Escape: "Esc",
      Enter: "↵ Return",
      ArrowUp: "↑",
      ArrowDown: "↓",
      ArrowLeft: "←",
      ArrowRight: "→",
      Period: ">",
      Comma: "<",
    };

    if (specialLabels[code]) return specialLabels[code];
    if (code.startsWith("Key") && code.length === 4) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;

    return code;
  }

  private renderKey(code: string) {
    const label = this.getKeyLabel(code);
    // Key names stay left-to-right even inside RTL locales so the badges
    // (and combos like "Shift + click") never scramble.
    return html`<span
      dir="ltr"
      class="ui-mono mx-0.5 inline-block min-w-[32px] rounded-[6px] border border-ui-border-strong bg-ui-ground px-2 py-1 text-center text-xs font-bold text-ui-text"
      >${label}</span
    >`;
  }

  protected renderHeaderSlot() {
    return uiPageHeader({
      title: translateText("main.help"),
      onBack: () => this.close(),
      backLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    const keybinds = this.keybinds;

    return html`
      <div
        dir=${textDirection()}
        class="prose prose-invert prose-sm max-w-none px-6 py-3
          [&_a]:text-df-red-bright [&_a:hover]:text-df-text transition-colors
          [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:text-white [&_h1]:border-b [&_h1]:border-white/10 [&_h1]:pb-2
          [&_h2]:text-ui-text
          [&_h3]:text-[15px] [&_h3]:font-bold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-ui-text
          [&_ul]:ps-5 [&_ul]:list-disc [&_ul]:space-y-1
          [&_li]:text-gray-300 [&_li]:leading-relaxed
          [&_p]:text-gray-300 [&_p]:mb-3 [&_strong]:text-white [&_strong]:font-bold
          [&_p]:[unicode-bidi:plaintext] [&_li]:[unicode-bidi:plaintext]
          [&_td:nth-child(2)]:[unicode-bidi:plaintext]
          [&_td:nth-child(3)]:[unicode-bidi:plaintext]"
      >
          <!-- In-game tutorial: starts a default solo game with the guide on -->
          <section
            class="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-ui-card border border-ui-border bg-ui-surface px-5 py-4 mb-8"
          >
            <div>
              <h3 class="!mt-0 !mb-1">
                ${translateText("help_modal.in_game_tutorial")}
              </h3>
              <p class="!mb-0 text-sm">
                ${translateText("help_modal.in_game_tutorial_desc")}
              </p>
            </div>
            <button
              class="${uiButtonClasses("primary")} shrink-0"
              @click=${() =>
                document.dispatchEvent(new CustomEvent("start-tutorial"))}
            >
              ${translateText("help_modal.in_game_tutorial_start")}
            </button>
          </section>

          <!-- Video Tutorial Section -->
          ${
            TUTORIAL_VIDEO_URL === ""
              ? null
              : html` <h2
                    class="ui-heading mt-8 mb-3 border-b border-ui-border pb-3 text-ui-text"
                  >
                    ${translateText("help_modal.video_tutorial")}
                  </h2>
                  <section
                    class="rounded-ui-card border border-ui-border bg-ui-surface overflow-hidden mb-8"
                  >
                    <div class="relative w-full h-0 pb-[56.25%]">
                      ${Platform.isElectron
                        ? html`<video
                            id="tutorial-video-player"
                            class="absolute top-0 left-0 w-full h-full"
                            src="${DESKTOP_TUTORIAL_VIDEO_URL}"
                            title="${translateText(
                              "help_modal.video_tutorial_title",
                            )}"
                            controls
                            preload="metadata"
                          ></video>`
                        : html`<iframe
                            id="tutorial-video-iframe"
                            class="absolute top-0 left-0 w-full h-full"
                            src="${this.isModalOpen ? TUTORIAL_VIDEO_URL : ""}"
                            title="${translateText(
                              "help_modal.video_tutorial_title",
                            )}"
                            frameborder="0"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                            allowfullscreen
                          ></iframe>`}
                    </div>
                  </section>`
          }

          <!-- Troubleshooting Section -->
          <h2 class="ui-heading mt-8 mb-3 border-b border-ui-border pb-3 text-ui-text">${translateText("main.troubleshooting")}</h2>
          <section>
            <div class="w-full flex flex-col items-center">
              <p class="mb-6 text-white/70 text-sm">
                ${translateText("help_modal.troubleshooting_desc")}
              </p>
              <button
                id="troubleshooting-button"
                class="${uiButtonClasses("secondary")}"
                data-page="page-troubleshooting"
                @click="${this.openTroubleshooting}"
              >
                ${translateText("main.go_to_troubleshooting")}
              </button>
            </div>
          </section>
          <!-- Hotkeys Section -->
          <h2 class="ui-heading mt-8 mb-3 border-b border-ui-border pb-3 text-ui-text">${translateText("help_modal.hotkeys")}</h2>
          <section
            class="rounded-ui-card border border-ui-border bg-ui-surface overflow-hidden"
          >
            <div class="pt-2 pb-4 px-4 overflow-x-auto">
              <table class="w-full text-sm border-separate border-spacing-y-1">
                <thead>
                  <tr
                    class="text-white/40 text-xs uppercase tracking-wider text-start"
                  >
                    <th class="pb-2 ps-4">
                      ${translateText("help_modal.table_key")}
                    </th>
                    <th class="pb-2">
                      ${translateText("help_modal.table_action")}
                    </th>
                  </tr>
                </thead>
                <tbody class="text-white/80">
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey("Escape")}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_esc")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey("Enter")}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_enter")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.toggleView)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("user_setting.toggle_view_desc")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.coordinateGrid)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_coordinate_grid")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.swapDirection)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.bomb_direction")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="inline-flex items-center gap-2">
                        ${this.renderKey(keybinds.shiftKey)}
                        <span class="text-white/40 font-bold">+</span>
                        <div
                          class="w-5 h-8 border border-white/40 rounded-full relative"
                        >
                          <div
                            class="absolute top-0 left-0 w-1/2 h-1/2 bg-red-500/80 rounded-tl-full"
                          ></div>
                          <div
                            class="w-0.5 h-1.5 bg-white/40 rounded-full absolute top-1.5 left-1/2 -translate-x-1/2"
                          ></div>
                        </div>
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_attack_altclick")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="inline-flex items-center gap-2">
                        ${this.renderKey(keybinds.buildMenuModifier)}
                        <span class="text-white/40 font-bold">+</span>
                        <div
                          class="w-5 h-8 border border-white/40 rounded-full relative"
                        >
                          <div
                            class="absolute top-0 left-0 w-1/2 h-1/2 bg-red-500/80 rounded-tl-full"
                          ></div>
                          <div
                            class="w-0.5 h-1.5 bg-white/40 rounded-full absolute top-1.5 left-1/2 -translate-x-1/2"
                          ></div>
                        </div>
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_build")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="inline-flex items-center gap-2">
                        ${this.renderKey(keybinds.emojiMenuModifier)}
                        <span class="text-white/40 font-bold">+</span>
                        <div
                          class="w-5 h-8 border border-white/40 rounded-full relative"
                        >
                          <div
                            class="absolute top-0 left-0 w-1/2 h-1/2 bg-red-500/80 rounded-tl-full"
                          ></div>
                          <div
                            class="w-0.5 h-1.5 bg-white/40 rounded-full absolute top-1.5 left-1/2 -translate-x-1/2"
                          ></div>
                        </div>
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_emote")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.quickChat)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_quick_chat")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.emojiMenu)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_emote")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.centerCamera)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("user_setting.center_camera_desc")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.pauseGame)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_pause_game")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="flex flex-wrap gap-2">
                        ${this.renderKey(keybinds.gameSpeedDown)}
                        ${this.renderKey(keybinds.gameSpeedUp)}
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_game_speed")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="flex flex-wrap gap-2">
                        ${this.renderKey(keybinds.zoomOut)}
                        ${this.renderKey(keybinds.zoomIn)}
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_zoom")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="flex flex-wrap gap-1 max-w-[200px]">
                        ${this.renderKey(keybinds.moveUp)}
                        ${this.renderKey(keybinds.moveLeft)}
                        ${this.renderKey(keybinds.moveDown)}
                        ${this.renderKey(keybinds.moveRight)}
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_move_camera")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="flex flex-wrap gap-2">
                        ${this.renderKey(keybinds.attackRatioDown)}
                        ${this.renderKey(keybinds.attackRatioUp)}
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_ratio_change")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="inline-flex items-center gap-2">
                        ${this.renderKey(keybinds.shiftKey)}
                        <span class="text-white/40 font-bold">+</span>
                        <div class="flex items-center gap-1">
                          <div
                            class="w-5 h-8 border border-white/40 rounded-full relative"
                          >
                            <div
                              class="w-0.5 h-2 bg-red-400 rounded-full absolute top-1.5 left-1/2 -translate-x-1/2"
                            ></div>
                          </div>
                          <div class="flex flex-col text-[10px] text-white/50">
                            <span>↑</span>
                            <span>↓</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_ratio_change")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="inline-flex items-center gap-2">
                        ${this.renderKey(keybinds.altKey)}
                        <span class="text-white/40 font-bold">+</span>
                        ${this.renderKey(keybinds.resetGfx)}
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_reset_gfx")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div
                        class="w-5 h-8 border border-white/40 rounded-full relative"
                      >
                        <div
                          class="w-0.5 h-2 bg-red-400 rounded-full absolute top-1.5 left-1/2 -translate-x-1/2"
                        ></div>
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_auto_upgrade")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      <div class="inline-flex items-center gap-2">
                        ${this.renderKey(keybinds.boxSelectWarships)}
                        <span class="text-white/40 font-bold">+</span>
                        <span class="text-white/50 text-xs"
                          >${translateText("help_modal.drag")}</span
                        >
                      </div>
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_warship_multiselect")}
                    </td>
                  </tr>
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5">
                      ${this.renderKey(keybinds.selectAllWarships)}
                    </td>
                    <td class="py-3 border-b border-white/5 text-white/70">
                      ${translateText("help_modal.action_warship_selectall")}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- UI Interface Section -->
          <section class="mb-8 mt-8">
            <h2 class="ui-heading mt-8 mb-4 border-b border-ui-border pb-3 text-ui-text">${translateText("help_modal.ui_section")}</h2>

            <div class="grid grid-cols-1 gap-6">
              <!-- Leaderboard -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col md:flex-row gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3 shrink-0">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.ui_leaderboard")}</span
                  >
                  <img
                    src=${assetUrl("images/helpModal/leaderboard2.webp")}
                    alt="Leaderboard"
                    class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                    loading="lazy"
                  />
                </div>
                <div
                  class="flex items-center text-white/70 text-sm leading-relaxed"
                >
                  <p>${translateText("help_modal.ui_leaderboard_desc")}</p>
                </div>
              </div>

              <!-- Control Panel -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col md:flex-row gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3 shrink-0">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.ui_control")}</span
                  >
                  <img
                    src=${assetUrl("images/helpModal/controlPanel.webp")}
                    alt="Control Panel"
                    class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                    loading="lazy"
                  />
                </div>
                <div class="flex flex-col justify-center text-white/70 text-sm">
                  <p class="mb-4 leading-relaxed">
                    ${translateText("help_modal.ui_control_desc")}
                  </p>
                  <ul class="space-y-2 list-disc ps-4 text-white/60">
                    <li>${translateText("help_modal.ui_gold")}</li>
                    <li>${translateText("help_modal.ui_attack_ratio")}</li>
                  </ul>
                </div>
              </div>

              <!-- Events Panel -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col md:flex-row gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3 shrink-0">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.ui_events")}</span
                  >
                  <div class="flex flex-col gap-2">
                    <img
                      src=${assetUrl("images/helpModal/eventsPanel.webp")}
                      alt="Events"
                      class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                      loading="lazy"
                    />
                    <img
                      src=${assetUrl("images/helpModal/eventsPanelAttack.webp")}
                      alt="Events Attack"
                      class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                      loading="lazy"
                    />
                  </div>
                </div>
                <div class="flex flex-col justify-center text-white/70 text-sm">
                  <p class="mb-4 leading-relaxed">
                    ${translateText("help_modal.ui_events_desc")}
                  </p>
                  <ul class="space-y-2 list-disc ps-4 text-white/60">
                    <li>${translateText("help_modal.ui_events_alliance")}</li>
                    <li>${translateText("help_modal.ui_events_attack")}</li>
                    <li>${translateText("help_modal.ui_events_quickchat")}</li>
                  </ul>
                </div>
              </div>

              <!-- Options -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col md:flex-row gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3 shrink-0">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.ui_options")}</span
                  >
                  <img
                    src=${assetUrl("images/helpModal/options2.webp")}
                    alt="Options"
                    class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                    loading="lazy"
                  />
                </div>
                <div class="flex flex-col justify-center text-white/70 text-sm">
                  <p class="mb-4 leading-relaxed">
                    ${translateText("help_modal.ui_options_desc")}
                  </p>
                  <ul class="space-y-2 list-disc ps-4 text-white/60">
                    <li>${translateText("help_modal.option_timer")}</li>
                    <li>${translateText("help_modal.option_speed")}</li>
                    <li>${translateText("help_modal.option_pause")}</li>
                    <li>${translateText("help_modal.option_settings")}</li>
                    <li>${translateText("help_modal.option_exit")}</li>
                  </ul>
                </div>
              </div>

              <!-- Player Overlay -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col md:flex-row gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3 shrink-0">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.ui_playeroverlay")}</span
                  >
                  <img
                    src=${assetUrl("images/helpModal/playerInfoOverlay.webp")}
                    alt="Player Info"
                    class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                    loading="lazy"
                  />
                </div>
                <div
                  class="flex items-center text-white/70 text-sm leading-relaxed"
                >
                  <p>${translateText("help_modal.ui_playeroverlay_desc")}</p>
                </div>
              </div>
            </div>
          </section>

          <!-- Radial Menu Section -->
          <section class="mb-8">
            <h2 class="ui-heading mt-8 mb-4 border-b border-ui-border pb-3 text-ui-text">${translateText("help_modal.radial_title")}</h2>

            <div
              class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col md:flex-row gap-6 hover:bg-white/5 transition-colors"
            >
              <div class="flex flex-col gap-4 shrink-0">
                <img
                  src=${assetUrl("images/helpModal/radialMenu2.webp")}
                  alt="Radial Menu"
                  class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                  loading="lazy"
                />
                <img
                  src=${assetUrl("images/helpModal/radialMenuAlly.webp")}
                  alt="Radial Menu Ally"
                  class="rounded-lg shadow-lg border border-white/20 max-w-[200px]"
                  loading="lazy"
                />
              </div>
              <div class="text-white/70 text-sm">
                <p class="mb-4 leading-relaxed">
                  ${translateText("help_modal.radial_desc")}
                </p>
                <ul class="space-y-3">
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/BuildIconWhite.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span>${translateText("help_modal.radial_build")}</span>
                  </li>
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/InfoIcon.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span>${translateText("help_modal.radial_info")}</span>
                  </li>
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/BoatIconWhite.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span>${translateText("help_modal.radial_boat")}</span>
                  </li>
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/AllianceIconWhite.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span>${translateText("help_modal.info_alliance")}</span>
                  </li>
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/TraitorIconWhite.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span>${translateText("help_modal.ally_betray")}</span>
                  </li>
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/DonateTroopIconWhite.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span
                      >${translateText("help_modal.radial_donate_troops")}</span
                    >
                  </li>
                  <li class="flex items-center gap-3">
                    <img
                      src=${assetUrl("images/DonateGoldIconWhite.svg")}
                      class="w-8 h-8 scale-75 origin-left"
                    />
                    <span
                      >${translateText("help_modal.radial_donate_gold")}</span
                    >
                  </li>
                </ul>
              </div>
            </div>
          </section>

          <!-- Info/Ally Panels Section -->
          <section class="mb-8">
            <h2 class="ui-heading mt-8 mb-4 border-b border-ui-border pb-3 text-ui-text">${translateText("help_modal.info_title")}</h2>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <!-- Enemy Info -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.info_enemy_panel")}</span
                  >
                  <img
                    src=${assetUrl("images/helpModal/infoMenu2.webp")}
                    alt="Enemy Info"
                    class="rounded-lg shadow-lg border border-white/20 max-w-[240px]"
                    loading="lazy"
                  />
                </div>
                <div class="text-white/70 text-sm">
                  <p class="mb-4 leading-relaxed">
                    ${translateText("help_modal.info_enemy_desc")}
                  </p>
                  <ul class="space-y-3">
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/ChatIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span>${translateText("help_modal.info_chat")}</span>
                    </li>
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/TargetIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span>${translateText("help_modal.info_target")}</span>
                    </li>
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/AllianceIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span>${translateText("help_modal.info_alliance")}</span>
                    </li>
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/EmojiIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span>${translateText("help_modal.info_emoji")}</span>
                    </li>
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/StopIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                        loading="lazy"
                      />
                      <span>${translateText("help_modal.info_trade")}</span>
                    </li>
                  </ul>
                </div>
              </div>

              <!-- Ally Info -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-6 flex flex-col gap-6 hover:bg-white/5 transition-colors"
              >
                <div class="flex flex-col items-center gap-3">
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >${translateText("help_modal.info_ally_panel")}</span
                  >
                  <img
                    src=${assetUrl("images/helpModal/infoMenu2Ally.webp")}
                    alt="Ally Info"
                    class="rounded-lg shadow-lg border border-white/20 max-w-[240px]"
                    loading="lazy"
                  />
                </div>
                <div class="text-white/70 text-sm">
                  <p class="mb-4 leading-relaxed">
                    ${translateText("help_modal.info_ally_desc")}
                  </p>
                  <ul class="space-y-3">
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/TraitorIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span>${translateText("help_modal.ally_betray")}</span>
                    </li>
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/DonateTroopIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span>${translateText("help_modal.ally_donate")}</span>
                    </li>
                    <li class="flex items-center gap-3">
                      <img
                        src=${assetUrl("images/DonateGoldIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                      <span
                        >${translateText("help_modal.ally_donate_gold")}</span
                      >
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </section>

          <!-- Build Menu Section -->
          <section class="mb-8">
            <h2 class="ui-heading mt-8 mb-4 border-b border-ui-border pb-3 text-ui-text">${translateText("help_modal.build_menu_title")}</h2>

            <p class="mb-4 text-white/70 text-sm">
              ${translateText("help_modal.build_menu_desc")}
            </p>

            <div class="overflow-hidden rounded-xl border border-white/10">
              <table class="w-full border-collapse">
                <thead class="bg-white/10">
                  <tr>
                    <th
                      class="py-3 ps-4 text-start text-xs font-bold uppercase tracking-wider text-df-text-secondary w-[20%]"
                    >
                      ${translateText("help_modal.build_name")}
                    </th>
                    <th
                      class="py-3 text-start text-xs font-bold uppercase tracking-wider text-df-text-secondary w-[8%]"
                    >
                      ${translateText("help_modal.build_icon")}
                    </th>
                    <th
                      class="py-3 text-start text-xs font-bold uppercase tracking-wider text-df-text-secondary"
                    >
                      ${translateText("help_modal.build_desc")}
                    </th>
                  </tr>
                </thead>
                <tbody class="text-white/80">
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.city")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/CityIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_city_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.defense_post")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/ShieldIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_defense_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.port")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/PortIcon.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_port_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.factory")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/FactoryIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_factory_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.warship")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/BattleshipIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_warship_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.missile_silo")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/MissileSiloIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_silo_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.sam_launcher")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/SamLauncherIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_sam_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.airport")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/AirportIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_airport_desc", {
                        range: AIRPORT_RANGE_TILES,
                        seconds: AIRPORT_REARM_TICKS / 10,
                      })}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.airstrike")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/AirstrikeIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_airstrike_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.atom_bomb")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/NukeIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_atom_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.hydrogen_bomb")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/MushroomCloudIconWhite.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_hydrogen_desc")}
                    </td>
                  </tr>
                  <tr class="bg-white/5 hover:bg-white/10 transition-colors">
                    <td class="py-3 ps-4 border-b border-white/5 font-medium">
                      ${translateText("unit_type.mirv")}
                    </td>
                    <td class="py-3 border-b border-white/5">
                      <img
                        src=${assetUrl("images/MIRVIcon.svg")}
                        class="w-8 h-8 scale-75 origin-left"
                      />
                    </td>
                    <td
                      class="py-3 border-b border-white/5 text-white/60 text-sm"
                    >
                      ${translateText("help_modal.build_mirv_desc")}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Player Icons Section -->
          <section class="mb-4">
            <h2 class="ui-heading mt-8 mb-4 border-b border-ui-border pb-3 text-ui-text">${translateText("help_modal.player_icons")}</h2>

            <p class="mb-6 text-white/70 text-sm">
              ${translateText("help_modal.icon_desc")}
            </p>

            <div class="grid grid-cols-2 md:grid-cols-3 gap-6">
              <!-- Crown -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-4 flex flex-col items-center gap-3 hover:bg-white/5 transition-colors"
              >
                <img
                  src=${assetUrl("images/helpModal/crown.webp")}
                  alt="Rank 1"
                  class="rounded shadow-lg border border-white/10 h-24 w-auto object-contain"
                  loading="lazy"
                />
                <span
                  class="text-xs font-bold uppercase tracking-wider text-white text-center"
                >
                  ${translateText("help_modal.icon_crown")}
                </span>
              </div>

              <!-- Traitor -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-4 flex flex-col items-center gap-3 hover:bg-white/5 transition-colors"
              >
                <img
                  src=${assetUrl("images/helpModal/traitor2.webp")}
                  alt="Traitor"
                  class="rounded shadow-lg border border-white/10 h-24 w-auto object-contain"
                  loading="lazy"
                />
                <span
                  class="text-xs font-bold uppercase tracking-wider text-white text-center"
                >
                  ${translateText("help_modal.icon_traitor")}
                </span>
              </div>

              <!-- Ally -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-4 flex flex-col items-center gap-3 hover:bg-white/5 transition-colors"
              >
                <img
                  src=${assetUrl("images/helpModal/ally2.webp")}
                  alt="Ally"
                  class="rounded shadow-lg border border-white/10 h-24 w-auto object-contain"
                  loading="lazy"
                />
                <span
                  class="text-xs font-bold uppercase tracking-wider text-white text-center"
                >
                  ${translateText("help_modal.icon_ally")}
                </span>
              </div>

              <!-- Embargo -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-4 flex flex-col items-center gap-3 hover:bg-white/5 transition-colors"
              >
                <img
                  src=${assetUrl("images/helpModal/embargo.webp")}
                  alt="Embargo"
                  class="rounded shadow-lg border border-white/10 h-24 w-auto object-contain"
                  loading="lazy"
                />
                <span
                  class="text-xs font-bold uppercase tracking-wider text-white text-center"
                >
                  ${translateText("help_modal.icon_embargo")}
                </span>
              </div>

              <!-- Alliance Request -->
              <div
                class="rounded-ui-card border border-ui-border bg-ui-surface p-4 flex flex-col items-center gap-3 hover:bg-white/5 transition-colors"
              >
                <img
                  src=${assetUrl("images/helpModal/allianceRequest.webp")}
                  alt="Request"
                  class="rounded shadow-lg border border-white/10 h-24 w-auto object-contain"
                  loading="lazy"
                />
                <span
                  class="text-xs font-bold uppercase tracking-wider text-white text-center"
                >
                  ${translateText("help_modal.icon_request")}
                </span>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  openTroubleshooting() {
    const troubleshootingModal = document.querySelector(
      "troubleshooting-modal",
    ) as TroubleshootingModal;
    if (
      !troubleshootingModal ||
      !(troubleshootingModal instanceof TroubleshootingModal)
    ) {
      console.warn("Troubleshooting modal element not found");
      return;
    }
    troubleshootingModal.open();
  }

  protected onOpen(): void {
    this.keybinds = this.getKeybinds();
    // Restore the video src when modal opens
    if (this.videoIframe) {
      this.videoIframe.src = TUTORIAL_VIDEO_URL;
    }
  }

  protected onClose(): void {
    // Clear the iframe src to stop video playback
    if (this.videoIframe) {
      this.videoIframe.src = "";
    }
    // The desktop <video> keeps its src -- the file is local, so unlike the
    // YouTube iframe there is nothing to unload; pausing is enough.
    this.videoPlayer?.pause();
  }
}
