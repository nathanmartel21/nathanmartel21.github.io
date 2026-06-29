"""Shared Garmin Connect data puller.

Given an *already authenticated* ``garminconnect.Garmin`` client, this module
pulls a rich snapshot of the athlete (activities + wellness) and returns a
plain ``dict`` matching the JSON schema the web dashboard consumes.

It is deliberately defensive: Garmin's payloads are deeply nested and vary by
account/device/firmware, and some endpoints are missing for some days. Every
field is dug out with ``getattr``/``.get`` guards and every per-day metric is
wrapped so one missing day never aborts the whole export.

Used by:
  - ``app.py``        — the stateless FastAPI live backend (Hugging Face / Render)
  - ``export_local.py`` — the local CLI fallback exporter

Schema (``garmin-data.json``):
{
  "schema": "garmin-export/1",
  "generated_at": "<iso>",
  "athlete": { "name": str, "id": any },
  "activities": [ {
      id, name, type, date, distance(m), moving_time(s), elapsed_time(s),
      elev(m), elev_loss(m), avg_hr, max_hr, cadence(spm), calories,
      avg_speed(m/s), vo2max, te_aerobic, te_anaerobic, steps, effort, kudos
  } ],
  "wellness": [ {
      date, resting_hr, steps, steps_goal, floors, intensity_minutes,
      calories_total, sleep{...}|null, stress{...}|null,
      body_battery{...}|null, hrv{...}|null, training_readiness{...}|null
  } ],
  "snapshot": {
      vo2max_running, vo2max_cycling, fitness_age,
      training_status, acute_load
  }
}
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Callable, Optional


# --------------------------------------------------------------------------- #
# Small helpers                                                               #
# --------------------------------------------------------------------------- #

def _dig(obj: Any, *path: Any, default: Any = None) -> Any:
    """Walk nested dicts/lists safely. Returns ``default`` on any miss."""
    cur = obj
    for key in path:
        if cur is None:
            return default
        try:
            if isinstance(key, int):
                cur = cur[key]
            else:
                cur = cur.get(key)
        except (KeyError, IndexError, TypeError, AttributeError):
            return default
    return cur if cur is not None else default


def _num(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> Optional[int]:
    n = _num(value)
    return int(round(n)) if n is not None else None


def _norm_type(type_key: Optional[str]) -> str:
    x = (type_key or "").lower()
    if "run" in x:
        return "Run"
    if "cycl" in x or "bik" in x:
        return "Ride"
    if "swim" in x:
        return "Swim"
    if "walk" in x:
        return "Walk"
    if "hik" in x:
        return "Hike"
    if "strength" in x or "weight" in x:
        return "Workout"
    # Fall back to a readable label ("trail_running" -> "Trail Running").
    return (type_key or "Workout").replace("_", " ").title()


def _iso_date(start_local: Optional[str]) -> Optional[str]:
    """Garmin's ``startTimeLocal`` is ``"YYYY-MM-DD HH:MM:SS"`` — make it ISO."""
    if not start_local:
        return None
    return str(start_local).strip().replace(" ", "T")[:19]


# --------------------------------------------------------------------------- #
# Activities                                                                  #
# --------------------------------------------------------------------------- #

