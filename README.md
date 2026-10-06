# Pump Water Dashboard - Fixed

Static HTML/CSS/JavaScript dashboard for the ESP32 + Supabase pump monitor.

## Fixes in this version
- Chart containers have fixed heights.
- Chart.js canvases can no longer grow indefinitely.
- Charts are destroyed before being recreated.
- Chart animation is disabled to avoid repeated resize work.
- Added resizeDelay.
- Added axis labels for litres and minutes.
- Dashboard remains responsive on mobile.

## Deploy
Upload this folder to Vercel as a static site.

Files:
- index.html
- style.css
- app.js
- README.md

## Water estimate
The dashboard estimates:

    litres = runtime_seconds / 60 × flow_litres_per_minute

The default is 30 L/min. Change this in the dashboard after calibrating the actual pump flow.

## Security
The browser contains only the Supabase publishable key.

For production:
- enable Supabase Row Level Security
- allow only the required SELECT access for this dashboard
- never use a secret/service-role key in app.js
# pump-dashboard
