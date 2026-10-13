/**
 * npm run launch:loadtest -- --base http://localhost:8787 --origin http://localhost:9000 \
 *     [--duration 10] [--concurrency 20]
 *
 * A small load test for the two endpoints every page load and every join
 * touches (plan item 41): POST /auth/refresh (rotates a session: a database
 * write) and GET /users/@me (the game server calls it for every join).
 * Each virtual player makes one guest account, then alternates the two calls
 * as fast as the server answers.
 *
 * Point it at a STAGING copy, never at the live site: it creates guests and
 * will trip the per-address rate limits (429 is counted and reported; raise
 * the limits on the target if you want to measure the server, not the
 * limiter). It sends no credentials of its own and prints no tokens.
 */
export interface Sample {
  route: string;
  status: number;
  ms: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export interface RouteSummary {
  route: string;
  requests: number;
  perSecond: number;
  ok: number;
  limited: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(
  samples: readonly Sample[],
  seconds: number,
): RouteSummary[] {
  const byRoute = new Map<string, Sample[]>();
  for (const s of samples)
    byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s]);
  return [...byRoute].map(([route, list]) => {
    const times = list.map((s) => s.ms).sort((a, b) => a - b);
    return {
      route,
      requests: list.length,
      perSecond: Math.round((list.length / seconds) * 10) / 10,
      ok: list.filter((s) => s.status >= 200 && s.status < 300).length,
      limited: list.filter((s) => s.status === 429).length,
      failed: list.filter((s) => s.status === 0 || s.status >= 500).length,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      p99: percentile(times, 99),
      max: times[times.length - 1] ?? 0,
    };
  });
}

async function timed(
  route: string,
  run: () => Promise<Response>,
): Promise<{ sample: Sample; res: Response | null }> {
  const start = performance.now();
  try {
    const res = await run();
    await res.arrayBuffer();
    return {
      sample: {
        route,
        status: res.status,
        ms: Math.round(performance.now() - start),
      },
      res,
    };
  } catch {
    return {
      sample: { route, status: 0, ms: Math.round(performance.now() - start) },
      res: null,
    };
  }
}

export async function runLoadTest(options: {
  base: string;
  origin: string;
  seconds: number;
  concurrency: number;
}): Promise<{ summaries: RouteSummary[]; players: number }> {
  const samples: Sample[] = [];
  const stopAt = Date.now() + options.seconds * 1000;
  let players = 0;
  async function player(): Promise<void> {
    let cookie = "";
    let jwt = "";
    const refresh = async (): Promise<void> => {
      const { sample, res } = await timed("POST /auth/refresh", () =>
        fetch(`${options.base}/auth/refresh`, {
          method: "POST",
          headers: {
            Origin: options.origin,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        }),
      );
      samples.push(sample);
      if (res?.ok) {
        const set = res.headers
          .getSetCookie()
          .find((c) => c.startsWith("df_refresh="));
        if (set) cookie = set.split(";")[0];
        // the body was consumed by timed(); the JWT comes from a second call below
      }
    };
    // The first call makes the guest; read its token from a body we keep.
    const first = await fetch(`${options.base}/auth/refresh`, {
      method: "POST",
      headers: { Origin: options.origin },
    }).catch(() => null);
    if (!first?.ok) return;
    cookie = (
      first.headers.getSetCookie().find((c) => c.startsWith("df_refresh=")) ??
      ""
    ).split(";")[0];
    jwt = ((await first.json()) as { jwt: string }).jwt;
    players++;
    while (Date.now() < stopAt) {
      const me = await timed("GET /users/@me", () =>
        fetch(`${options.base}/users/@me`, {
          headers: { Authorization: `Bearer ${jwt}` },
        }),
      );
      samples.push(me.sample);
      await refresh();
    }
  }
  await Promise.all(Array.from({ length: options.concurrency }, player));
  return { summaries: summarize(samples, options.seconds), players };
}

if (process.argv[1]?.endsWith("loadtest.ts")) {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
  };
  const base = arg("base", "http://localhost:8787");
  const result = await runLoadTest({
    base,
    origin: arg("origin", "http://localhost:9000"),
    seconds: Number(arg("duration", "10")),
    concurrency: Number(arg("concurrency", "20")),
  });
  console.log(`${result.players} virtual players against ${base}`);
  console.table(result.summaries);
}
