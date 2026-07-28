"""Stateless Garmin Connect proxy for the web dashboard.

Design goal: **the server stores no credentials, ever.**

  POST /api/login      {email, password}
       -> logs in to Garmin via garminconnect/garth
       -> returns an opaque *session token* (the Garth OAuth tokens, which the
          browser stores in localStorage — exactly like the Strava token model)
       -> if Garmin demands a 2FA code, returns {status:"mfa_required", ticket}

  POST /api/login/mfa  {ticket, code}
       -> finishes a pending MFA login, returns the session token

  POST /api/sync       {token, wellness_days?, activities_limit?}
       -> rebuilds the Garmin client *from the token only* (no password),
          pulls activities + wellness, returns the dashboard JSON, plus a
          refreshed token so the browser keeps a valid session

The only state kept is a short-lived in-memory map of *pending MFA logins*
(cleared after 5 min). No password is logged, persisted or returned.

Run locally:   uvicorn app:app --reload --port 8000
Deploy:        see README.md (Hugging Face Spaces / Render).
"""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import hmac
import json
import os
import secrets
import smtplib
import time
import urllib.request as _urlreq
import uuid
from collections import defaultdict
from email.message import EmailMessage
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from garminconnect import Garmin

import garmin_pull

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None

try:
    from pywebpush import webpush, WebPushException
except Exception:  # pragma: no cover — push disabled if the dep is missing
    webpush = None
    WebPushException = Exception

app = FastAPI(title="Garmin Live Proxy", version="1.0")

_origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pending MFA logins: ticket -> (garmin_client, garth_state, created_at).
_MFA_PENDING: dict[str, tuple[Any, Any, float]] = {}
_MFA_TTL = 300  # seconds


def _gc_pending() -> None:
    now = time.time()
    for k in [k for k, v in _MFA_PENDING.items() if now - v[2] > _MFA_TTL]:
        _MFA_PENDING.pop(k, None)


# --------------------------------------------------------------------------- #
# Per-IP rate limiting — the endpoints are public and unauthenticated, so this
# stops abuse (spam / using the server as a Garmin-login relay). In-memory,
# fixed-window. Tunable via env RL_MAX / RL_WINDOW.
# --------------------------------------------------------------------------- #

_RL_HITS: dict[str, list[float]] = defaultdict(list)
_RL_MAX = int(os.environ.get("RL_MAX", "6"))          # login attempts...
_RL_WINDOW = int(os.environ.get("RL_WINDOW", "600"))  # ...per this many seconds


def _client_ip(request: Request) -> str:
    # Behind HF/Render proxies the real client is in X-Forwarded-For.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limit(request: Request) -> None:
    now = time.time()
    # Opportunistic cleanup so the map can't grow unbounded.
    if len(_RL_HITS) > 4096:
        for ip in [ip for ip, ts in _RL_HITS.items() if not ts or now - ts[-1] > _RL_WINDOW]:
            _RL_HITS.pop(ip, None)
    ip = _client_ip(request)
    hits = [t for t in _RL_HITS[ip] if now - t < _RL_WINDOW]
    if len(hits) >= _RL_MAX:
        retry = int(_RL_WINDOW - (now - hits[0])) // 60 + 1
        raise HTTPException(status_code=429, detail=f"Trop de tentatives de connexion. Réessaie dans ~{retry} min.")
    hits.append(now)
    _RL_HITS[ip] = hits


# --------------------------------------------------------------------------- #
# Token (opaque to the browser): base64(json({garth, display_name, full_name}))
# --------------------------------------------------------------------------- #

# This garminconnect version bundles its garth client at ``garmin.client``
# (with dumps/loads/connectapi) — there is no ``garmin.garth`` attribute.
def _ensure_profile(garmin: Garmin) -> None:
    """Populate display_name/full_name (login(return_on_mfa) skips this)."""
    if getattr(garmin, "display_name", None):
        return
    try:
        prof = garmin.client.connectapi("/userprofile-service/socialProfile")
        if isinstance(prof, dict):
            garmin.display_name = prof.get("displayName")
            garmin.full_name = prof.get("fullName") or getattr(garmin, "full_name", None)
    except Exception:  # noqa: BLE001
        pass


