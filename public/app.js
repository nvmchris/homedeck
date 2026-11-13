// homedeck frontend: fetches each widget from the server and re-renders on an interval.
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Run `fn` now and every `seconds`; show errors in `errorEl` instead of crashing.
function every(seconds, fn, errorEl) {
  const run = () =>
    fn().catch((err) => {
      if (errorEl) errorEl.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    });
  run();
  setInterval(run, seconds * 1000);
}

function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const levelColor = (pct) => (pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)");

// ---------- header ----------

function tickClock() {
  const now = new Date();
  $("time").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  const h = now.getHours();
  $("greeting").dataset.text = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  if ($("greeting").dataset.enabled === "true") $("greeting").textContent = $("greeting").dataset.text;
}

async function loadConfig() {
  const config = await getJson("/api/config");
  $("title").textContent = config.title;
  document.title = config.title;
  $("greeting").dataset.enabled = config.greeting;
  tickClock();
}

// ---------- system ----------

function gauge(label, pct, detail) {
  return `<div class="gauge">
    <div class="ring-wrap">
      <div class="ring" style="--value:${pct.toFixed(1)};--color:${levelColor(pct)}"></div>
      <div class="ring-label">${Math.round(pct)}%</div>
    </div>
    <small>${esc(label)}</small>
    ${detail ? `<div class="detail">${esc(detail)}</div>` : ""}
  </div>`;
}

async function loadSystem() {
  const s = await getJson("/api/system");
  const mem = (100 * s.memory.used) / s.memory.total;
  $("gauges").innerHTML = [
    gauge("CPU", s.cpu, `${s.cores} cores`),
    gauge("Memory", mem, `${bytes(s.memory.used)} / ${bytes(s.memory.total)}`),
    ...s.disks.map((d) => (d.error ? `<div class="gauge"><small>${esc(d.name)}</small><div class="error">${esc(d.error)}</div></div>` : gauge(d.name, (100 * d.used) / d.total, `${bytes(d.used)} / ${bytes(d.total)}`))),
  ].join("");
  $("facts").innerHTML = `
    <div><dt>Load</dt><dd>${s.load.map((l) => l.toFixed(2)).join(" ")}</dd></div>
    <div><dt>Uptime</dt><dd>${duration(s.uptime)}</dd></div>
    <div><dt>Temp</dt><dd>${s.temperature == null ? "–" : `${s.temperature.toFixed(0)} °C`}</dd></div>`;
}

// ---------- weather ----------

// WMO weather codes -> [day icon, night icon, description]
const WMO = {
  0: ["☀️", "🌙", "Clear sky"], 1: ["🌤️", "🌙", "Mainly clear"], 2: ["⛅", "☁️", "Partly cloudy"], 3: ["☁️", "☁️", "Overcast"],
  45: ["🌫️", "🌫️", "Fog"], 48: ["🌫️", "🌫️", "Rime fog"],
  51: ["🌦️", "🌧️", "Light drizzle"], 53: ["🌦️", "🌧️", "Drizzle"], 55: ["🌧️", "🌧️", "Heavy drizzle"],
  56: ["🌧️", "🌧️", "Freezing drizzle"], 57: ["🌧️", "🌧️", "Freezing drizzle"],
  61: ["🌦️", "🌧️", "Light rain"], 63: ["🌧️", "🌧️", "Rain"], 65: ["🌧️", "🌧️", "Heavy rain"],
  66: ["🌧️", "🌧️", "Freezing rain"], 67: ["🌧️", "🌧️", "Freezing rain"],
  71: ["🌨️", "🌨️", "Light snow"], 73: ["🌨️", "🌨️", "Snow"], 75: ["❄️", "❄️", "Heavy snow"], 77: ["🌨️", "🌨️", "Snow grains"],
  80: ["🌦️", "🌧️", "Rain showers"], 81: ["🌧️", "🌧️", "Rain showers"], 82: ["⛈️", "⛈️", "Violent showers"],
  85: ["🌨️", "🌨️", "Snow showers"], 86: ["❄️", "❄️", "Snow showers"],
  95: ["⛈️", "⛈️", "Thunderstorm"], 96: ["⛈️", "⛈️", "Thunderstorm, hail"], 99: ["⛈️", "⛈️", "Thunderstorm, hail"],
};
const wmo = (code, day = true) => {
  const w = WMO[code] || ["🌡️", "🌡️", "Unknown"];
  return { icon: day ? w[0] : w[1], text: w[2] };
};

