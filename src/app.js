'use strict';

// ─────────────────────────────────────────────────────────────
// LOGGER  (level controlled via APP_CONFIG.LOG_LEVEL)
// ─────────────────────────────────────────────────────────────
const _logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
const _logMin    = _logLevels[window.APP_CONFIG?.LOG_LEVEL ?? 'warn'] ?? 2;
const logger = {
  debug: (...a) => _logMin <= 0 && console.debug('[HR Monitor]', ...a),
  info:  (...a) => _logMin <= 1 && console.info( '[HR Monitor]', ...a),
  warn:  (...a) => _logMin <= 2 && console.warn( '[HR Monitor]', ...a),
  error: (...a) => _logMin <= 3 && console.error('[HR Monitor]', ...a),
};

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const CFG = {
  REDIRECT_URI:          (window.APP_CONFIG?.REDIRECT_URI || 'http://127.0.0.1:5500/'),
  SCOPE:                 'heartrate activity',
  POLL_MS:               60_000,   // 60s = 120 API calls/hr (2 endpoints) — within Fitbit's 150/hr limit
  MAX_HISTORY:           90,              // ~90 min of data
  DISPLAY_POINTS:        20,
  NOTIF_COOLDOWN_MS:     3 * 60_000,      // HR alert notification cooldown
  SMOOTH_WINDOW:         3,
  GAP_BREAK_MS:          3 * 60_000,      // gap > 3 min breaks consecutive streak
  WALK_WINDOW_MS:        5 * 60_000,      // window to sum steps for state detection
  SITTING_THRESHOLD_MS:  45 * 60_000,     // 45 min sitting → alert
  SITTING_COOLDOWN_MS:   15 * 60_000,     // 15 min between sitting alerts
  SITTING_WARN_MS:       35 * 60_000,     // 35 min → orange warning color
};

// ─────────────────────────────────────────────────────────────
// ALERT RULES  (mutable via applySettings)
// ─────────────────────────────────────────────────────────────
let RULES = {
  resting: {
    high:   { threshold: 110, durationMs: 3 * 60_000 },
    medium: { threshold: 105, durationMs: 5 * 60_000 },
  },
  walking: {
    high:   { threshold: 125, durationMs: 1 * 60_000 },
    medium: null,
  },
};
let WALK_STEP_THRESH = 20;

// ─────────────────────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────────────────────
let accessToken        = null;
let pollTimer          = null;
let chart              = null;
let currentState       = 'resting';    // 'resting' | 'walking'
let prevState          = 'resting';    // previous cycle's state (for transition detection)

// Rate-limit backoff: pause polling until this timestamp
let rateLimitedUntil   = 0;

// Notifications
let lastHRNotifTime    = 0;            // wall-clock ms of last HR browser notification

// Sitting
let sittingStartTime   = null;         // Fitbit-timestamp when current sitting streak began
let lastSittingAlertTime = 0;          // wall-clock ms of last sitting alert (notif + sound)

// Sound
let soundEnabled       = true;
let audioCtx           = null;         // lazy-init Web Audio context

/**
 * Unified history: [{time: ms, hr: bpm, steps: count_per_min}]
 * One entry per Fitbit 1-minute data point.
 */
let history = [];

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function init() {
  const savedId = localStorage.getItem('fitbit_client_id') || '';
  document.getElementById('clientIdInput').value = savedId;

  logger.info('App init — redirect URI:', CFG.REDIRECT_URI);

  // Priority 1: fresh OAuth redirect — token is in URL hash
  const hashToken = extractTokenFromHash();
  if (hashToken) {
    accessToken = hashToken;
    startDashboard();
    return;
  }

  // Priority 2: restore stored token if it hasn't expired yet
  const storedToken = localStorage.getItem('fitbit_token');
  if (storedToken) {
    if (isTokenExpired()) {
      // Token exists but is past its expiry time — clear it and warn user
      clearTokenStorage();
      showLogin(/* expired= */ true);
    } else {
      accessToken = storedToken;
      startDashboard();
    }
    return;
  }

  // No token at all
  showLogin();
}