def _name(garmin: Garmin) -> str:
    return getattr(garmin, "full_name", None) or getattr(garmin, "display_name", None) or "Athlète"


def _make_token(garmin: Garmin) -> str:
    payload = {
        "garth": garmin.client.dumps(),
        "display_name": getattr(garmin, "display_name", None),
        "full_name": getattr(garmin, "full_name", None),
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _client_from_token(token: str) -> Garmin:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.encode()).decode())
        garmin = Garmin()
        garmin.client.loads(payload["garth"])
        # Methods build URLs from display_name; set it from the token so we
        # never need the password again.
        if payload.get("display_name"):
            garmin.display_name = payload["display_name"]
        if payload.get("full_name"):
            garmin.full_name = payload["full_name"]
        _ensure_profile(garmin)
        return garmin
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail="Session invalide ou expirée, reconnecte-toi.") from exc


# --------------------------------------------------------------------------- #
# Request models                                                              #
# --------------------------------------------------------------------------- #

class LoginIn(BaseModel):
    email: str
    password: str


class MfaIn(BaseModel):
    ticket: str
    code: str


class SyncIn(BaseModel):
    token: str
    wellness_days: int = 30
    activities_limit: int = 400


class ActivityDetailIn(BaseModel):
    token: str
    activity_id: int


# --------------------------------------------------------------------------- #
# Routes                                                                      #
# --------------------------------------------------------------------------- #

@app.get("/")
def root() -> dict:
    return {"service": "garmin-live-proxy", "status": "ok",
            "endpoints": ["/api/login", "/api/login/mfa", "/api/sync"]}


@app.post("/api/login")
def login(body: LoginIn, request: Request) -> dict:
    _rate_limit(request)
    _gc_pending()
    try:
        garmin = Garmin(email=body.email, password=body.password, return_on_mfa=True)
        result = garmin.login()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Échec de connexion Garmin : {exc}") from exc

    # With return_on_mfa, login() yields (result1, result2). result1 == "needs_mfa"
    # means Garmin wants a 2FA code; result2 is the client state to resume with.
    if isinstance(result, tuple):
        result1, result2 = result
        if result1 == "needs_mfa":
            ticket = uuid.uuid4().hex
            _MFA_PENDING[ticket] = (garmin, result2, time.time())
            return {"status": "mfa_required", "ticket": ticket}

    # Clean login via return_on_mfa returns before the profile is loaded.
    _ensure_profile(garmin)
    return {"status": "ok", "token": _make_token(garmin), "name": _name(garmin)}


