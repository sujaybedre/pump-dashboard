const SUPABASE_BASE = "https://xbdjnpncoxjzxovnfvri.supabase.co";
const PUMP_EVENTS_ENDPOINT = `${SUPABASE_BASE}/rest/v1/pump_events`;

// Publishable key only. Never put a secret/service-role key in browser JavaScript.
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_aEkrtoWXMOXhnzVkOfKavA_aYaCA2Hc";

const DEVICE_ID = "npshsr_01";
const PUMP_ID = "pump_01";

const flowInput = document.getElementById("flowRate");
const refreshBtn = document.getElementById("refreshBtn");
const syncStatus = document.getElementById("syncStatus");

let events = [];
let waterChart = null;
let runtimeChart = null;

flowInput.value = localStorage.getItem("pumpFlowLpm") || "30";

flowInput.addEventListener("change", () => {
  localStorage.setItem("pumpFlowLpm", flowInput.value);
  render();
});

refreshBtn.addEventListener("click", loadData);

function flowLpm() {
  const v = Number(flowInput.value);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

function litresFor(seconds) {
  return (Number(seconds || 0) / 60) * flowLpm();
}

function localDateKey(value) {
  const d = value instanceof Date ? value : new Date(value);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric"
  });
}

function formatRuntime(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds || 0)));

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDateTime(value) {
  if (!value) return "—";

  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatLitres(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(2)} kL`;
  return `${Math.round(v).toLocaleString()} L`;
}

async function loadData() {
  syncStatus.textContent = "Loading…";
  syncStatus.className = "status";

  const query = new URLSearchParams({
    select: "id,device_id,pump_id,started_at,stopped_at,runtime_seconds,wifi_rssi,created_at",
    device_id: `eq.${DEVICE_ID}`,
    pump_id: `eq.${PUMP_ID}`,
    order: "started_at.desc",
    limit: "500"
  });

  try {
    const response = await fetch(
      `${PUMP_EVENTS_ENDPOINT}?${query.toString()}`,
      {
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `Supabase returned HTTP ${response.status}: ${await response.text()}`
      );
    }

    events = await response.json();

    syncStatus.textContent =
      `Updated ${new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })}`;

    syncStatus.className = "status ok";

    render();

  } catch (error) {
    console.error(error);

    syncStatus.textContent = "Could not load data";
    syncStatus.className = "status error";

    document.getElementById("eventsBody").innerHTML =
      `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
  }
}

function render() {
  renderCards();
  renderCharts();
  renderTable();
}

function renderCards() {
  const today = localDateKey(new Date());

  const todayEvents = events.filter(
    event =>
      event.started_at &&
      localDateKey(event.started_at) === today
  );

  const runtime = todayEvents.reduce(
    (sum, event) => sum + Number(event.runtime_seconds || 0),
    0
  );

  const water = litresFor(runtime);

  document.getElementById("todayWater").textContent =
    formatLitres(water);

  document.getElementById("todayRuntime").textContent =
    formatRuntime(runtime);

  document.getElementById("todayRuns").textContent =
    todayEvents.length.toLocaleString();

  const latest = events[0];

  if (latest) {
    document.getElementById("lastRun").textContent =
      formatRuntime(latest.runtime_seconds);

    document.getElementById("lastRunTime").textContent =
      `${formatDateTime(latest.started_at)} → ${formatDateTime(latest.stopped_at)}`;

  } else {
    document.getElementById("lastRun").textContent = "No data";
    document.getElementById("lastRunTime").textContent = "—";
  }
}

function lastSevenDays() {
  const days = [];
  const now = new Date();

  now.setHours(0, 0, 0, 0);

  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);

    days.push({
      key: localDateKey(date),
      label: dayLabel(date),
      runtime: 0,
      water: 0
    });
  }

  const dayMap = new Map(days.map(day => [day.key, day]));

  events.forEach(event => {
    if (!event.started_at) return;

    const key = localDateKey(event.started_at);
    const day = dayMap.get(key);

    if (!day) return;

    const seconds = Number(event.runtime_seconds || 0);

    day.runtime += seconds;
    day.water += litresFor(seconds);
  });

  return days;
}

function renderCharts() {
  const days = lastSevenDays();

  if (waterChart) {
    waterChart.destroy();
    waterChart = null;
  }

  if (runtimeChart) {
    runtimeChart.destroy();
    runtimeChart = null;
  }

  const waterCanvas = document.getElementById("waterChart");
  const runtimeCanvas = document.getElementById("runtimeChart");

  const sharedOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    resizeDelay: 200,
    plugins: {
      legend: {
        display: false
      }
    },
    scales: {
      x: {
        grid: {
          display: false
        }
      },
      y: {
        beginAtZero: true
      }
    }
  };

  waterChart = new Chart(waterCanvas, {
    type: "bar",
    data: {
      labels: days.map(day => day.label),
      datasets: [
        {
          label: "Estimated litres",
          data: days.map(day => Math.round(day.water))
        }
      ]
    },
    options: {
      ...sharedOptions,
      scales: {
        ...sharedOptions.scales,
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "Litres"
          }
        }
      }
    }
  });

  runtimeChart = new Chart(runtimeCanvas, {
    type: "line",
    data: {
      labels: days.map(day => day.label),
      datasets: [
        {
          label: "Runtime minutes",
          data: days.map(
            day => Number((day.runtime / 60).toFixed(1))
          ),
          tension: 0.25,
          fill: false
        }
      ]
    },
    options: {
      ...sharedOptions,
      scales: {
        ...sharedOptions.scales,
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "Minutes"
          }
        }
      }
    }
  });
}

function renderTable() {
  const body = document.getElementById("eventsBody");

  if (!events.length) {
    body.innerHTML =
      `<tr><td colspan="5">No pump events found.</td></tr>`;
    return;
  }

  body.innerHTML = events
    .slice(0, 20)
    .map(
      event => `
        <tr>
          <td>${escapeHtml(formatDateTime(event.started_at))}</td>
          <td>${escapeHtml(formatDateTime(event.stopped_at))}</td>
          <td>${escapeHtml(formatRuntime(event.runtime_seconds))}</td>
          <td>${escapeHtml(formatLitres(litresFor(event.runtime_seconds)))}</td>
          <td>${event.wifi_rssi == null ? "—" : `${Number(event.wifi_rssi)} dBm`}</td>
        </tr>
      `
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadData();

// Refresh once per minute while dashboard is open.
setInterval(loadData, 60_000);