/** Shared setup called whenever we have a valid access token. */
function startDashboard() {
  logger.info('Starting dashboard');
  showDashboard();
  initChart();
  initTodayChart();
  maybeShowNotifBanner();
  updateTokenInfo();
  fetchAndSeedHistory().then(startPolling);
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
function extractTokenFromHash() {
  if (!window.location.hash) return null;
  const params    = new URLSearchParams(window.location.hash.substring(1));
  const token     = params.get('access_token');
  const expiresIn = parseInt(params.get('expires_in') ?? '0', 10);

  if (token) {
    localStorage.setItem('fitbit_token', token);

    // Save the absolute expiry timestamp so we can check it on future page loads
    if (expiresIn > 0) {
      const expiryMs = Date.now() + expiresIn * 1000;
      localStorage.setItem('fitbit_token_expiry', String(expiryMs));
    }

    // Clean the URL so the token doesn't stay visible in the address bar
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    logger.info('Token extracted from OAuth redirect');
    return token;
  }
  return null;
}

function login() {
  const id = document.getElementById('clientIdInput').value.trim();
  if (!id) { document.getElementById('loginError').textContent = 'Please enter your Fitbit App Client ID.'; return; }
  localStorage.setItem('fitbit_client_id', id);
  const url = new URL('https://www.fitbit.com/oauth2/authorize');
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('client_id',     id);
  url.searchParams.set('redirect_uri',  CFG.REDIRECT_URI);
  url.searchParams.set('scope',         CFG.SCOPE);
  url.searchParams.set('expires_in',    '86400');
  logger.info('Redirecting to Fitbit OAuth, redirect_uri:', CFG.REDIRECT_URI);
  window.location.href = url.toString();
}

function logout() {
  accessToken = null; history = []; sittingStartTime = null;
  clearInterval(pollTimer); pollTimer = null;
  clearTokenStorage();
  logger.info('User logged out');
  showLogin();
}

// ─── Token lifecycle helpers ───────────────────────────────

/** Remove both token and expiry from storage. */
function clearTokenStorage() {
  localStorage.removeItem('fitbit_token');
  localStorage.removeItem('fitbit_token_expiry');
}

/**
 * Returns true if a stored expiry timestamp exists AND is in the past
 * (with a 60-second buffer so we don't use a token that will expire mid-session).
 */
function isTokenExpired() {
  const expiry = parseInt(localStorage.getItem('fitbit_token_expiry') ?? '0', 10);
  if (!expiry) return false;           // no expiry saved → assume valid
  return Date.now() >= expiry - 60_000;
}

/**
 * Called when the Fitbit API returns 401.
 * Shows the in-dashboard expired banner instead of silently redirecting.
 * The user can click "Reconnect Fitbit" without losing their screen context.
 */
function handleTokenExpired() {
  logger.warn('Token expired — stopping polling');
  clearTokenStorage();
  accessToken = null;
  clearInterval(pollTimer);
  pollTimer = null;

  // Show the red banner on the dashboard
  document.getElementById('expiredBanner').style.display = 'flex';

  // Update the header token info
  const el = document.getElementById('tokenInfo');
  el.textContent = 'Session expired';
  el.className = 'expired';
}

/**
 * One-click re-authentication using the already-saved client ID.
 * Falls back to the login screen if no client ID is stored.
 */
function autoReconnect() {
  const clientId = localStorage.getItem('fitbit_client_id');
  if (!clientId) { showLogin(); return; }

  const url = new URL('https://www.fitbit.com/oauth2/authorize');
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  CFG.REDIRECT_URI);
  url.searchParams.set('scope',         CFG.SCOPE);
  url.searchParams.set('expires_in',    '86400');
  window.location.href = url.toString();
}

/**
 * Update the small "Token: Xh Ym" chip in the header.
 * Color shifts to orange inside the last 30 minutes, red when expired.
 */
function updateTokenInfo() {
  const el     = document.getElementById('tokenInfo');
  const expiry = parseInt(localStorage.getItem('fitbit_token_expiry') ?? '0', 10);

  if (!expiry) { el.textContent = ''; return; }

  const remaining = expiry - Date.now();
  if (remaining <= 0) {
    el.textContent = 'Session expired';
    el.className   = 'expired';
    return;
  }

  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  el.textContent = h > 0 ? `Token: ${h}h ${m}m` : `Token: ${m}m`;
  el.className   = remaining < 30 * 60_000 ? 'expiring' : '';
}

// ─────────────────────────────────────────────────────────────
// FITBIT API
// ─────────────────────────────────────────────────────────────
const API = {
  HR:    'https://api.fitbit.com/1/user/-/activities/heart/date/today/1d/1min.json',
  STEPS: 'https://api.fitbit.com/1/user/-/activities/steps/date/today/1d/1min.json',
};

async function fetchDataset(url, dataKey) {
  // Skip the call immediately if we're still in a rate-limit backoff window
  if (Date.now() < rateLimitedUntil) return null;

  try {
    logger.debug('Fetching', url);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (res.status === 401) { handleTokenExpired(); return null; }

    if (res.status === 429) {
      // Read Retry-After header (Fitbit sets this; default to 60s if absent)
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      rateLimitedUntil = Date.now() + retryAfter * 1000;
      logger.warn(`Rate limited — retrying in ${retryAfter}s`);

      // Update header status to show the countdown
      setRateLimitUI(retryAfter);

      // Schedule a single recovery poll once the window expires
      setTimeout(() => {
        rateLimitedUntil = 0;
        setRateLimitUI(0);  // restore "Connected" text
        pollOnce();
      }, retryAfter * 1000 + 500);

      return null;
    }

    if (!res.ok) {
      logger.error(`Fitbit API error HTTP ${res.status}`, url);
      showToast(`Fitbit API error (HTTP ${res.status})`, 'error');
      return null;
    }
    const json = await res.json();
    return json[dataKey]?.dataset ?? null;
  } catch (e) {
    logger.error('Network error fetching', url, e);
    showToast(`Network error: ${e.message}`, 'error');
    return null;
  }
}

/** Update the header to show "Rate limited (Xs)" or restore "Connected". */
function setRateLimitUI(retryAfterSec) {
  const dot  = document.querySelector('.live-dot');
  const txt  = document.querySelector('.connected-txt');
  if (!dot || !txt) return;

  if (retryAfterSec > 0) {
    dot.style.background   = 'var(--orange)';
    txt.style.color        = 'var(--orange)';
    txt.textContent        = `Rate limited (${retryAfterSec}s)`;

    // Tick the countdown every second so the user can see it decrement
    let remaining = retryAfterSec;
    const tickId  = setInterval(() => {
      remaining--;
      if (remaining <= 0 || Date.now() >= rateLimitedUntil) {
        clearInterval(tickId);
      } else {
        txt.textContent = `Rate limited (${remaining}s)`;
      }
    }, 1_000);
  } else {
    dot.style.background   = '';
    txt.style.color        = '';
    txt.textContent        = 'Connected';
  }
}

