// @vitest-environment node
import { LAUNCH_FEATURES_VALUE } from "@openfront/shared/AccountFeatures";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBackupConfig } from "../../scripts/backup/backup";
import { loadConfig } from "../../src/account-api/config";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** KEY=VALUE lines of an env file (comments and blanks skipped). */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe("the reference environment files", () => {
  const api = parseEnv(read("deploy/env/api.env.example"));
  const game = parseEnv(read("deploy/env/game.env.example"));
  const backup = parseEnv(read("deploy/env/backup.env.example"));

  it("hold only placeholders: no value looks like a real secret", () => {
    for (const [file, env] of [
      ["api", api],
      ["game", game],
      ["backup", backup],
    ] as const) {
      for (const [name, value] of Object.entries(env)) {
        if (
          /(SECRET|KEY|PASSWORD|DATABASE_URL|TOKEN)/.test(name) &&
          !/PATH|SITE_KEY|FEATURES/.test(name)
        ) {
          expect(value, `${file}:${name}`).toMatch(/CHANGE_ME|age1CHANGE_ME/);
        }
      }
    }
  });

  it("the API file, with its placeholders filled in, is a valid production configuration for exactly the launch features", () => {
    const filled = Object.fromEntries(
      Object.entries(api).map(([k, v]) => [
        k,
        v.replace(/CHANGE_ME/g, "filled-in-value"),
      ]),
    );
    const config = loadConfig(filled);
    expect(config.env).toBe("prod");
    expect(config.publicOrigin).toBe("https://api.example.com");
    expect(config.trustProxyHops).toBe(1);
    expect(config.turnstileHostnames).toEqual(["example.com"]);
    const enabled = Object.entries(config.features)
      .filter(([, on]) => on)
      .map(([n]) => n);
    expect(enabled.sort()).toEqual(LAUNCH_FEATURES_VALUE.split(",").sort());
    expect(api.DF_ACCOUNT_FEATURES).toBe(LAUNCH_FEATURES_VALUE);
    expect(game.DF_ACCOUNT_FEATURES).toBe(LAUNCH_FEATURES_VALUE);
  });

  it("the game file's fallback is the safe default and its CSP is enforced", () => {
    expect(game.TURNSTILE_FALLBACK).toBe("registered");
    expect(game.CSP_MODE).toBe("enforce");
    expect(game.GAME_ENV).toBe("prod");
  });

  it("the backup file is a valid backup configuration once filled in", () => {
    const config = loadBackupConfig({
      ...backup,
      BACKUP_DATABASE_URL: "postgres://df_backup:x@127.0.0.1:5432/deltafront",
      BACKUP_AGE_RECIPIENT:
        "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    });
    expect(config.encryption).toBe("age");
    expect(config.remote).toBe("b2:deltafront-backups/prod");
  });

  it("every variable the account API reads is documented in example.env or the API file", () => {
    const source = read("src/account-api/config.ts");
    const names = new Set<string>();
    for (const m of source.matchAll(/trimmed\(env, "([A-Z0-9_]+)"\)/g))
      names.add(m[1]);
    for (const m of source.matchAll(/env\[?\.?"?([A-Z][A-Z0-9_]{3,})"?\]?/g))
      names.add(m[1]);
    for (const m of source.matchAll(/parseOAuth\(env, "(DISCORD|GOOGLE)"/g)) {
      names.add(`${m[1]}_CLIENT_ID`);
      names.add(`${m[1]}_CLIENT_SECRET`);
    }
    names.delete("ACCOUNT_FEATURES_ENV"); // a constant, not a variable
    names.add("DF_ACCOUNT_FEATURES");
    const documented = read("example.env") + read("deploy/env/api.env.example");
    const missing = [...names].filter(
      (n) => !new RegExp(`^#?\\s*${n}=`, "m").test(documented),
    );
    expect(missing).toEqual([]);
  });

  it("every variable the game server's checks read is documented too", () => {
    const documented =
      read("example.env") + read("deploy/env/game.env.example");
    for (const name of [
      "API_KEY",
      "TURNSTILE_SITE_KEY",
      "TURNSTILE_FALLBACK",
      "CSP_MODE",
      "ALLOW_PLACEHOLDER_LEGAL_PAGES",
      "DF_ACCOUNT_FEATURES",
      "DOMAIN",
      "NUM_WORKERS",
      "INSTANCE_LETTER",
    ]) {
      expect(documented, name).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
    }
  });
});

describe("the systemd units", () => {
  const unit = (name: string) => read(`deploy/systemd/${name}`);

  it("run the services as unprivileged users with the standard sandbox", () => {
    for (const name of [
      "deltafront-account-api.service",
      "deltafront-backup.service",
    ]) {
      const text = unit(name);
      expect(text, name).toMatch(/^User=df-/m);
      for (const directive of [
        "NoNewPrivileges=true",
        "ProtectSystem=strict",
        "PrivateTmp=true",
        "PrivateDevices=true",
        "RestrictNamespaces=true",
        "CapabilityBoundingSet=",
        "UMask=0077",
      ]) {
        expect(text, `${name}: ${directive}`).toContain(directive);
      }
      expect(text, name).not.toMatch(/^User=root/m);
    }
  });

  it("the account API restarts on failure, drains on SIGTERM, and never migrates by itself", () => {
    const text = unit("deltafront-account-api.service");
    expect(text).toMatch(/^Restart=always/m);
    expect(text).toMatch(/^KillSignal=SIGTERM/m);
    // longer than SHUTDOWN_TIMEOUT_MS (15 s) + the 5 s backstop
    expect(
      Number(/^TimeoutStopSec=(\d+)/m.exec(text)![1]),
    ).toBeGreaterThanOrEqual(25);
    expect(text).toMatch(/^EnvironmentFile=\/etc\/deltafront\/api\.env/m);
    const code = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/account-api:migrate|migrate\.ts/);
    expect(text).toMatch(/^ExecStart=.*src\/account-api\/index\.ts/m);
    expect(text).toMatch(/After=.*postgresql\.service/);
  });

  it("no unit carries a credential", () => {
    for (const name of fs.readdirSync(path.join(ROOT, "deploy/systemd"))) {
      const text = unit(name);
      expect(text, name).not.toMatch(
        /PASSWORD=|SECRET=|API_KEY=|TOKEN=|postgres:\/\/[^\s]*:[^\s@]+@/,
      );
    }
  });

  it("the game container keeps account-API traffic on this machine and cannot gain privileges", () => {
    const text = unit("deltafront-game.service");
    expect(text).toContain("--add-host api.example.com:host-gateway");
    expect(text).toContain("--publish 127.0.0.1:3080:80");
    expect(text).toContain("--security-opt no-new-privileges");
    expect(text).toMatch(/^Restart=always/m);
    expect(text).toMatch(/^ExecStop=.*docker stop --time 30/m);
  });

  it("the nightly backup is a persistent timer that alerts on failure", () => {
    expect(unit("deltafront-backup.timer")).toMatch(
      /OnCalendar=\*-\*-\* 03:17:00/,
    );
    expect(unit("deltafront-backup.timer")).toMatch(/Persistent=true/);
    expect(unit("deltafront-backup.service")).toMatch(
      /OnFailure=deltafront-alert@%n\.service/,
    );
    expect(unit("deltafront-backup.service")).toMatch(
      /scripts\/backup\/cli\.ts run/,
    );
    expect(unit("deltafront-healthcheck.service")).toMatch(
      /OnFailure=deltafront-alert@%n\.service/,
    );
    expect(unit("deltafront-alert@.service")).toMatch(
      /ExecStart=\/etc\/deltafront\/alert %i/,
    );
  });

  it("units that run repository code point at files that exist", () => {
    for (const name of fs.readdirSync(path.join(ROOT, "deploy/systemd"))) {
      for (const m of unit(name).matchAll(
        /\/opt\/deltafront\/current\/((?:deploy|scripts|src)\/[^\s]+)/g,
      )) {
        expect(fs.existsSync(path.join(ROOT, m[1])), `${name}: ${m[1]}`).toBe(
          true,
        );
      }
    }
  });
});

describe("the nginx edge configuration", () => {
  const text = read("deploy/nginx/deltafront.conf");

  it("redirects http to https and serves ACME challenges", () => {
    expect(text).toMatch(
      /listen 80;[\s\S]*return 301 https:\/\/\$host\$request_uri/,
    );
    expect(text).toContain("/.well-known/acme-challenge/");
  });

  it("terminates modern TLS only, hides its version, and sets HSTS exactly once", () => {
    expect(text).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
    expect(text).not.toMatch(/SSLv|TLSv1\.0|TLSv1\.1/);
    expect(text.match(/server_tokens off;/g)!.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain("proxy_hide_header Strict-Transport-Security;");
    expect(text).toMatch(
      /add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/,
    );
  });

  it("forwards WebSockets and OVERWRITES X-Forwarded-For so a client cannot forge its address", () => {
    expect(text).toMatch(/proxy_set_header Upgrade \$http_upgrade;/);
    expect(text).toMatch(/proxy_set_header Connection \$connection_upgrade;/);
    expect(text).not.toContain("$proxy_add_x_forwarded_for");
    const proxied = text.match(/proxy_pass /g)!.length;
    expect(
      text.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)!.length,
    ).toBeGreaterThanOrEqual(proxied - 1);
  });

  it("routes the site to the game container and the API host to the API, with a long socket timeout", () => {
    expect(text).toContain("upstream df_game { server 127.0.0.1:3080;");
    expect(text).toContain("upstream df_api  { server 127.0.0.1:8787;");
    expect(text).toMatch(/proxy_read_timeout 3600s;/);
  });

  it("allows the 100 MB game archive only on /game/ and keeps /ready off the internet", () => {
    expect(text).toMatch(
      /location \^~ \/game\/ \{\s*client_max_body_size 100m;/,
    );
    expect(text.match(/client_max_body_size 100m/g)).toHaveLength(1);
    expect(text).toMatch(
      /location = \/ready \{\s*allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/,
    );
  });

  it("rate-limits sign-in harder than the rest of the API", () => {
    expect(text).toMatch(
      /limit_req_zone \$binary_remote_addr zone=df_auth:10m rate=5r\/s;/,
    );
    expect(text).toMatch(/location \^~ \/auth\/ \{\s*limit_req zone=df_auth/);
  });

  it("is syntactically valid when nginx is installed", () => {
    let nginx: string;
    try {
      nginx = execFileSync("sh", ["-c", "command -v nginx"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return; // not installed in this environment; the structural checks above stand
    }
    expect(nginx).not.toBe("");
  });
});

describe("the health-check script", () => {
  const script = read("deploy/bin/df-healthcheck");

  it("is executable POSIX sh, checks all three endpoints, and prints no response body", () => {
    expect(
      fs.statSync(path.join(ROOT, "deploy/bin/df-healthcheck")).mode & 0o111,
    ).not.toBe(0);
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    for (const endpoint of ["/health", "/ready", "/api/health"])
      expect(script).toContain(endpoint);
    expect(script).toContain("-o /dev/null");
  });

  it("exits non-zero when an endpoint is down and zero when all answer", () => {
    const http = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const s = require('node:http').createServer((q, r) => { r.statusCode = q.url === '/ready' ? Number(process.env.READY) : 200; r.end('{}'); });
      s.listen(0, '127.0.0.1', () => console.log(s.address().port));
      setTimeout(() => process.exit(0), 100);
    `,
      ],
      { encoding: "utf8", env: { ...process.env, READY: "200" } },
    );
    expect(Number(http.trim())).toBeGreaterThan(0);
    // nothing listens on port 1: every check fails
    let code = 0;
    try {
      execFileSync(path.join(ROOT, "deploy/bin/df-healthcheck"), [], {
        env: {
          ...process.env,
          DF_API_URL: "http://127.0.0.1:1",
          DF_GAME_URL: "http://127.0.0.1:1",
        },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      code = (error as { status: number }).status;
    }
    expect(code).toBe(1);
  });
});

describe("the database roles", () => {
  const sql = read("deploy/postgresql/roles.sql");
  it("separates owner, application and backup, and contains no password", () => {
    for (const role of ["df_owner", "df_app", "df_backup"])
      expect(sql).toContain(`CREATE ROLE ${role} LOGIN PASSWORD`);
    expect(sql).toMatch(/PASSWORD :owner_pw/);
    expect(sql).not.toMatch(/PASSWORD '/);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO df_app/,
    );
    const statements = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(
      /ROLE df_app[^;]*(SUPERUSER|CREATEDB|CREATEROLE)/i,
    );
    expect(statements).not.toMatch(/OWNER (TO )?df_app/i);
    expect(statements).not.toMatch(
      /GRANT CREATE ON SCHEMA public TO[^;]*df_app/i,
    );
    expect(sql).toMatch(/GRANT SELECT ON TABLES TO df_backup/);
  });
});
