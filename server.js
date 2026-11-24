// homedeck - a small self-hosted homelab dashboard.
// Zero dependencies: only Node.js built-in modules.
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // unset: all interfaces
const CONFIG_PATH = process.env.CONFIG || path.join(__dirname, "config", "config.json");
const EXAMPLE_PATH = path.join(__dirname, "config.example.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- config ----------

// Read on every request so edits apply without a restart.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    console.log(`No config found, created ${CONFIG_PATH} from the example`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ---------- small helpers ----------

// Cache async results for `ttlMs`, keyed by string.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { time: Date.now(), value });
  return value;
}

// Certificates are verified unless the caller opts out (per service: "insecureTls": true).
const warnedInsecure = new Set();
function warnInsecure(url) {
  if (warnedInsecure.has(url)) return;
  warnedInsecure.add(url);
  console.warn(`WARNING: TLS verification disabled for ${url} (insecureTls). Prefer a trusted certificate.`);
}

// GET a URL and return { status, body }.
function request(url, { timeoutMs = 8000, socketPath, readBody = true, insecureTls = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = socketPath ? new URL(url, "http://localhost") : new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    if (insecureTls && target.protocol === "https:") warnInsecure(target.origin);
    const req = lib.request(
      target,
      { method: "GET", socketPath, rejectUnauthorized: !insecureTls, timeout: timeoutMs, headers: { "User-Agent": "homedeck" } },
      (res) => {
        if (!readBody) {
          res.resume();
          return resolve({ status: res.statusCode, body: "" });
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body, location: res.headers.location }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

// ---------- system ----------

let lastCpu = null;
function cpuTimes() {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

async function cpuUsage() {
  if (!lastCpu) {
    lastCpu = cpuTimes();
    await new Promise((r) => setTimeout(r, 250));
  }
  const now = cpuTimes();
  const total = now.total - lastCpu.total;
  const idle = now.idle - lastCpu.idle;
  lastCpu = now;
  return total > 0 ? 100 * (1 - idle / total) : 0;
}

function memory() {
  // MemAvailable is more honest than os.freemem(), which ignores reclaimable cache.
  try {
    const info = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))[1]) * 1024;
    const total = kb("MemTotal");
    return { total, used: total - kb("MemAvailable") };
  } catch {
    return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  }
}

function disks(config) {
  const list = config.system?.disks || [{ name: "Root", path: "/" }];
  return list.map(({ name, path: p }) => {
    try {
      const s = fs.statfsSync(p);
      const total = s.blocks * s.bsize;
      return { name, total, used: total - s.bavail * s.bsize };
    } catch (err) {
      return { name, error: err.code || err.message };
    }
  });
}

function temperature() {
  // First thermal zone, if the kernel exposes one.
  try {
    return Number(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8")) / 1000;
  } catch {
    return null;
  }
}

async function system(config) {
  return {
    cpu: await cpuUsage(),
    cores: os.cpus().length,
    load: os.loadavg(),
    memory: memory(),
    disks: disks(config),
    temperature: temperature(),
    uptime: os.uptime(),
  };
}

// ---------- docker ----------

// DOCKER_URL (env) or docker.url (config) point at a docker-socket-proxy over HTTP;
// otherwise the Unix socket is used.
async function docker(config) {
  const base = process.env.DOCKER_URL || config.docker?.url;
  const res = base
    ? await request(new URL("/containers/json?all=true", base).href)
    : await request("/containers/json?all=true", { socketPath: config.docker?.socket || "/var/run/docker.sock" });
  if (res.status !== 200) throw new Error(`Docker API returned ${res.status}`);
  return JSON.parse(res.body)
    .map((c) => ({
      name: c.Names[0].replace(/^\//, ""),
      image: c.Image,
      state: c.State, // running, exited, paused, restarting, ...
      status: c.Status, // e.g. "Up 3 hours (healthy)"
    }))
    .sort((a, b) => (b.state === "running") - (a.state === "running") || a.name.localeCompare(b.name));
}

// ---------- service status ----------

async function ping(url, insecureTls) {
  const start = Date.now();
  try {
    const res = await request(url, { timeoutMs: 5000, readBody: false, insecureTls });
    // Any HTTP answer (even 401/403) means the service is up.
    return { up: res.status < 500, ms: Date.now() - start };
  } catch {
    return { up: false, ms: null };
  }
}

async function services(config) {
  const groups = config.services || [];
  return Promise.all(
    groups.map(async (group) => ({
      ...group,
      items: await Promise.all(
        (group.items || []).map(async (item) => ({
          ...item,
          status: item.ping === false || !item.url ? null : await cached(`ping:${item.url}`, 30_000, () => ping(item.url, item.insecureTls === true)),
        }))
      ),
    }))
  );
}

// ---------- weather (Open-Meteo, no API key) ----------

async function weather(config) {
  const w = config.weather;
  if (!w) return null;
  const params = new URLSearchParams({
    latitude: w.latitude,
    longitude: w.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: 5,
    temperature_unit: w.unit === "fahrenheit" ? "fahrenheit" : "celsius",
  });
  return cached(`weather:${params}`, 10 * 60_000, async () => {
    const res = await request(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (res.status !== 200) throw new Error(`Open-Meteo returned ${res.status}`);
    const data = JSON.parse(res.body);
    return {
      name: w.name,
      unit: data.current_units.temperature_2m,
      current: data.current,
      daily: data.daily.time.map((date, i) => ({
        date,
        code: data.daily.weather_code[i],
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        rain: data.daily.precipitation_probability_max[i],
      })),
    };
  });
}

// ---------- calendar (ICS feeds) ----------

// Parse an ICS date value: 20261113, 20261113T090000 (local) or 20261113T090000Z (UTC).
function parseIcsDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const args = [+y, +mo - 1, +d, +h, +mi, +s];
  return { date: z ? new Date(Date.UTC(...args)) : new Date(...args), allDay: !m[4] };
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // unfold continued lines
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT") {
      if (ev.start) events.push(ev);
      ev = null;
    } else if (ev) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).split(";")[0];
      const value = line.slice(i + 1);
      if (key === "SUMMARY") ev.title = value.replace(/\\n/g, " ").replace(/\\([,;\\])/g, "$1");
      else if (key === "DTSTART") Object.assign(ev, (({ date, allDay }) => ({ start: date, allDay }))(parseIcsDate(value) || {}));
      else if (key === "RRULE") ev.rrule = Object.fromEntries(value.split(";").map((p) => p.split("=")));
    }
  }
  return events;
}

