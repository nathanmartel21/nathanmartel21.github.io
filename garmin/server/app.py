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

def _make_token(garmin: Garmin) -> str:
    payload = {
        "garth": garmin.garth.dumps(),
        "display_name": getattr(garmin, "display_name", None),
        "full_name": getattr(garmin, "full_name", None),
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def _client_from_token(token: str) -> Garmin:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.encode()).decode())
        garmin = Garmin()
        garmin.garth.loads(payload["garth"])
        # Methods build URLs from display_name; set it from the token so we
        # never need to re-fetch the profile (and never need the password).
        if payload.get("display_name"):
            garmin.display_name = payload["display_name"]
        if payload.get("full_name"):
            garmin.full_name = payload["full_name"]
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

    return {"status": "ok", "token": _make_token(garmin),
            "name": garmin_pull._safe(lambda: garmin.get_full_name()) or getattr(garmin, "full_name", "Athlète")}


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

    return {"status": "ok", "token": _make_token(garmin),
            "name": garmin_pull._safe(lambda: garmin.get_full_name()) or getattr(garmin, "full_name", "Athlète")}


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
