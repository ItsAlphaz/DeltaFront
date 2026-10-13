import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A missing translation shows the player a raw key ("CLAN_MODAL.CREATE_TAG_LABEL"),
// which no unit test of the component sees. This reads every literal
// `clan_modal.*` key the clan code can show and checks it exists in en.json.

const ROOT = path.resolve(__dirname, "../../..");
const en = JSON.parse(
  fs.readFileSync(path.join(ROOT, "resources/lang/en.json"), "utf8"),
) as { clan_modal: Record<string, string> };

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) sources(rel, out);
    else if (rel.endsWith(".ts")) out.push(rel);
  }
  return out;
}

describe("clan strings", () => {
  const files = [
    "src/client/ClanApi.ts",
    "src/client/ClanModal.ts",
    ...sources("src/client/components/clan"),
  ];
  const used = new Map<string, string>();
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const m of text.matchAll(/["'`]clan_modal\.([a-z0-9_]+)["'`]/g)) {
      used.set(m[1], file);
    }
  }

  it("finds the keys the clan UI uses", () => {
    expect(used.size).toBeGreaterThan(50);
    expect(used.has("create_tag_label")).toBe(true);
  });

  it.each([...used.keys()].sort())("clan_modal.%s is in en.json", (key) => {
    expect(en.clan_modal[key], `${key} (used in ${used.get(key)})`).toBeTypeOf(
      "string",
    );
  });

  it("keeps the clan strings sorted, as the rest of en.json is", () => {
    const keys = Object.keys(en.clan_modal);
    expect(keys).toEqual([...keys].sort());
  });
});