@app.post("/api/login/mfa")
def login_mfa(body: MfaIn, request: Request) -> dict:
    _rate_limit(request)
    _gc_pending()
    pending = _MFA_PENDING.pop(body.ticket, None)
    if not pending:
        raise HTTPException(status_code=400, detail="Demande MFA expirée — recommence la connexion.")
    garmin, state, _ = pending
    try:
        garmin.resume_login(state, body.code.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Code MFA refusé : {exc}") from exc

    _ensure_profile(garmin)
    return {"status": "ok", "token": _make_token(garmin), "name": _name(garmin)}


@app.post("/api/sync")
def sync(body: SyncIn) -> dict:
    garmin = _client_from_token(body.token)
    days = max(1, min(body.wellness_days, 120))
    limit = max(1, min(body.activities_limit, 1000))
    try:
        data = garmin_pull.pull_all(garmin, activities_limit=limit, wellness_days=days)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Erreur lors de la récupération Garmin : {exc}") from exc

    # Hand back a refreshed token so the browser session stays valid.
    data["token"] = _make_token(garmin)
    return data


@app.post("/api/activity")
def activity_detail(body: ActivityDetailIn) -> dict:
    """Lazy per-activity detail (km splits, HR zones, GPS track). Token-only,
    like /api/sync — no password, nothing stored."""
    garmin = _client_from_token(body.token)
    try:
        return garmin_pull.pull_activity_detail(garmin, body.activity_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Erreur lors de la récupération du détail : {exc}") from exc


# --------------------------------------------------------------------------- #
# Web Push — hydration + session-of-the-day reminders.                        #
#                                                                             #
# Design mirrors the rest of the app: no Garmin credentials touched. The      #
# browser precomputes a 3-day session PLAN (client-side suggestRun) and POSTs #
# it with the push subscription; an hourly external cron hits /api/push/tick, #
# and we send whichever slot is due in each subscriber's OWN timezone (so DST #
# and the Space sleeping never matter). Subscriptions live in memory only —   #
# the browser re-subscribes on every app open, repopulating after a restart.  #
# --------------------------------------------------------------------------- #

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
CRON_SECRET = os.environ.get("CRON_SECRET", "")

HYDRATION_HOURS = [10, 15, 21]
RUN_REMINDER_HOUR = 8

# endpoint -> {"subscription": {...}, "prefs": {...}, "tz": str, "plan": [...], "sent": set()}
_SUBS: dict[str, dict] = {}


class SubscribeIn(BaseModel):
    subscription: dict
    prefs: dict = {}
    tz: str = "Europe/Paris"
    plan: list = []


class EndpointIn(BaseModel):
    endpoint: str


class TickIn(BaseModel):
    secret: str = ""


def _push_enabled() -> bool:
    return bool(webpush and VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


def _send(sub: dict, title: str, body: str, tag: str) -> bool:
    """Send one push; drop the subscription on 404/410 (expired)."""
    if not _push_enabled():
        return False
    payload = json.dumps({"title": title, "body": body, "tag": tag, "url": "./app.html"})
    try:
        webpush(
            subscription_info=sub["subscription"],
            data=payload,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
        )
        return True
    except WebPushException as exc:  # noqa: BLE001
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            _SUBS.pop(sub["subscription"].get("endpoint", ""), None)
        return False
    except Exception:  # noqa: BLE001
        return False


def _local_now(tzname: str) -> _dt.datetime:
    if ZoneInfo is not None:
        try:
            return _dt.datetime.now(ZoneInfo(tzname))
        except Exception:  # noqa: BLE001 — unknown tz / missing tzdata
            pass
    return _dt.datetime.now()


@app.get("/api/push/vapid")
def push_vapid() -> dict:
    return {"key": VAPID_PUBLIC_KEY, "enabled": _push_enabled()}


@app.post("/api/push/subscribe")
def push_subscribe(body: SubscribeIn) -> dict:
    endpoint = (body.subscription or {}).get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="Abonnement invalide.")
    existing = _SUBS.get(endpoint, {})
    _SUBS[endpoint] = {
        "subscription": body.subscription,
        "prefs": body.prefs or {},
        "tz": body.tz or "Europe/Paris",
        "plan": body.plan or [],
        "sent": existing.get("sent", set()),
    }
    return {"status": "ok"}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: EndpointIn) -> dict:
    _SUBS.pop(body.endpoint, None)
    return {"status": "ok"}


@app.post("/api/push/test")
def push_test(body: EndpointIn) -> dict:
    sub = _SUBS.get(body.endpoint)
    if not sub:
        raise HTTPException(status_code=404, detail="Abonnement inconnu.")
    ok = _send(sub, "🔔 Test réussi", "Tes rappels Garmin Premium fonctionnent 👌", "garmin-test")
    return {"status": "ok" if ok else "failed"}


@app.post("/api/push/tick")
def push_tick(body: TickIn, request: Request) -> dict:
    """Called hourly by the cron. Sends the slot due in each subscriber's local
    time (hydration at 10/15/21h, session reminder at 8h)."""
    secret = body.secret or request.headers.get("x-cron-secret", "")
    if CRON_SECRET and secret != CRON_SECRET:
        raise HTTPException(status_code=401, detail="Bad cron secret.")
    if not _push_enabled():
        return {"status": "push_disabled", "sent": 0}

    sent = 0
    for endpoint, sub in list(_SUBS.items()):
        now = _local_now(sub.get("tz", "Europe/Paris"))
        hour = now.hour
        today = now.date().isoformat()
        prefs = sub.get("prefs", {})
        seen: set = sub.setdefault("sent", set())

        # Hydration reminders.
        if prefs.get("hydration") and hour in HYDRATION_HOURS:
            key = f"{today}:hydration_{hour}"
            if key not in seen:
                msgs = {10: "Un grand verre d’eau pour bien démarrer 💧",
                        15: "Pause hydratation — bois un coup 💧",
                        21: "Dernier verre d’eau de la journée 💧"}
                if _send(sub, "💧 Hydratation", msgs.get(hour, "Pense à boire de l’eau."), f"hydration-{hour}"):
                    seen.add(key)
                    sent += 1

        # Session-of-the-day reminder (only on days with a session in the plan).
        if prefs.get("run") and hour == RUN_REMINDER_HOUR:
            key = f"{today}:run"
            if key not in seen:
                entry = next((p for p in sub.get("plan", []) if p.get("date") == today), None)
                if entry and entry.get("session"):
                    body_txt = entry.get("body") or entry.get("title") or "Séance conseillée aujourd’hui."
                    if _send(sub, "🏃 Séance du jour", body_txt, "run-reminder"):
                        seen.add(key)
                        sent += 1

        # Keep the per-endpoint "sent" set from growing without bound.
        if len(seen) > 40:
            sub["sent"] = {k for k in seen if k.startswith(today)}

    return {"status": "ok", "sent": sent, "subscribers": len(_SUBS)}


# --------------------------------------------------------------------------- #
# Coffre (password vault) — security-event sink.                              #
#                                                                             #
# Receives METADATA-ONLY events from the vault (never entry contents / a      #
# password). Ships each to Elasticsearch for a Kibana dashboard, and sends a  #
# push alert for the sensitive event types to subscribers who opted in        #
# (prefs.coffre). Optional shared token deters casual abuse of the endpoint.  #
# --------------------------------------------------------------------------- #

ES_URL = os.environ.get("ES_URL", "").rstrip("/")
ES_API_KEY = os.environ.get("ES_API_KEY", "")
ES_USER = os.environ.get("ES_USER", "")           # basic-auth alternative (e.g. Bonsai)
ES_PASS = os.environ.get("ES_PASS", "")
ES_INDEX = os.environ.get("ES_INDEX", "coffre-events")
COFFRE_TOKEN = os.environ.get("COFFRE_TOKEN", "")


def _es_auth() -> str:
    if ES_API_KEY:
        return f"ApiKey {ES_API_KEY}"
    if ES_USER and ES_PASS:
        return "Basic " + base64.b64encode(f"{ES_USER}:{ES_PASS}".encode()).decode()
    return ""


def _es_enabled() -> bool:
    return bool(ES_URL and _es_auth())

COFFRE_ALERTS = {
    "access_denied": "Accès refusé (géo/VPN)",
    "create_denied": "Création refusée (géo/VPN)",
    "unlock_fail": "Échec de déverrouillage",
    "self_destruct": "Auto-destruction du coffre",
    "master_changed": "Mot de passe maître modifié",
    "wipe": "Coffre effacé",
    "import": "Coffre importé",
}


class CoffreEventIn(BaseModel):
    token: str = ""
    type: str
    ok: bool = False
    ts: Optional[int] = None
    meta: dict = {}


def _ship_es(doc: dict) -> None:
    if not _es_enabled():
        return
    try:
        req = _urlreq.Request(
            f"{ES_URL}/{ES_INDEX}/_doc",
            data=json.dumps(doc).encode(),
            headers={"Content-Type": "application/json", "Authorization": _es_auth()},
            method="POST",
        )
        _urlreq.urlopen(req, timeout=5)  # noqa: S310 — fixed trusted URL
    except Exception:  # noqa: BLE001 — logging must never break the app
        pass


@app.post("/api/coffre/event")
def coffre_event(body: CoffreEventIn, request: Request) -> dict:
    if COFFRE_TOKEN and body.token != COFFRE_TOKEN:
        raise HTTPException(status_code=401, detail="Bad coffre token.")
    doc = {
        "@timestamp": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "event": body.type,
        "ok": bool(body.ok),
        "meta": body.meta or {},
        "ip": _client_ip(request),
    }
    _ship_es(doc)

    alerted = 0
    label = COFFRE_ALERTS.get(body.type)
    if label and _push_enabled():
        city = (body.meta or {}).get("city") or ""
        isp = (body.meta or {}).get("isp") or ""
        detail = " · ".join([x for x in (city, isp) if x])
        text = label + (f" — {detail}" if detail else "")
        for _ep, sub in list(_SUBS.items()):
            if sub.get("prefs", {}).get("coffre"):
                if _send(sub, "🔐 Alerte Coffre", text, "coffre-alert"):
                    alerted += 1
    return {"status": "ok", "alerted": alerted}


# --------------------------------------------------------------------------- #
# Access system — request/approve distribution + email-OTP login.             #
#                                                                             #
# Datastore = Elasticsearch (access-requests, access-users). Email = Gmail    #
# SMTP. Sessions = stateless HMAC-signed tokens. Email-OTP is an ACCESS layer #
# only; it never touches the vault's zero-knowledge master password.          #
# --------------------------------------------------------------------------- #

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "") or SMTP_USER
# HTTP email APIs (HF Spaces block outbound SMTP — use these over HTTPS instead).
MAIL_FROM = os.environ.get("MAIL_FROM", "") or SMTP_FROM         # verified sender address
MAIL_FROM_NAME = os.environ.get("MAIL_FROM_NAME", "Accès")
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip().lower()
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
SITE_URL = os.environ.get("SITE_URL", "https://nathanmartel21.github.io")
ES_REQ_INDEX = os.environ.get("ES_REQ_INDEX", "access-requests")
ES_USER_INDEX = os.environ.get("ES_USER_INDEX", "access-users")
ES_LOG_INDEX = os.environ.get("ES_LOG_INDEX", "access-logs")

