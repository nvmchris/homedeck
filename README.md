# homedeck

A small self-hosted homelab dashboard in the style of Homepage/Dashy.
No build step and no dependencies: one Node.js server and a static page.

**Widgets**

- **Services**: link tiles in groups, each with a live up/down check and latency
- **Containers**: all Docker containers with state and health, with a filter
- **System**: CPU, memory and disk gauges, load, uptime, temperature
- **Weather**: current conditions and a 5-day forecast from [Open-Meteo](https://open-meteo.com) (no API key)
- **Calendar**: upcoming events from one or more ICS feeds (Google, Nextcloud, iCloud, ...)

## Run with Docker

```bash
docker compose up -d --build
```

Open http://localhost:3000. On first start `config/config.json` is created from
`config.example.json`. Edit it; changes show up on the next refresh, no restart needed.

## Run without Docker

Needs Node.js 18.15 or newer.

```bash
node server.js
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `PORT` | Listen port (default `3000`) |
| `CONFIG` | Config path (default `./config/config.json`) |
| `HOMEDECK_TOKEN` | Optional access token. If set, requests need `Authorization: Bearer <token>`, `X-Homedeck-Token`, or the `homedeck_token` cookie; open `/?token=<token>` once in a browser to set the cookie. If unset, a warning is logged and the dashboard is open. |
| `ALLOWED_HOSTS` | Extra `Host` names, comma-separated. Defaults: `localhost`, `alpha.tail2970c8.ts.net`, `homepi.tail2970c8.ts.net`, `nvmchris.duckdns.org`; IP literals are always accepted. Other hosts get 403. |
| `DOCKER_URL` | Docker API over HTTP (e.g. a docker-socket-proxy); overrides `docker.socket` |

The server listens on all interfaces. Prefer binding the published port to loopback
(`127.0.0.1:3000:3000`) behind a reverse proxy, and set `HOMEDECK_TOKEN` if it is reachable by others.

## Configuration

See [config.example.json](config.example.json).

| Key | Meaning |
| --- | --- |
| `title` | Page title |
| `greeting` | Show "Good morning" etc. above the title |
| `services[]` | Groups: `{ "group", "items": [{ "name", "url", "icon", "description", "ping" }] }`. `icon` is an emoji or an image URL. `"ping": false` skips the status check. `"insecureTls": true` accepts a self-signed certificate for that service. |
| `docker.socket` | Path to the Docker socket |
| `docker.url` | Docker API URL (socket proxy); alternative to `docker.socket` |
| `system.disks[]` | `{ "name", "path" }` mount points to show |
| `weather` | `{ "name", "latitude", "longitude", "unit": "celsius" \| "fahrenheit" }` |
| `calendars[]` | `{ "name", "url", "color" }` ICS feed URLs |
| `calendarDays` / `calendarLimit` | How far ahead to look and how many events to show |

## Notes

- TLS certificates are verified. For self-signed targets set `"insecureTls": true` on that service or calendar (a warning is logged). Status checks count any HTTP answer below 500 as "up".
- Weather is cached for 10 minutes, calendars for 15, status checks for 30 seconds.
- Recurring events support `FREQ` (daily/weekly/monthly/yearly), `INTERVAL`, `COUNT` and `UNTIL`;
  rules like `BYDAY` and exceptions (`EXDATE`) are not expanded.
- The Docker socket gives full control over Docker, and `:ro` does not restrict the API. The compose file
  therefore mounts it only into a `docker-socket-proxy` that allows listing containers (`CONTAINERS=1`);
  homedeck reaches it via `DOCKER_URL`. Existing `docker.socket` configs keep working without compose.
- Disk usage in Docker: only `/etc/hostname` is mounted at `/host` (statfs reports the host root filesystem).
  Other host filesystems need their own mount and `system.disks` entry.
- The container runs as the `node` user (uid 1000); make `./config` writable by it.