async function fetchMergedData() {
  // Fetch HR first (required). Steps are best-effort — a steps 429 won't block HR.
  const hrDataset = await fetchDataset(API.HR, 'activities-heart-intraday');
  if (!hrDataset) return null;   // HR failed → abort this cycle

  // Steps: fetch independently; if it fails, fall back to zeros (don't abort)
  const stepsDataset = await fetchDataset(API.STEPS, 'activities-steps-intraday') ?? [];

  const stepsMap = new Map(stepsDataset.map(e => [e.time, e.value]));
  return hrDataset.map(e => ({
    time:  fitbitTimeToMs(e.time),
    hr:    e.value,
    steps: stepsMap.get(e.time) ?? 0,
  }));
}

function fitbitTimeToMs(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s).getTime();
}


// ─────────────────────────────────────────────────────────────
// DATA MANAGEMENT
// ─────────────────────────────────────────────────────────────
async function fetchAndSeedHistory() {
  const merged = await fetchMergedData();
  if (!merged || merged.length === 0) return;

  // Seed with everything available (up to MAX_HISTORY) so sitting timer
  // can detect how long the user has already been resting today.
  history = merged.slice(-CFG.MAX_HISTORY);
  logger.info('History seeded with', history.length, 'data points');

  // Determine current state from seeded data
  currentState = detectState();
  prevState    = currentState;

  // Initialise sitting timer: walk back to find when current resting streak began
  if (currentState === 'resting') {
    sittingStartTime = findRestingStreakStart();
  }

  processUI();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollOnce();
  pollTimer = setInterval(pollOnce, CFG.POLL_MS);
  logger.info('Polling started — interval', CFG.POLL_MS / 1000, 's');

  // Refresh the token-expiry chip every minute (independent of data polling)
  setInterval(updateTokenInfo, 60_000);
}

async function pollOnce() {
  const merged = await fetchMergedData();
  if (!merged || merged.length === 0) return;

  const latest   = merged[merged.length - 1];
  const latestTs = latest.time;

  if (history.some(p => p.time === latestTs)) {
    // No new Fitbit data yet — still update sitting display with real-time clock
    if (history.length > 0) updateSittingDisplay();
    return;
  }

  logger.debug('New data point', latest);
  history.push(latest);
  if (history.length > CFG.MAX_HISTORY) history.shift();

  // State transition handling
  prevState    = currentState;
  currentState = detectState();

  if (prevState === 'walking' && currentState === 'resting') {
    // Transition: just sat down — start sitting timer from this data point
    sittingStartTime = latest.time;
    logger.info('State: walking → resting, sitting timer started');
  } else if (prevState === 'resting' && currentState === 'walking') {
    // Transition: got up — reset sitting timer
    sittingStartTime = null;
    logger.info('State: resting → walking, sitting timer reset');
  }
  // If state unchanged and resting without a timer, set it now (init safety)
  if (currentState === 'resting' && sittingStartTime === null) {
    sittingStartTime = findRestingStreakStart();
  }

  processUI();
}

/**
 * Central UI refresh — called after every state change or new data point.
 */
