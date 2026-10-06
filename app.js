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

function render() {
  syncBathroomOptions();
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
    select: "device_id,pump_id,started_at,stopped_at,runtime_seconds,wifi_rssi",
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
    select: "device_id,pump_id,started_at,wifi_rssi",
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
}

function init() {
  const today = istTodayKey();
  fromInput.value = addDays(today, -29);
  toInput.value = today;
  if (window.Chart) {
    Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;
    Chart.defaults.color = "#667085";
  }
  bind();
  loadData();
  setInterval(loadData, 60_000);
}

init();
