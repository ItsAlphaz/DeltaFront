import { z } from "zod";

/**
 * Zod compiles object schemas into functions with `new Function` when it can,
 * and probes for that ability with `Function("")` once. The production page's
 * Content-Security-Policy deliberately has no 'unsafe-eval' (src/server/
 * SecurityHeaders.ts), so the probe fails and zod falls back to its ordinary
 * parser, but the browser reports the blocked probe as a CSP violation on
 * every page load. Switching the compiler off up front makes the behaviour the
 * same in development and production and keeps the violation log meaningful.
 * Import this module first in the page's entry point.
 */
z.config({ jitless: true });