function processUI() {
  if (history.length === 0) return;
  const latest = history[history.length - 1];
  updateHRDisplay(latest.hr, latest.time);
  updateStateCard();
  updateSittingDisplay();
  checkAlerts();
  checkSittingReminder();
  updateChart();
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY STATE DETECTION
// ─────────────────────────────────────────────────────────────

/**
 * Sum per-minute steps over the last WALK_WINDOW_MS.
 * > WALK_STEP_THRESH → walking, else → resting.
 */
function detectState() {
  if (history.length < 2) return 'resting';
  const latestTime = history[history.length - 1].time;
  const cutoff     = latestTime - CFG.WALK_WINDOW_MS;
  const recent     = history.filter(p => p.time >= cutoff);
  const totalSteps = recent.reduce((s, p) => s + (p.steps || 0), 0);
  updateStepsBar(totalSteps);
  return totalSteps > WALK_STEP_THRESH ? 'walking' : 'resting';
}

function updateStepsBar(totalSteps) {
  const pct = Math.min(100, (totalSteps / WALK_STEP_THRESH) * 100);
  document.getElementById('stepsBarFill').style.width     = pct + '%';
  document.getElementById('stepsCountLabel').textContent  = `${totalSteps} / ${WALK_STEP_THRESH}`;
}

function updateStateCard() {
  const card    = document.getElementById('stateCard');
  const icon    = document.getElementById('stateIcon');
  const name    = document.getElementById('stateName');
  const info    = document.getElementById('stateInfo');
  const modeTag = document.getElementById('alertModeTag');
  const sitDiv  = document.getElementById('sittingTimer');

  if (currentState === 'walking') {
    card.className      = 'card state-card is-walking';
    icon.textContent    = '🚶';
    name.className      = 'state-name walking';
    name.textContent    = 'Walking';
    info.textContent    = 'Active movement detected';
    modeTag.className   = 'alert-mode-tag tag-walking';
    modeTag.textContent = '🚶 Walking rules active';
    document.getElementById('restingBars').style.display = 'none';
    document.getElementById('walkingBars').style.display = 'block';
    sitDiv.style.display = 'none';
  } else {
    card.className      = 'card state-card is-resting';
    icon.textContent    = '🪑';
    name.className      = 'state-name resting';
    name.textContent    = 'Resting';
    info.textContent    = 'Low movement — sedentary mode';
    modeTag.className   = 'alert-mode-tag tag-resting';
    modeTag.textContent = '🪑 Resting rules active';
    document.getElementById('restingBars').style.display = 'block';
    document.getElementById('walkingBars').style.display = 'none';
    sitDiv.style.display = 'block';
  }
}

// ─────────────────────────────────────────────────────────────
// SITTING TIMER
// ─────────────────────────────────────────────────────────────

/**
 * Walk backwards through history to find the earliest point in the
 * current continuous resting streak (same logic as consecutiveDuration).
 * Used for seeding the timer after page load.
 */
function findRestingStreakStart() {
  if (history.length === 0) return Date.now();
  let startTime = history[history.length - 1].time;

  for (let i = history.length - 1; i >= 0; i--) {
    // Break on time gap
    if (i < history.length - 1) {
      if (history[i + 1].time - history[i].time > CFG.GAP_BREAK_MS) break;
    }
    // A point counts as "resting" if steps-in-5-min at that point were low
    const cutoff = history[i].time - CFG.WALK_WINDOW_MS;
    const win    = history.filter(p => p.time >= cutoff && p.time <= history[i].time);
    const steps  = win.reduce((s, p) => s + p.steps, 0);
    if (steps <= WALK_STEP_THRESH) {
      startTime = history[i].time;
    } else {
      break;
    }
  }
  return startTime;
}

/**
 * Update the sitting duration display using real-time wall clock so it
 * doesn't feel stale between Fitbit polls.
 */
function updateSittingDisplay() {
  if (currentState !== 'resting' || sittingStartTime === null) return;

  const sittingMs  = Date.now() - sittingStartTime;
  const totalMin   = Math.floor(sittingMs / 60_000);
  const pct        = Math.min(100, (sittingMs / CFG.SITTING_THRESHOLD_MS) * 100);
  const durEl      = document.getElementById('sittingDuration');
  const barEl      = document.getElementById('sittingBarFill');

  durEl.textContent = `${totalMin} min`;

  // Color coding based on progress toward the threshold
  if (sittingMs >= CFG.SITTING_THRESHOLD_MS) {
    durEl.className  = 'sitting-duration alert';
    barEl.className  = 'sitting-bar-fill alert';
  } else if (sittingMs >= CFG.SITTING_WARN_MS) {
    durEl.className  = 'sitting-duration warn';
    barEl.className  = 'sitting-bar-fill warn';
  } else {
    durEl.className  = 'sitting-duration';
    barEl.className  = 'sitting-bar-fill';
  }
  barEl.style.width = pct + '%';
}

/**
 * Check if the sitting alert should fire.
 * Fires at CFG.SITTING_THRESHOLD_MS, then respects SITTING_COOLDOWN_MS.
 */
function checkSittingReminder() {
  if (currentState !== 'resting' || sittingStartTime === null) return;

  const now       = Date.now();
  const sittingMs = now - sittingStartTime;

  if (sittingMs < CFG.SITTING_THRESHOLD_MS) return;
  if (now - lastSittingAlertTime < CFG.SITTING_COOLDOWN_MS) return;

  // Cooldown passed — fire the alert
  lastSittingAlertTime = now;

  const totalMin = Math.floor(sittingMs / 60_000);
  const msg      = `⏰ You've been sitting for ${totalMin} minutes. Time to move!`;
  logger.warn('Sitting alert fired', totalMin, 'min');

  // Browser notification
  if (Notification.permission === 'granted') {
    new Notification('Sedentary Reminder', {
      body:     msg,
      icon:     '⏰',
      tag:      'sitting-alert',
      renotify: true,
    });
  }

  // Toast on page
  showToast(msg, 'warn');

  // Sound — gentle double-beep
  playSound('sitting');
}

// ─────────────────────────────────────────────────────────────
// HR ALERT LOGIC
// ─────────────────────────────────────────────────────────────

/**
 * Count consecutive tail of data points where hr > threshold.
 * A gap > GAP_BREAK_MS in the data resets the streak.
 */
function consecutiveDuration(threshold) {
  if (history.length === 0) return 0;
  let startTime = null;

  for (let i = history.length - 1; i >= 0; i--) {
    if (i < history.length - 1 && history[i + 1].time - history[i].time > CFG.GAP_BREAK_MS) break;
    if (history[i].hr > threshold) {
      startTime = history[i].time;
    } else {
      break;
    }
  }
  if (startTime === null) return 0;
  return history[history.length - 1].time - startTime;
}

function checkAlerts() {
  const activeRules = RULES[currentState];
  const durHigh     = consecutiveDuration(activeRules.high.threshold);
  const durMed      = activeRules.medium ? consecutiveDuration(activeRules.medium.threshold) : 0;

  // Update progress bars
  if (currentState === 'resting') {
    setBar('barHigh',  'ruleHighTime', durHigh, activeRules.high.durationMs);
    setBar('barMed',   'ruleMedTime',  durMed,  activeRules.medium.durationMs);
  } else {
    setBar('barWalk',  'ruleWalkTime', durHigh, activeRules.high.durationMs);
  }

  // Fire HR alerts
  if (durHigh >= activeRules.high.durationMs) {
    const label = currentState === 'walking' ? '🚶 Walking Alert' : '🚨 High Alert';
    setAlertFiring(label, activeRules.high.threshold, durHigh, 'red');
    maybeSendHRNotification(label, activeRules.high.threshold, durHigh, 'alert');
  } else if (activeRules.medium && durMed >= activeRules.medium.durationMs) {
    setAlertFiring('⚠️ Elevated Alert', activeRules.medium.threshold, durMed, 'orange');
    maybeSendHRNotification('Elevated', activeRules.medium.threshold, durMed, 'mild');
  } else {
    clearAlertUI(durHigh, durMed);
  }
}

function setBar(barId, timeId, durationMs, maxMs) {
  document.getElementById(barId).style.width     = Math.min(100, durationMs / maxMs * 100) + '%';
  document.getElementById(timeId).textContent    = `${fmtDur(durationMs)} / ${fmtDur(maxMs)}`;
}

function setAlertFiring(label, threshold, durationMs, color) {
  logger.warn('HR alert firing', label, threshold, 'BPM for', fmtDur(durationMs));
  document.getElementById('alertDot').className   = 'alert-dot firing';
  document.getElementById('alertMain').textContent = label;
  document.getElementById('alertMain').style.color = `var(--${color})`;
  document.getElementById('alertSub').textContent  = `HR >${threshold} BPM for ${fmtDur(durationMs)}`;
}

function clearAlertUI(durHigh, durMed) {
  document.getElementById('alertDot').className    = 'alert-dot';
  document.getElementById('alertMain').textContent = 'All clear';
  document.getElementById('alertMain').style.color = '';
  const maxDur = Math.max(durHigh, durMed);
  document.getElementById('alertSub').textContent  = maxDur > 0
    ? `Monitoring… streak: ${fmtDur(maxDur)}`
    : 'No alerts active';
}

function maybeSendHRNotification(level, threshold, durationMs, soundType) {
  const now = Date.now();
  if (now - lastHRNotifTime < CFG.NOTIF_COOLDOWN_MS) return;
  lastHRNotifTime = now;

  if (Notification.permission === 'granted') {
    new Notification(`Heart Rate Alert — ${level}`, {
      body:     `HR >${threshold} BPM for ${fmtDur(durationMs)}`,
      icon:     '💗',
      tag:      'hr-alert',
      renotify: true,
    });
  }
  playSound(soundType);
}

// ─────────────────────────────────────────────────────────────
// SOUND  (Web Audio API — no external dependencies)
// ─────────────────────────────────────────────────────────────

/**
 * Synthesise a beep pattern using Web Audio API.
 *
 * @param {'alert'|'mild'|'sitting'} type
 *   alert:   3 short urgent beeps at 880 Hz  (high HR)
 *   mild:    2 medium beeps at 660 Hz        (elevated HR)
 *   sitting: 2 soft longer beeps at 480 Hz   (sedentary)
 */
function playSound(type) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {
    logger.warn('Web Audio API not available', e);
    return;
  }

  // Each entry: { freq (Hz), dur (s) }  — freq 0 = silence gap
  const patterns = {
    alert:   [
      { freq: 880, dur: 0.12 }, { freq: 0, dur: 0.07 },
      { freq: 880, dur: 0.12 }, { freq: 0, dur: 0.07 },
      { freq: 880, dur: 0.22 },
    ],
    mild:    [
      { freq: 660, dur: 0.18 }, { freq: 0, dur: 0.10 },
      { freq: 660, dur: 0.18 },
    ],
    sitting: [
      { freq: 480, dur: 0.28 }, { freq: 0, dur: 0.14 },
      { freq: 480, dur: 0.42 },
    ],
  };

  const beeps = patterns[type] ?? patterns.mild;
  let t = audioCtx.currentTime + 0.05;  // small lead-in

  beeps.forEach(({ freq, dur }) => {
    if (freq > 0) {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type            = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.start(t);
      osc.stop(t + dur);
    }
    t += dur;
  });
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('soundBtn');
  btn.classList.toggle('muted', !soundEnabled);
  btn.textContent = soundEnabled ? '🔔 Sound' : '🔕 Sound';
  // Keep the settings checkbox in sync
  document.getElementById('soundToggle').checked = soundEnabled;
  showToast(soundEnabled ? 'Sound alerts on' : 'Sound alerts off', 'info');
}

