/* Parser for Strava's free data export (activities.csv).

   Strava lets any athlete export their full history for free from
   account settings — this is the legitimate, no-subscription way to get
   real data into the app now that the API is paywalled. The CSV is wide,
   localised (EN/FR) and its units shift between km and metres, so the
   parser below is deliberately tolerant: it maps columns by header
   synonyms and detects units from the values. */

/* ---------------- Low-level CSV ---------------- */

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      /* ignore */
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------------- Helpers ---------------- */

function normHeader(h) {
  return (h || '').toLowerCase().trim();
}

function numParse(s) {
  if (s == null) return NaN;
  let v = String(s).trim().replace(/\s/g, '');
  if (v.includes(',') && !v.includes('.')) v = v.replace(',', '.');
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

const FR_MONTHS = {
  janv: 0, janvier: 0, févr: 1, février: 1, fevr: 1, fevrier: 1, mars: 2,
  avr: 3, avril: 3, mai: 4, juin: 5, juil: 6, juillet: 6, août: 7, aout: 7,
  sept: 8, septembre: 8, oct: 9, octobre: 9, nov: 10, novembre: 10,
  déc: 11, dec: 11, décembre: 11, decembre: 11
};

function parseDateToIso(s) {
  if (!s) return null;
  const str = String(s).trim();

  const native = new Date(str);
  if (!Number.isNaN(native.getTime())) return native.toISOString().slice(0, 19);

  /* French long form: "1 août 2024 à 18:00:00" */
  const fr = str.match(/(\d{1,2})\s+([a-zûéèôà.]+)\.?\s+(\d{4})(?:[ ,à]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i);
  if (fr) {
    const month = FR_MONTHS[fr[2].toLowerCase().replace('.', '')];
    if (month != null) {
      const d = new Date(+fr[3], month, +fr[1], +(fr[4] || 0), +(fr[5] || 0), +(fr[6] || 0));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19);
    }
  }

  /* Numeric dd/mm/yyyy or mm/dd/yyyy */
  const num = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (num) {
    let [, a, b, y, h, mi, se] = num;
    y = +y < 100 ? 2000 + +y : +y;
    const d = new Date(y, +b - 1, +a, +(h || 0), +(mi || 0), +(se || 0)); // assume day/month
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19);
  }
  return null;
}

/* Normalise localised sport types so the analysis engine's run detection
   (looks for "run") works on French exports too. */
function normType(t) {
  const x = (t || '').toLowerCase();
  if (/run|course\s*à?\s*pied|footing|trail/.test(x)) return 'Run';
  if (/ride|cycl|vélo|velo|bike|home trainer/.test(x)) return 'Ride';
  if (/walk|marche/.test(x)) return 'Walk';
  if (/hike|randonn/.test(x)) return 'Hike';
  if (/swim|natation|nage/.test(x)) return 'Swim';
  return t || 'Workout';
}

const COLUMN_SYNONYMS = {
  id: ['activity id', "id de l'activité", "identifiant de l'activité"],
  name: ['activity name', "nom de l'activité"],
  type: ['activity type', "type d'activité"],
  date: ['activity date', "date de l'activité"],
  distance: ['distance'],
  movingTime: ['moving time', 'durée de déplacement', 'temps de déplacement', 'temps de mouvement'],
  elapsedTime: ['elapsed time', 'durée', 'temps écoulé'],
  elevation: ['elevation gain', 'dénivelé positif', "gain d'altitude", 'dénivelé'],
  avgHr: ['average heart rate', 'fréquence cardiaque moyenne', 'fc moyenne'],
  maxHr: ['max heart rate', 'fréquence cardiaque maximale', 'fc max']
};

function indicesFor(header, syns) {
  const out = [];
  header.forEach((h, i) => { if (syns.includes(normHeader(h))) out.push(i); });
  return out;
}

/* Among candidate columns, pick the one whose values are plain numbers
   (Strava repeats "Elapsed Time" as both a formatted string and seconds). */
function pickNumericIndex(indices, dataRows) {
  for (const idx of indices) {
    const sample = dataRows.slice(0, 40).map(r => r[idx]).filter(v => v != null && v !== '');
    if (!sample.length) continue;
    const numericRatio = sample.filter(v => !String(v).includes(':') && Number.isFinite(numParse(v))).length / sample.length;
    if (numericRatio > 0.8) return idx;
  }
  return indices.length ? indices[0] : -1;
}

