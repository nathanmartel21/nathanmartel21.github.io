/* Strava OAuth2 flow (authorization code).
   The token exchange uses https://www.strava.com/api/v3/oauth/token,
   which supports CORS, so everything runs in the browser — credentials
   never leave this device. */

const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';
const STRAVA_SCOPE = 'read,activity:read_all,profile:read_all';

/* The auth landing page (strava/index.html) is the OAuth callback. */
function redirectUri() {
  const url = new URL('index.html', window.location.href);
  return url.origin + url.pathname;
}

function buildAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: Store.get(STORE.clientId),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: STRAVA_SCOPE,
    approval_prompt: 'auto'
  });
  return `${STRAVA_AUTHORIZE_URL}?${params.toString()}`;
}

function saveTokens(data) {
  Store.set(STORE.accessToken, data.access_token);
  Store.set(STORE.refreshToken, data.refresh_token);
  Store.set(STORE.expiresAt, String(data.expires_at));
  if (data.athlete) {
    Store.setJSON(STORE.athlete, data.athlete);
  }
}

async function exchangeCode(code) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Store.get(STORE.clientId),
      client_secret: Store.get(STORE.clientSecret),
      code,
      grant_type: 'authorization_code'
    })
  });
  if (!response.ok) {
    throw new Error(`Échec de l'échange du code (HTTP ${response.status}). Vérifie ton Client ID / Secret.`);
  }
  saveTokens(await response.json());
}

async function refreshAccessToken() {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Store.get(STORE.clientId),
      client_secret: Store.get(STORE.clientSecret),
      refresh_token: Store.get(STORE.refreshToken),
      grant_type: 'refresh_token'
    })
  });
  if (!response.ok) {
    throw new Error(`Impossible de rafraîchir le token (HTTP ${response.status}).`);
  }
  saveTokens(await response.json());
}

/* Returns a valid access token, refreshing it first if it expires soon. */
async function getAccessToken() {
  const expiresAt = Number(Store.get(STORE.expiresAt) || 0);
  const now = Math.floor(Date.now() / 1000);
  if (now > expiresAt - 300) {
    await refreshAccessToken();
  }
  return Store.get(STORE.accessToken);
}

function logout() {
  clearSession();
  window.location.href = 'index.html';
}
