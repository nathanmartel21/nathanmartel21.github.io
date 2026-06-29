/* Talks to the stateless Garmin proxy backend (garmin/server/).

   The flow mirrors Strava's OAuth model: log in once with email/password
   (+ MFA if Garmin asks), receive an opaque session token, store it in this
   browser, and from then on pull data with the token only. The password is
   never stored. Pulled activities + wellness are cached per profile so the
   dashboard loads instantly; "refresh" re-pulls. */

async function apiPost(path, body) {
  const base = getBackendUrl();
  if (!base) throw new Error("Aucune URL de backend configurée.");
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error("Impossible de joindre le serveur. Vérifie l'URL du backend (et qu'il est bien démarré — un hébergeur gratuit peut mettre ~1 min à se réveiller).");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error((data && data.detail) || `Erreur serveur (HTTP ${res.status}).`);
  }
  return data;
}

/* ---------------- Auth ---------------- */

function backendLogin(email, password) {
  return apiPost('/api/login', { email, password });
}

function backendMfa(ticket, code) {
  return apiPost('/api/login/mfa', { ticket, code });
}

function slugify(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'athlete';
}

/* Stores a freshly obtained session token under a (name-based) profile and
   makes it active. Re-logging the same athlete updates the same profile. */
function createLiveProfile(token, name) {
  const id = `g_${slugify(name)}`;
  upsertProfile({ id, name: name || 'Athlète', avatar: null, source: 'live' });
  Profile.set(PKEY.token, token, id);
  setActiveId(id);
  return id;
}

/* ---------------- Sync ---------------- */

function getSyncDays(id = getActiveId()) {
  const v = Number(Profile.get(PKEY.syncDays, id));
  return v > 0 ? v : 30;
}
function setSyncDays(days, id = getActiveId()) {
  Profile.set(PKEY.syncDays, String(days), id);
}

/* Pulls live data for a profile and caches it. */
async function syncLive(id = getActiveId(), days = getSyncDays(id)) {
  const token = Profile.get(PKEY.token, id);
  if (!token) throw new Error("Session expirée — reconnecte-toi.");

  const data = await apiPost('/api/sync', {
    token,
    wellness_days: days,
    activities_limit: 600
  });

  if (data.token) Profile.set(PKEY.token, data.token, id);   // refreshed session
  if (data.athlete) Profile.setJSON(PKEY.athlete, data.athlete, id);
  Profile.setJSON(PKEY.activities, data.activities || [], id);
  Profile.setJSON(PKEY.wellness, data.wellness || [], id);
  Profile.setJSON(PKEY.snapshot, data.snapshot || {}, id);
  Profile.set(PKEY.lastSync, String(Math.floor(Date.now() / 1000)), id);
  return data;
}

/* ---------------- Cache getters ---------------- */

function getCachedActivities(id = getActiveId()) { return Profile.getJSON(PKEY.activities, id); }
function getCachedWellness(id = getActiveId()) { return Profile.getJSON(PKEY.wellness, id) || []; }
function getCachedSnapshot(id = getActiveId()) { return Profile.getJSON(PKEY.snapshot, id) || {}; }
function getCachedAthlete(id = getActiveId()) { return Profile.getJSON(PKEY.athlete, id); }
function getLastSync(id = getActiveId()) {
  const v = Number(Profile.get(PKEY.lastSync, id));
  return v > 0 ? new Date(v * 1000) : null;
}

/* ---------------- Per-activity detail (lazy, cached) ---------------- */

/* Fetches splits / HR zones / GPS track for one activity from the relay.
   Live profiles only (needs a session token). Cached forever per profile +
   activity, since a past activity's detail never changes. */
async function getActivityDetail(activityId, id = getActiveId()) {
  const ck = `garmin_prof_${id}_actdetail_${activityId}`;
  try { const cached = localStorage.getItem(ck); if (cached) return JSON.parse(cached); } catch {}
  const token = Profile.get(PKEY.token, id);
  if (!token) throw new Error("Détail disponible uniquement pour un compte Garmin connecté.");
  const data = await apiPost('/api/activity', { token, activity_id: Number(activityId) });
  try { localStorage.setItem(ck, JSON.stringify(data)); } catch {}
  return data;
}

/* Removes the active profile and routes to the next sensible screen. */
function logoutActive() {
  const id = getActiveId();
  if (id) removeProfile(id);
  if (hasProfiles()) window.location.reload();
  else window.location.href = 'index.html';
}
