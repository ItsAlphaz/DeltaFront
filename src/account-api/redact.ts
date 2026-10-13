/**
 * Keeps secrets and personal data out of log lines.
 *
 * Callers are careful not to log tokens, codes, keys or addresses, and this is
 * the net underneath: every log record passes through it, so a mistake (an
 * upstream error message that echoes a URL, a thrown pg error carrying the
 * connection string) cannot reach the log.
 *  - values under a sensitive key name are replaced whole;
 *  - strings are scrubbed for things that look like secrets wherever they
 *    appear: JWTs, server API keys, bearer values, database URLs, e-mail
 *    addresses and OAuth/secret query parameters.
 */

export const REDACTED = "[redacted]";

const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|verifier|e-?mail|jwt|private|connection[-_]?string|database[-_]?url|dsn)/i;

const SCRUBBERS: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\bdfk_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, REDACTED],
  [
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    REDACTED,
  ],
  [
    /([?&](?:code|state|token|access_token|refresh_token|id_token|client_secret|code_verifier|secret|key)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
];

export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SCRUBBERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MAX_DEPTH = 6;

/** A redacted deep copy of `value`; `key` is the name it sits under, if any. */
export function redact(value: unknown, key = "", depth = 0): unknown {
  if (key !== "" && SENSITIVE_KEY.test(key)) {
    return value === undefined || value === null ? value : REDACTED;
  }
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, "", depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack === undefined ? undefined : scrubString(value.stack),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = redact(v, k, depth + 1);
  }
  return out;
}
