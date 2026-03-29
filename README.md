# Fitbit Smart HR Monitor

A browser-based heart rate monitoring dashboard powered by the Fitbit API. Monitors your heart rate in real-time, detects whether you are resting or walking, fires smart alerts when your heart rate stays elevated too long, and reminds you to get up after extended sitting periods.

No server, no build step, no npm. Open `index.html` with VS Code Live Server and it works.

---

## Features

| Feature | Details |
|---|---|
| **Real-time HR polling** | Fetches heart rate every 60 seconds via Fitbit intraday API |
| **Activity state detection** | Distinguishes Resting vs Walking using step count over a rolling 5-minute window |
| **Smart HR alerts** | Resting: high >110 BPM for 3 min / medium >105 BPM for 5 min; Walking: high >125 BPM for 1 min |
| **Sedentary reminder** | Alerts after 45 continuous minutes of sitting (15-minute cooldown) |
| **Sound alerts** | Synthesized beeps via Web Audio API — no audio files needed |
| **Browser notifications** | Native OS notifications for HR and sedentary alerts |
| **Today's Trend view** | Full-day HR + steps chart (00:00 → now) with avg / max / min stats |
| **Zoomable charts** | Scroll to zoom, drag to pan; shows selection statistics |
| **Token lifecycle** | 24-hour OAuth token with expiry countdown and in-dashboard reconnect banner |
| **Rate limit handling** | Respects Fitbit's 150 calls/hour limit; shows countdown on 429 |
| **Configurable thresholds** | All alert thresholds and timing adjustable in the Settings panel |

---

## Prerequisites

- A **Fitbit account** with a compatible heart-rate-tracking device
- A **Fitbit Developer app** registered at [dev.fitbit.com](https://dev.fitbit.com/apps/new)
- **VS Code** with the [Live Server extension](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) (or any local static file server on port 5500)

---

## Quick Start

### 1. Register a Fitbit App

1. Go to [dev.fitbit.com/apps/new](https://dev.fitbit.com/apps/new)
2. Fill in the form:
   - **Application Type**: `Personal`
   - **OAuth 2.0 Application Type**: `Client`
   - **Callback URL**: `http://127.0.0.1:5500/` *(must match exactly)*
   - **Default Access Type**: `Read-Only`
3. Under **Permissions**, enable: `Heart Rate` and `Activity`
4. Save and note your **OAuth 2.0 Client ID** (e.g. `23ABCDE`)

### 2. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/joyce_fitbitweb.git
cd joyce_fitbitweb

# Copy the example config and edit it
cp config.example.js config.js
```

Edit `config.js` to set your redirect URI (must match your Fitbit app's Callback URL):

```js
window.APP_CONFIG = {
  REDIRECT_URI: 'http://127.0.0.1:5500/',
  LOG_LEVEL: 'warn',
};
```

> `config.js` is in `.gitignore` and will never be committed.

### 3. Run

Open the project folder in VS Code and click **Go Live** in the bottom status bar.

The app opens at `http://127.0.0.1:5500/`. Enter your **Client ID** and click **Connect Fitbit**.

---

## Project Structure

```
joyce_fitbitweb/
├── index.html          # App shell — HTML markup only
├── src/
│   ├── style.css       # All styles
│   └── app.js          # All application logic
├── config.js           # Your local config (gitignored — never commit)
├── config.example.js   # Template — copy to config.js and customize
├── .gitignore
└── README.md
```

---

## Configuration Reference

`config.js` sets `window.APP_CONFIG` before the app loads:

| Key | Default | Description |
|---|---|---|
| `REDIRECT_URI` | `http://127.0.0.1:5500/` | Must exactly match your Fitbit app's registered Callback URL |
| `LOG_LEVEL` | `'warn'` | Console verbosity: `'debug'` / `'info'` / `'warn'` / `'error'` |

Alert thresholds and timing can be adjusted live in the **Settings** panel inside the dashboard — no code changes needed.

---

## Alert Rules (defaults)

| Mode | Level | Condition |
|---|---|---|
| Resting | High | HR > 110 BPM sustained for ≥ 3 minutes |
| Resting | Medium | HR > 105 BPM sustained for ≥ 5 minutes |
| Walking | High | HR > 125 BPM sustained for ≥ 1 minute |
| Any | Sedentary | Continuous resting for ≥ 45 minutes |

---

## API Usage

The app calls two Fitbit intraday endpoints per poll cycle (every 60 seconds):

```
GET /1/user/-/activities/heart/date/today/1d/1min.json
GET /1/user/-/activities/steps/date/today/1d/1min.json
```

This uses **120 calls/hour** — within Fitbit's 150-call-per-hour limit. HTTP 429 responses are handled automatically with a visible countdown and auto-retry.

---

## Tech Stack

- **Vanilla JavaScript** (ES6+) — no framework, no bundler
- **Chart.js 4.4** — dual-axis HR line + steps bar chart
- **chartjs-plugin-zoom 2.0** — scroll/pinch zoom and pan
- **Hammer.js 2.0** — touch support for chart interactions
- **Web Audio API** — synthesized beep alerts (no audio files)
- **Fitbit OAuth 2.0 Implicit Flow** — browser-only authentication

---

## Troubleshooting

**"redirect_uri_mismatch" error from Fitbit**
The `REDIRECT_URI` in `config.js` must exactly match the Callback URL in your Fitbit app — including trailing slash and port.

**No heart rate data shown**
Make sure your Fitbit device has synced recently and that both `heartrate` and `activity` scopes were granted during OAuth.

**Rate limited**
The header shows a countdown. The app retries automatically after the window expires. Avoid refreshing the page repeatedly.

**Token expired**
A red banner appears on the dashboard. Click **Reconnect Fitbit** for one-click re-auth using your saved Client ID.

---

## License

MIT
