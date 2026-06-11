/* Strava API client: fetches the athlete profile and all activities,
   keeps a slimmed-down copy in localStorage and syncs incrementally. */

const STRAVA_API = 'https://www.strava.com/api/v3';

async function apiGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(STRAVA_API + path);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401) {
    throw new Error('Session expirée — reconnecte-toi à Strava.');
  }
  if (response.status === 429) {
    throw new Error('Limite de requêtes Strava atteinte — réessaie dans 15 minutes.');
  }
  if (!response.ok) {
    throw new Error(`Erreur API Strava (HTTP ${response.status}).`);
  }
  return response.json();
}

/* Keep only the fields the dashboard needs so thousands of activities
   fit comfortably in localStorage. */
function slimActivity(act) {
  return {
    id: act.id,
    name: act.name,
    type: act.sport_type || act.type,
    distance: act.distance,
    moving_time: act.moving_time,
    elapsed_time: act.elapsed_time,
    elev: act.total_elevation_gain,
    date: act.start_date_local,
    avg_speed: act.average_speed,
    max_speed: act.max_speed,
    avg_hr: act.average_heartrate || null,
    max_hr: act.max_heartrate || null,
    effort: act.suffer_score || null,
    kudos: act.kudos_count || 0
  };
}

async function fetchAthlete() {
  const athlete = await apiGet('/athlete');
  Store.setJSON(STORE.athlete, athlete);
  return athlete;
}

async function fetchActivitiesPaged(extraParams, onProgress) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await apiGet('/athlete/activities', {
      per_page: 200,
      page,
      ...extraParams
    });
    all.push(...batch.map(slimActivity));
    if (onProgress) onProgress(all.length);
    if (batch.length < 200) break;
  }
  return all;
}

/* Full fetch on first run, then incremental (re-fetches the last 7 days
   to pick up edits) on subsequent syncs. Returns activities sorted by
   date, most recent first. */
async function syncActivities(onProgress) {
  const cached = Store.getJSON(STORE.activities) || [];
  const lastSync = Number(Store.get(STORE.lastSync) || 0);
  let merged;

  if (cached.length && lastSync) {
    const after = lastSync - 7 * 86400;
    const fresh = await fetchActivitiesPaged({ after }, onProgress);
    const freshIds = new Set(fresh.map(a => a.id));
    merged = [...fresh, ...cached.filter(a => !freshIds.has(a.id))];
  } else {
    merged = await fetchActivitiesPaged({}, onProgress);
  }

  merged.sort((a, b) => new Date(b.date) - new Date(a.date));
  Store.setJSON(STORE.activities, merged);
  Store.set(STORE.lastSync, String(Math.floor(Date.now() / 1000)));
  return merged;
}

function getCachedActivities() {
  return Store.getJSON(STORE.activities);
}

function getCachedAthlete() {
  return Store.getJSON(STORE.athlete);
}
