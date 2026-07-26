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
import json
import os
import time
import uuid
from collections import defaultdict
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