def pull_activities(api: Any, limit: int = 400) -> list[dict]:
    """Most-recent ``limit`` activities, slimmed to the dashboard's shape."""
    raw = api.get_activities(0, limit) or []
    out: list[dict] = []

    for a in raw:
        date = _iso_date(a.get("startTimeLocal") or a.get("startTimeGMT"))
        distance = _num(a.get("distance"))
        if not date or not distance or distance < 300:
            continue

        moving = _num(a.get("movingDuration")) or _num(a.get("duration")) or 0
        elapsed = _num(a.get("elapsedDuration")) or _num(a.get("duration")) or moving
        if moving < 30:
            continue

        out.append({
            "id": a.get("activityId"),
            "name": (a.get("activityName") or "Sortie").strip(),
            "type": _norm_type(_dig(a, "activityType", "typeKey")),
            "date": date,
            "distance": int(round(distance)),
            "moving_time": int(round(moving)),
            "elapsed_time": int(round(elapsed)),
            "elev": _int(a.get("elevationGain")) or 0,
            "elev_loss": _int(a.get("elevationLoss")),
            "avg_hr": _int(a.get("averageHR")),
            "max_hr": _int(a.get("maxHR")),
            # Garmin running cadence is already steps/min (not per-leg like Strava CSV).
            "cadence": _int(a.get("averageRunningCadenceInStepsPerMinute")
                            or a.get("averageBikingCadenceInRevPerMinute")),
            "calories": _int(a.get("calories")),
            "avg_speed": _num(a.get("averageSpeed")) or (distance / moving if moving else 0),
            "max_speed": _num(a.get("maxSpeed")) or 0,
            "vo2max": _num(a.get("vO2MaxValue")),
            "te_aerobic": _num(a.get("aerobicTrainingEffect")),
            "te_anaerobic": _num(a.get("anaerobicTrainingEffect")),
            "steps": _int(a.get("steps")),
            # Garmin's per-activity training load maps to our "relative effort".
            "effort": _int(a.get("activityTrainingLoad")),
            "kudos": 0,
        })

    out.sort(key=lambda r: r["date"], reverse=True)
    return out


# --------------------------------------------------------------------------- #
# Daily wellness                                                              #
# --------------------------------------------------------------------------- #

def _safe(fn: Callable[[], Any], default: Any = None) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001 — any Garmin/HTTP hiccup for one metric
        return default


def _sleep_for(api: Any, cdate: str) -> Optional[dict]:
    data = _safe(lambda: api.get_sleep_data(cdate))
    dto = _dig(data, "dailySleepDTO") or {}
    total = _num(dto.get("sleepTimeSeconds"))
    if not total:
        return None
    return {
        "total": _int(total),
        "deep": _int(dto.get("deepSleepSeconds")),
        "light": _int(dto.get("lightSleepSeconds")),
        "rem": _int(dto.get("remSleepSeconds")),
        "awake": _int(dto.get("awakeSleepSeconds")),
        "score": _int(_dig(dto, "sleepScores", "overall", "value")),
        "resp_avg": _num(dto.get("averageRespirationValue")),
    }


def _stress_for(api: Any, cdate: str) -> Optional[dict]:
    data = _safe(lambda: api.get_stress_data(cdate))
    avg = _int(_dig(data, "avgStressLevel"))
    if avg is None or avg < 0:
        return None
    return {
        "avg": avg,
        "max": _int(_dig(data, "maxStressLevel")),
        "rest_min": _int(_dig(data, "restStressDuration", default=None)),
    }


def _body_battery_for(api: Any, cdate: str) -> Optional[dict]:
    data = _safe(lambda: api.get_body_battery(cdate, cdate))
    if not isinstance(data, list) or not data:
        return None
    day = data[0] or {}
    values = day.get("bodyBatteryValuesArray") or []
    levels = [v[1] for v in values if isinstance(v, list) and len(v) > 1 and v[1] is not None]
    return {
        "charged": _int(day.get("charged")),
        "drained": _int(day.get("drained")),
        "high": _int(max(levels)) if levels else None,
        "low": _int(min(levels)) if levels else None,
    }


def _hrv_for(api: Any, cdate: str) -> Optional[dict]:
    data = _safe(lambda: api.get_hrv_data(cdate))
    summary = _dig(data, "hrvSummary") or {}
    weekly = _int(summary.get("weeklyAvg"))
    if weekly is None and summary.get("lastNightAvg") is None:
        return None
    return {
        "weekly_avg": weekly,
        "last_night_avg": _int(summary.get("lastNightAvg")),
        "status": summary.get("status"),
    }


def _readiness_for(api: Any, cdate: str) -> Optional[dict]:
    data = _safe(lambda: api.get_training_readiness(cdate))
    item = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
    score = _int(_dig(item, "score"))
    if score is None:
        return None
    return {"score": score, "level": _dig(item, "level")}


