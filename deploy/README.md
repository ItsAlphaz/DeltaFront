# deploy/

Reference configuration for the single-server deployment described in
[`docs/Deployment.md`](../docs/Deployment.md). Nothing here contains a
credential: every secret is a `CHANGE_ME` placeholder, and
`npm run launch:check` refuses to pass while one is left in the real files.

| Path                    | What it is                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `nginx/deltafront.conf` | the public nginx: TLS, `example.com`, `api.example.com`, WebSockets      |
| `systemd/`              | units: account API, game container, nightly backup, health check, alerts |
| `env/*.example`         | the environment files, with every variable and no secret                 |
| `postgresql/roles.sql`  | three least-privilege database roles                                     |
| `bin/df-healthcheck`    | the one-minute health probe the timer runs                               |

Nothing here is applied automatically, and this repository never deploys.
