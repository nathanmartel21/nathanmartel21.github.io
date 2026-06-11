/* Configuration & storage for the Strava Premium app.

   The app is multi-athlete: the Strava API application (clientId/secret)
   is shared, but every connected athlete gets an isolated "profile".
   Per-profile data (tokens, activities, goal) is namespaced under
   `strava_prof_<id>_<suffix>`; a registry lists the profiles and which
   one is active. The active profile's id is the Strava athlete id (or
   "demo" for the demo profile). */

/* App-level keys, shared across all athletes. */
const APP = {
  clientId: 'strava_client_id',
  clientSecret: 'strava_client_secret',
  profiles: 'strava_profiles',       // [{ id, name, avatar, demo }]
  active: 'strava_active_profile'    // id string
};

/* Per-profile key suffixes. */
const PKEY = {
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  expiresAt: 'expires_at',
  athlete: 'athlete',
  activities: 'activities',
  lastSync: 'last_sync',
  weeklyGoal: 'weekly_goal',
  planSessions: 'plan_sessions',
  planObjective: 'plan_objective'
};

const DEMO_ID = 'demo';

/* Raw localStorage access. */
const Store = {
  get(key) { return localStorage.getItem(key); },
  set(key, value) { localStorage.setItem(key, value); },
  remove(key) { localStorage.removeItem(key); },
  getJSON(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  },
  setJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};

/* ---------------- Profile registry ---------------- */

function getProfiles() { return Store.getJSON(APP.profiles) || []; }
function saveProfiles(list) { Store.setJSON(APP.profiles, list); }
function getActiveId() { return Store.get(APP.active); }
function setActiveId(id) { Store.set(APP.active, id); }
function getProfile(id) { return getProfiles().find(p => p.id === id) || null; }
function getActiveProfile() { return getProfile(getActiveId()); }
function hasProfiles() { return getProfiles().length > 0; }

function upsertProfile(profile) {
  const list = getProfiles();
  const i = list.findIndex(p => p.id === profile.id);
  if (i >= 0) list[i] = { ...list[i], ...profile };
  else list.push(profile);
  saveProfiles(list);
}

function removeProfile(id) {
  saveProfiles(getProfiles().filter(p => p.id !== id));
  Object.values(PKEY).forEach(suffix => Store.remove(`strava_prof_${id}_${suffix}`));
  if (getActiveId() === id) {
    const remaining = getProfiles();
    if (remaining.length) setActiveId(remaining[0].id);
    else Store.remove(APP.active);
  }
}

/* ---------------- Per-profile storage ---------------- */

const Profile = {
  key(suffix, id) { return `strava_prof_${id || getActiveId()}_${suffix}`; },
  get(suffix, id) { return localStorage.getItem(Profile.key(suffix, id)); },
  set(suffix, value, id) { localStorage.setItem(Profile.key(suffix, id), value); },
  remove(suffix, id) { localStorage.removeItem(Profile.key(suffix, id)); },
  getJSON(suffix, id) {
    try { const raw = localStorage.getItem(Profile.key(suffix, id)); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  },
  setJSON(suffix, value, id) { localStorage.setItem(Profile.key(suffix, id), JSON.stringify(value)); }
};

/* ---------------- State helpers ---------------- */

function isConfigured() {
  return Boolean(Store.get(APP.clientId) && Store.get(APP.clientSecret));
}

function isActiveDemo() {
  return getActiveId() === DEMO_ID;
}

/* True when the active profile can show a dashboard (demo, has imported
   activities, or has Strava tokens). */
function activeHasSession() {
  const id = getActiveId();
  if (!id) return false;
  if (id === DEMO_ID) return true;
  const profile = getProfile(id);
  if (profile && profile.source === 'import') {
    const acts = Profile.getJSON(PKEY.activities, id);
    return Boolean(acts && acts.length);
  }
  return Boolean(Profile.get(PKEY.refreshToken, id));
}

function isActiveImport() {
  const profile = getActiveProfile();
  return Boolean(profile && profile.source === 'import');
}

function ensureDemoProfile() {
  upsertProfile({ id: DEMO_ID, name: 'Nathan (démo)', avatar: null, demo: true, source: 'demo' });
  setActiveId(DEMO_ID);
}

/* ---------------- One-time migration ---------------- */

/* Move data written by the earlier single-athlete version into a
   profile so nothing is lost. */
(function migrateLegacy() {
  const legacyAthlete = Store.getJSON('strava_athlete');
  const legacyRefresh = Store.get('strava_refresh_token');
  if (legacyRefresh && legacyAthlete && legacyAthlete.id) {
    const id = String(legacyAthlete.id);
    if (!getProfile(id)) {
      const name = `${legacyAthlete.firstname || ''} ${legacyAthlete.lastname || ''}`.trim() || 'Athlète';
      upsertProfile({ id, name, avatar: legacyAthlete.profile_medium || null });
      Profile.set(PKEY.accessToken, Store.get('strava_access_token') || '', id);
      Profile.set(PKEY.refreshToken, legacyRefresh, id);
      Profile.set(PKEY.expiresAt, Store.get('strava_expires_at') || '0', id);
      Profile.setJSON(PKEY.athlete, legacyAthlete, id);
      const acts = Store.getJSON('strava_activities');
      if (acts) Profile.setJSON(PKEY.activities, acts, id);
      const lastSync = Store.get('strava_last_sync');
      if (lastSync) Profile.set(PKEY.lastSync, lastSync, id);
      const goal = Store.get('strava_weekly_goal');
      if (goal) Profile.set(PKEY.weeklyGoal, goal, id);
      if (!getActiveId()) setActiveId(id);
    }
    ['strava_access_token', 'strava_refresh_token', 'strava_expires_at',
     'strava_athlete', 'strava_activities', 'strava_last_sync', 'strava_weekly_goal']
      .forEach(k => Store.remove(k));
  }

  if (Store.get('strava_demo_mode') === '1') {
    upsertProfile({ id: DEMO_ID, name: 'Nathan (démo)', avatar: null, demo: true });
    if (!getActiveId()) setActiveId(DEMO_ID);
    Store.remove('strava_demo_mode');
  }
})();