/* Distance is repeated too: an early column in the athlete's unit (km)
   and a later one in metres. Detect the unit from the median value. */
function pickDistance(indices, dataRows) {
  let best = null;
  for (const idx of indices) {
    const vals = dataRows.map(r => numParse(r[idx])).filter(Number.isFinite).filter(v => v > 0);
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const scale = med > 1000 ? 1 : 1000; // >1000 ⇒ already metres
    if (!best || scale === 1) best = { idx, scale };
  }
  return best || { idx: indices[0] ?? -1, scale: 1000 };
}

/* ---------------- Public: parse activities.csv text ---------------- */

function parseStravaExport(text) {
  const rows = parseCSV(text).filter(r => r.length > 1);
  if (rows.length < 2) {
    throw new Error("Le fichier ne ressemble pas à un activities.csv Strava (aucune ligne lisible).");
  }
  const header = rows[0];
  const data = rows.slice(1);

  const col = {};
  Object.entries(COLUMN_SYNONYMS).forEach(([key, syns]) => {
    col[key] = indicesFor(header, syns);
  });

  if (!col.date.length || !col.distance.length) {
    throw new Error("Colonnes introuvables dans le CSV (date / distance). Est-ce bien le fichier activities.csv de l'export Strava ?");
  }

  const iId = col.id[0] ?? -1;
  const iName = col.name[0] ?? -1;
  const iType = col.type[0] ?? -1;
  const iDate = col.date[0];
  const dist = pickDistance(col.distance, data);
  const iMoving = pickNumericIndex(col.movingTime, data);
  const iElapsed = pickNumericIndex(col.elapsedTime, data);
  const iElev = pickNumericIndex(col.elevation, data);
  const iAvgHr = col.avgHr[0] ?? -1;
  const iMaxHr = col.maxHr[0] ?? -1;

  const get = (r, i) => (i >= 0 ? r[i] : undefined);

  const activities = [];
  let skipped = 0;

  for (const r of data) {
    const date = parseDateToIso(get(r, iDate));
    const distance = dist.idx >= 0 ? numParse(r[dist.idx]) * dist.scale : NaN;
    if (!date || !Number.isFinite(distance) || distance < 300) { skipped++; continue; }

    const moving = numParse(get(r, iMoving));
    const elapsed = numParse(get(r, iElapsed));
    const movingTime = Number.isFinite(moving) ? moving : (Number.isFinite(elapsed) ? elapsed : 0);
    if (movingTime < 30) { skipped++; continue; }

    const elev = numParse(get(r, iElev));
    const avgHr = numParse(get(r, iAvgHr));
    const maxHr = numParse(get(r, iMaxHr));
    const rawId = get(r, iId);
    const id = rawId && String(rawId).trim()
      ? String(rawId).trim()
      : `${date}_${Math.round(distance)}`;

    activities.push({
      id,
      name: (get(r, iName) || 'Sortie').trim(),
      type: normType(get(r, iType)),
      distance: Math.round(distance),
      moving_time: Math.round(movingTime),
      elapsed_time: Math.round(Number.isFinite(elapsed) ? elapsed : movingTime),
      elev: Number.isFinite(elev) ? Math.round(elev) : 0,
      date,
      avg_speed: movingTime > 0 ? distance / movingTime : 0,
      max_speed: 0,
      avg_hr: Number.isFinite(avgHr) && avgHr > 0 ? Math.round(avgHr) : null,
      max_hr: Number.isFinite(maxHr) && maxHr > 0 ? Math.round(maxHr) : null,
      effort: null,
      kudos: 0
    });
  }

  if (!activities.length) {
    throw new Error("Aucune activité exploitable trouvée dans le fichier.");
  }

  activities.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { activities, skipped };
}

/* Merge freshly imported activities into a profile's cache, deduping by
   id — this is the "incremental sync" when re-importing a newer export. */
function mergeImportedActivities(profileId, imported) {
  const cached = Profile.getJSON(PKEY.activities, profileId) || [];
  const byId = new Map();
  cached.forEach(a => byId.set(String(a.id), a));
  imported.forEach(a => byId.set(String(a.id), a)); // imported wins on conflict
  const merged = [...byId.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
  Profile.setJSON(PKEY.activities, merged, profileId);
  Profile.set(PKEY.lastSync, String(Math.floor(Date.now() / 1000)), profileId);
  return merged;
}