async function loadWeather() {
  const w = await getJson("/api/weather");
  if (!w) return ($("weather").hidden = true);
  const c = w.current;
  const now = wmo(c.weather_code, c.is_day);
  $("weather-name").textContent = w.name || "";
  $("weather-body").className = "";
  $("weather-body").innerHTML = `
    <div class="now">
      <div class="icon">${now.icon}</div>
      <div>
        <div class="temp">${Math.round(c.temperature_2m)}${esc(w.unit)}</div>
        <div class="desc">${now.text} · feels ${Math.round(c.apparent_temperature)}° · 💧 ${c.relative_humidity_2m}% · 💨 ${Math.round(c.wind_speed_10m)} km/h</div>
      </div>
    </div>
    <div class="forecast">
      ${w.daily
        .map((d, i) => `<div>
          <div class="day">${i === 0 ? "Today" : new Date(d.date + "T12:00").toLocaleDateString([], { weekday: "short" })}</div>
          <div class="ico" title="${wmo(d.code).text}">${wmo(d.code).icon}</div>
          <div class="range">${Math.round(d.max)}° <span>${Math.round(d.min)}°</span></div>
        </div>`)
        .join("")}
    </div>`;
}

// ---------- calendar ----------

async function loadCalendar() {
  const events = await getJson("/api/calendar");
  if (!events.length) return ($("events").innerHTML = `<li class="muted">Nothing coming up.</li>`);
  $("events").innerHTML = events
    .map((e) => {
      const d = new Date(e.start);
      const today = new Date().toDateString() === d.toDateString();
      const time = e.allDay ? "All day" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `<li>
        <div class="when"><small>${today ? "Today" : d.toLocaleDateString([], { month: "short" })}</small><b>${d.getDate()}</b></div>
        <div class="what">
          <div>${esc(e.title)}</div>
          <div class="meta"><i style="${e.color ? `background:${esc(e.color)}` : ""}"></i>${time}${e.calendar ? ` · ${esc(e.calendar)}` : ""}</div>
        </div>
      </li>`;
    })
    .join("");
}

// ---------- services ----------

const icon = (i) => (!i ? "🔗" : /[/.]/.test(i) ? `<img src="${esc(i)}" alt="">` : esc(i));

function statusBadge(s) {
  if (!s) return "";
  return `<span class="status"><span class="dot ${s.up ? "up" : "down"}"></span>${s.up ? `${s.ms} ms` : "offline"}</span>`;
}

async function loadServices() {
  const groups = await getJson("/api/services");
  $("services").innerHTML = groups
    .map(
      (g) => `<div class="group">
        <h2>${esc(g.group)}</h2>
        <div class="tiles">
          ${g.items
            .map(
              (s) => `<a class="tile" href="${esc(s.url)}" target="_blank" rel="noopener">
                <div class="icon">${icon(s.icon)}</div>
                <div class="info">
                  <div class="name">${esc(s.name)}</div>
                  ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ""}
                </div>
                ${statusBadge(s.status)}
              </a>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");
}

// ---------- docker ----------

let containers = [];

function renderContainers() {
  const q = $("docker-filter").value.trim().toLowerCase();
  const list = containers.filter((c) => !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q));
  $("containers").innerHTML =
    list
      .map((c) => {
        const cls = c.state === "running" ? (/unhealthy/.test(c.status) ? "warn" : "up") : c.state === "exited" || c.state === "dead" ? "down" : "warn";
        return `<div class="container">
          <span class="dot ${cls}"></span>
          <div class="info">
            <div class="name">${esc(c.name)}</div>
            <div class="image">${esc(c.image)}</div>
          </div>
          <div class="state">${esc(c.status)}</div>
        </div>`;
      })
      .join("") || `<p class="muted">No containers.</p>`;
}

async function loadDocker() {
  containers = await getJson("/api/docker");
  const running = containers.filter((c) => c.state === "running").length;
  $("docker-count").textContent = `${running} running · ${containers.length - running} stopped`;
  renderContainers();
}

$("docker-filter").addEventListener("input", renderContainers);

// ---------- start ----------

loadConfig().catch(() => {});
setInterval(tickClock, 1000);
tickClock();
every(5, loadSystem, $("gauges"));
every(10, loadDocker, $("containers"));
every(30, loadServices, $("services"));
every(600, loadWeather, $("weather-body"));
every(900, loadCalendar, $("events"));
