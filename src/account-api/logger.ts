import winston from "winston";
import { redact, scrubString } from "./redact";

export type Logger = Pick<winston.Logger, "error" | "warn" | "info" | "debug">;

/**
 * Runs every record through the redactor (redact.ts) after `errors()` has
 * turned an Error into message and stack, and before it is serialised.
 */
const redactRecord = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === "level" || key === "timestamp" || key === "service") continue;
    info[key] =
      key === "message" || key === "stack"
        ? scrubString(String(info[key]))
        : redact(info[key], key);
  }
  return info;
});

/** JSON lines on stdout, like the game server's logs, without its telemetry wiring. */
export function createLogger(
  level: string,
  transports: winston.transport[] = [new winston.transports.Console()],
): Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      redactRecord(),
      winston.format.json(),
    ),
    defaultMeta: { service: "account-api" },
    transports,
  });
}

/** Swallows everything; for tests that do not care about logs. */
export const silentLogger: Logger = {
  error: () => silentLogger as never,
  warn: () => silentLogger as never,
  info: () => silentLogger as never,
  debug: () => silentLogger as never,
};
