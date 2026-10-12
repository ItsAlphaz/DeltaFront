import winston from "winston";

export type Logger = Pick<winston.Logger, "error" | "warn" | "info" | "debug">;

/** JSON lines on stdout, like the game server's logs, without its telemetry wiring. */
export function createLogger(level: string): Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    defaultMeta: { service: "account-api" },
    transports: [new winston.transports.Console()],
  });
}

/** Swallows everything; for tests that do not care about logs. */
export const silentLogger: Logger = {
  error: () => silentLogger as never,
  warn: () => silentLogger as never,
  info: () => silentLogger as never,
  debug: () => silentLogger as never,
};
