const SUPABASE_BASE = "https://xbdjnpncoxjzxovnfvri.supabase.co";
const BATHROOM_ENDPOINT = `${SUPABASE_BASE}/rest/v1/bathroom_people_count`;
const PUMP_ENDPOINT = `${SUPABASE_BASE}/rest/v1/pump_events`;

// Publishable key only. Never put a secret/service-role key in browser JavaScript.
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_aEkrtoWXMOXhnzVkOfKavA_aYaCA2Hc";

const IST = "Asia/Kolkata";
const PAGE_SIZE = 1000;
const MAX_ROWS = 8000;
const FOOT_COLOR = "#2f6fed";
const WATER_COLOR = "#0f8f78";
const PEAK_COLOR = "#b45309";

// Compared with this pump's own median current, not a fixed amp rating.
const DRY_RATIO = 0.7;
const JAM_RATIO = 1.6;
const JAM_SPIKE_RATIO = 1.25;
const OVERLOAD_RATIO = 1.25;
const OVERLOAD_STREAK = 3;
const DRIFT_RATIO = 1.1;
const MIN_BASELINE_RUNS = 8;
const MIN_DRIFT_WEEKS = 4;
const USAGE_CHART_IDS = ["visitsDayChart", "visitsHourChart", "bathroomChart", "waterChart", "relationChart"];
const HEALTH_CHART_IDS = ["currentChart", "driftChart"];

const fromInput = document.getElementById("fromDate");
const toInput = document.getElementById("toDate");
const bathroomSelect = document.getElementById("bathroomFilter");
const flowInput = document.getElementById("flowRate");
const refreshBtn = document.getElementById("refreshBtn");
const syncStatus = document.getElementById("syncStatus");
const loadError = document.getElementById("loadError");

const state = {
  bathroom: [],
  pumps: [],
  bathroomLatest: [],
  pumpLatest: [],
  waterGrain: "day",
  view: "usage",
  truncated: false,
  charts: {}
};

let loadGen = 0;

flowInput.value = localStorage.getItem("pumpFlowLpm") || "30";

function flowLpm() {
  const value = Number(flowInput.value);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function litresFor(seconds) {
  return (Number(seconds || 0) / 60) * flowLpm();
}

function istParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;

  const key = `${get("year")}-${get("month")}-${get("day")}`;
  return { key, hour, minute: get("minute"), weekday: get("weekday") };
}

function istTodayKey() {
  return istParts(new Date()).key;
}

function addDays(key, delta) {
  const date = new Date(`${key}T12:00:00+05:30`);
  date.setTime(date.getTime() + delta * 86400000);
  return istParts(date).key;
}

function daysBetween(from, to) {
  const start = new Date(`${from}T12:00:00+05:30`).getTime();
  const end = new Date(`${to}T12:00:00+05:30`).getTime();
  return Math.round((end - start) / 86400000);
}

function eachDateKey(from, to) {
  const span = daysBetween(from, to);
  if (span < 0 || span > 92) return null;

  const keys = [];
  let key = from;
  while (key <= to && keys.length < 100) {
    keys.push(key);
    key = addDays(key, 1);
  }
  return keys;
}

function isWeekday(key) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "short"
  }).format(new Date(`${key}T12:00:00+05:30`));
  return weekday !== "Sat" && weekday !== "Sun";
}

function weekStartKey(key) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "short"
  }).format(new Date(`${key}T12:00:00+05:30`));
  const index = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 1;
  return addDays(key, -((index + 6) % 7));
}

function formatCount(value) {
  return Math.round(Number(value || 0)).toLocaleString("en-IN");
}

function formatLitres(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kL`;
  return `${Math.round(value).toLocaleString("en-IN")} L`;
}

function formatPerPerson(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 100) return `${Math.round(value).toLocaleString("en-IN")} L`;
  if (value >= 10) return `${value.toFixed(1)} L`;
  return `${value.toFixed(2)} L`;
}

function formatRuntime(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remain}s`;
  return `${remain}s`;
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(value));
}

function formatDayKey(key) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "numeric",
    month: "short"
  }).format(new Date(`${key}T12:00:00+05:30`));
}

function formatDayLong(key) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(`${key}T12:00:00+05:30`));
}

function formatBucket(key, grain) {
  if (grain === "month") {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: IST,
      month: "short",
      year: "numeric"
    }).format(new Date(`${key}-01T12:00:00+05:30`));
  }
  if (grain === "week") return `Week of ${formatDayKey(key)}`;
  return formatDayKey(key);
}

function hourLabel(hour) {
  const suffix = hour < 12 ? "AM" : "PM";
  const clock = hour % 12 || 12;
  return `${clock} ${suffix}`;
}

function prettyBathroom(id) {
  if (!id) return "Unknown";
  return String(id)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function signalText(rssi) {
  if (rssi == null || rssi === "") return "—";
  const value = Number(rssi);
  const quality = value >= -67 ? "Good" : value >= -75 ? "Fair" : "Weak";
  return `${value} dBm · ${quality}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function headers(range) {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    ...(range ? { Range: range } : {})
  };
}

async function fetchPage(endpoint, params, start) {
  const response = await fetch(`${endpoint}?${params.toString()}`, {
    headers: headers(`${start}-${start + PAGE_SIZE - 1}`)
  });

  if (!response.ok) {
    throw new Error(`Supabase returned HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchAll(endpoint, params) {
  const rows = [];

  for (let start = 0; start < MAX_ROWS; start += PAGE_SIZE) {
    const chunk = await fetchPage(endpoint, params, start);
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) {
      return { rows, truncated: false };
    }
  }

  return { rows, truncated: true };
}

function rangeBounds() {
  let from = fromInput.value;
  let to = toInput.value;
  if (from && to && from > to) {
    [from, to] = [to, from];
    fromInput.value = from;
    toInput.value = to;
  }
  return { from, to };
}

function markPreset(preset) {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === preset);
  });
}

function applyPreset(preset) {
  const today = istTodayKey();
  if (preset === "7") {
    fromInput.value = addDays(today, -6);
    toInput.value = today;
  } else if (preset === "30") {
    fromInput.value = addDays(today, -29);
    toInput.value = today;
  } else if (preset === "month") {
    fromInput.value = `${today.slice(0, 7)}-01`;
    toInput.value = today;
  } else {
    fromInput.value = "2026-08-01";
    toInput.value = today;
  }
  markPreset(preset);
  loadData();
}

function visibleBathroomRows() {
  const id = bathroomSelect.value;
  if (!id) return state.bathroom;
  return state.bathroom.filter((row) => row.bathroom_id === id);
}

function sumVisits(rows) {
  return rows.reduce((sum, row) => sum + Number(row.count_increment || 0), 0);
}

function dayVisits(rows) {
  const totals = new Map();
  rows.forEach((row) => {
    if (!row.recorded_at) return;
    const key = istParts(row.recorded_at).key;
    totals.set(key, (totals.get(key) || 0) + Number(row.count_increment || 0));
  });
  return totals;
}

function dayWater(rows) {
  const totals = new Map();
  rows.forEach((row) => {
    if (!row.started_at) return;
    const key = istParts(row.started_at).key;
    totals.set(key, (totals.get(key) || 0) + litresFor(row.runtime_seconds));
  });
  return totals;
}