// Expand simple recurrences (FREQ + INTERVAL + COUNT/UNTIL) into occurrences within [from, to].
function occurrences(ev, from, to) {
  if (!ev.rrule) return ev.start >= from && ev.start <= to ? [ev.start] : [];
  const step = { DAILY: [0, 1], WEEKLY: [0, 7], MONTHLY: [1, 0], YEARLY: [12, 0] }[ev.rrule.FREQ];
  if (!step) return [];
  const interval = Number(ev.rrule.INTERVAL) || 1;
  const count = Number(ev.rrule.COUNT) || Infinity;
  const until = ev.rrule.UNTIL ? parseIcsDate(ev.rrule.UNTIL)?.date : null;
  const out = [];
  for (let n = 0; n < count && n < 5000; n++) {
    const d = new Date(ev.start);
    d.setMonth(d.getMonth() + step[0] * interval * n);
    d.setDate(d.getDate() + step[1] * interval * n);
    if (d > to || (until && d > until)) break;
    if (d >= from) out.push(d);
  }
  return out;
}

async function calendar(config) {
  const feeds = config.calendars || [];
  const days = config.calendarDays || 14;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + days * 86_400_000);
  const results = await Promise.all(
    feeds.map(({ name, url, color, insecureTls }) =>
      cached(`ics:${url}`, 15 * 60_000, async () => {
        const opts = { insecureTls: insecureTls === true };
        let res = await request(url, opts);
        if (res.status >= 300 && res.status < 400 && res.location) res = await request(new URL(res.location, url).href, opts);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        return parseIcs(res.body);
      })
        .then((events) =>
          events.flatMap((ev) =>
            occurrences(ev, from, to).map((start) => ({ title: ev.title || "(no title)", start, allDay: ev.allDay, calendar: name, color }))
          )
        )
        .catch((err) => {
          console.error(`Calendar "${name}": ${err.message}`);
          return [];
        })
    )
  );
  return results.flat().sort((a, b) => a.start - b.start).slice(0, config.calendarLimit || 12);
}

