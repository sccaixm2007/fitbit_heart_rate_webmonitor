// config.example.js — Template for your local configuration.
//
// SETUP:
//   1. Copy this file:  cp config.example.js config.js
//   2. Edit config.js with your own values (see comments below).
//   3. Never commit config.js — it is listed in .gitignore.
//
// HOW IT WORKS:
//   config.js is loaded before app.js and sets window.APP_CONFIG.
//   The app reads these values at startup instead of using hardcoded defaults.

window.APP_CONFIG = {
  // OAuth redirect URI — must exactly match the "Callback URL" you registered
  // in the Fitbit Developer Portal (https://dev.fitbit.com/apps).
  //
  // Common values:
  //   VS Code Live Server (default port 5500): 'http://127.0.0.1:5500/'
  //   Other local servers: 'http://localhost:PORT/'
  REDIRECT_URI: 'http://127.0.0.1:5500/',

  // Log level for the browser console.
  // Options: 'debug' | 'info' | 'warn' | 'error'
  // Use 'debug' during development, 'warn' for normal use.
  LOG_LEVEL: 'warn',
};
