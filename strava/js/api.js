/* Strava API client: fetches the active athlete's profile and all their
   activities, keeps a slimmed-down copy in the active profile's storage
   and syncs incrementally. */

const STRAVA_API = 'https://www.strava.com/api/v3';

async function apiGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(STRAVA_API + path);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401) {
    throw new Error('Session expirée — reconnecte ce profil à Strava.');
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
    cadence: act.average_cadence ? Math.round(act.average_cadence * 2) : null,
    calories: act.calories || null,
    effort: act.suffer_score || null,
    gap_speed: null,
    avg_grade: null,
    steps: null,
    temp: act.average_temp != null ? act.average_temp : null,
    elev_loss: null,
    kudos: act.kudos_count || 0
  };
}

async function fetchAthlete() {
  const athlete = await apiGet('/athlete');
  Profile.setJSON(PKEY.athlete, athlete);
  /* Keep the registry label/avatar in sync. */
  upsertProfile({
    id: getActiveId(),
    name: profileNameFromAthlete(athlete),
    avatar: athlete.profile_medium || athlete.profile || null
  });
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
   to pick up edits) on subsequent syncs. Stored on the active profile.
   Returns activities sorted by date, most recent first. */
async function syncActivities(onProgress) {
  const cached = Profile.getJSON(PKEY.activities) || [];
  const lastSync = Number(Profile.get(PKEY.lastSync) || 0);
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
  Profile.setJSON(PKEY.activities, merged);
  Profile.set(PKEY.lastSync, String(Math.floor(Date.now() / 1000)));
  return merged;
}

function getCachedActivities() {
  return Profile.getJSON(PKEY.activities);
}

function getCachedAthlete() {
  return Profile.getJSON(PKEY.athlete);
}
