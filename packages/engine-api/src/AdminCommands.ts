/**
 * The in-game admin commands the engine understands (the `admin_command`
 * intent, executed by AdminCommandExecution).
 *
 * Wire order, so APPEND ONLY: a command's position is its encoding.
 *
 * Who may send which command is not decided here. The engine has no notion of
 * roles; the game server authorizes each command against the sender's
 * permissions (@openfront/shared/Permissions ADMIN_COMMAND_PERMISSION) before
 * it relays the intent, and the engine then applies it on every client.
 */
export const ADMIN_COMMANDS = [
  "give_gold",
  "take_gold",
  "set_gold",
  "give_troops",
  "take_troops",
  "set_troops",
  "eliminate",
  "force_win",
] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

/** Upper bound on one command's amount: large enough for testing, small enough to stay finite. */
export const ADMIN_COMMAND_MAX_AMOUNT = 1_000_000_000_000;
