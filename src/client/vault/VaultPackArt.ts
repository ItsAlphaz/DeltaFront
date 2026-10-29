import type { VaultRarity } from "@openfront/shared/VaultSchemas";
import { html } from "lit";
import { BRAND } from "../Branding";
import { RARITY_COLOR, rarityPower } from "./VaultFx";
import { tone } from "./VaultPixel";
import { sprite } from "./VaultSprites";

/**
 * A foil pack in pixel art: crimped ends, an emblem in a ring of pixels that
 * turns a notch at a time, the pack's name and a star for each step of its
 * rarity. It fills the box it is put in (the packs on the page, the sealed
 * pack of the reveal), so a pack looks the same from the shelf to the moment
 * it is torn open. Its CSS is VAULT_CSS's.
 */
export function renderPackArt(pack: { name: string; rarity: VaultRarity }) {
  const pips = rarityPower(pack.rarity) + 1;
  return html`<div class="vault-pack-wrap">
    <div
      class="vault-pack-art"
      data-vault-pack-art
      style=${tone(RARITY_COLOR[pack.rarity])}
    >
      <span class="vault-pack-crimp vault-pack-crimp-top"></span>
      <div class="vault-pack-face">
        <div class="vault-pack-emblem" aria-hidden="true">
          <span class="vault-pack-orbit">
            ${Array.from(
              { length: 12 },
              (_, n) => html`<i style="--n:${n}"></i>`,
            )}
          </span>
          ${sprite("emblem", 3)}
        </div>
        <div class="vault-pack-name">${pack.name}</div>
        <div class="vault-pack-pips" aria-hidden="true">
          ${Array.from({ length: pips }, () => html`<i></i>`)}
        </div>
        <div class="vault-pack-brand">${BRAND.name}</div>
      </div>
      <span class="vault-pack-crimp vault-pack-crimp-bottom"></span>
      <span class="vault-pack-sheen"></span>
    </div>
  </div>`;
}
