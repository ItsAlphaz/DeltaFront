/**
 * The launch gate for the Terms of Service and Privacy Policy pages
 * (`resources/public/terms-of-service.html`, `privacy-policy.html`, linked
 * from the footer).
 *
 * DeltaFront ships placeholder pages: they say the real text "has not been
 * published yet" and carry the marker below. The real text is a legal
 * document the operator has to write or commission; code cannot supply it. What
 * code can do is refuse to let the placeholders go public unnoticed, so a page
 * only passes when:
 *  - it no longer carries the placeholder marker or placeholder wording;
 *  - someone put their name and a date on it with a review marker
 *    (`<!-- DELTAFRONT-LEGAL-REVIEWED: 2026-11-01 by Jane Doe -->`);
 *  - it gives a way to contact the operator;
 *  - it is long enough to be a policy and mentions the subjects that
 *    DeltaFront's own behaviour makes unavoidable (cookies and sign-in
 *    providers, account deletion, Credits having no cash value, and so on).
 * The subject list is a floor, not legal advice: passing it means the page is
 * not an empty shell, not that it is correct.
 */

export const LEGAL_PLACEHOLDER_MARKER = "DELTAFRONT PLACEHOLDER";

export type LegalPageKind = "terms" | "privacy";

const REVIEWED =
  /<!--\s*DELTAFRONT-LEGAL-REVIEWED:\s*(\d{4}-\d{2}-\d{2})\s+by\s+([^>]{2,80}?)\s*-->/;
const PLACEHOLDER_WORDING =
  /has not been published yet|will describe|coming soon|lorem ipsum|\[(?:your|company|operator)[^\]]*\]/i;
const CONTACT =
  /mailto:|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/[^\s"'<>]*contact/i;

/** Lower-case words that must appear, with the reason each is expected. */
const REQUIRED_TOPICS: Record<LegalPageKind, Array<[RegExp, string]>> = {
  privacy: [
    [/cookie/, "the refresh-session cookie"],
    [/discord/, "Discord sign-in"],
    [/google/, "Google sign-in"],
    [/delet/, "account deletion"],
    [/retain|retention|kept for|stored for/, "how long data is kept"],
    [/cloudflare|turnstile/, "the Cloudflare Turnstile bot check"],
    [/ip address/, "IP addresses"],
  ],
  terms: [
    [/account/, "accounts"],
    [/ban|suspend|terminat/, "bans and termination"],
    [/credits/, "Credits (the in-game currency)"],
    [
      /no cash value|no monetary value|not redeemable|no real.world value/,
      "Credits having no cash value",
    ],
    [/liab/, "limitation of liability"],
    [/governing law|jurisdiction/, "governing law"],
  ],
};

/** What a privacy policy must add once emailed sign-in links exist (milestone M8). */
const EMAIL_TOPICS: Array<[RegExp, string]> = [
  [/e-?mail address/, "the e-mail address used for sign-in links"],
  [/(sign-?in|magic|login) links?/, "e-mailed sign-in links"],
  [
    /(e-?mail|mail) (delivery )?(provider|service|processor)|sent through|delivered by/,
    "the e-mail delivery provider",
  ],
];

const MIN_TEXT_LENGTH = 1500;

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What is wrong with a legal page; empty means it may go public. */
export function legalPageProblems(
  kind: LegalPageKind,
  html: string,
  now: Date = new Date(),
  /** Email sign-in is on (DF_EMAIL_AUTH): the privacy policy must also cover it. */
  options: { emailAuth?: boolean } = {},
): string[] {
  const problems: string[] = [];
  if (html.includes(LEGAL_PLACEHOLDER_MARKER)) {
    problems.push(
      `still carries the "${LEGAL_PLACEHOLDER_MARKER}" marker: it is the placeholder page`,
    );
  }
  const text = visibleText(html);
  if (PLACEHOLDER_WORDING.test(text)) {
    problems.push("still contains placeholder wording");
  }
  const reviewed = REVIEWED.exec(html);
  if (reviewed === null) {
    problems.push(
      "has no review marker (add <!-- DELTAFRONT-LEGAL-REVIEWED: YYYY-MM-DD by <reviewer> --> once the text has been reviewed)",
    );
  } else {
    const date = new Date(`${reviewed[1]}T00:00:00Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.getTime() > now.getTime() + 86_400_000
    ) {
      problems.push("its review marker has an invalid or future date");
    }
  }
  if (!CONTACT.test(html)) {
    problems.push(
      "gives no way to contact the operator (an email address or contact link)",
    );
  }
  if (text.length < MIN_TEXT_LENGTH) {
    problems.push(
      `is too short to be a ${kind === "privacy" ? "privacy policy" : "terms of service"} (${text.length} characters of text, at least ${MIN_TEXT_LENGTH} expected)`,
    );
  }
  const lower = text.toLowerCase();
  const missing = REQUIRED_TOPICS[kind]
    .filter(([pattern]) => !pattern.test(lower))
    .map(([, topic]) => topic);
  if (kind === "privacy" && options.emailAuth === true) {
    for (const [pattern, topic] of EMAIL_TOPICS) {
      if (!pattern.test(lower)) missing.push(topic);
    }
  }
  if (missing.length > 0)
    problems.push(`does not mention: ${missing.join(", ")}`);
  return problems;
}

export const LEGAL_PAGE_FILES: Record<LegalPageKind, string> = {
  terms: "terms-of-service.html",
  privacy: "privacy-policy.html",
};
