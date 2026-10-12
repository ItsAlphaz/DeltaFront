import {
  GameRecordSchema,
  type GameRecord,
} from "@openfront/shared/WireSchemas";

/**
 * A finished game as the game server archives it, shaped like the real thing
 * and checked against the production GameRecordSchema (so the fixture can
 * never drift from the contract).
 */
export function makeGameRecord(
  gameID: string,
  overrides: { persistentIDs?: Array<string | null> } = {},
): GameRecord {
  const ids = overrides.persistentIDs ?? [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const record = {
    version: "v0.0.2",
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    domain: "localhost",
    subdomain: "a",
    info: {
      gameID,
      lobbyCreatedAt: 1_700_000_000_000,
      visibleAt: 1_700_000_000_000,
      lobbyFillTime: 1000,
      start: 1_700_000_001_000,
      end: 1_700_000_601_000,
      duration: 600,
      num_turns: 6000,
      winner: ["player", "cli00001"],
      publicGameType: "ffa",
      reports: [],
      config: {
        gameMap: "Africa",
        difficulty: "Medium",
        donateGold: true,
        donateTroops: true,
        gameType: "Public",
        gameMode: "Free For All",
        gameMapSize: "Normal",
        nations: "default",
        bots: 100,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      },
      players: ids.map((persistentID, i) => ({
        clientID: `cli0000${i + 1}`,
        username: `Player${i + 1}`,
        clanTag: null,
        persistentID,
        stats: { attacks: ["1", "0", "0"] },
      })),
    },
    turns: [{ turnNumber: 0, intents: [] }],
  };
  const parsed = GameRecordSchema.safeParse(record);
  if (!parsed.success)
    throw new Error(
      `fixture is not a valid GameRecord: ${parsed.error.message}`,
    );
  return record as unknown as GameRecord;
}