# Pending OTP codes (in memory, short-lived): email -> (code, expires, tries).
_OTP: dict[str, tuple[str, float, int]] = {}

# Per-IP auth lockout: too many wrong codes from one IP → temporary block.
_AUTH_FAIL: dict[str, dict] = {}
AUTH_MAX_FAILS = int(os.environ.get("AUTH_MAX_FAILS", "5"))
AUTH_LOCK = int(os.environ.get("AUTH_LOCK", "900"))   # seconds


def _auth_locked(ip: str) -> bool:
    g = _AUTH_FAIL.get(ip)
    return bool(g and g.get("until", 0) > time.time())


def _auth_fail(ip: str) -> bool:
    """Record a failed attempt; returns True if this trips the lockout."""
    g = _AUTH_FAIL.setdefault(ip, {"fails": 0, "until": 0})
    g["fails"] += 1
    if g["fails"] >= AUTH_MAX_FAILS:
        g["until"] = time.time() + AUTH_LOCK
        g["fails"] = 0
        return True
    return False


def _auth_clear(ip: str) -> None:
    _AUTH_FAIL.pop(ip, None)


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _email_provider() -> str:
    if BREVO_API_KEY:
        return "brevo"
    if RESEND_API_KEY:
        return "resend"
    if SMTP_USER and SMTP_PASS:
        return "smtp"
    return ""


