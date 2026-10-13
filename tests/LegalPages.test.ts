import {
  LEGAL_PAGE_FILES,
  LEGAL_PLACEHOLDER_MARKER,
  legalPageProblems,
  type LegalPageKind,
} from "@openfront/shared/LegalPages";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLegalPagesFinal,
  checkLegalPages,
} from "../src/server/LegalGate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "resources/public");

const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<p>Paragraph ${i + 1} sets out in plain words how the service handles this subject and what the operator promises.</p>`,
  ).join("\n");

/** A page that passes the gate: what the operator's finished text must look like. */
function finishedPage(kind: LegalPageKind): string {
  const body =
    kind === "privacy"
      ? `<p>We set one cookie that keeps you signed in. You may sign in with Discord or Google. We keep your IP address in a hashed form with each session. Cloudflare Turnstile checks that you are not a bot. You can delete your account at any time, and we retain game records without your name afterwards.</p>`
      : `<p>You may keep one account. We may ban or suspend an account that breaks the rules, and terminate it. Credits are an in-game currency with no cash value. To the extent allowed we have no liability for lost progress. The governing law is that of the operator's country.</p>`;
  return `<!doctype html><html><body><main>
  <!-- DELTAFRONT-LEGAL-REVIEWED: 2026-01-15 by Jane Example -->
  <h1>${kind}</h1>${body}${filler(20)}
  <p>Contact: <a href="mailto:legal@example.com">legal@example.com</a></p>
  </main></body></html>`;
}

