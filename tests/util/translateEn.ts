import fs from "fs";
import { IntlMessageFormat } from "intl-messageformat";
import path from "path";

/**
 * The client's translateText, answering from the real resources/lang/en.json,
 * for tests that check what a player reads rather than a translation key
 * (translateText echoes the key when no language is loaded).
 */
const EN: Record<string, string> = {};
(function flatten(obj: Record<string, unknown>, prefix = "") {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") EN[prefix + k] = v;
    else flatten(v as Record<string, unknown>, `${prefix}${k}.`);
  }
})(
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../resources/lang/en.json"),
      "utf8",
    ),
  ),
);

export function translateEn(
  key: string,
  params?: Record<string, string | number>,
): string {
  const message = EN[key];
  if (message === undefined) return key;
  return String(new IntlMessageFormat(message, "en").format(params ?? {}));
}

export const hasEnglish = (key: string): boolean => EN[key] !== undefined;
