/* Strava OAuth2 flow (authorization code), multi-athlete aware.

   The token exchange uses https://www.strava.com/api/v3/oauth/token,
   which supports CORS, so everything runs in the browser — credentials
   never leave this device. The athlete returned by the exchange decides
   which profile the tokens belong to. */

const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';
const STRAVA_SCOPE = 'read,activity:read_all,profile:read_all';

/* The auth landing page (strava/index.html) is the OAuth callback. */
function redirectUri() {
  const url = new URL('index.html', window.location.href);
  return url.origin + url.pathname;
}

/* `force` re-shows Strava's consent screen — used when adding a second
   athlete so the right account can be authorised. */
function buildAuthorizeUrl(force) {
  const params = new URLSearchParams({
    client_id: Store.get(APP.clientId),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: STRAVA_SCOPE,
    approval_prompt: force ? 'force' : 'auto'
  });
  return `${STRAVA_AUTHORIZE_URL}?${params.toString()}`;
}

function profileNameFromAthlete(athlete) {
  return `${athlete.firstname || ''} ${athlete.lastname || ''}`.trim() || 'Athlète';
}

function saveTokens(data, id) {
  Profile.set(PKEY.accessToken, data.access_token, id);
  Profile.set(PKEY.refreshToken, data.refresh_token, id);
  Profile.set(PKEY.expiresAt, String(data.expires_at), id);
  if (data.athlete) Profile.setJSON(PKEY.athlete, data.athlete, id);
}

/* Exchanges the OAuth code, creates/updates the matching profile and
   makes it active. Returns the profile id. */
async function exchangeCode(code) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Store.get(APP.clientId),
      client_secret: Store.get(APP.clientSecret),
      code,
      grant_type: 'authorization_code'
    })
  });
  if (!response.ok) {
    throw new Error(`Échec de l'échange du code (HTTP ${response.status}). Vérifie ton Client ID / Secret.`);
  }
  const data = await response.json();
  const athlete = data.athlete || {};
  const id = String(athlete.id || `a${Date.now()}`);
  upsertProfile({
    id,
    name: profileNameFromAthlete(athlete),
    avatar: athlete.profile_medium || athlete.profile || null
  });
  saveTokens(data, id);
  setActiveId(id);
  return id;
}

async function refreshAccessToken(id = getActiveId()) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Store.get(APP.clientId),
      client_secret: Store.get(APP.clientSecret),
      refresh_token: Profile.get(PKEY.refreshToken, id),
      grant_type: 'refresh_token'
    })
  });
  if (!response.ok) {
    throw new Error(`Impossible de rafraîchir le token (HTTP ${response.status}).`);
  }
  saveTokens(await response.json(), id);
}

/* Returns a valid access token for the active profile, refreshing it
   first if it expires soon. */
async function getAccessToken() {
  const id = getActiveId();
  const expiresAt = Number(Profile.get(PKEY.expiresAt, id) || 0);
  const now = Math.floor(Date.now() / 1000);
  if (now > expiresAt - 300) {
    await refreshAccessToken(id);
  }
  return Profile.get(PKEY.accessToken, id);
}

/* Removes the active profile and routes to the next sensible screen. */
function logoutActive() {
  const id = getActiveId();
  if (id) removeProfile(id);
  if (hasProfiles()) {
    window.location.reload();
  } else {
    window.location.href = 'index.html';
  }
}