function onSoundToggleChange() {
  soundEnabled = document.getElementById('soundToggle').checked;
  const btn = document.getElementById('soundBtn');
  btn.classList.toggle('muted', !soundEnabled);
  btn.textContent = soundEnabled ? '🔔 Sound' : '🔕 Sound';
}

// ─────────────────────────────────────────────────────────────
// BROWSER NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
function maybeShowNotifBanner() {
  if ('Notification' in window && Notification.permission === 'default') {
    document.getElementById('notifBanner').style.display = 'flex';
  }
}

async function enableNotifications() {
  if (!('Notification' in window)) return;
  const perm = await Notification.requestPermission();
  document.getElementById('notifBanner').style.display = 'none';
  logger.info('Notification permission:', perm);
  showToast(perm === 'granted' ? 'Notifications enabled!' : 'Notifications blocked — alerts shown on screen only.',
    perm === 'granted' ? 'success' : 'warn');
}

// ─────────────────────────────────────────────────────────────
// HR DISPLAY
// ─────────────────────────────────────────────────────────────
function updateHRDisplay(hr, timestamp) {
  document.getElementById('hrNumber').textContent  = hr;
  document.getElementById('hrUpdated').textContent = `Updated ${fmtTime(timestamp)}`;

  const numEl     = document.getElementById('hrNumber');
  const badge     = document.getElementById('hrBadge');
  const card      = document.getElementById('hrCard');
  const highThres = RULES[currentState].high.threshold;
  const medThres  = RULES[currentState].medium?.threshold ?? highThres;

  if (hr > highThres) {
    numEl.style.color = 'var(--red)';
    badge.className   = 'hr-badge badge-danger';
    badge.textContent = currentState === 'walking' ? 'Too High (Walking)' : 'Danger — Very High';
    card.className    = 'card hr-card state-danger';
  } else if (hr > medThres) {
    numEl.style.color = 'var(--orange)';
    badge.className   = 'hr-badge badge-elevated';
    badge.textContent = 'Elevated';
    card.className    = 'card hr-card state-elevated';
  } else {
    numEl.style.color = 'var(--green)';
    badge.className   = 'hr-badge badge-normal';
    badge.textContent = 'Normal';
    card.className    = 'card hr-card state-normal';
  }
}

