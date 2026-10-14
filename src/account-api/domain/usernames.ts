import { UsernameSchema } from "@openfront/engine-api/Schemas";
import { profanityMatcher } from "@openfront/shared/Censor";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { ACCOUNT_RULES } from "./constants";

/**
 * Account usernames (docs/DeltaFrontAccountsPlan.md section 8.2): a base the
 * player picks plus a random four-digit discriminator, shown as `base.1234`.
 * Bare names are not offered in V1, so every name carries its suffix.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

export const PutUsernameBody = z.object({
  username: z.string(),
  acceptSuffixed: z.boolean().optional(),
});

export type UsernameVerdict =
  | { ok: true; base: string }
  | {
      ok: false;
      code: "USERNAME_INVALID" | "USERNAME_PROFANE";
      reason: string;
    };

/**
 * Whether `input` is an acceptable base name: 3 to 20 characters, no dots, in
 * the charset the game accepts on the wire (the suffixed name must itself be a
 * valid in-game name), and not profane.
 */
export function checkUsernameBase(input: string): UsernameVerdict {
  const base = input.trim().replace(/\s+/g, " ");
  if (base.length < USERNAME_MIN_LENGTH || base.length > USERNAME_MAX_LENGTH)
    return {
      ok: false,
      code: "USERNAME_INVALID",
      reason: `Usernames are ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters long`,
    };
  if (base.includes("."))
    return {
      ok: false,
      code: "USERNAME_INVALID",
      reason: "Usernames cannot contain dots",
    };
  if (!UsernameSchema.safeParse(`${base}.0000`).success)
    return {
      ok: false,
      code: "USERNAME_INVALID",
      reason: "Usernames can only use letters, digits and common punctuation",
    };
  if (profanityMatcher.hasMatch(base))
    return {
      ok: false,
      code: "USERNAME_PROFANE",
      reason: "That username is not allowed",
    };
  return { ok: true, base };
}

/** A random discriminator, `0000` to `9999`. */
export function randomDiscriminator(): string {
  return String(randomInt(10_000)).padStart(4, "0");
}

/**
 * The pre-rendered name the client shows as is: `base.1234`, the bare `base`
 * for an account holding a bare name (no discriminator), or null when never set.
 */
export function displayUsername(
  base: string | null,
  discriminator: string | null,
): string | null {
  if (base === null) return null;
  return discriminator === null ? base : `${base}.${discriminator}`;
}

/** When a change made at `now` lets the player rename again. */
export function nextChangeAfter(now: Date): Date {
  return new Date(
    now.getTime() + ACCOUNT_RULES.usernameChangeCooldownDays * 86_400_000,
  );
}
