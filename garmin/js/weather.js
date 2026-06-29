/* Weather + run-window planner (Open-Meteo, no API key, CORS-friendly).

   Pulls today's hourly forecast for the athlete's city and turns it into
   actionable advice: when it rains, when it's too hot, and the best windows to
   run. 100% browser-side, like the rest of the app.

   Relies on globals from config.js (Profile, PKEY, getActiveId). Per-profile
   city is stored under PKEY.city; the geocode + daily forecast are cached in
   localStorage (forecast re-fetched once per calendar day).

   Exposes window.Weather. */

(function () {
  'use strict';

  const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

  /* Apparent-temperature thresholds (°C). */
  const HEAT_CAUTION = 27;
  const HEAT_AVOID = 31;
  /* Rain when either accumulation or probability crosses these. */
  const RAIN_MM = 0.2;
  const RAIN_PROB = 50;

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function geoCacheKey(id) { return `garmin_prof_${id || getActiveId()}_weather_geo`; }
  function fcCacheKey(id) { return `garmin_prof_${id || getActiveId()}_weather_fc`; }

  /* ---------------- City ---------------- */

  function getCity(id) { return Profile.get(PKEY.city, id) || ''; }

  function setCity(city, id) {
    const v = (city || '').trim();
    if (v) Profile.set(PKEY.city, v, id);
    else Profile.remove(PKEY.city, id);
    // city changed → drop cached geocode + forecast for this profile
    try { localStorage.removeItem(geoCacheKey(id)); localStorage.removeItem(fcCacheKey(id)); } catch {}
  }

  /* ---------------- Fetch + cache ---------------- */

  async function geocode(city, id) {
    const cached = (() => { try { return JSON.parse(localStorage.getItem(geoCacheKey(id))); } catch { return null; } })();
    if (cached && cached.city === city) return cached.geo;
    const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=fr&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('geocode-failed');
    const data = await res.json();
    if (!data.results || !data.results.length) throw new Error('city-not-found');
    const r = data.results[0];
    const geo = {
      lat: r.latitude, lon: r.longitude,
      label: [r.name, r.admin1, r.country_code].filter(Boolean).slice(0, 2).join(', ')
    };
    try { localStorage.setItem(geoCacheKey(id), JSON.stringify({ city, geo })); } catch {}
    return geo;
  }

  async function fetchForecast(geo) {
    const params = new URLSearchParams({
      latitude: geo.lat, longitude: geo.lon,
      hourly: 'temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
      timezone: 'auto', forecast_days: '1'
    });
    const res = await fetch(`${FORECAST_URL}?${params}`);
    if (!res.ok) throw new Error('forecast-failed');
    return res.json();
  }

  function normalize(raw, geo) {
    const h = raw.hourly || {};
    const times = h.time || [];
    const hourly = times.map((t, i) => ({
      h: Number(t.slice(11, 13)),
      time: t,
      temp: h.temperature_2m ? h.temperature_2m[i] : null,
      feels: h.apparent_temperature ? h.apparent_temperature[i] : null,
      precip: h.precipitation ? h.precipitation[i] : 0,
      prob: h.precipitation_probability ? h.precipitation_probability[i] : 0,
      code: h.weather_code ? h.weather_code[i] : null
    }));
    const d = raw.daily || {};
    const nowHour = new Date().getHours();
    const now = hourly.find(x => x.h === nowHour) || hourly[0] || null;
    return {
      label: geo.label,
      tempMax: d.temperature_2m_max ? d.temperature_2m_max[0] : null,
      tempMin: d.temperature_2m_min ? d.temperature_2m_min[0] : null,
      sunrise: d.sunrise ? Number(d.sunrise[0].slice(11, 13)) : 6,
      sunset: d.sunset ? Number(d.sunset[0].slice(11, 13)) : 21,
      now,
      hourly
    };
  }

  /* Returns the normalized forecast for a profile's city, or null if no city set.
     Throws on geocode/network errors (caller shows a discreet message). */
  async function fetchToday(id) {
    const city = getCity(id);
    if (!city) return null;
    const today = todayStr();
    const cached = (() => { try { return JSON.parse(localStorage.getItem(fcCacheKey(id))); } catch { return null; } })();
    if (cached && cached.date === today && cached.city === city) return cached.weather;

    const geo = await geocode(city, id);
    const raw = await fetchForecast(geo);
    const weather = normalize(raw, geo);
    try { localStorage.setItem(fcCacheKey(id), JSON.stringify({ date: today, city, weather })); } catch {}
    return weather;
  }

  /* ---------------- Analysis ---------------- */

  function fmtRange(a, b) { return `${a}h→${b + 1}h`; }   // hour b is inclusive

  /* Group an ordered list of hour-numbers into contiguous [from,to] ranges. */
  function toRanges(hours) {
    const ranges = [];
    let start = null, prev = null;
    hours.forEach(h => {
      if (start === null) { start = prev = h; return; }
      if (h === prev + 1) { prev = h; return; }
      ranges.push([start, prev]); start = prev = h;
    });
    if (start !== null) ranges.push([start, prev]);
    return ranges;
  }

  /* Turns a forecast into run advice. Returns null if no weather. */
  function analyzeForRun(weather) {
    if (!weather || !weather.hourly.length) return null;
    const dayHours = weather.hourly.filter(x => x.h >= weather.sunrise && x.h <= weather.sunset);
    const pool = dayHours.length ? dayHours : weather.hourly;

    const isRain = x => (x.precip != null && x.precip >= RAIN_MM) || (x.prob != null && x.prob >= RAIN_PROB);
    const isHot = x => x.feels != null && x.feels >= HEAT_AVOID;
    const isWarm = x => x.feels != null && x.feels >= HEAT_CAUTION;

    const rainWindows = toRanges(pool.filter(isRain).map(x => x.h));
    const hotWindows = toRanges(pool.filter(isHot).map(x => x.h));
    const best = toRanges(pool.filter(x => !isRain(x) && !isWarm(x)).map(x => x.h));
    const peakFeels = pool.reduce((m, x) => (x.feels != null && x.feels > m.feels ? { feels: x.feels, h: x.h } : m), { feels: -99, h: null });

    const hasRain = rainWindows.length > 0;
    const hasHeat = hotWindows.length > 0;
    const allBad = best.length === 0;

    let verdict;
    if (allBad && (hasHeat || hasRain)) verdict = hasHeat ? 'heat' : 'rain';
    else if (hasHeat && hasRain) verdict = 'mixed';
    else if (hasHeat) verdict = 'heat';
    else if (hasRain) verdict = 'rain';
    else verdict = 'ideal';

    const rainTxt = hasRain ? 'pluie ' + rainWindows.map(([a, b]) => fmtRange(a, b)).join(', ') : '';
    const bestTxt = best.length ? best.map(([a, b]) => fmtRange(a, b)).join(', ') : '';
    const nowTemp = weather.now && weather.now.temp != null ? Math.round(weather.now.temp) : (weather.tempMax != null ? Math.round(weather.tempMax) : null);

    let oneLiner, advice, icon;
    if (verdict === 'ideal') {
      icon = '☀️';
      oneLiner = `${icon} ${nowTemp}°C · conditions idéales pour courir`;
      advice = bestTxt ? `Bon créneau toute la journée (${bestTxt}).` : 'Conditions favorables aujourd’hui.';
    } else if (verdict === 'rain') {
      icon = '🌧️';
      oneLiner = bestTxt ? `${icon} ${nowTemp}°C · ${rainTxt} — cours ${bestTxt}` : `${icon} ${nowTemp}°C · ${rainTxt}`;
      advice = bestTxt ? `Il pleut ${rainWindows.map(([a, b]) => fmtRange(a, b)).join(', ')} : vise plutôt ${bestTxt}.` : `Pluie une bonne partie de la journée (${rainTxt}) — prévois le couvert ou repousse.`;
    } else if (verdict === 'heat') {
      icon = '🥵';
      const peakTxt = peakFeels.h != null ? ` (pic ressenti ${Math.round(peakFeels.feels)}°C vers ${peakFeels.h}h)` : '';
      oneLiner = bestTxt ? `${icon} ${nowTemp}°C · trop chaud${peakTxt} — cours ${bestTxt}` : `${icon} ${nowTemp}°C · trop chaud aujourd’hui${peakTxt}`;
      advice = bestTxt ? `Forte chaleur${peakTxt}. Cours tôt le matin ou en soirée : ${bestTxt}.` : `Chaleur marquée toute la journée${peakTxt} — déconseillé, privilégie le repos ou l’intérieur.`;
    } else { // mixed
      icon = '🌦️';
      oneLiner = bestTxt ? `${icon} ${nowTemp}°C · chaleur + ${rainTxt} — cours ${bestTxt}` : `${icon} ${nowTemp}°C · chaleur et pluie aujourd’hui`;
      advice = bestTxt ? `Chaleur et averses dans la journée. Meilleurs créneaux : ${bestTxt}.` : `Conditions difficiles (chaleur + pluie) — repousse si possible.`;
    }

    return {
      verdict, icon, oneLiner, advice,
      nowTemp, peakFeels: peakFeels.h != null ? peakFeels : null,
      rainWindows, hotWindows, bestWindows: best,
      rainText: rainTxt, bestText: bestTxt,
      discourage: verdict === 'heat' && best.length === 0
    };
  }

  window.Weather = { getCity, setCity, fetchToday, analyzeForRun };
})();
