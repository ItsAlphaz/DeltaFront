// The name screening lives in @openfront/shared so the account API (which may
// not import src/server) applies the identical matcher, shadow-name pool and
// hash as the game server's local fallback. Re-exported here so existing
// imports keep working.
export * from "@openfront/shared/Censor";
