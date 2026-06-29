/* Configuration & storage for the Garmin Premium app.

   Like the Strava app, this is multi-athlete and 100% browser-side. The only
   shared, app-level setting is the URL of the stateless Garmin proxy backend
   (see garmin/server/). Each connected athlete is an isolated "profile":
   per-profile data (the Garmin session token, cached activities + wellness,
   goal, plan inputs) is namespaced under `garmin_prof_<id>_<suffix>`.

   A profile's `source` is one of:
     - 'live'   : connected through the backend, has a session token
     - 'import' : built from an uploaded garmin-data.json (local exporter)
     - 'demo'   : generated sample data */

/* App-level keys, shared across all athletes. */
const APP = {
  backendUrl: 'garmin_backend_url',   // the FastAPI proxy base URL
  profiles: 'garmin_profiles',        // [{ id, name, avatar, source }]
  active: 'garmin_active_profile'     // id string
};

/* Per-profile key suffixes. */
const PKEY = {
  token: 'token',                     // opaque Garmin session token (live)
  athlete: 'athlete',
  activities: 'activities',
  wellness: 'wellness',
  snapshot: 'snapshot',
  lastSync: 'last_sync',
  weeklyGoal: 'weekly_goal',
  syncDays: 'sync_days',
  city: 'city',                       // athlete's city, for the weather planner
  raceKm: 'race_km',                  // goal-race distance (km)
  raceDate: 'race_date',              // goal-race date (YYYY-MM-DD)
  raceTarget: 'race_target',          // goal-race target time (hh:mm:ss)
  shoes: 'shoes'                      // gear/shoe tracker (reserved for a later phase)
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
  Object.values(PKEY).forEach(suffix => Store.remove(`garmin_prof_${id}_${suffix}`));
  if (getActiveId() === id) {
    const remaining = getProfiles();
    if (remaining.length) setActiveId(remaining[0].id);
    else Store.remove(APP.active);
  }
}

/* ---------------- Per-profile storage ---------------- */

const Profile = {
  key(suffix, id) { return `garmin_prof_${id || getActiveId()}_${suffix}`; },
  get(suffix, id) { return localStorage.getItem(Profile.key(suffix, id)); },
  set(suffix, value, id) { localStorage.setItem(Profile.key(suffix, id), value); },
  remove(suffix, id) { localStorage.removeItem(Profile.key(suffix, id)); },
  getJSON(suffix, id) {
    try { const raw = localStorage.getItem(Profile.key(suffix, id)); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  },
  setJSON(suffix, value, id) { localStorage.setItem(Profile.key(suffix, id), JSON.stringify(value)); }
};

/* ---------------- App-level helpers ---------------- */

function getBackendUrl() {
  const url = Store.get(APP.backendUrl);
  return url ? url.replace(/\/+$/, '') : '';
}
function setBackendUrl(url) { Store.set(APP.backendUrl, (url || '').trim().replace(/\/+$/, '')); }
function isConfigured() { return Boolean(getBackendUrl()); }

function isActiveDemo() { return getActiveId() === DEMO_ID; }

function isActiveImport() {
  const profile = getActiveProfile();
  return Boolean(profile && profile.source === 'import');
}

function isActiveLive() {
  const profile = getActiveProfile();
  return Boolean(profile && profile.source === 'live');
}

/* True when the active profile can show a dashboard. */
function activeHasSession() {
  const id = getActiveId();
  if (!id) return false;
  if (id === DEMO_ID) return true;
  const profile = getProfile(id);
  if (!profile) return false;
  if (profile.source === 'import') {
    const acts = Profile.getJSON(PKEY.activities, id);
    return Boolean(acts && acts.length);
  }
  // live: needs a session token
  return Boolean(Profile.get(PKEY.token, id));
}

function ensureDemoProfile() {
  upsertProfile({ id: DEMO_ID, name: 'Nathan (démo)', avatar: null, source: 'demo' });
  setActiveId(DEMO_ID);
}
