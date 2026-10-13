import { ServerEnv } from "./ServerEnv";

const TIMEOUT_MS = 1_500;

/**
 * Whether `tag` belongs to a registered clan, a held tag or the reserved list,
 * asked of the account API on the spot (server key). The privilege refresher's
 * tag list is only polled every few minutes, so a clan created since the last
 * poll would otherwise look like a free "fictional" tag and anyone could wear
 * it until the next poll; a player wearing a tag they do not own is checked
 * here instead.
 *
 * Returns null when the API cannot be asked (timeout, error, refusal): the
 * caller keeps the tag, as the rest of the tag logic does when the API is down.
 */
export async function isClanTagRegistered(
  tag: string,
): Promise<boolean | null> {
  try {
    const response = await fetch(
      `${ServerEnv.jwtIssuer()}/reserved_clan_tags/${encodeURIComponent(tag.toUpperCase())}`,
      {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "x-api-key": ServerEnv.apiKey() },
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { registered?: unknown };
    return typeof body.registered === "boolean" ? body.registered : null;
  } catch {
    return null;
  }
}