def _http_post(url: str, payload: dict, headers: dict, tag: str) -> bool:
    try:
        req = _urlreq.Request(url, data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json", **headers}, method="POST")
        with _urlreq.urlopen(req, timeout=12) as r:
            r.read()
        return True
    except _urlreq.HTTPError as e:
        try:
            body = e.read().decode()[:300]
        except Exception:  # noqa: BLE001
            body = ""
        print(f"[email] {tag} HTTP {e.code}: {body}", flush=True)
        return False
    except Exception as e:  # noqa: BLE001
        print(f"[email] {tag} err: {type(e).__name__}: {e}", flush=True)
        return False


def _send_email(to: str, subject: str, text: str) -> bool:
    p = _email_provider()
    if p == "brevo":
        return _http_post("https://api.brevo.com/v3/smtp/email",
                          {"sender": {"email": MAIL_FROM, "name": MAIL_FROM_NAME},
                           "to": [{"email": to}], "subject": subject, "textContent": text},
                          {"api-key": BREVO_API_KEY, "accept": "application/json"}, "brevo")
    if p == "resend":
        return _http_post("https://api.resend.com/emails",
                          {"from": MAIL_FROM or "onboarding@resend.dev", "to": [to],
                           "subject": subject, "text": text},
                          {"Authorization": f"Bearer {RESEND_API_KEY}"}, "resend")
    if p == "smtp":
        try:
            msg = EmailMessage()
            msg["From"] = MAIL_FROM or SMTP_USER
            msg["To"] = to
            msg["Subject"] = subject
            msg.set_content(text)
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=12) as s:
                s.starttls()
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[email] smtp err: {type(e).__name__}: {e}", flush=True)
            return False
    print("[email] aucun fournisseur configuré (BREVO_API_KEY / RESEND_API_KEY / SMTP).", flush=True)
    return False


