# NPS HSR bathroom and water dashboard

Static dashboard for school administrators. It reads two Supabase tables and does not collect personal data.

- `bathroom_people_count` — anonymous visit batches from ESP32 + VL53L0X counters (`count_increment`, `cumulative_count`, `recorded_at`, `wifi_rssi`)
- `pump_events` — pump start, stop, and runtime

Visit totals use `count_increment`. The on-device counter can reset, so it is shown only as a device reading.

Water is estimated as:

    litres = runtime_seconds / 60 × flow_litres_per_minute

The default flow is 30 L/min. Change it on the dashboard after a real calibration. The browser stores that value locally.

Times are shown in India Standard Time. Counters are expected to report during school hours, 7:30–16:00 IST.

## Deploy

Upload this folder to Vercel as a static site.

- `index.html`
- `style.css`
- `app.js`

## Security

The browser contains only the Supabase publishable key.

For production, enable Row Level Security and allow only the SELECT access this dashboard needs. Never put a secret or service-role key in `app.js`.