describe("the legal-page launch gate", () => {
  it("passes a finished page for each kind", () => {
    for (const kind of ["terms", "privacy"] as const) {
      expect(legalPageProblems(kind, finishedPage(kind))).toEqual([]);
    }
  });

  it("fails the placeholder marker and wording", () => {
    const page = finishedPage("privacy").replace(
      "<main>",
      `<main><!-- ${LEGAL_PLACEHOLDER_MARKER}: replace --><p>This policy has not been published yet.</p>`,
    );
    const problems = legalPageProblems("privacy", page);
    expect(problems.join("\n")).toMatch(/placeholder page/);
    expect(problems.join("\n")).toMatch(/placeholder wording/);
  });

  it("fails without a review marker, with a malformed or future one", () => {
    const good = finishedPage("terms");
    const marker = /<!-- DELTAFRONT-LEGAL-REVIEWED[^>]*-->/;
    expect(legalPageProblems("terms", good.replace(marker, "")).join()).toMatch(
      /no review marker/,
    );
    expect(
      legalPageProblems(
        "terms",
        good.replace(marker, "<!-- DELTAFRONT-LEGAL-REVIEWED: soon by X -->"),
      ).join(),
    ).toMatch(/no review marker/);
    expect(
      legalPageProblems(
        "terms",
        good.replace(
          marker,
          "<!-- DELTAFRONT-LEGAL-REVIEWED: 2999-01-01 by Jane Example -->",
        ),
      ).join(),
    ).toMatch(/invalid or future date/);
  });

  it("fails a page with no contact, or too short, or missing the subjects the product makes unavoidable", () => {
    const good = finishedPage("privacy");
    expect(
      legalPageProblems(
        "privacy",
        good.replace(/<a href="mailto:[^>]*>[^<]*<\/a>/, "us"),
      ).join(),
    ).toMatch(/no way to contact/);
    expect(
      legalPageProblems(
        "privacy",
        finishedPage("privacy").replace(/<p>Paragraph[\s\S]*?<\/p>\s*/g, ""),
      ).join(),
    ).toMatch(/too short/);
    const noDelete = good.replace(/delete your account/g, "leave");
    expect(legalPageProblems("privacy", noDelete).join()).toMatch(
      /does not mention: account deletion/,
    );
    const noCredits = finishedPage("terms").replace(
      /no cash value/g,
      "some worth",
    );
    expect(legalPageProblems("terms", noCredits).join()).toMatch(
      /Credits having no cash value/,
    );
  });

  it("once email sign-in is on, the privacy policy must also cover the address, the links and the delivery provider", () => {
    const page = finishedPage("privacy");
    expect(
      legalPageProblems("privacy", page, new Date(), { emailAuth: false }),
    ).toEqual([]);
    const missing = legalPageProblems("privacy", page, new Date(), {
      emailAuth: true,
    }).join("\n");
    expect(missing).toMatch(
      /does not mention: .*the e-mail address used for sign-in links, e-mailed sign-in links, the e-mail delivery provider/,
    );
    const covered = page.replace(
      "<h1>privacy</h1>",
      "<h1>privacy</h1><p>If you sign in by email we keep your e-mail address, and e-mail you sign-in links through our mail delivery provider.</p>",
    );
    expect(
      legalPageProblems("privacy", covered, new Date(), { emailAuth: true }),
    ).toEqual([]);
    // the terms page is unaffected
    expect(
      legalPageProblems("terms", finishedPage("terms"), new Date(), {
        emailAuth: true,
      }),
    ).toEqual([]);
  });

  it("the pages shipped in this repository are either detected placeholders or pass the gate", () => {
    for (const [kind, file] of Object.entries(LEGAL_PAGE_FILES)) {
      const html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
      const problems = legalPageProblems(kind as LegalPageKind, html);
      if (html.includes(LEGAL_PLACEHOLDER_MARKER)) {
        expect(problems.join(), file).toMatch(/placeholder page/);
      } else {
        expect(problems, file).toEqual([]);
      }
    }
  });
});

describe("the game server's boot gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  function staticDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df-legal-"));
    dirs.push(dir);
    for (const [name, html] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), html);
    }
    return dir;
  }
  const placeholders = () =>
    staticDir(
      Object.fromEntries(
        Object.values(LEGAL_PAGE_FILES).map((f) => [
          f,
          `<p>${LEGAL_PLACEHOLDER_MARKER} not published yet</p>`,
        ]),
      ),
    );
  const final = () =>
    staticDir({
      "terms-of-service.html": finishedPage("terms"),
      "privacy-policy.html": finishedPage("privacy"),
    });

  it("refuses to start prod with placeholder pages, naming the files", () => {
    const warn: string[] = [];
    expect(() =>
      assertLegalPagesFinal({
        staticDir: placeholders(),
        env: "prod",
        allowPlaceholders: false,
        warn: (m) => warn.push(m),
      }),
    ).toThrow(/terms-of-service\.html.*privacy-policy\.html/s);
  });

  it("refuses when a page is missing", () => {
    expect(checkLegalPages(staticDir({}))).toHaveLength(2);
    expect(() =>
      assertLegalPagesFinal({
        staticDir: staticDir({}),
        env: "prod",
        allowPlaceholders: false,
        warn: () => undefined,
      }),
    ).toThrow(/is missing/);
  });

  it("only warns in staging, and when explicitly allowed in prod", () => {
    for (const [env, allow] of [
      ["staging", false],
      ["prod", true],
    ] as const) {
      const warn: string[] = [];
      assertLegalPagesFinal({
        staticDir: placeholders(),
        env,
        allowPlaceholders: allow,
        warn: (m) => warn.push(m),
      });
      expect(warn, env).toHaveLength(1);
      expect(warn[0]).toMatch(/not final/);
    }
  });

  it("is silent for final pages, and never runs in dev", () => {
    const warn: string[] = [];
    assertLegalPagesFinal({
      staticDir: final(),
      env: "prod",
      allowPlaceholders: false,
      warn: (m) => warn.push(m),
    });
    assertLegalPagesFinal({
      staticDir: placeholders(),
      env: "dev",
      allowPlaceholders: false,
      warn: (m) => warn.push(m),
    });
    expect(warn).toEqual([]);
  });
});
