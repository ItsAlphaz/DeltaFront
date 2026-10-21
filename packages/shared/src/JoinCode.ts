import { customAlphabet } from "nanoid";

// A private lobby's join code: four characters a host can say out loud. It is
// an alias for the lobby's real game id (which stays the permanent archive key
// and the link), valid only while that lobby is alive on its worker.
//
// The first character names the worker that owns the lobby (its index in the
// alphabet), so a client can ask that worker directly and no shared registry
// is needed; the other three are random. No 0/O/1/I/L, so nothing is
// confusable when read aloud or typed from a screen.
export const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const JOIN_CODE_LENGTH = 4;
export const JOIN_CODE_REGEX = /^[2-9A-HJKMNP-Z]{4}$/;

const randomTail = customAlphabet(JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH - 1);

/** What a player typed, as a code: trimmed, upper-cased, without spaces or dashes; null if it is not one. */
export function normalizeJoinCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return JOIN_CODE_REGEX.test(code) ? code : null;
}

/** The worker index a code names. */
export function joinCodeWorker(code: string): number {
  return JOIN_CODE_ALPHABET.indexOf(code[0]);
}

/** A fresh code for a lobby on `workerId`, or null when the worker has no letter (more than 31 workers). */
export function generateJoinCode(workerId: number): string | null {
  const head = JOIN_CODE_ALPHABET[workerId];
  return head === undefined ? null : head + randomTail();
}
