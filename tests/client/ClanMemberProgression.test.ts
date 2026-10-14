import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  showToast: vi.fn(),
}));

import type { ClanMember } from "@openfront/shared/ClanApiSchemas";
import { render } from "lit";
import { renderMemberRow } from "../../src/client/components/clan/ClanShared";

const member = (over: Partial<ClanMember> = {}): ClanMember => ({
  role: "member",
  joinedAt: "2026-01-01T00:00:00.000Z",
  publicId: "abc123",
  username: "ann",
  ...over,
});

function draw(m: ClanMember): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(renderMemberRow(m, null, host), host);
  return host;
}

describe("a clan member row with progression", () => {
  it("shows the member's level badge and the clan XP they contributed", () => {
    const row = draw(
      member({ level: 47, prestige: 2, legend: false, xp: 12_340 }),
    );
    const badge = row.querySelector("level-badge") as HTMLElement & {
      level: number;
      prestige: number;
    };
    expect(badge.level).toBe(47);
    expect(badge.prestige).toBe(2);
    expect(row.querySelector("[data-member-clan-xp]")?.textContent).toContain(
      '"xp":"12,340"',
    );
  });

  it("shows neither while progression is off (the API sends neither)", () => {
    const row = draw(member());
    expect(row.querySelector("level-badge")).toBeNull();
    expect(row.querySelector("[data-member-clan-xp]")).toBeNull();
  });

  it("still shows a member who has contributed nothing yet", () => {
    const row = draw(member({ level: 1, prestige: 0, legend: false, xp: 0 }));
    expect(row.querySelector("[data-member-clan-xp]")?.textContent).toContain(
      '"xp":"0"',
    );
  });
});