function bucketKey(day, grain) {
  if (grain === "month") return day.slice(0, 7);
  if (grain === "week") return weekStartKey(day);
  return day;
}

function seriesFromMap(totals, grain, fillDays) {
  const buckets = new Map();

  if (fillDays && grain === "day") {
    fillDays.forEach((day) => buckets.set(day, 0));
  }

  totals.forEach((value, day) => {
    const key = bucketKey(day, grain);
    buckets.set(key, (buckets.get(key) || 0) + value);
  });

  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => ({
      key,
      label: formatBucket(key, grain),
      value
    }));
}

function freshness(lastValue) {
  if (!lastValue) return { label: "No data", tone: "error" };

  const lastDay = istParts(lastValue).key;
  const today = istTodayKey();
  if (lastDay === today) return { label: "Reporting", tone: "ok" };
  if (lastDay === addDays(today, -1)) return { label: "Seen yesterday", tone: "warn" };
  return { label: "No recent data", tone: "error" };
}

function firstBy(rows, key) {
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row[key])) map.set(row[key], row);
  });
  return [...map.values()];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function chartBase(showLegend) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    resizeDelay: 200,
    plugins: {
      legend: {
        display: showLegend,
        labels: { boxWidth: 12, usePointStyle: true }
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
      },
      y: { beginAtZero: true }
    }
  };
}

function mountChart(id, emptyId, hasData, config) {
  const canvas = document.getElementById(id);
  const empty = document.getElementById(emptyId);

  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }

  canvas.hidden = !hasData;
  empty.hidden = hasData;
  if (!hasData) return;
  state.charts[id] = new Chart(canvas, config);
}