// ─────────────────────────────────────────────────────────────
// CHART  (dual-axis: HR line + Steps bars)
// ─────────────────────────────────────────────────────────────
function initChart() {
  const ctx  = document.getElementById('hrChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, 'rgba(255,79,109,0.30)');
  grad.addColorStop(1, 'rgba(255,79,109,0)');

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        // 0 — HR line (left axis)
        {
          type: 'line', label: 'Heart Rate', data: [], yAxisID: 'yHR',
          borderColor: '#ff4f6d', backgroundColor: grad,
          borderWidth: 2.5, tension: 0.4, fill: true,
          pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: '#ff4f6d', order: 1,
        },
        // 1 — Active threshold (left axis, dashed)
        {
          type: 'line', label: 'Threshold', data: [], yAxisID: 'yHR',
          borderColor: 'rgba(244,67,54,0.6)', borderWidth: 1.5,
          borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0, order: 2,
        },
        // 2 — Steps bars (right axis)
        {
          type: 'bar', label: 'Steps/min', data: [], yAxisID: 'ySteps',
          backgroundColor: 'rgba(68,138,255,0.22)', borderColor: 'rgba(68,138,255,0.5)',
          borderWidth: 1, borderRadius: 3, order: 3,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 350 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,13,31,0.92)',
          borderColor: 'rgba(255,255,255,0.10)', borderWidth: 1,
          callbacks: {
            label: c => c.datasetIndex === 0 ? `HR: ${Math.round(c.parsed.y)} BPM`
                      : c.datasetIndex === 1 ? `Threshold: ${c.parsed.y} BPM`
                      : `Steps: ${c.parsed.y}`,
          },
        },
        zoom: {
          zoom: {
            wheel: { enabled: true, speed: 0.15 },
            pinch: { enabled: true },
            mode: 'x',
            onZoom:         ({ chart: c }) => updateZoomInfo(c, 'hrZoomInfo', 'hrResetZoom'),
            onZoomComplete: ({ chart: c }) => updateZoomInfo(c, 'hrZoomInfo', 'hrResetZoom'),
          },
          pan: {
            enabled: true,
            mode: 'x',
            onPan:         ({ chart: c }) => updateZoomInfo(c, 'hrZoomInfo', 'hrResetZoom'),
            onPanComplete: ({ chart: c }) => updateZoomInfo(c, 'hrZoomInfo', 'hrResetZoom'),
          },
        },
      },
      scales: {
        x: {
          grid:   { color: 'rgba(255,255,255,0.05)' },
          ticks:  { color: 'rgba(255,255,255,0.40)', maxTicksLimit: 8, font: { size: 11 } },
          border: { color: 'rgba(255,255,255,0.10)' },
        },
        yHR: {
          type: 'linear', position: 'left',
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: 'rgba(255,255,255,0.40)', font: { size: 11 } },
          border: { color: 'rgba(255,255,255,0.10)' },
          suggestedMin: 50, suggestedMax: 150,
          title: { display: true, text: 'BPM', color: 'rgba(255,255,255,0.30)', font: { size: 10 } },
        },
        ySteps: {
          type: 'linear', position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: 'rgba(68,138,255,0.5)', font: { size: 11 } },
          border: { color: 'rgba(255,255,255,0.10)' },
          suggestedMin: 0, suggestedMax: 100,
          title: { display: true, text: 'Steps', color: 'rgba(68,138,255,0.4)', font: { size: 10 } },
        },
      },
    },
  });
}

function movingAverage(pts, win) {
  if (win < 2) return pts.map(p => p.hr);
  const half = Math.floor(win / 2);
  return pts.map((_, i) => {
    const lo = Math.max(0, i - half), hi = Math.min(pts.length - 1, i + half);
    const sl = pts.slice(lo, hi + 1);
    return sl.reduce((s, p) => s + p.hr, 0) / sl.length;
  });
}

function updateChart() {
  if (!chart) return;
  const visible  = history.slice(-CFG.DISPLAY_POINTS);
  const smoothed = movingAverage(visible, CFG.SMOOTH_WINDOW);
  const n        = visible.length;
  const thresh   = RULES[currentState].high.threshold;

  chart.data.labels              = visible.map(p => fmtTime(p.time));
  chart.data.datasets[0].data    = smoothed;
  chart.data.datasets[1].data    = Array(n).fill(thresh);
  chart.data.datasets[2].data    = visible.map(p => p.steps);
  document.getElementById('chartThreshLabel').textContent = `Threshold (${thresh})`;
  chart.update('none');
}

// ─────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────
/** Settings panel tab switcher (Resting / Walking / Sedentary). */
function switchSettingsTab(tab) {
  ['resting','walking','sedentary'].forEach((t, i) => {
    document.querySelectorAll('.tab-btn')[i].classList.toggle('active', t === tab);
    document.getElementById(`tab${t.charAt(0).toUpperCase() + t.slice(1)}`).classList.toggle('active', t === tab);
  });
}

// ─────────────────────────────────────────────────────────────
// VIEW SWITCHER  (Realtime ↔ Today's Trend)
// ─────────────────────────────────────────────────────────────
let currentView       = 'realtime';
let todayRefreshTimer = null;   // interval for auto-refresh while on today tab
let allTodayData      = [];     // [{time:"HH:MM", ts:ms, bpm:number, steps:number}]
let todayViewChart    = null;