// ---------- http server ----------

const api = {
  "/api/config": (c) => ({ title: c.title || "homedeck", greeting: c.greeting !== false }),
  "/api/system": system,
  "/api/docker": docker,
  "/api/services": services,
  "/api/weather": weather,
  "/api/calendar": calendar,
};

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  res.end(body);
}

// ---------- access control ----------

// Host allow-list (blocks DNS rebinding). IP literals are always allowed: a rebinding
// attack needs a hostname. Extend with ALLOWED_HOSTS (comma-separated hostnames).
const DEFAULT_HOSTS = ["localhost", "alpha.tail2970c8.ts.net", "homepi.tail2970c8.ts.net", "nvmchris.duckdns.org"];
function allowedHosts() {
  const extra = (process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set([...DEFAULT_HOSTS, ...extra]);
}

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::\d+)?$/i.exec(hostHeader.trim());
  if (!m) return false;
  const host = m[1].toLowerCase();
  return host.startsWith("[") || net.isIPv4(host) || allowedHosts().has(host);
}

const COOKIE = "homedeck_token";
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const tokenMatches = (given, token) => !!given && crypto.timingSafeEqual(sha(given), sha(token));

function requestToken(req, query) {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
  if (bearer) return bearer[1];
  if (req.headers["x-homedeck-token"]) return req.headers["x-homedeck-token"];
  const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : query;
}

// ---------- http server ----------

function handle(req, res) {
  return (async () => {
    if (!hostAllowed(req.headers.host)) return send(res, 403, "Forbidden host", "text/plain");
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, "Bad request", "text/plain");
    }
    const { pathname } = url;
    const token = process.env.HOMEDECK_TOKEN;
    if (token) {
      const queryToken = url.searchParams.get("token");
      if (!tokenMatches(requestToken(req, queryToken), token)) return send(res, 401, "Unauthorized", "text/plain");
      if (queryToken) {
        // Browser login: /?token=... sets a cookie, then drops the token from the URL.
        res.writeHead(302, { Location: pathname, "Set-Cookie": `${COOKIE}=${encodeURIComponent(queryToken)}; HttpOnly; SameSite=Lax; Max-Age=31536000; Path=/` });
        return res.end();
      }
    }
    const handler = api[pathname];
    if (handler) {
      try {
        send(res, 200, JSON.stringify(await handler(loadConfig())));
      } catch (err) {
        send(res, 502, JSON.stringify({ error: err.message }));
      }
      return;
    }
    const file = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, "Not found", "text/plain");
    }
    send(res, 200, fs.readFileSync(file), types[path.extname(file)] || "application/octet-stream");
  })().catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, "Internal error", "text/plain");
  });
}

const server = http.createServer(handle);
module.exports = { server };

if (require.main === module) {
  if (!process.env.HOMEDECK_TOKEN) console.warn("WARNING: HOMEDECK_TOKEN is not set; the dashboard is unauthenticated.");
  server.listen(PORT, HOST, () => console.log(`homedeck running on http://${HOST || "localhost"}:${PORT}`));
}