def pull_wellness(api: Any, days: int = 30,
                  progress: Optional[Callable[[int, int], None]] = None) -> list[dict]:
    """One record per day for the last ``days`` days (oldest first)."""
    today = _dt.date.today()
    out: list[dict] = []

    for i in range(days - 1, -1, -1):
        d = today - _dt.timedelta(days=i)
        cdate = d.isoformat()

        summary = _safe(lambda: api.get_user_summary(cdate), {}) or {}
        record = {
            "date": cdate,
            "resting_hr": _int(summary.get("restingHeartRate")),
            "steps": _int(summary.get("totalSteps")),
            "steps_goal": _int(summary.get("dailyStepGoal")),
            "floors": _int(summary.get("floorsAscended")),
            "intensity_minutes": (_int(summary.get("moderateIntensityMinutes")) or 0)
                                 + 2 * (_int(summary.get("vigorousIntensityMinutes")) or 0),
            "calories_total": _int(summary.get("totalKilocalories")),
            "sleep": _sleep_for(api, cdate),
            "stress": _stress_for(api, cdate),
            "body_battery": _body_battery_for(api, cdate),
            "hrv": _hrv_for(api, cdate),
            "training_readiness": _readiness_for(api, cdate),
        }
        out.append(record)
        if progress:
            progress(days - i, days)

    return out


# --------------------------------------------------------------------------- #
# "Now" snapshot (latest single-day metrics)                                  #
# --------------------------------------------------------------------------- #

def pull_snapshot(api: Any) -> dict:
    today = _dt.date.today().isoformat()

    metrics = _safe(lambda: api.get_max_metrics(today)) or []
    m = metrics[0] if isinstance(metrics, list) and metrics else (metrics or {})
    vo2_run = _num(_dig(m, "generic", "vo2MaxPreciseValue") or _dig(m, "generic", "vo2MaxValue"))
    vo2_bike = _num(_dig(m, "cycling", "vo2MaxPreciseValue") or _dig(m, "cycling", "vo2MaxValue"))
    fitness_age = _num(_dig(m, "generic", "fitnessAge"))

    status_raw = _safe(lambda: api.get_training_status(today)) or {}
    latest = _dig(status_raw, "mostRecentTrainingStatus", "latestTrainingStatusData") or {}
    training_status = None
    acute_load = None
    if isinstance(latest, dict):
        for device in latest.values():
            training_status = training_status or _dig(device, "trainingStatusFeedbackPhrase") \
                or _dig(device, "trainingStatus")
            acute_load = acute_load or _num(_dig(device, "acuteTrainingLoadDTO", "acwrPercent")) \
                or _num(_dig(device, "loadTunnelMin"))

    return {
        "vo2max_running": vo2_run,
        "vo2max_cycling": vo2_bike,
        "fitness_age": fitness_age,
        "training_status": training_status,
        "acute_load": acute_load,
    }


# --------------------------------------------------------------------------- #
# Per-activity detail (lazy-loaded on click): km splits, HR zones, GPS track  #
# --------------------------------------------------------------------------- #

def _metric_index(descriptors: Any, key: str) -> Optional[int]:
    """Index of a metric inside each activityDetailMetrics row, by its key."""
    for d in descriptors or []:
        if isinstance(d, dict) and d.get("key") == key:
            return d.get("metricsIndex")
    return None


