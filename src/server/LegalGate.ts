import {
  LEGAL_PAGE_FILES,
  legalPageProblems,
  type LegalPageKind,
} from "@openfront/shared/LegalPages";
import fs from "node:fs";
import path from "node:path";

/**
 * Keeps the placeholder Terms and Privacy pages from going public unnoticed
 * (packages/shared/src/LegalPages.ts says what a finished page is).
 *
 * At game-server start, outside dev, the pages it is about to serve are
 * checked. Staging only warns (so a rehearsal can run); prod refuses to start
 * until the pages are final, unless ALLOW_PLACEHOLDER_LEGAL_PAGES=1 is set,
 * which is for an explicitly private rehearsal of the production setup and
 * is logged on every start.
 */

export class LegalPagesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalPagesError";
  }
}

export interface LegalFinding {
  file: string;
  problems: string[];
}

export function checkLegalPages(staticDir: string): LegalFinding[] {
  const findings: LegalFinding[] = [];
  for (const kind of Object.keys(LEGAL_PAGE_FILES) as LegalPageKind[]) {
    const file = LEGAL_PAGE_FILES[kind];
    let html: string;
    try {
      html = fs.readFileSync(path.join(staticDir, file), "utf8");
    } catch {
      findings.push({ file, problems: ["is missing"] });
      continue;
    }
    const problems = legalPageProblems(kind, html);
    if (problems.length > 0) findings.push({ file, problems });
  }
  return findings;
}

export function assertLegalPagesFinal(options: {
  staticDir: string;
  env: "dev" | "staging" | "prod";
  allowPlaceholders: boolean;
  warn: (message: string) => void;
}): void {
  if (options.env === "dev") return;
  const findings = checkLegalPages(options.staticDir);
  if (findings.length === 0) return;
  const text = findings
    .map((f) => `${f.file} ${f.problems.join("; ")}`)
    .join(" | ");
  if (options.env === "prod" && !options.allowPlaceholders) {
    throw new LegalPagesError(
      `The Terms of Service / Privacy Policy pages are not final: ${text}. Replace resources/public/*.html with the real text (docs/Deployment.md, "Terms and privacy"), rebuild, or set ALLOW_PLACEHOLDER_LEGAL_PAGES=1 for a private rehearsal.`,
    );
  }
  options.warn(
    `Terms/Privacy pages are not final (${options.env}): ${text}${options.allowPlaceholders ? " [ALLOW_PLACEHOLDER_LEGAL_PAGES is set]" : ""}`,
  );
}
