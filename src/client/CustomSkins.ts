import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  CustomSkinSchema,
  customSkinSlotOf,
  ownsSkinCreator,
  type CustomSkin,
  type CustomSkinBody,
} from "@openfront/shared/CustomSkins";
import { z } from "zod";
import { getApiBase } from "./ApiBase";
import { getAuthHeader } from "./Auth";
import { broadcastFreshUserMe } from "./Cosmetics";
import { UserSettings } from "./UserSettings";

/**
 * The client side of "Create Your Own": the account's saved designs, saving
 * and deleting them, and wearing one.
 */

/** The designs an account has saved, by slot. */
export function customSkinsOf(userMe: UserMeResponse | false): CustomSkin[] {
  return userMe === false ? [] : (userMe.player.customSkins ?? []);
}

/** Whether the account has bought the creator. */
export function canCreateSkins(userMe: UserMeResponse | false): boolean {
  return userMe !== false && ownsSkinCreator(userMe.player.flares);
}

export type SaveSkinResult =
  | { ok: true; customSkins: CustomSkin[] }
  | { ok: false; code: "not_owned" | "login_required" | "invalid" | "failed" };

const ListResponse = z.object({ customSkins: CustomSkinSchema.array() });

async function send(
  slot: number,
  method: "PUT" | "DELETE",
  body?: CustomSkinBody,
): Promise<SaveSkinResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/skins/${slot}`, {
      method,
      headers: {
        Authorization: await getAuthHeader(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 403) {
      const code = (
        (await response.json().catch(() => null)) as {
          code?: string;
        } | null
      )?.code;
      return {
        ok: false,
        code: code === "NOT_OWNED" ? "not_owned" : "login_required",
      };
    }
    if (response.status === 400) return { ok: false, code: "invalid" };
    if (!response.ok) return { ok: false, code: "failed" };
    const parsed = ListResponse.safeParse(await response.json());
    if (!parsed.success) return { ok: false, code: "failed" };
    // The list rides in /users/@me: refresh it so every open screen agrees.
    await broadcastFreshUserMe();
    return { ok: true, customSkins: parsed.data.customSkins };
  } catch (e) {
    console.error("custom skin request failed", e);
    return { ok: false, code: "failed" };
  }
}

export const saveCustomSkin = (slot: number, body: CustomSkinBody) =>
  send(slot, "PUT", body);

/** Deleting a design also stops wearing it. */
export async function deleteCustomSkin(slot: number): Promise<SaveSkinResult> {
  const result = await send(slot, "DELETE");
  const settings = new UserSettings();
  if (result.ok && settings.getSelectedCustomSkinSlot() === slot) {
    settings.setSelectedCustomSkin(undefined);
  }
  return result;
}

/** Wears a saved design (or takes it off, with `undefined`). */
export function wearCustomSkin(slot: number | undefined): void {
  new UserSettings().setSelectedCustomSkin(slot);
}

export { customSkinSlotOf };