def _km_splits(stream: list[tuple]) -> list[dict]:
    """Build per-kilometre splits from a (distance_m, elapsed_s, hr) stream.

    HR per km is the mean of the samples falling in that km (approximate, since
    samples aren't evenly spaced in time, but fine for display)."""
    splits: list[dict] = []
    if len(stream) < 2:
        return splits

    next_km = 1000.0
    seg_start_dur = stream[0][1]
    hr_vals: list[float] = []

    for dist, dur, hr in stream:
        if hr is not None:
            hr_vals.append(hr)
        while dist >= next_km:
            seg_time = dur - seg_start_dur
            splits.append({
                "km": int(next_km / 1000),
                "time": int(round(seg_time)),
                "pace": int(round(seg_time)),          # seconds for this 1 km
                "avg_hr": int(round(sum(hr_vals) / len(hr_vals))) if hr_vals else None,
            })
            seg_start_dur = dur
            hr_vals = []
            next_km += 1000.0

    # Trailing partial kilometre (≥ 100 m left).
    last_dist, last_dur, _ = stream[-1]
    rem = last_dist - (next_km - 1000.0)
    if rem >= 100:
        seg_time = last_dur - seg_start_dur
        pace = seg_time / (rem / 1000.0) if rem else 0
        splits.append({
            "km": round(last_dist / 1000.0, 2),
            "time": int(round(seg_time)),
            "pace": int(round(pace)),
            "avg_hr": int(round(sum(hr_vals) / len(hr_vals))) if hr_vals else None,
            "partial": True,
        })
    return splits


def _hr_zones(api: Any, activity_id: Any) -> list[dict]:
    """Seconds spent in each HR zone (Z1–Z5)."""
    data = _safe(lambda: api.get_activity_hr_in_timezones(activity_id)) or []
    zones: list[dict] = []
    for z in data if isinstance(data, list) else []:
        secs = _num(z.get("secsInZone"))
        if secs is None:
            continue
        zones.append({
            "zone": _int(z.get("zoneNumber")),
            "secs": int(round(secs)),
            "low_bpm": _int(z.get("zoneLowBoundary")),
        })
    zones.sort(key=lambda x: x["zone"] or 0)
    return zones


def pull_activity_detail(api: Any, activity_id: Any,
                         max_chart: int = 2000, max_poly: int = 1500) -> dict:
    """Lazy per-activity detail for the dashboard's activity modal:
    per-km splits, time in HR zones, and a simplified GPS track."""
    detail = _safe(lambda: api.get_activity_details(activity_id,
                                                    maxchart=max_chart,
                                                    maxpoly=max_poly)) or {}
    descriptors = detail.get("metricDescriptors") or []
    rows = detail.get("activityDetailMetrics") or []

    i_dist = _metric_index(descriptors, "sumDistance")
    i_dur = _metric_index(descriptors, "sumDuration")
    if i_dur is None:
        i_dur = _metric_index(descriptors, "sumMovingDuration")
    i_hr = _metric_index(descriptors, "directHeartRate")

    stream: list[tuple] = []
    for row in rows:
        vals = row.get("metrics") if isinstance(row, dict) else row
        if not vals:
            continue
        dist = vals[i_dist] if (i_dist is not None and i_dist < len(vals)) else None
        dur = vals[i_dur] if (i_dur is not None and i_dur < len(vals)) else None
        if dist is None or dur is None:
            continue
        hr = vals[i_hr] if (i_hr is not None and i_hr < len(vals)) else None
        stream.append((dist, dur, hr))

    poly = _dig(detail, "geoPolylineDTO", "polyline") or []
    track = [[round(p["lat"], 5), round(p["lon"], 5)]
             for p in poly
             if isinstance(p, dict) and p.get("lat") is not None and p.get("lon") is not None]

    return {
        "id": activity_id,
        "splits": _km_splits(stream),
        "hr_zones": _hr_zones(api, activity_id),
        "track": track,
    }


# --------------------------------------------------------------------------- #
# Top-level                                                                   #
# --------------------------------------------------------------------------- #

def pull_all(api: Any, activities_limit: int = 400, wellness_days: int = 30,
             progress: Optional[Callable[[int, int], None]] = None) -> dict:
    """Build the full ``garmin-data.json`` payload from an authed client."""
    name = getattr(api, "full_name", None) or _safe(lambda: api.get_full_name()) or "Athlète"
    athlete_id = getattr(api, "display_name", None)

    return {
        "schema": "garmin-export/1",
        "generated_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "athlete": {"name": name, "id": athlete_id},
        "activities": pull_activities(api, activities_limit),
        "wellness": pull_wellness(api, wellness_days, progress),
        "snapshot": pull_snapshot(api),
    }
