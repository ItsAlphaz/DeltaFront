import type { VaultRarity } from "@openfront/shared/VaultSchemas";
import { html } from "lit";
import { BRAND } from "../Branding";
import { RARITY_COLOR, rarityPower } from "./VaultFx";

/**
 * A foil pack: crimped ends, an emblem in a slowly turning ring, the pack's
 * name and a pip for each step of its rarity. It fills the box it is put in
 * (the packs on the page, the sealed pack of the reveal), so a pack looks the
 * same from the shelf to the moment it is torn open. Its CSS is VAULT_CSS's.
 */
export function renderPackArt(pack: { name: string; rarity: VaultRarity }) {
  const pips = rarityPower(pack.rarity) + 1;
  return html`<div
    class="vault-pack-art"
    data-vault-pack-art
    style="--c:${RARITY_COLOR[pack.rarity]}"
  >
    <span class="vault-pack-crimp vault-pack-crimp-top"></span>
    <div class="vault-pack-face">
      <svg
        class="vault-pack-emblem"
        viewBox="-50 -50 100 100"
        aria-hidden="true"
      >
        <circle
          class="vault-pack-orbit"
          r="45"
          fill="none"
          stroke="currentColor"
          stroke-opacity=".45"
          stroke-width="1.4"
          stroke-dasharray="2 5.2"
        />
        <circle
          r="35"
          fill="none"
          stroke="currentColor"
          stroke-opacity=".7"
          stroke-width="1.8"
        />
        <path
          class="vault-pack-star"
          d="M0 -27 L6.5 -6.5 L27 0 L6.5 6.5 L0 27 L-6.5 6.5 L-27 0 L-6.5 -6.5 Z"
          fill="#fff"
        />
      </svg>
      <div class="vault-pack-name">${pack.name}</div>
      <div class="vault-pack-pips" aria-hidden="true">
        ${Array.from({ length: pips }, () => html`<i></i>`)}
      </div>
      <div class="vault-pack-brand">${BRAND.name}</div>
    </div>
    <span class="vault-pack-crimp vault-pack-crimp-bottom"></span>
    <span class="vault-pack-sheen"></span>
  </div>`;
}
