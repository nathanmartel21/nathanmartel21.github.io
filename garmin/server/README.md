# Garmin Live Proxy — backend

A tiny **stateless** FastAPI service that lets the Garmin dashboard pull your
data *live*. It never stores your credentials: you log in from the web page,
the server exchanges your email/password for a Garmin session token, hands that
token back to your browser, and from then on only the token is used.

```
browser ──(email+password, once)──▶  /api/login   ──▶ Garmin SSO
browser ◀──────────(session token)──────────────────  (no password kept)
browser ──(token)──▶  /api/sync  ──▶ Garmin Connect API ──▶ activities + wellness JSON
```

## Endpoints

| Method | Path             | Body                                   | Returns |
|--------|------------------|----------------------------------------|---------|
| POST   | `/api/login`     | `{email, password}`                    | `{status:"ok", token, name}` or `{status:"mfa_required", ticket}` |
| POST   | `/api/login/mfa` | `{ticket, code}`                       | `{status:"ok", token, name}` |
| POST   | `/api/sync`      | `{token, wellness_days?, activities_limit?}` | the dashboard JSON (+ refreshed `token`) |

## Run locally

```bash
cd garmin/server
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

Then on the dashboard's connect screen, set the backend URL to
`http://localhost:8000`.

## Deploy free — Hugging Face Spaces (recommended, no credit card)

1. Create an account on <https://huggingface.co>.
2. **New Space** → SDK: **Docker** → blank template → make it **Public** (so the
   code stays transparent — it touches your password) or Private if you prefer.
3. Upload the four files from this folder: `Dockerfile`, `requirements.txt`,
   `app.py`, `garmin_pull.py` (or push them with git to the Space repo).
4. Wait for the build. Your backend URL is
   `https://<your-user>-<space-name>.hf.space`.
5. (Optional, recommended) In the Space **Settings → Variables**, add
   `ALLOWED_ORIGINS = https://nathanmartel21.github.io` to lock CORS to your site.
6. Paste that URL into the dashboard's connect screen.

> Spaces sleep after inactivity and wake on the next request (first call after a
> nap is slow). That's normal on the free tier.

## Deploy free — Render (alternative)

1. Push this `server/` folder to a GitHub repo.
2. Render → **New → Web Service** → connect the repo → it detects the Dockerfile.
3. Instance type: **Free**. Add env var `ALLOWED_ORIGINS` as above. Deploy.
4. Use the `https://<service>.onrender.com` URL on the dashboard.

> The free Render tier spins the service down after ~15 min idle; the first
> request afterwards cold-starts (~50 s).

## ⚠️ The one thing that can fail: Garmin + cloud IPs

Garmin's SSO sometimes flags logins coming from **datacenter IPs** (any free
host) and forces a 2FA/MFA challenge or refuses outright. The dashboard handles
the MFA code prompt, but if a host's IP is hard-blocked, use the **local
exporter** below instead — it logs in from your own IP, which Garmin trusts.

## Fallback: local export (no server)

```bash
cd garmin/server
pip install -r requirements.txt
python export_local.py --days 120
```

This writes `garmin-data.json`. On the dashboard, choose **« Importer un
fichier »** and drop that file in. Same data, no server, credentials stay on
your machine.

## Privacy

- The server keeps **no database and no files**. The only state is a 5-minute
  in-memory map of *pending MFA logins*, cleared automatically.
- Your password is used once to obtain a token, then discarded. It is never
  logged or returned.
- The session token lives in **your browser's localStorage** (like the Strava
  tokens) and is sent to `/api/sync` to fetch data.