/** Switch between the Realtime view and the Today's Trend view. */
function switchView(name) {
  currentView = name;

  document.querySelectorAll('.view-btn').forEach((btn, i) => {
    btn.classList.toggle('active', (i === 0 && name === 'realtime') ||
                                   (i === 1 && name === 'today'));
  });

  document.getElementById('viewRealtime').style.display = name === 'realtime' ? '' : 'none';
  document.getElementById('viewToday').style.display    = name === 'today'    ? '' : 'none';

  if (name === 'today') {
    loadTodayView();
    // Auto-refresh the full-day chart every 3 minutes while this tab is open
    clearInterval(todayRefreshTimer);
    todayRefreshTimer = setInterval(loadTodayView, 3 * 60_000);
  } else {
    clearInterval(todayRefreshTimer);
    todayRefreshTimer = null;
  }
}

/** Fetch all of today's HR + steps data and render the full-day chart. */
async function loadTodayView() {
  document.getElementById('todayLoadingTxt').textContent = 'Loading…';

  try {
    const [hrDataset, stepsDataset] = await Promise.all([
      fetchDataset(API.HR,    'activities-heart-intraday'),
      fetchDataset(API.STEPS, 'activities-steps-intraday'),
    ]);
    if (!hrDataset) return;

    const d          = new Date();
    const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const stepsMap   = new Map((stepsDataset ?? []).map(e => [e.time, e.value]));

    allTodayData = hrDataset
      .map(e => {
        const [h, m, s] = e.time.split(':').map(Number);
        const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s).getTime();
        return { time: e.time.slice(0, 5), ts, bpm: e.value, steps: stepsMap.get(e.time) ?? 0 };
      })
      .filter(p => p.bpm > 0 && p.ts >= startOfDay);

    logger.info('Today view loaded', allTodayData.length, 'data points');
    renderTodayView();
  } catch (e) {
    logger.error('Failed to load today view', e);
    showToast('Could not load today\'s data', 'error');
  } finally {
    document.getElementById('todayLoadingTxt').textContent = '';
  }
}

/** Update stats cards and chart from allTodayData. */
function renderTodayView() {
  if (allTodayData.length === 0) {
    document.getElementById('todayLastLoad').textContent = 'No data for today yet';
    return;
  }

  const values     = allTodayData.map(p => p.bpm);
  const stepsArr   = allTodayData.map(p => p.steps ?? 0);
  const totalSteps = stepsArr.reduce((s, v) => s + v, 0);
  const avg        = Math.round(values.reduce((s, v) => s + v, 0) / values.length);

  document.getElementById('todayAvgBpm').textContent     = avg;
  document.getElementById('todayMaxBpm').textContent     = Math.max(...values);
  document.getElementById('todayMinBpm').textContent     = Math.min(...values);
  document.getElementById('todayTotalSteps').textContent = totalSteps.toLocaleString();
  document.getElementById('todayPts').textContent        = values.length;
  document.getElementById('todayLastLoad').textContent   =
    `Updated ${new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false })}` +
    ` · ${values.length} data points`;

  if (!todayViewChart) return;

  const n      = allTodayData.length;
  const thresh = RULES.resting.high.threshold;
  todayViewChart.data.labels           = allTodayData.map(p => p.time);
  todayViewChart.data.datasets[0].data = values;
  todayViewChart.data.datasets[1].data = Array(n).fill(thresh);
  todayViewChart.data.datasets[2].data = stepsArr;
  todayViewChart.update('none');
}

/** Build the full-day Chart.js instance (called once from startDashboard). */
function initTodayChart() {
  const ctx  = document.getElementById('todayChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 300);
  grad.addColorStop(0, 'rgba(255,79,109,0.28)');
  grad.addColorStop(1, 'rgba(255,79,109,0)');

  todayViewChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        // 0 — HR line (left axis)
        {
          type: 'line',
          label: 'Heart Rate',
          data: [],
          yAxisID: 'yHR',
          borderColor: '#ff4f6d',
          backgroundColor: grad,
          borderWidth: 2,
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: '#ff4f6d',
          order: 1,
        },
        // 1 — Alert threshold dashed reference (left axis)
        {
          type: 'line',
          label: 'Alert Threshold',
          data: [],
          yAxisID: 'yHR',
          borderColor: 'rgba(244,67,54,0.50)',
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 2,
        },
        // 2 — Steps bars (right axis)
        {
          type: 'bar',
          label: 'Steps/min',
          data: [],
          yAxisID: 'ySteps',
          backgroundColor: 'rgba(68,138,255,0.22)',
          borderColor: 'rgba(68,138,255,0.5)',
          borderWidth: 1,
          borderRadius: 2,
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },        // no animation — can have 500+ points
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,13,31,0.92)',
          borderColor: 'rgba(255,255,255,0.10)', borderWidth: 1,
          callbacks: {
            label: c => c.datasetIndex === 0 ? `HR: ${Math.round(c.parsed.y)} BPM`
                      : c.datasetIndex === 1 ? `Threshold: ${c.parsed.y} BPM`
                      : `Steps: ${c.parsed.y}`,
          },
        },
        zoom: {
          zoom: {
            wheel: { enabled: true, speed: 0.15 },
            pinch: { enabled: true },
            mode: 'x',
            onZoom:         ({ chart: c }) => updateZoomInfo(c, 'todayZoomInfo', 'todayResetZoom'),
            onZoomComplete: ({ chart: c }) => updateZoomInfo(c, 'todayZoomInfo', 'todayResetZoom'),
          },
          pan: {
            enabled: true,
            mode: 'x',
            onPan:         ({ chart: c }) => updateZoomInfo(c, 'todayZoomInfo', 'todayResetZoom'),
            onPanComplete: ({ chart: c }) => updateZoomInfo(c, 'todayZoomInfo', 'todayResetZoom'),
          },
        },
      },
      scales: {
        x: {
          grid:   { color: 'rgba(255,255,255,0.05)' },
          // maxTicksLimit keeps labels readable even with 600+ data points
          ticks:  { color: 'rgba(255,255,255,0.40)', maxTicksLimit: 13, font: { size: 11 } },
          border: { color: 'rgba(255,255,255,0.10)' },
        },
        yHR: {
          type: 'linear', position: 'left',
          grid:         { color: 'rgba(255,255,255,0.05)' },
          ticks:        { color: 'rgba(255,255,255,0.40)', font: { size: 11 } },
          border:       { color: 'rgba(255,255,255,0.10)' },
          suggestedMin: 45,
          suggestedMax: 140,
          title: { display: true, text: 'BPM', color: 'rgba(255,255,255,0.30)', font: { size: 10 } },
        },
        ySteps: {
          type: 'linear', position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: 'rgba(68,138,255,0.5)', font: { size: 11 } },
          border: { color: 'rgba(255,255,255,0.10)' },
          suggestedMin: 0, suggestedMax: 100,
          title: { display: true, text: 'Steps', color: 'rgba(68,138,255,0.4)', font: { size: 10 } },
        },
      },
    },
  });
}

