# Fitbit Smart HR Monitor

A browser-based heart rate monitoring dashboard powered by the Fitbit API. Monitors your heart rate in real-time, detects whether you are resting or walking, fires smart alerts when your heart rate stays elevated too long, reminds you to get up after extended sitting periods, and provides AI-powered daily health analysis via GPT-4o-mini.

No server, no build step. Open `index.html` with VS Code Live Server and it works.

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
| **AI Analysis tab** | GPT-4o-mini powered daily analysis: today's status, trend direction, risk assessment, root cause, and personalised suggestions |
| **Personal context file** | `personal.json` (local-only, gitignored) pre-fills the AI user background textarea on every page load |
| **3-day rolling history** | AI analysis results are saved locally and fed back into the next analysis for trend-aware conclusions |
| **Token cost tracker** | Shows per-call and cumulative OpenAI spend in USD with a one-click reset |
| **Zoomable charts** | Scroll to zoom, drag to pan; shows selection statistics |
| **Token lifecycle** | 24-hour OAuth token with expiry countdown and in-dashboard reconnect banner |
| **Rate limit handling** | Respects Fitbit's 150 calls/hour limit; shows countdown on 429 and auto-retries without infinite loops |
| **Configurable thresholds** | All alert thresholds and timing adjustable in the Settings panel |

---

## Prerequisites

- A **Fitbit account** with a compatible heart-rate-tracking device
- A **Fitbit Developer app** registered at [dev.fitbit.com](https://dev.fitbit.com/apps/new)
- **VS Code** with the [Live Server extension](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) (or any local static file server on port 5500)
- *(Optional)* An **OpenAI API key** for the AI Analysis tab — get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

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
git clone https://github.com/sccaixm2007/fitbit_heart_rate_webmonitor.git
cd fitbit_heart_rate_webmonitor

# Copy the example config and edit it
cp config.example.js config.js
```

Edit `config.js`:

```js
window.APP_CONFIG = {
  REDIRECT_URI: 'http://127.0.0.1:5500/',
  LOG_LEVEL: 'warn',

  // Optional — leave empty ('') to disable AI analysis
  OPENAI_API_KEY: 'sk-...',
  OPENAI_BUDGET: 100,
  OPENAI_SPENT_OFFSET: 0,
};
```

> `config.js` is in `.gitignore` and will never be committed.

### 3. (Optional) Set up your personal AI context

```bash
cp personal.example.json personal.json
```

Edit `personal.json` with your own health background (age, baseline HR, known conditions, etc.). This file is loaded automatically on every page load and pre-fills the AI user context textarea. It is in `.gitignore` and will never be committed.

```json
{
  "context": "Age 35. Sedentary lifestyle. Resting HR 70–80 BPM. No chronic conditions."
}
```

### 4. Run

Open the project folder in VS Code and click **Go Live** in the bottom status bar.

The app opens at `http://127.0.0.1:5500/`. Enter your **Client ID** and click **Connect Fitbit**.

---

## Project Structure

```
fitbit_heart_rate_webmonitor/
├── index.html              # App shell — HTML markup only
├── src/
│   ├── style.css           # All styles
│   └── app.js              # All application logic
├── config.js               # Your local config (gitignored — never commit)
├── config.example.js       # Template — copy to config.js and customize
├── personal.json           # Your private AI context (gitignored — never commit)
├── personal.example.json   # Template — copy to personal.json and customize
├── package.json            # Optional: npm run dev for live-server
├── .gitignore
└── README.md
```

---

## Configuration Reference

`config.js` sets `window.APP_CONFIG` before the app loads:

| Key | Default | Description |
|---|---|---|
| `REDIRECT_URI` | `'http://127.0.0.1:5500/'` | Must exactly match your Fitbit app's registered Callback URL |
| `LOG_LEVEL` | `'warn'` | Console verbosity: `'debug'` / `'info'` / `'warn'` / `'error'` |
| `OPENAI_API_KEY` | `''` | OpenAI API key; leave empty to disable AI analysis |
| `OPENAI_BUDGET` | `100` | Your total OpenAI credit budget in USD (for cost tracking display) |
| `OPENAI_SPENT_OFFSET` | `0` | Spend already incurred outside this app (subtracted from budget display) |

Alert thresholds and timing can be adjusted live in the **Settings** panel — no code changes needed.

---

## AI Analysis Tab

The AI Analysis tab uses GPT-4o-mini to analyse your Fitbit data and produce a structured daily health report.

**Output fields:**

| Field | Description |
|---|---|
| Today's Status | Overall assessment: Improving / Stable / Elevated / Worsening |
| Trend | Direction vs recent days: Getting better / Holding steady / Getting worse |
| Risk Assessment | Risk level — explicitly confirms "no concern" when trend is improving |
| Root Cause | Up to 2 contributing factors (e.g. poor sleep, stress, reduced activity) |
| Suggestions | Personalised action items based on current trend |
| Summary | One-sentence conclusion that reflects the overall trend |

**3-day rolling history** — each analysis is saved to `localStorage`. The next analysis receives the past 3 days as context so conclusions reflect trends rather than single-day snapshots.

**Personal context (`personal.json`)** — edit this file to tell the AI your baseline (typical resting HR, known conditions, lifestyle, etc.). Changes take effect on the next page reload.

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

This uses **120 calls/hour** — within Fitbit's 150-call-per-hour limit. HTTP 429 responses are handled automatically: polling stops, a visible countdown runs, and polling restarts cleanly after the window expires.

---

## Tech Stack

- **Vanilla JavaScript** (ES6+) — no framework, no bundler
- **Chart.js 4.4** — dual-axis HR line + steps bar chart
- **chartjs-plugin-zoom 2.0** — scroll/pinch zoom and pan
- **Hammer.js 2.0** — touch support for chart interactions
- **Web Audio API** — synthesized beep alerts (no audio files)
- **Fitbit OAuth 2.0 Implicit Flow** — browser-only authentication
- **OpenAI API (gpt-4o-mini)** — AI daily health analysis

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

**AI analysis button does nothing / shows error**
Check that `OPENAI_API_KEY` is set in `config.js` and that the key has available credits. The AI tab also requires at least one day of Fitbit data — open **Today's Trend** first if the AI tab shows no stats.

**Personal context not loading**
Make sure `personal.json` exists in the project root and contains valid JSON with a `"context"` key. The file must be served by the same local server (Live Server) — opening `index.html` directly as a `file://` URL will block the fetch.

---

## License

MIT