function syncBathroomOptions() {
  const current = bathroomSelect.value;
  const ids = [...new Set(state.bathroom.map((row) => row.bathroom_id).filter(Boolean))].sort();

  bathroomSelect.innerHTML =
    `<option value="">All bathrooms</option>` +
    ids
      .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(prettyBathroom(id))}</option>`)
      .join("");

  if (ids.includes(current)) bathroomSelect.value = current;
}

function renderCards() {
  const rows = visibleBathroomRows();
  const visits = sumVisits(rows);
  const runtime = state.pumps.reduce((sum, row) => sum + Number(row.runtime_seconds || 0), 0);
  const water = litresFor(runtime);
  const hours = new Map();

  rows.forEach((row) => {
    if (!row.recorded_at) return;
    const hour = istParts(row.recorded_at).hour;
    hours.set(hour, (hours.get(hour) || 0) + Number(row.count_increment || 0));
  });

  let peakHour = null;
  hours.forEach((count, hour) => {
    if (!peakHour || count > peakHour.count) peakHour = { hour, count };
  });

  const visitsByDay = dayVisits(state.bathroom);
  const waterByDay = dayWater(state.pumps);
  let overlapVisits = 0;
  let overlapWater = 0;
  let overlapDays = 0;

  visitsByDay.forEach((dayVisitsTotal, day) => {
    const dayLitres = waterByDay.get(day) || 0;
    if (dayVisitsTotal > 0 && dayLitres > 0) {
      overlapDays += 1;
      overlapVisits += dayVisitsTotal;
      overlapWater += dayLitres;
    }
  });

  document.getElementById("kpiFootfall").textContent = formatCount(visits);
  document.getElementById("kpiFootfallSub").textContent = bathroomSelect.value
    ? prettyBathroom(bathroomSelect.value)
    : `${rows.length.toLocaleString("en-IN")} uploads`;

  document.getElementById("kpiPeak").textContent = peakHour
    ? `${hourLabel(peakHour.hour)}–${hourLabel((peakHour.hour + 1) % 24)}`
    : "—";
  document.getElementById("kpiPeakSub").textContent = peakHour
    ? `${formatCount(peakHour.count)} visits`
    : "IST";

  document.getElementById("kpiWater").textContent = formatLitres(water);
  document.getElementById("kpiWaterSub").textContent = `${flowLpm()} L/min assumed`;

  const perVisit = overlapVisits > 0 ? overlapWater / overlapVisits : null;
  document.getElementById("kpiPerPerson").textContent = formatPerPerson(perVisit);
  document.getElementById("kpiPerPersonSub").textContent = overlapDays
    ? `${overlapDays} day${overlapDays === 1 ? "" : "s"} with both signals`
    : "No overlapping day yet";

  document.getElementById("kpiRuntime").textContent = formatRuntime(runtime);
  document.getElementById("kpiRuntimeSub").textContent =
    `${state.pumps.length.toLocaleString("en-IN")} completed cycle${state.pumps.length === 1 ? "" : "s"}`;

  const latestDevices = firstBy(state.bathroomLatest, "device_id");
  const newest = [...latestDevices].sort((a, b) =>
    new Date(b.recorded_at) - new Date(a.recorded_at)
  )[0];

  document.getElementById("kpiLastSeen").textContent = newest
    ? formatDateTime(newest.recorded_at)
    : "No data";
  document.getElementById("kpiLastSeenSub").textContent = newest
    ? `${latestDevices.length} counter${latestDevices.length === 1 ? "" : "s"} · ${signalText(newest.wifi_rssi)}`
    : "Waiting for an upload";
}

function renderInsights() {
  const list = document.getElementById("insights");
  const rows = visibleBathroomRows();
  const notes = [];
  const visitsByDay = dayVisits(rows);
  const allVisitsByDay = dayVisits(state.bathroom);
  const waterByDay = dayWater(state.pumps);
  const dayValues = [...visitsByDay.values()];
  const typical = median(dayValues);

  let peakHour = null;
  const hours = new Map();
  rows.forEach((row) => {
    if (!row.recorded_at) return;
    const hour = istParts(row.recorded_at).hour;
    hours.set(hour, (hours.get(hour) || 0) + Number(row.count_increment || 0));
  });
  hours.forEach((count, hour) => {
    if (!peakHour || count > peakHour.count) peakHour = { hour, count };
  });

  if (peakHour) {
    notes.push(
      `Busiest hour is ${hourLabel(peakHour.hour)}–${hourLabel((peakHour.hour + 1) % 24)} IST, with ${formatCount(peakHour.count)} visits.`
    );
  }

  let busiest = null;
  visitsByDay.forEach((count, day) => {
    if (!busiest || count > busiest.count) busiest = { day, count };
  });
  if (busiest) {
    notes.push(`${formatDayLong(busiest.day)} has the most visits in this range: ${formatCount(busiest.count)}.`);
  }

  if (typical && typical >= 40) {
    let quiet = null;
    visitsByDay.forEach((count, day) => {
      if (!isWeekday(day)) return;
      if (count < typical * 0.25 && (!quiet || count < quiet.count)) quiet = { day, count };
    });
    if (quiet) {
      notes.push(
        `${formatDayLong(quiet.day)} recorded ${formatCount(quiet.count)} visits, well below a typical day of about ${formatCount(typical)}. The counter may have been offline.`
      );
    }
  }

  let overlapVisits = 0;
  let overlapWater = 0;
  let overlapDays = 0;
  const perDay = [];

  allVisitsByDay.forEach((count, day) => {
    const litres = waterByDay.get(day) || 0;
    if (count > 0 && litres > 0) {
      overlapDays += 1;
      overlapVisits += count;
      overlapWater += litres;
      perDay.push({ day, count, litres, each: litres / count });
    }
  });

  const runtime = state.pumps.reduce((sum, row) => sum + Number(row.runtime_seconds || 0), 0);

  if (overlapVisits > 0) {
    const each = overlapWater / overlapVisits;
    notes.push(
      `Estimated water is ${formatPerPerson(each)} per visit across ${overlapDays} day${overlapDays === 1 ? "" : "s"} with both counts and pump runtime.`
    );
  } else if (sumVisits(rows) > 0) {
    notes.push("Pump runtime does not overlap these visit dates, so water per visit is not available yet.");
  }

  if (runtime > 0 && runtime < 600) {
    notes.push(
      `Pump history in this range is only ${formatRuntime(runtime)}. Treat the water figures as a short sample until more cycles are recorded.`
    );
  }

  const rates = perDay.map((day) => day.each);
  const typicalRate = median(rates);
  if (typicalRate && typicalRate > 0) {
    const high = perDay
      .filter((day) => day.each > typicalRate * 2 && day.litres >= 20)
      .sort((a, b) => b.each - a.each)[0];
    if (high) {
      notes.push(
        `${formatDayLong(high.day)} used about ${formatPerPerson(high.each)} per visit, above the typical ${formatPerPerson(typicalRate)} on days with both signals.`
      );
    }
  }

  waterByDay.forEach((litres, day) => {
    const count = allVisitsByDay.get(day) || 0;
    if (litres >= 20 && count < 5) {
      notes.push(
        `${formatDayLong(day)} shows pump water with almost no counted visits. Check for a test run, a leak, or a counter that was offline.`
      );
    }
  });

  list.innerHTML = (notes.slice(0, 5).length ? notes.slice(0, 5) : ["No records in the selected dates."])
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");
}

function renderCharts() {
  const { from, to } = rangeBounds();
  const fill = from && to ? eachDateKey(from, to) : null;
  const rows = visibleBathroomRows();
  const daily = seriesFromMap(dayVisits(rows), "day", fill);
  const water = seriesFromMap(dayWater(state.pumps), state.waterGrain, fill);
  const relationVisits = seriesFromMap(dayVisits(state.bathroom), "day", fill);
  const relationWater = seriesFromMap(dayWater(state.pumps), "day", fill);
  const relationLabels = [...new Set([
    ...relationVisits.map((point) => point.key),
    ...relationWater.map((point) => point.key)
  ])].sort();
  const visitsLookup = new Map(relationVisits.map((point) => [point.key, point.value]));
  const waterLookup = new Map(relationWater.map((point) => [point.key, point.value]));

  const hours = new Map();
  for (let hour = 8; hour <= 15; hour += 1) hours.set(hour, 0);
  rows.forEach((row) => {
    if (!row.recorded_at) return;
    const hour = istParts(row.recorded_at).hour;
    hours.set(hour, (hours.get(hour) || 0) + Number(row.count_increment || 0));
  });
  const hourSeries = [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, count]) => ({ hour, count }));

  const bathrooms = new Map();
  state.bathroom.forEach((row) => {
    const id = row.bathroom_id || "unknown";
    bathrooms.set(id, (bathrooms.get(id) || 0) + Number(row.count_increment || 0));
  });
  const bathroomSeries = [...bathrooms.entries()].sort((a, b) => b[1] - a[1]);
  const bathroomTotal = bathroomSeries.reduce((sum, entry) => sum + entry[1], 0);
  document.getElementById("bathroomChart").parentElement.classList.toggle(
    "short",
    bathroomSeries.length > 0 && bathroomSeries.length < 3
  );

  document.getElementById("visitsDayCaption").textContent = bathroomSelect.value
    ? prettyBathroom(bathroomSelect.value)
    : "All bathrooms";
  document.getElementById("bathroomCaption").textContent = bathroomSeries.length
    ? `${bathroomSeries.length} bathroom${bathroomSeries.length === 1 ? "" : "s"} in this range`
    : "Share of visits";
  document.getElementById("waterCaption").textContent =
    state.waterGrain === "day" ? "Estimated litres by day" :
    state.waterGrain === "week" ? "Estimated litres by week" :
    "Estimated litres by month";

  mountChart("visitsDayChart", "visitsDayEmpty", daily.some((point) => point.value > 0), {
    type: "bar",
    data: {
      labels: daily.map((point) => point.label),
      datasets: [{
        label: "Visits",
        data: daily.map((point) => Math.round(point.value)),
        backgroundColor: FOOT_COLOR,
        borderRadius: 6,
        maxBarThickness: 28
      }]
    },
    options: chartBase(false)
  });

  mountChart("visitsHourChart", "visitsHourEmpty", hourSeries.some((point) => point.count > 0), {
    type: "bar",
    data: {
      labels: hourSeries.map((point) => hourLabel(point.hour)),
      datasets: [{
        label: "Visits",
        data: hourSeries.map((point) => Math.round(point.count)),
        backgroundColor: hourSeries.map((point) =>
          point.hour >= 8 && point.hour <= 15 ? FOOT_COLOR : "#9aa8bd"
        ),
        borderRadius: 6,
        maxBarThickness: 36
      }]
    },
    options: {
      ...chartBase(false),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: "Visits" } }
      }
    }
  });

  mountChart("bathroomChart", "bathroomEmpty", bathroomTotal > 0, {
    type: "bar",
    data: {
      labels: bathroomSeries.map(([id]) => prettyBathroom(id)),
      datasets: [{
        label: "Visits",
        data: bathroomSeries.map((entry) => Math.round(entry[1])),
        backgroundColor: "#5b7cfa",
        borderRadius: 6,
        maxBarThickness: 42
      }]
    },
    options: {
      ...chartBase(false),
      indexAxis: "y",
      scales: {
        x: { beginAtZero: true, grid: { display: false } },
        y: { grid: { display: false } }
      }
    }
  });

  mountChart("waterChart", "waterEmpty", water.some((point) => point.value > 0), {
    type: "bar",
    data: {
      labels: water.map((point) => point.label),
      datasets: [{
        label: "Estimated litres",
        data: water.map((point) => Math.round(point.value)),
        backgroundColor: WATER_COLOR,
        borderRadius: 6,
        maxBarThickness: 28
      }]
    },
    options: {
      ...chartBase(false),
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, title: { display: true, text: "Litres" } }
      }
    }
  });

  const relationHasData = relationLabels.some((key) =>
    (visitsLookup.get(key) || 0) > 0 || (waterLookup.get(key) || 0) > 0
  );

  mountChart("relationChart", "relationEmpty", relationHasData, {
    type: "bar",
    data: {
      labels: relationLabels.map((key) => formatDayKey(key)),
      datasets: [
        {
          type: "bar",
          label: "Visits",
          data: relationLabels.map((key) => Math.round(visitsLookup.get(key) || 0)),
          backgroundColor: "rgba(47, 111, 237, 0.75)",
          borderRadius: 6,
          maxBarThickness: 22,
          yAxisID: "y",
          order: 2
        },
        {
          type: "line",
          label: "Estimated litres",
          data: relationLabels.map((key) => Math.round(waterLookup.get(key) || 0)),
          borderColor: WATER_COLOR,
          backgroundColor: WATER_COLOR,
          tension: 0.25,
          pointRadius: 3,
          yAxisID: "y1",
          order: 1
        }
      ]
    },
    options: {
      ...chartBase(true),
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, position: "left", title: { display: true, text: "Visits" } },
        y1: {
          beginAtZero: true,
          position: "right",
          grid: { display: false },
          title: { display: true, text: "Litres" }
        }
      }
    }
  });
}

function renderDevices() {
  const body = document.getElementById("devicesBody");
  const bathroomDevices = firstBy(state.bathroomLatest, "device_id").map((row) => ({
    id: row.device_id,
    role: prettyBathroom(row.bathroom_id),
    at: row.recorded_at,
    rssi: row.wifi_rssi
  }));
  const pumpDevices = firstBy(state.pumpLatest, "device_id").map((row) => ({
    id: row.device_id,
    role: prettyBathroom(row.pump_id || "pump"),
    at: row.started_at,
    rssi: row.wifi_rssi
  }));
  const devices = [...bathroomDevices, ...pumpDevices];

  if (!devices.length) {
    body.innerHTML = `<p class="muted">No device uploads yet.</p>`;
    return;
  }

  body.innerHTML = devices
    .map((device) => {
      const status = freshness(device.at);
      return `
        <article class="device">
          <div>
            <strong>${escapeHtml(device.id || "—")}</strong>
            <span class="meta">${escapeHtml(device.role)} · ${escapeHtml(formatDateTime(device.at))} · ${escapeHtml(signalText(device.rssi))}</span>
          </div>
          <span class="pill ${status.tone}">${escapeHtml(status.label)}</span>
        </article>
      `;
    })
    .join("");
}

function renderBathroomTable() {
  const body = document.getElementById("bathroomBody");
  const rows = [...visibleBathroomRows()].sort((a, b) =>
    new Date(b.recorded_at) - new Date(a.recorded_at)
  );

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5">No visit uploads in this range.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .slice(0, 12)
    .map((row) => `
      <tr>
        <td>${escapeHtml(formatDateTime(row.recorded_at))}</td>
        <td>${escapeHtml(prettyBathroom(row.bathroom_id))}</td>
        <td>${escapeHtml(formatCount(row.count_increment))}</td>
        <td>${row.cumulative_count == null ? "—" : escapeHtml(formatCount(row.cumulative_count))}</td>
        <td>${escapeHtml(signalText(row.wifi_rssi))}</td>
      </tr>
    `)
    .join("");
}

function renderPumpTable() {
  const body = document.getElementById("eventsBody");
  const rows = [...state.pumps].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5">No pump runs in this range.</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .slice(0, 20)
    .map((row) => `
      <tr>
        <td>${escapeHtml(formatDateTime(row.started_at))}</td>
        <td>${escapeHtml(formatDateTime(row.stopped_at))}</td>
        <td>${escapeHtml(formatRuntime(row.runtime_seconds))}</td>
        <td>${escapeHtml(formatLitres(litresFor(row.runtime_seconds)))}</td>
        <td>${escapeHtml(signalText(row.wifi_rssi))}</td>
      </tr>
    `)
    .join("");
}

function reading(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatAmps(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  return `${number.toFixed(number >= 10 ? 1 : 2)} A`;
}

function destroyCharts(ids) {
  ids.forEach((id) => {
    if (state.charts[id]) {
      state.charts[id].destroy();
      delete state.charts[id];
    }
  });
}

function establishBaseline(runs) {
  const averages = runs.map((run) => reading(run.avg_current)).filter((value) => value != null);
  if (!averages.length) return { amps: null, reliable: false, samples: 0 };

  const mid = median(averages);
  const core = averages.filter((value) => value >= mid * 0.55 && value <= mid * 1.45);
  return {
    amps: core.length >= 5 ? median(core) : mid,
    reliable: averages.length >= MIN_BASELINE_RUNS && core.length >= 5 && mid > 0,
    samples: averages.length
  };
}

function bearingDrift(runs) {
  const byWeek = new Map();
  runs.forEach((run) => {
    const avg = reading(run.avg_current);
    if (avg == null || !run.started_at) return;
    const week = weekStartKey(istParts(run.started_at).key);
    const values = byWeek.get(week) || [];
    values.push(avg);
    byWeek.set(week, values);
  });

  const weeks = [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, values]) => ({
      week,
      label: formatBucket(week, "week"),
      median: median(values),
      count: values.length
    }));

  if (weeks.length < MIN_DRIFT_WEEKS) {
    return { flagged: false, weeks, older: null, newer: null };
  }

  const mid = Math.floor(weeks.length / 2);
  const older = median(weeks.slice(0, mid).map((week) => week.median));
  const newer = median(weeks.slice(mid).map((week) => week.median));
  return {
    flagged: older > 0 && newer >= older * DRIFT_RATIO,
    weeks,
    older,
    newer
  };
}

function analyzePumpHealth(runs) {
  const baseline = establishBaseline(runs);
  const base = baseline.amps;
  const ordered = [...runs].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const classified = ordered.map((run) => {
    const avg = reading(run.avg_current);
    const max = reading(run.max_current);
    if (avg == null && max == null) {
      return { run, avg, max, findings: [], kind: "no-current" };
    }
    if (!baseline.reliable || base == null) {
      return { run, avg, max, findings: [], kind: "learning" };
    }

    const dry = avg != null && avg < base * DRY_RATIO;
    const jam = max != null && max > base * JAM_RATIO && (avg == null || max >= avg * JAM_SPIKE_RATIO);
    const elevated = avg != null && avg > base * OVERLOAD_RATIO && !jam && !dry;
    return { run, avg, max, dry, jam, elevated, findings: [], kind: "normal" };
  });

  let streak = 0;
  classified.forEach((item) => {
    if (item.kind === "no-current" || item.kind === "learning") {
      streak = 0;
      return;
    }
    if (item.elevated) streak += 1;
    else streak = 0;
    const findings = [];
    if (item.jam) findings.push("jam");
    if (item.elevated && streak >= OVERLOAD_STREAK) findings.push("overload");
    if (item.dry) findings.push("dry");
    item.findings = findings;
    item.kind = findings[0] || (item.elevated ? "elevated" : "normal");
  });

  return { baseline, classified, drift: bearingDrift(ordered) };
}

function findingLabel(item) {
  const names = {
    dry: "Dry run / cavitation",
    jam: "Jamming / blockage",
    overload: "Motor overload",
    elevated: "Above baseline",
    normal: "Normal",
    learning: "Baseline forming",
    "no-current": "No current"
  };
  if (item.findings.length) return item.findings.map((finding) => names[finding]).join(", ");
  return names[item.kind] || "—";
}

function findingTone(item) {
  if (item.findings.includes("jam") || item.findings.includes("overload")) return "error";
  if (item.findings.includes("dry") || item.kind === "elevated") return "warn";
  if (item.kind === "normal") return "ok";
  return "";
}

function setStatus(id, label, tone) {
  const el = document.getElementById(id);
  el.textContent = label;
  el.className = tone ? `status ${tone}` : "status";
}

function latestPumpEvent() {
  return [...state.pumpLatest, ...state.pumps]
    .filter((run) => run.started_at)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0] || null;
}

function pluralRuns(count) {
  return `${formatCount(count)} run${count === 1 ? "" : "s"}`;
}

const pumpScene = {
  raf: 0,
  active: false,
  replay: true,
  reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  model: null,
  readKey: ""
};

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function formatVolume(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return formatLitres(value);
  if (value >= 100) return `${Math.round(value).toLocaleString("en-IN")} L`;
  return `${value.toFixed(1)} L`;
}

function sceneMotion(model, time) {
  if (!model) return { litres: 0, seconds: 0, moving: false };
  if (model.live && model.startedAt) {
    const seconds = Math.max(0, (Date.now() - new Date(model.startedAt).getTime()) / 1000);
    return { litres: litresFor(seconds), seconds, moving: true };
  }
  if (model.hasRun && pumpScene.replay && !pumpScene.reduced) {
    const t = (time % 6800) / 6800;
    return {
      litres: model.cycleLitres * t,
      seconds: model.cycleSeconds * t,
      moving: true
    };
  }
  return { litres: model.cycleLitres || 0, seconds: model.cycleSeconds || 0, moving: false };
}

function tankLevel(litres) {
  if (!litres || litres <= 0) return 0.08;
  return Math.min(0.9, 0.12 + 0.78 * (1 - Math.exp(-litres / 70)));
}

function pointAlong(points, t) {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(length);
    total += length;
  }
  let dist = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (dist <= lengths[i] || i === lengths.length - 1) {
      const u = lengths[i] ? dist / lengths[i] : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * u,
        y: points[i].y + (points[i + 1].y - points[i].y) * u
      };
    }
    dist -= lengths[i];
  }
  return points[points.length - 1];
}

function drawWater(ctx, tank, level, time, bubbly) {
  const fillTop = tank.y + tank.h * (1 - level);
  ctx.save();
  roundRect(ctx, tank.x, tank.y, tank.w, tank.h, 12);
  ctx.clip();
  ctx.fillStyle = "#2f6fed";
  ctx.fillRect(tank.x, fillTop, tank.w, tank.y + tank.h - fillTop);
  ctx.beginPath();
  ctx.moveTo(tank.x, fillTop);
  for (let x = 0; x <= tank.w; x += 6) {
    ctx.lineTo(tank.x + x, fillTop + Math.sin(x / 14 + time / 280) * 2.4);
  }
  ctx.lineTo(tank.x + tank.w, fillTop + 7);
  ctx.lineTo(tank.x, fillTop + 7);
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.fill();
  if (bubbly) {
    ctx.fillStyle = "rgba(255,255,255,.75)";
    for (let i = 0; i < 5; i += 1) {
      const y = fillTop + 16 + ((time / 18 + i * 23) % (tank.h * level - 10));
      ctx.beginPath();
      ctx.arc(tank.x + 18 + (i % 3) * 22, y, 2.5 + (i % 2), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.strokeStyle = "#d5deea";
  ctx.lineWidth = 2;
  roundRect(ctx, tank.x, tank.y, tank.w, tank.h, 12);
  ctx.stroke();
}

function drawPumpFrame(time) {
  const canvas = document.getElementById("pumpCanvas");
  const model = pumpScene.model;
  if (!canvas || !model) return;
  const bounds = canvas.parentElement.getBoundingClientRect();
  if (bounds.width < 20) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = bounds.width;
  const height = bounds.height;
  const pixelW = Math.round(width * dpr);
  const pixelH = Math.round(height * dpr);
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const motion = sceneMotion(model, time || 0);
  const sourceW = Math.min(150, width * 0.18);
  const deliveryW = Math.min(168, width * 0.2);
  const source = { x: 24, y: height * 0.34, w: sourceW, h: height * 0.48 };
  const delivery = { x: width - 24 - deliveryW, y: 28, w: deliveryW, h: height * 0.42 };
  const pump = { x: width * 0.42, y: height * 0.64, r: Math.min(50, height * 0.18) };
  const headerY = delivery.y + delivery.h * 0.42;
  const path = [
    { x: source.x + source.w, y: source.y + source.h * 0.4 },
    { x: pump.x - pump.r, y: pump.y },
    { x: pump.x - 6, y: pump.y },
    { x: pump.x + 6, y: pump.y - pump.r },
    { x: pump.x + 6, y: headerY },
    { x: delivery.x, y: headerY }
  ];

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f4f7fb";
  ctx.fillRect(0, 0, width, height);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  path.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  ctx.strokeStyle = "#7f8da3";
  ctx.lineWidth = 16;
  ctx.stroke();
  ctx.strokeStyle = "#e7eef8";
  ctx.lineWidth = 8;
  ctx.stroke();

  const sourceLevel = motion.moving ? 0.62 + Math.sin(time / 500) * 0.03 : 0.66;
  drawWater(ctx, source, sourceLevel, time || 0, model.fault === "dry" && motion.moving);
  drawWater(ctx, delivery, tankLevel(motion.litres), time || 0, false);

  const housing = model.fault === "jam" ? "#a73333" : model.fault === "overload" ? "#b45309" : "#172033";
  ctx.beginPath();
  ctx.arc(pump.x, pump.y, pump.r, 0, Math.PI * 2);
  ctx.fillStyle = "#eef3f8";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = housing;
  ctx.stroke();

  const spin = motion.moving ? (model.fault === "jam" ? 0.004 : 0.012) * (time || 0) : 0.4;
  ctx.save();
  ctx.translate(pump.x, pump.y);
  ctx.rotate(spin);
  ctx.fillStyle = "#2f6fed";
  for (let vane = 0; vane < 6; vane += 1) {
    ctx.rotate(Math.PI / 3);
    roundRect(ctx, 8, -5, pump.r - 18, 10, 4);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 9, 0, Math.PI * 2);
  ctx.fillStyle = "#172033";
  ctx.fill();
  ctx.restore();

  const motorX = pump.x - 48;
  const motorY = pump.y + pump.r + 10;
  roundRect(ctx, motorX, motorY, 96, 34, 8);
  ctx.fillStyle = "#243044";
  ctx.fill();
  ctx.fillStyle = motion.moving && model.live ? "#3dd68c" : motion.moving ? "#f5c16c" : "#98a2b3";
  ctx.beginPath();
  ctx.arc(motorX + 16, motorY + 17, 5, 0, Math.PI * 2);
  ctx.fill();

  if (motion.moving) {
    for (let i = 0; i < 14; i += 1) {
      const point = pointAlong(path, ((time / 1400) + i / 14) % 1);
      if (Math.hypot(point.x - pump.x, point.y - pump.y) < pump.r - 2) continue;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#2f6fed";
      ctx.fill();
    }
  }

  ctx.fillStyle = "#172033";
  ctx.font = "700 13px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Suction", source.x, source.y + source.h + 18);
  ctx.fillText("Delivery", delivery.x, delivery.y + delivery.h + 18);
  const volume = formatVolume(motion.litres);
  const levelTop = delivery.y + delivery.h * (1 - tankLevel(motion.litres));
  ctx.fillStyle = levelTop < delivery.y + 36 ? "#ffffff" : "#172033";
  ctx.font = "800 18px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(volume, delivery.x + 12, delivery.y + 26);
  ctx.fillStyle = motion.moving && model.live ? "#247445" : "#8a5a10";
  ctx.font = "800 12px Inter, ui-sans-serif, system-ui, sans-serif";
  const badge = model.live ? "RUNNING" : motion.moving ? "REPLAY" : model.hasRun ? "IDLE" : "NO RUNS";
  ctx.fillText(badge, 24, 28);

  const readKey = [
    model.flow,
    formatVolume(motion.litres),
    formatLitres(model.rangeLitres),
    formatRuntime(motion.seconds),
    model.current == null ? "—" : formatAmps(model.current)
  ].join("|");
  if (readKey !== pumpScene.readKey) {
    pumpScene.readKey = readKey;
    document.getElementById("sceneFlow").textContent = `${model.flow} L/min`;
    document.getElementById("sceneVolume").textContent = formatVolume(motion.litres);
    document.getElementById("sceneRange").textContent = formatLitres(model.rangeLitres || 0);
    document.getElementById("sceneRuntime").textContent = formatRuntime(motion.seconds);
    document.getElementById("sceneCurrent").textContent = model.current == null
      ? "Not recorded"
      : `${formatAmps(model.current)} avg`;
    canvas.setAttribute("aria-label", `${badge}. ${volume} this cycle at ${model.flow} litres per minute.`);
  }
}

function ensurePumpLoop() {
  if (pumpScene.reduced) {
    drawPumpFrame(0);
    return;
  }
  if (pumpScene.active) return;
  pumpScene.active = true;
  const tick = (time) => {
    if (!pumpScene.active) return;
    drawPumpFrame(time);
    pumpScene.raf = requestAnimationFrame(tick);
  };
  pumpScene.raf = requestAnimationFrame(tick);
}

function stopPumpLoop() {
  pumpScene.active = false;
  if (pumpScene.raf) cancelAnimationFrame(pumpScene.raf);
  pumpScene.raf = 0;
}

function updatePumpScene(latest, rangeSeconds, classified) {
  const live = Boolean(latest && !latest.stopped_at);
  const cycleSeconds = latest ? Number(latest.runtime_seconds || 0) : 0;
  const match = latest && classified.find((item) =>
    item.run.started_at === latest.started_at && item.run.device_id === latest.device_id
  );
  pumpScene.model = {
    live,
    hasRun: Boolean(latest),
    startedAt: latest?.started_at || null,
    flow: flowLpm(),
    rangeLitres: litresFor(rangeSeconds),
    cycleSeconds,
    cycleLitres: litresFor(cycleSeconds),
    current: latest ? reading(latest.avg_current) : null,
    fault: match && ["dry", "jam", "overload"].includes(match.kind) ? match.kind : "normal"
  };
  const button = document.getElementById("pumpReplayBtn");
  const caption = document.getElementById("pumpSceneCaption");
  button.hidden = live || !latest || pumpScene.reduced;
  button.textContent = pumpScene.replay ? "Pause replay" : "Play replay";
  if (live) caption.textContent = "Live cycle. Volume is flow rate times time since the pump started.";
  else if (!latest) caption.textContent = "No cycle recorded yet.";
  else if (!pumpScene.replay || pumpScene.reduced) caption.textContent = "Pump is idle. Last cycle held.";
  else caption.textContent = "Pump is idle. Replaying the last cycle.";
  pumpScene.readKey = "";
  if (state.view === "health") ensurePumpLoop();
  else stopPumpLoop();
}

function renderHealth() {
  const report = analyzePumpHealth(state.pumps);
  const { baseline, classified, drift } = report;
  const counts = { dry: 0, jam: 0, overload: 0, elevated: 0, current: 0 };
  classified.forEach((item) => {
    if (item.avg != null || item.max != null) counts.current += 1;
    item.findings.forEach((finding) => {
      counts[finding] += 1;
    });
    if (item.kind === "elevated") counts.elevated += 1;
  });
  const flagged = classified.filter((item) => item.findings.length);
  const latest = latestPumpEvent();
  const runtime = state.pumps.reduce((sum, run) => sum + Number(run.runtime_seconds || 0), 0);
  const banner = document.getElementById("healthBanner");
  const bannerTitle = document.getElementById("healthBannerTitle");
  const bannerText = document.getElementById("healthBannerText");

  if (latest && !latest.stopped_at) {
    document.getElementById("healthNow").textContent = "Running";
    document.getElementById("healthNowSub").textContent = `Since ${formatDateTime(latest.started_at)}`;
  } else if (latest) {
    document.getElementById("healthNow").textContent = "Idle";
    document.getElementById("healthNowSub").textContent = `Last stop ${formatDateTime(latest.stopped_at || latest.started_at)}`;
  } else {
    document.getElementById("healthNow").textContent = "No runs";
    document.getElementById("healthNowSub").textContent = "No pump cycles yet";
  }

  document.getElementById("healthRuntime").textContent = formatRuntime(runtime);
  document.getElementById("healthRuntimeSub").textContent =
    `${formatCount(state.pumps.length)} cycle${state.pumps.length === 1 ? "" : "s"} in this range`;

  document.getElementById("healthBaseline").textContent = baseline.reliable ? formatAmps(baseline.amps) : "—";
  document.getElementById("healthBaselineSub").textContent = baseline.samples
    ? baseline.reliable
      ? `Median of ${formatCount(baseline.samples)} runs`
      : `${formatCount(baseline.samples)} of ${MIN_BASELINE_RUNS} runs needed`
    : "No average current yet";

  document.getElementById("healthFlags").textContent = formatCount(flagged.length);
  document.getElementById("healthFlagsSub").textContent = drift.flagged
    ? "Plus a rising weekly baseline"
    : counts.current
      ? "Dry run, jam, or overload"
      : "Current not recorded yet";

  const waiting = !state.pumps.length
    ? "No pump cycles in this range."
    : !counts.current
      ? "Waiting for average and peak current on these runs."
      : !baseline.reliable
        ? `Need ${MIN_BASELINE_RUNS} runs with current before a run can be flagged. This range has ${formatCount(baseline.samples)}.`
        : null;

  setStatus("faultDry", waiting ? "Waiting" : counts.dry ? pluralRuns(counts.dry) : "Clear", waiting ? "warn" : counts.dry ? "warn" : "ok");
  document.getElementById("faultDryDetail").textContent = waiting || counts.dry
    ? waiting || `${pluralRuns(counts.dry)} averaged under ${Math.round(DRY_RATIO * 100)}% of the ${formatAmps(baseline.amps)} baseline. That fits a pump that has run out of water or drawn in air.`
    : `No run averaged under ${Math.round(DRY_RATIO * 100)}% of the ${formatAmps(baseline.amps)} baseline.`;

  setStatus("faultJam", waiting ? "Waiting" : counts.jam ? pluralRuns(counts.jam) : "Clear", waiting ? "warn" : counts.jam ? "error" : "ok");
  document.getElementById("faultJamDetail").textContent = waiting || counts.jam
    ? waiting || `${pluralRuns(counts.jam)} peaked above ${Math.round(JAM_RATIO * 100)}% of baseline. A blocked impeller or valve makes the motor work much harder and can overheat the windings.`
    : `No peak jumped above ${Math.round(JAM_RATIO * 100)}% of the ${formatAmps(baseline.amps)} baseline.`;

  if (!counts.current) {
    setStatus("faultBearing", state.pumps.length ? "Waiting" : "Waiting", "warn");
    document.getElementById("faultBearingDetail").textContent = state.pumps.length
      ? "Waiting for average current. Bearing wear shows up as a gradual rise in the weekly median, so it needs several weeks."
      : "No pump cycles in this range.";
  } else if (drift.weeks.length < MIN_DRIFT_WEEKS) {
    setStatus("faultBearing", "Need weeks", "warn");
    document.getElementById("faultBearingDetail").textContent =
      `A gradual rise needs at least ${MIN_DRIFT_WEEKS} separate weeks of current. This range has ${formatCount(drift.weeks.length)}.`;
  } else if (drift.flagged) {
    setStatus("faultBearing", "Drifting up", "warn");
    document.getElementById("faultBearingDetail").textContent =
      `The weekly median rose from ${formatAmps(drift.older)} to ${formatAmps(drift.newer)}. Extra mechanical friction, such as bearing wear, can cause that slow climb.`;
  } else {
    setStatus("faultBearing", "Clear", "ok");
    document.getElementById("faultBearingDetail").textContent =
      `Across ${formatCount(drift.weeks.length)} weeks, the later median (${formatAmps(drift.newer)}) has not risen ${Math.round((DRIFT_RATIO - 1) * 100)}% above the earlier one (${formatAmps(drift.older)}).`;
  }

  setStatus(
    "faultOverload",
    waiting ? "Waiting" : counts.overload ? pluralRuns(counts.overload) : "Clear",
    waiting ? "warn" : counts.overload ? "error" : "ok"
  );
  document.getElementById("faultOverloadDetail").textContent = waiting || counts.overload
    ? waiting || `${pluralRuns(counts.overload)} stayed above ${Math.round(OVERLOAD_RATIO * 100)}% of baseline for ${OVERLOAD_STREAK} or more cycles in a row. That continuous over-current sits outside the pump’s efficient range.`
    : counts.elevated
      ? `${pluralRuns(counts.elevated)} averaged above ${Math.round(OVERLOAD_RATIO * 100)}% of baseline, but not for ${OVERLOAD_STREAK} cycles in a row.`
      : `No stretch of ${OVERLOAD_STREAK} runs stayed above ${Math.round(OVERLOAD_RATIO * 100)}% of baseline.`;

  if (!state.pumps.length) {
    banner.className = "health-banner warn";
    bannerTitle.textContent = "No pump runs in this range";
    bannerText.textContent = "Widen the dates to include cycles. Health checks use start, stop, average current, and peak current.";
  } else if (!counts.current) {
    banner.className = "health-banner warn";
    bannerTitle.textContent = "No current readings yet";
    bannerText.textContent = `${pluralRuns(state.pumps.length)} have start and stop times, and none include current. Dry-run, jam, bearing wear, and overload checks start when the monitor sends average and peak current.`;
  } else if (!baseline.reliable) {
    banner.className = "health-banner warn";
    bannerTitle.textContent = "Baseline still forming";
    bannerText.textContent = `${formatCount(baseline.samples)} of ${MIN_BASELINE_RUNS} runs with current are in this range. Nothing is flagged until the pump’s normal load is clear.`;
  } else if (counts.jam || counts.overload) {
    banner.className = "health-banner error";
    bannerTitle.textContent = "Pump needs attention";
    bannerText.textContent = healthSummary(counts, drift, baseline);
  } else if (counts.dry || drift.flagged) {
    banner.className = "health-banner warn";
    bannerTitle.textContent = "Check the pump";
    bannerText.textContent = healthSummary(counts, drift, baseline);
  } else if (counts.elevated) {
    banner.className = "health-banner warn";
    bannerTitle.textContent = "Current sometimes high";
    bannerText.textContent = `${pluralRuns(counts.elevated)} rose above the ${formatAmps(baseline.amps)} baseline, but not for long enough to call an overload.`;
  } else {
    banner.className = "health-banner ok";
    bannerTitle.textContent = "Current looks normal";
    bannerText.textContent = `No dry run, jam, overload, or bearing drift in this range. Normal load is ${formatAmps(baseline.amps)}.`;
  }

  renderHealthCharts(report);
  renderHealthTable(classified);
  updatePumpScene(latest, runtime, classified);
}

function healthSummary(counts, drift, baseline) {
  const parts = [];
  if (counts.jam) {
    parts.push(`${pluralRuns(counts.jam)} peaked hard enough to fit jamming or blockage`);
  }
  if (counts.overload) {
    parts.push(`${pluralRuns(counts.overload)} carried sustained over-current`);
  }
  if (counts.dry) {
    parts.push(`${pluralRuns(counts.dry)} ran well below the normal load`);
  }
  if (drift.flagged) {
    parts.push(`the weekly baseline rose from ${formatAmps(drift.older)} to ${formatAmps(drift.newer)}`);
  }
  const joined = parts.join("; ");
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1);
  return `${sentence}. Normal load for these dates is ${formatAmps(baseline.amps)}.`;
}

function renderHealthCharts(report) {
  const { baseline, classified, drift } = report;
  const points = classified.filter((item) => item.avg != null || item.max != null);
  document.getElementById("currentCaption").textContent = baseline.reliable
    ? `Baseline ${formatAmps(baseline.amps)}`
    : "Average and peak current";
  document.getElementById("currentChart").parentElement.classList.toggle("short", points.length === 0);
  document.getElementById("driftChart").parentElement.classList.toggle("short", drift.weeks.length === 0);

  const datasets = [
    {
      label: "Average current",
      data: points.map((item) => item.avg),
      borderColor: FOOT_COLOR,
      backgroundColor: FOOT_COLOR,
      tension: 0.2,
      spanGaps: false,
      pointRadius: 3
    },
    {
      label: "Peak current",
      data: points.map((item) => item.max),
      borderColor: PEAK_COLOR,
      backgroundColor: PEAK_COLOR,
      tension: 0.2,
      spanGaps: false,
      pointRadius: 3
    }
  ];

  if (baseline.reliable) {
    datasets.push({
      label: "Baseline",
      data: points.map(() => Number(baseline.amps.toFixed(2))),
      borderColor: "#98a2b3",
      backgroundColor: "#98a2b3",
      borderDash: [4, 4],
      pointRadius: 0,
      tension: 0
    });
  }

  mountChart("currentChart", "currentEmpty", points.length > 0, {
    type: "line",
    data: {
      labels: points.map((item) => formatDateTime(item.run.started_at)),
      datasets
    },
    options: {
      ...chartBase(true),
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
        y: { beginAtZero: true, title: { display: true, text: "Amps" } }
      }
    }
  });

  const mid = Math.floor(drift.weeks.length / 2);
  mountChart("driftChart", "driftEmpty", drift.weeks.length > 0, {
    type: "bar",
    data: {
      labels: drift.weeks.map((week) => week.label),
      datasets: [{
        label: "Median amps",
        data: drift.weeks.map((week) => Number(week.median.toFixed(2))),
        backgroundColor: drift.weeks.map((_, index) =>
          drift.flagged && index >= mid ? PEAK_COLOR : FOOT_COLOR
        ),
        borderRadius: 6,
        maxBarThickness: 36
      }]
    },
    options: {
      ...chartBase(false),
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, title: { display: true, text: "Amps" } }
      }
    }
  });
}

function renderHealthTable(classified) {
  const body = document.getElementById("healthBody");
  const caption = document.getElementById("healthRunsCaption");
  const newest = [...classified].reverse();
  const shown = newest.slice(0, 40);
  caption.textContent = newest.length > shown.length
    ? `Newest 40 of ${formatCount(newest.length)} cycles`
    : "Each cycle in the selected dates, newest first";

  if (!shown.length) {
    body.innerHTML = `<tr><td colspan="5">No pump runs in this range.</td></tr>`;
    return;
  }

  body.innerHTML = shown.map((item) => {
    const tone = findingTone(item);
    const runtime = item.run.stopped_at ? formatRuntime(item.run.runtime_seconds) : "In progress";
    return `
      <tr>
        <td>${escapeHtml(formatDateTime(item.run.started_at))}</td>
        <td>${escapeHtml(runtime)}</td>
        <td>${escapeHtml(formatAmps(item.avg))}</td>
        <td>${escapeHtml(formatAmps(item.max))}</td>
        <td><span class="pill ${tone}">${escapeHtml(findingLabel(item))}</span></td>
      </tr>
    `;
  }).join("");
}

function applyViewChrome() {
  const health = state.view === "health";
  document.body.dataset.view = state.view;
  document.querySelector("h1").textContent = health ? "Pump health dashboard" : "School usage dashboard";
  document.querySelector(".sub").textContent = health
    ? "Run time and current draw for this pump. Faults are judged against its own baseline. Times are India Standard Time."
    : "Anonymous bathroom visits and estimated pump water. Times are India Standard Time.";
  document.querySelector(".eyebrow").textContent = health ? "NPS HSR · Pump health" : "NPS HSR · Bathroom & water";
  document.title = health ? "NPS HSR · Pump health" : "NPS HSR · Bathroom & Water";
  document.getElementById("view-usage").hidden = health;
  document.getElementById("view-health").hidden = !health;
  document.getElementById("tab-usage").setAttribute("aria-selected", String(!health));
  document.getElementById("tab-health").setAttribute("aria-selected", String(health));
}

function setView(view) {
  state.view = view === "health" ? "health" : "usage";
  const url = new URL(location.href);
  url.hash = state.view === "health" ? "health" : "";
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  applyViewChrome();
  render();
}

function render() {
  syncBathroomOptions();
  if (state.view === "health") {
    destroyCharts(USAGE_CHART_IDS);
    renderHealth();
    return;
  }
  destroyCharts(HEALTH_CHART_IDS);
  stopPumpLoop();
  renderCards();
  renderInsights();
  renderCharts();
  renderDevices();
  renderBathroomTable();
  renderPumpTable();
}

async function loadData() {
  const gen = ++loadGen;
  const { from, to } = rangeBounds();

  syncStatus.textContent = "Loading…";
  syncStatus.className = "status";
  loadError.hidden = true;
  refreshBtn.disabled = true;

  const bathroomParams = new URLSearchParams({
    select: "device_id,bathroom_id,count_increment,cumulative_count,recorded_at,wifi_rssi",
    order: "recorded_at.asc"
  });
  const pumpParams = new URLSearchParams({
    select: "device_id,pump_id,started_at,stopped_at,runtime_seconds,avg_current,max_current,wifi_rssi",
    order: "started_at.asc"
  });

  if (from) {
    bathroomParams.append("recorded_at", `gte.${from}T00:00:00+05:30`);
    pumpParams.append("started_at", `gte.${from}T00:00:00+05:30`);
  }
  if (to) {
    bathroomParams.append("recorded_at", `lte.${to}T23:59:59.999+05:30`);
    pumpParams.append("started_at", `lte.${to}T23:59:59.999+05:30`);
  }

  const latestBathroomParams = new URLSearchParams({
    select: "device_id,bathroom_id,recorded_at,wifi_rssi",
    order: "recorded_at.desc",
    limit: "300"
  });
  const latestPumpParams = new URLSearchParams({
    select: "device_id,pump_id,started_at,stopped_at,runtime_seconds,avg_current,max_current,wifi_rssi",
    order: "started_at.desc",
    limit: "100"
  });

  try {
    const [bathroom, pumps, bathroomLatest, pumpLatest] = await Promise.all([
      fetchAll(BATHROOM_ENDPOINT, bathroomParams),
      fetchAll(PUMP_ENDPOINT, pumpParams),
      fetchPage(BATHROOM_ENDPOINT, latestBathroomParams, 0),
      fetchPage(PUMP_ENDPOINT, latestPumpParams, 0)
    ]);

    if (gen !== loadGen) return;

    state.bathroom = bathroom.rows;
    state.pumps = pumps.rows;
    state.bathroomLatest = bathroomLatest;
    state.pumpLatest = pumpLatest;
    state.truncated = bathroom.truncated || pumps.truncated;

    const updated = new Intl.DateTimeFormat("en-GB", {
      timeZone: IST,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date());

    syncStatus.textContent = state.truncated ? `Partial data · ${updated} IST` : `Updated ${updated} IST`;
    syncStatus.className = state.truncated ? "status warn" : "status ok";
    render();
  } catch (error) {
    if (gen !== loadGen) return;
    console.error(error);
    syncStatus.textContent = "Could not load data";
    syncStatus.className = "status error";
    loadError.hidden = false;
    loadError.textContent = error.message || "Could not reach Supabase.";
  } finally {
    if (gen === loadGen) refreshBtn.disabled = false;
  }
}

function bind() {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  document.querySelectorAll("[data-grain]").forEach((button) => {
    button.addEventListener("click", () => {
      state.waterGrain = button.dataset.grain;
      document.querySelectorAll("[data-grain]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderCharts();
    });
  });

  fromInput.addEventListener("change", () => {
    markPreset("");
    loadData();
  });

  toInput.addEventListener("change", () => {
    markPreset("");
    loadData();
  });

  bathroomSelect.addEventListener("change", render);

  flowInput.addEventListener("change", () => {
    localStorage.setItem("pumpFlowLpm", flowInput.value);
    render();
  });

  refreshBtn.addEventListener("click", loadData);

  document.getElementById("pumpReplayBtn").addEventListener("click", () => {
    pumpScene.replay = !pumpScene.replay;
    pumpScene.readKey = "";
    document.getElementById("pumpReplayBtn").textContent = pumpScene.replay ? "Pause replay" : "Play replay";
    document.getElementById("pumpSceneCaption").textContent = pumpScene.replay
      ? "Pump is idle. Replaying the last cycle."
      : "Pump is idle. Last cycle held.";
  });

  document.getElementById("tab-usage").addEventListener("click", () => setView("usage"));
  document.getElementById("tab-health").addEventListener("click", () => setView("health"));
  window.addEventListener("hashchange", () => {
    const next = location.hash === "#health" ? "health" : "usage";
    if (next === state.view) return;
    state.view = next;
    applyViewChrome();
    render();
  });
}

function init() {
  const today = istTodayKey();
  fromInput.value = addDays(today, -29);
  toInput.value = today;
  state.view = location.hash === "#health" ? "health" : "usage";
  applyViewChrome();
  if (window.Chart) {
    Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;
    Chart.defaults.color = "#667085";
  }
  bind();
  loadData();
  setInterval(loadData, 60_000);
}

init();
