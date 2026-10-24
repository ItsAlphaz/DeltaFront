import {
  CustomSkinSchema,
  type CustomSkin,
  type CustomSkinBody,
} from "@openfront/shared/CustomSkins";
import type { Db } from "./users";

/** The designs an account saved with the "Create Your Own" skin creator. */

interface Row {
  slot: number;
  name: string;
  pattern_data: string;
  primary_color: string;
  secondary_color: string;
}

const toSkin = (row: Row): CustomSkin =>
  CustomSkinSchema.parse({
    slot: row.slot,
    name: row.name,
    patternData: row.pattern_data,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
  });

/** Every saved design, by slot. A row that no longer validates is left out. */
export async function customSkinsOf(
  db: Db,
  userId: string,
): Promise<CustomSkin[]> {
  const { rows } = await db.query<Row>(
    `SELECT slot, name, pattern_data, primary_color, secondary_color
       FROM custom_skins WHERE user_id = $1 ORDER BY slot`,
    [userId],
  );
  const skins: CustomSkin[] = [];
  for (const row of rows) {
    try {
      skins.push(toSkin(row));
    } catch {
      // never hand the game server something it would refuse
    }
  }
  return skins;
}

/** Saves a design into a slot, replacing what was there. */
export async function saveCustomSkin(
  db: Db,
  userId: string,
  slot: number,
  body: CustomSkinBody,
): Promise<void> {
  await db.query(
    `INSERT INTO custom_skins
       (user_id, slot, name, pattern_data, primary_color, secondary_color)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, slot) DO UPDATE SET
       name = EXCLUDED.name,
       pattern_data = EXCLUDED.pattern_data,
       primary_color = EXCLUDED.primary_color,
       secondary_color = EXCLUDED.secondary_color,
       updated_at = now()`,
    [
      userId,
      slot,
      body.name,
      body.patternData,
      body.primaryColor,
      body.secondaryColor,
    ],
  );
}

/** Removes a design. Returns whether there was one. */
export async function deleteCustomSkin(
  db: Db,
  userId: string,
  slot: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM custom_skins WHERE user_id = $1 AND slot = $2",
    [userId, slot],
  );
  return (rowCount ?? 0) > 0;
}