function applySettings() {
  const rHT = parseInt(document.getElementById('rHighThresh').value, 10);
  const rHD = parseInt(document.getElementById('rHighDur').value,    10);
  const rMT = parseInt(document.getElementById('rMedThresh').value,  10);
  const rMD = parseInt(document.getElementById('rMedDur').value,     10);
  const wHT = parseInt(document.getElementById('wHighThresh').value, 10);
  const wHD = parseInt(document.getElementById('wHighDur').value,    10);
  const wSt = parseInt(document.getElementById('walkStepThresh').value, 10);
  const sit = parseInt(document.getElementById('setSittingMin').value,  10);
  const scd = parseInt(document.getElementById('setSittingCooldownMin').value, 10);

  if ([rHT,rHD,rMT,rMD,wHT,wHD,wSt,sit,scd].some(isNaN)) {
    showToast('Please enter valid numeric values.', 'error'); return;
  }
  if (rMT >= rHT) {
    showToast('Resting medium threshold must be below high threshold.', 'warn'); return;
  }

  RULES.resting.high   = { threshold: rHT, durationMs: rHD * 60_000 };
  RULES.resting.medium = { threshold: rMT, durationMs: rMD * 60_000 };
  RULES.walking.high   = { threshold: wHT, durationMs: wHD * 60_000 };
  WALK_STEP_THRESH     = wSt;
  CFG.SITTING_THRESHOLD_MS = sit * 60_000;
  CFG.SITTING_COOLDOWN_MS  = scd * 60_000;
  CFG.SITTING_WARN_MS      = Math.max(0, (sit - 10)) * 60_000;

  // Refresh labels
  document.getElementById('ruleHighLabel').textContent = `HR >${rHT} BPM`;
  document.getElementById('ruleMedLabel').textContent  = `HR >${rMT} BPM`;
  document.getElementById('ruleWalkLabel').textContent = `HR >${wHT} BPM`;
  document.getElementById('stepsCountLabel').textContent = `-- / ${wSt}`;

  logger.info('Settings applied', { rHT, rMT, wHT, wSt, sit, scd });
  if (history.length > 0) processUI();
  showToast('Settings applied!', 'success');
}

// ─────────────────────────────────────────────────────────────
// SCREEN HELPERS
// ─────────────────────────────────────────────────────────────
/**
 * @param {boolean} [expired=false] When true, shows the "session expired" hint
 *   on the login card so the user knows why they ended up here.
 */
function showLogin(expired = false) {
  document.getElementById('loginScreen').style.display  = 'flex';
  document.getElementById('dashboard').style.display    = 'none';
  document.getElementById('loginExpiredMsg').style.display = expired ? 'block' : 'none';
}

function showDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display   = 'block';
  // Hide expired banner in case it was showing from a previous session
  document.getElementById('expiredBanner').style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = el.className.replace(' show', ''); }, 4000);
}

// ─────────────────────────────────────────────────────────────
// FORMAT HELPERS
// ─────────────────────────────────────────────────────────────
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// ZOOM HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Called on every zoom/pan event.
 * When the chart is zoomed, shows the avg/min/max of visible HR data
 * and makes the "Reset Zoom" button visible.
 */
function updateZoomInfo(chartInstance, infoId, resetId) {
  const infoEl  = document.getElementById(infoId);
  const resetEl = document.getElementById(resetId);
  if (!infoEl || !resetEl) return;

  if (!chartInstance.isZoomedOrPanned()) {
    infoEl.textContent = '';
    infoEl.classList.remove('visible');
    resetEl.classList.remove('visible');
    return;
  }

  const scale = chartInstance.scales.x;
  const lo    = Math.max(0, Math.round(scale.min));
  const hi    = Math.min(chartInstance.data.labels.length - 1, Math.round(scale.max));
  // dataset[0] is always the HR line
  const vals  = chartInstance.data.datasets[0].data
                  .slice(lo, hi + 1)
                  .filter(v => v != null && v > 0);

  if (vals.length > 0) {
    const avg  = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    const vMin = Math.min(...vals);
    const vMax = Math.max(...vals);
    infoEl.textContent = `Selection avg ${avg} BPM · min ${vMin} · max ${vMax}`;
    infoEl.classList.add('visible');
  }
  resetEl.classList.add('visible');
}

function resetZoom(target) {
  if (target === 'hr' && chart) {
    chart.resetZoom();
    updateZoomInfo(chart, 'hrZoomInfo', 'hrResetZoom');
  } else if (target === 'today' && todayViewChart) {
    todayViewChart.resetZoom();
    updateZoomInfo(todayViewChart, 'todayZoomInfo', 'todayResetZoom');
  }
}


// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
