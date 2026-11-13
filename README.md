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

Environment variables: `PORT` (default `3000`), `CONFIG` (default `./config/config.json`).

## Configuration

See [config.example.json](config.example.json).

| Key | Meaning |
| --- | --- |
| `title` | Page title |
| `greeting` | Show "Good morning" etc. above the title |
| `services[]` | Groups: `{ "group", "items": [{ "name", "url", "icon", "description", "ping" }] }`. `icon` is an emoji or an image URL. `"ping": false` skips the status check. |
| `docker.socket` | Path to the Docker socket |
| `system.disks[]` | `{ "name", "path" }` mount points to show |
| `weather` | `{ "name", "latitude", "longitude", "unit": "celsius" \| "fahrenheit" }` |
| `calendars[]` | `{ "name", "url", "color" }` ICS feed URLs |
| `calendarDays` / `calendarLimit` | How far ahead to look and how many events to show |

## Notes

- Status checks accept self-signed certificates and count any HTTP answer below 500 as "up".
- Weather is cached for 10 minutes, calendars for 15, status checks for 30 seconds.
- Recurring events support `FREQ` (daily/weekly/monthly/yearly), `INTERVAL`, `COUNT` and `UNTIL`;
  rules like `BYDAY` and exceptions (`EXDATE`) are not expanded.
- The Docker socket gives full control over Docker. It is mounted read-only, but only
  expose homedeck inside your LAN or behind a reverse proxy with auth.
