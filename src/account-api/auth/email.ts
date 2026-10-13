import type { EmailConfig } from "../config";
import { senderAddress } from "../config";

/**
 * Sending the sign-in email (milestone M8).
 *
 * `Mailer` is the only thing the rest of the API knows about delivery. Three
 * adapters exist:
 *  - `resend` and `postmark`: the two providers the plan names, each one
 *    HTTPS call with an API key (no SDK, no new dependency);
 *  - `dev`: keeps the message in memory so a developer or a test can read the
 *    link back. It is refused by the configuration outside GAME_ENV=dev, and
 *    the only way to read it is the loopback-only route in
 *    routes/devOutbox.ts, which is itself mounted only in dev.
 *
 * Nothing here logs an address, a token or a provider response body: an
 * error carries a status code and nothing else.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly provider: string;
  /** Throws MailDeliveryError when the message was not accepted for delivery. */
  send(message: EmailMessage): Promise<void>;
}

export class MailDeliveryError extends Error {
  constructor(
    message: string,
    /** True for a failure that may pass (rate limit, provider outage). */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** The sign-in email: short, plain, no tracking pixels and no other links. */
export function magicLinkMessage(options: {
  to: string;
  link: string;
  ttlMinutes: number;
  productName?: string;
}): EmailMessage {
  const name = options.productName ?? "DeltaFront";
  const text = [
    `Sign in to ${name}`,
    "",
    `Open this link to sign in. It works once and expires in ${options.ttlMinutes} minutes:`,
    "",
    options.link,
    "",
    `If you did not ask for this email, ignore it: nobody can sign in without opening the link.`,
  ].join("\n");
  const link = escapeHtml(options.link);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#090909;color:#f5f5f5;font-family:Arial,sans-serif;line-height:1.5"><div style="max-width:480px;margin:0 auto;padding:24px;background:#161616;border-top:2px solid #e31b23"><h1 style="margin:0 0 16px;font-size:20px;letter-spacing:.04em;text-transform:uppercase">Sign in to ${escapeHtml(name)}</h1><p>Open the link below to sign in. It works once and expires in ${options.ttlMinutes} minutes.</p><p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#e31b23;color:#fff;text-decoration:none;font-weight:bold">Sign in</a></p><p style="color:#b8b8b8;font-size:13px">Or paste this address into your browser:<br>${link}</p><p style="color:#b8b8b8;font-size:13px">If you did not ask for this email, ignore it: nobody can sign in without opening the link.</p></div></body></html>`;
  return {
    to: options.to,
    subject: `Your ${name} sign-in link`,
    text,
    html,
  };
}

// ------------------------------------------------------------------- dev

export interface DevOutboxEntry {
  to: string;
  subject: string;
  /** The sign-in link, extracted from the text body. */
  link: string | null;
  at: string;
}

export interface DevMailer extends Mailer {
  outbox(to?: string): DevOutboxEntry[];
  clear(): void;
}

const LINK = /https?:\/\/\S+/;

export function createDevMailer(max = 50): DevMailer {
  const entries: DevOutboxEntry[] = [];
  return {
    provider: "dev",
    async send(message) {
      entries.push({
        to: message.to,
        subject: message.subject,
        link: LINK.exec(message.text)?.[0] ?? null,
        at: new Date().toISOString(),
      });
      if (entries.length > max) entries.shift();
    },
    outbox: (to) =>
      entries
        .filter((e) => to === undefined || e.to === to.toLowerCase())
        .map((e) => ({ ...e }))
        .reverse(),
    clear: () => void (entries.length = 0),
  };
}

// ---------------------------------------------------------- HTTP providers

const TIMEOUT_MS = 8_000;

function failure(provider: string, status: number): MailDeliveryError {
  // Status only: a provider's body can echo the recipient.
  return new MailDeliveryError(
    `${provider} answered ${status}`,
    status === 429 || status >= 500,
  );
}

async function post(
  provider: string,
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  try {
    return await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new MailDeliveryError(`${provider} unreachable`, true);
  }
}

export const RESEND_URL = "https://api.resend.com/emails";
export const POSTMARK_URL = "https://api.postmarkapp.com/email";

function createResendMailer(
  from: string,
  apiKey: string,
  fetchFn: typeof fetch,
): Mailer {
  return {
    provider: "resend",
    async send(message) {
      const res = await post(
        "resend",
        fetchFn,
        RESEND_URL,
        { Authorization: `Bearer ${apiKey}` },
        {
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
      );
      if (!res.ok) throw failure("resend", res.status);
    },
  };
}

function createPostmarkMailer(
  from: string,
  apiKey: string,
  fetchFn: typeof fetch,
): Mailer {
  return {
    provider: "postmark",
    async send(message) {
      const res = await post(
        "postmark",
        fetchFn,
        POSTMARK_URL,
        { "X-Postmark-Server-Token": apiKey, Accept: "application/json" },
        {
          From: from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          MessageStream: "outbound",
          TrackOpens: false,
          TrackLinks: "None",
        },
      );
      if (!res.ok) throw failure("postmark", res.status);
      // Postmark answers 200 with a non-zero ErrorCode for a rejected message.
      const body = (await res.json().catch(() => null)) as {
        ErrorCode?: unknown;
      } | null;
      if (
        body !== null &&
        typeof body.ErrorCode === "number" &&
        body.ErrorCode !== 0
      ) {
        throw new MailDeliveryError(
          `postmark rejected the message (code ${body.ErrorCode})`,
          false,
        );
      }
    },
  };
}

/**
 * The mailer the configuration names, or null when email sign-in is off. The
 * configuration has already guaranteed a real provider has a sender and a key.
 */
export function createMailer(
  config: EmailConfig,
  fetchFn: typeof fetch = fetch,
): Mailer | null {
  if (!config.enabled || config.provider === null) return null;
  if (config.provider === "dev") return createDevMailer();
  if (
    config.from === null ||
    config.apiKey === null ||
    senderAddress(config.from) === null
  ) {
    throw new Error("a real email provider needs EMAIL_FROM and EMAIL_API_KEY");
  }
  return config.provider === "resend"
    ? createResendMailer(config.from, config.apiKey, fetchFn)
    : createPostmarkMailer(config.from, config.apiKey, fetchFn);
}
