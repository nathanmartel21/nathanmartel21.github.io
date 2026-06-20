#!/usr/bin/env python3
"""Local Garmin exporter (fallback / offline path).

Runs entirely on YOUR machine: it logs in to Garmin Connect, pulls the same
rich snapshot the live backend produces, and writes ``garmin-data.json`` that
you can drag onto the dashboard's import screen. Your credentials never leave
your computer.

Use this when:
  - you'd rather not run a server, or
  - Garmin blocks the cloud server's IP (datacenter logins sometimes trip
    Garmin's anti-bot/MFA), so the live path fails.

Usage:
    pip install -r requirements.txt
    python export_local.py                      # prompts for email/password
    python export_local.py --days 120 --out garmin-data.json

Credentials can also come from env vars GARMIN_EMAIL / GARMIN_PASSWORD.
A successful login caches a token under ~/.garminconnect so later runs skip
the password (and any MFA) prompt.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

from garminconnect import Garmin

import garmin_pull

TOKENSTORE = os.path.expanduser("~/.garminconnect")


def _login() -> Garmin:
    # Try to resume a cached session first (no password / MFA needed).
    try:
        garmin = Garmin()
        garmin.login(TOKENSTORE)
        print("Session Garmin restaurée depuis le cache.", file=sys.stderr)
        return garmin
    except Exception:  # noqa: BLE001 — no/expired cache, fall through to fresh login
        pass

    email = os.environ.get("GARMIN_EMAIL") or input("Email Garmin : ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Mot de passe Garmin : ")

    garmin = Garmin(email=email, password=password, return_on_mfa=True)
    result = garmin.login()
    if isinstance(result, tuple) and result[0] == "needs_mfa":
        code = input("Code MFA Garmin : ").strip()
        garmin.resume_login(result[1], code)

    try:
        garmin.garth.dump(TOKENSTORE)
        print(f"Session mise en cache dans {TOKENSTORE}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        pass
    return garmin


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporte tes données Garmin en JSON.")
    parser.add_argument("--out", default="garmin-data.json", help="fichier de sortie")
    parser.add_argument("--days", type=int, default=120, help="jours de wellness à récupérer")
    parser.add_argument("--activities", type=int, default=600, help="nombre d'activités à récupérer")
    args = parser.parse_args()

    garmin = _login()

    def progress(done: int, total: int) -> None:
        print(f"\rWellness… {done}/{total} jours", end="", file=sys.stderr, flush=True)

    print("Récupération des activités et du wellness…", file=sys.stderr)
    data = garmin_pull.pull_all(garmin, activities_limit=args.activities,
                                wellness_days=args.days, progress=progress)
    print("", file=sys.stderr)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    print(f"✅ {len(data['activities'])} activités + {len(data['wellness'])} jours "
          f"de wellness écrits dans {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