def _es(method: str, path: str, body: Optional[dict] = None) -> Optional[dict]:
    if not _es_enabled():
        return None
    try:
        data = json.dumps(body).encode() if body is not None else None
        req = _urlreq.Request(f"{ES_URL}{path}", data=data, method=method,
                              headers={"Content-Type": "application/json",
                                       "Authorization": _es_auth()})
        with _urlreq.urlopen(req, timeout=6) as r:  # noqa: S310
            return json.loads(r.read().decode())
    except _urlreq.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:  # noqa: BLE001
            return None
    except Exception:  # noqa: BLE001
        return None


def _audit(event: str, meta: dict) -> None:
    _es("POST", f"/{ES_LOG_INDEX}/_doc", {"@timestamp": _now_iso(), "event": event, **meta})


def _notify_owner(title: str, text: str) -> int:
    """Push an alert to the owner's device(s) — reuses the coffre-alert opt-in."""
    if not _push_enabled():
        return 0
    n = 0
    for _ep, sub in list(_SUBS.items()):
        if sub.get("prefs", {}).get("coffre"):
            if _send(sub, title, text, "access-alert"):
                n += 1
    return n


def _sign(payload: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(SESSION_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def _verify_token(token: str) -> Optional[dict]:
    if not SESSION_SECRET or "." not in token:
        return None
    try:
        body, sig = token.split(".", 1)
        exp = hmac.new(SESSION_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, exp):
            return None
        pad = "=" * ((4 - len(body) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + pad))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:  # noqa: BLE001
        return None


def _auth(request: Request) -> Optional[dict]:
    h = request.headers.get("authorization", "")
    return _verify_token(h[7:]) if h.startswith("Bearer ") else None


def _is_approved(email: str) -> bool:
    r = _es("GET", f"/{ES_USER_INDEX}/_doc/{email}")
    return bool(r and r.get("found"))


class AccessReqIn(BaseModel):
    email: str
    first: str = ""
    last: str = ""
    reason: str = ""


class EmailIn(BaseModel):
    email: str


class OtpIn(BaseModel):
    email: str
    code: str


class DecideIn(BaseModel):
    id: str
    decision: str


@app.post("/api/access/request")
def access_request(body: AccessReqIn, request: Request) -> dict:
    _rate_limit(request)
    email = body.email.strip().lower()
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Email invalide.")
    rid = uuid.uuid4().hex
    doc = {"email": email, "first": body.first.strip()[:80], "last": body.last.strip()[:80],
           "reason": body.reason.strip()[:1000], "status": "pending", "ts": _now_iso(),
           "ip": _client_ip(request)}
    _es("PUT", f"/{ES_REQ_INDEX}/_doc/{rid}", doc)
    _audit("access_request", {"email": email})
    _notify_owner("🎫 Nouvelle demande d'accès", f"{doc['first']} {doc['last']} <{email}>".strip())
    if ADMIN_EMAIL:
        _send_email(ADMIN_EMAIL, "Nouvelle demande d'accès",
                    f"{doc['first']} {doc['last']} <{email}>\n\nMotif :\n{doc['reason']}\n\n"
                    f"Approuver/refuser : {SITE_URL}/admin/")
    return {"status": "ok", "message": "Demande envoyée. Tu recevras un email après validation."}


@app.post("/api/auth/request-otp")
def request_otp(body: EmailIn, request: Request) -> dict:
    _rate_limit(request)
    email = body.email.strip().lower()
    if email == ADMIN_EMAIL or _is_approved(email):
        code = f"{secrets.randbelow(1000000):06d}"
        _OTP[email] = (code, time.time() + 600, 0)
        _send_email(email, "Ton code de connexion",
                    f"Code de connexion : {code}\n\nValable 10 minutes. Ignore cet email si tu n'es pas à l'origine de la demande.")
        _audit("otp_sent", {"email": email})
    # Generic response — never reveal whether an email is approved.
    return {"status": "ok", "message": "Si cet email est autorisé, un code vient d'être envoyé."}


@app.post("/api/auth/verify-otp")
def verify_otp(body: OtpIn, request: Request) -> dict:
    ip = _client_ip(request)
    if _auth_locked(ip):
        raise HTTPException(status_code=429, detail="Trop de tentatives depuis ton IP — réessaie dans quelques minutes.")
    email = body.email.strip().lower()
    rec = _OTP.get(email)
    if not rec or rec[1] < time.time():
        raise HTTPException(status_code=401, detail="Code expiré — redemande un code.")
    code, exp, tries = rec
    if tries >= 5:
        _OTP.pop(email, None)
        raise HTTPException(status_code=429, detail="Trop de tentatives — redemande un code.")
    if body.code.strip() != code:
        _OTP[email] = (code, exp, tries + 1)
        if _auth_fail(ip):
            _audit("auth_lockout", {"ip": ip, "email": email})
            _notify_owner("🚫 IP bloquée", f"Trop d'échecs de code depuis {ip}")
        raise HTTPException(status_code=401, detail="Code incorrect.")
    _auth_clear(ip)
    _OTP.pop(email, None)
    role = "admin" if email == ADMIN_EMAIL else "user"
    token = _sign({"email": email, "role": role, "exp": int(time.time() + 7 * 86400)})
    _audit("login", {"email": email, "role": role, "ip": _client_ip(request)})
    _notify_owner("🔓 Connexion", f"{email} ({role}) · {_client_ip(request)}")
    return {"status": "ok", "token": token, "email": email, "role": role}


@app.get("/api/me")
def me(request: Request) -> dict:
    p = _auth(request)
    if not p:
        raise HTTPException(status_code=401, detail="Non connecté.")
    return {"email": p["email"], "role": p["role"]}


@app.get("/api/admin/requests")
def admin_requests(request: Request) -> dict:
    p = _auth(request)
    if not p or p.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Réservé à l'admin.")
    res = _es("POST", f"/{ES_REQ_INDEX}/_search",
              {"size": 200, "sort": [{"ts": "desc"}], "query": {"match_all": {}}})
    hits = [{**h["_source"], "id": h["_id"]} for h in (res.get("hits", {}).get("hits", []) if res else [])]
    return {"requests": hits}


@app.post("/api/admin/decide")
def admin_decide(body: DecideIn, request: Request) -> dict:
    p = _auth(request)
    if not p or p.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Réservé à l'admin.")
    r = _es("GET", f"/{ES_REQ_INDEX}/_doc/{body.id}")
    if not r or not r.get("found"):
        raise HTTPException(status_code=404, detail="Demande introuvable.")
    src = r["_source"]
    email = src["email"]
    status = "approved" if body.decision == "approve" else "denied"
    src.update({"status": status, "decided_at": _now_iso(), "decided_by": p["email"]})
    _es("PUT", f"/{ES_REQ_INDEX}/_doc/{body.id}", src)
    if status == "approved":
        _es("PUT", f"/{ES_USER_INDEX}/_doc/{email}", {"email": email, "approved_at": _now_iso(), "by": p["email"]})
        _send_email(email, "Accès approuvé ✅",
                    f"Bonne nouvelle, ton accès est validé.\nConnecte-toi ici : {SITE_URL}/acces/ (avec cet email, tu recevras un code).")
    else:
        _send_email(email, "Demande d'accès refusée",
                    "Ta demande d'accès n'a pas été retenue pour le moment.")
    _audit("decision", {"email": email, "status": status, "by": p["email"]})
    return {"status": "ok", "decision": status}


class DebugEmailIn(BaseModel):
    secret: str = ""
    to: str


@app.post("/api/debug/email")
def debug_email(body: DebugEmailIn) -> dict:
    """Send a test email via the configured HTTP provider. Protected by CRON_SECRET.
    Check the Space Logs for the exact error line if ok=false."""
    if not CRON_SECRET or body.secret != CRON_SECRET:
        raise HTTPException(status_code=401, detail="Bad secret.")
    provider = _email_provider() or "aucun"
    ok = _send_email(body.to, "Test Coffre", "Si tu lis ceci, l'email fonctionne ✅")
    return {"ok": ok, "provider": provider, "from": MAIL_FROM, "admin": ADMIN_EMAIL}
