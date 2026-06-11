/* Shared configuration & storage helpers for the Strava Premium app. */

const STORE = {
  clientId: 'strava_client_id',
  clientSecret: 'strava_client_secret',
  accessToken: 'strava_access_token',
  refreshToken: 'strava_refresh_token',
  expiresAt: 'strava_expires_at',
  athlete: 'strava_athlete',
  activities: 'strava_activities',
  lastSync: 'strava_last_sync',
  demoMode: 'strava_demo_mode',
  weeklyGoal: 'strava_weekly_goal'
};

const Store = {
  get(key) {
    return localStorage.getItem(key);
  },
  set(key, value) {
    localStorage.setItem(key, value);
  },
  getJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  setJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  }
};

function isDemoMode() {
  return Store.get(STORE.demoMode) === '1';
}

function isConfigured() {
  return Boolean(Store.get(STORE.clientId) && Store.get(STORE.clientSecret));
}

function isConnected() {
  return Boolean(Store.get(STORE.refreshToken));
}

/* Wipes everything related to the Strava session (keeps the weekly goal). */
function clearSession() {
  [
    STORE.accessToken,
    STORE.refreshToken,
    STORE.expiresAt,
    STORE.athlete,
    STORE.activities,
    STORE.lastSync,
    STORE.demoMode
  ].forEach(key => Store.remove(key));
}
