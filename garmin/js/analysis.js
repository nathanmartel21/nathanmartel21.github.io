/* Analysis engine for the Garmin dashboard.

   Part 1 (running) is shared with the Strava app: pure functions over the
   activity list (most recent first). Part 2 (wellness) is Garmin-specific:
   sleep, stress, Body Battery, resting HR, HRV, training readiness, VO2max —
   plus the daily recovery-aware recommendation that ties it all together. */

/* ================================================================ */
/* PART 1 — running (shared with Strava)                            */
/* ================================================================ */

function fmtKm(meters, digits = 1) {
  return (meters / 1000).toFixed(digits).replace('.', ',');
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

/* pace in seconds per km -> "5:24 /km" */
function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return '–';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')} /km`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isRun(act) {
  return typeof act.type === 'string' && act.type.toLowerCase().includes('run');
}

function runsOnly(activities) {
  return activities.filter(isRun).filter(a => a.distance > 500 && a.moving_time > 60);
}

function paceOf(act) {
  return act.moving_time / (act.distance / 1000);
}

function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = (d.getDay() + 6) % 7;
  return addDays(d, -day);
}

function inLastDays(act, days, ref = new Date()) {
  const limit = addDays(startOfDay(ref), -(days - 1));
  return new Date(act.date) >= limit;
}

function sumStats(runs) {
  return runs.reduce((acc, r) => {
    acc.km += r.distance / 1000;
    acc.time += r.moving_time;
    acc.elev += r.elev || 0;
    acc.count += 1;
    return acc;
  }, { km: 0, time: 0, elev: 0, count: 0 });
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function periodStats(runs, ref = new Date()) {
  const weekStart = startOfWeek(ref);
  const thisWeek = runs.filter(r => new Date(r.date) >= weekStart);
  const last28 = runs.filter(r => inLastDays(r, 28, ref));
  const prev28 = runs.filter(r => {
    const d = new Date(r.date);
    return d >= addDays(startOfDay(ref), -55) && d < addDays(startOfDay(ref), -27);
  });
  const year = runs.filter(r => new Date(r.date).getFullYear() === ref.getFullYear());
  return {
    week: sumStats(thisWeek),
    last28: sumStats(last28),
    prev28: sumStats(prev28),
    year: sumStats(year),
    total: sumStats(runs)
  };
}

function weeklySeries(runs, nWeeks = 26, ref = new Date()) {
  const weeks = [];
  const currentWeekStart = startOfWeek(ref);
  for (let i = nWeeks - 1; i >= 0; i--) {
    const start = addDays(currentWeekStart, -7 * i);
    const end = addDays(start, 7);
    const inWeek = runs.filter(r => { const d = new Date(r.date); return d >= start && d < end; });
    weeks.push({ label: start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }), ...sumStats(inWeek) });
  }
  return weeks;
}

function fitnessSeries(runs, days = 182, ref = new Date()) {
  const today = startOfDay(ref);
  const first = addDays(today, -(days - 1));
  const dailyLoad = new Map();
  runs.forEach(r => {
    const key = startOfDay(new Date(r.date)).getTime();
    const load = r.distance / 1000 + (r.elev || 0) / 100;
    dailyLoad.set(key, (dailyLoad.get(key) || 0) + load);
  });
  const series = [];
  let ctl = 0, atl = 0;
  for (let d = addDays(first, -365); d < first; d = addDays(d, 1)) {
    const load = dailyLoad.get(d.getTime()) || 0;
    ctl += (load - ctl) / 42; atl += (load - atl) / 7;
  }
  for (let d = new Date(first); d <= today; d = addDays(d, 1)) {
    const load = dailyLoad.get(d.getTime()) || 0;
    ctl += (load - ctl) / 42; atl += (load - atl) / 7;
    series.push({ date: new Date(d), fitness: ctl, fatigue: atl, form: ctl - atl });
  }
  return series;
}

function paceTrend(runs, days = 182, ref = new Date()) {
  const recent = runs.filter(r => inLastDays(r, days, ref)).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const points = recent.map(r => ({ date: new Date(r.date), pace: paceOf(r), km: r.distance / 1000, name: r.name }));
  const rolling = points.map((p, i) => {
    const window = points.slice(Math.max(0, i - 4), i + 1);
    return { date: p.date, pace: window.reduce((s, w) => s + w.pace, 0) / window.length };
  });
  return { points, rolling };
}

function calendarSeries(runs, days = 364, ref = new Date()) {
  const dailyKm = new Map();
  runs.forEach(r => {
    const key = startOfDay(new Date(r.date)).getTime();
    dailyKm.set(key, (dailyKm.get(key) || 0) + r.distance / 1000);
  });
  const end = startOfDay(ref);
  const start = startOfWeek(addDays(end, -(days - 1)));
  const cells = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    cells.push({ date: new Date(d), km: dailyKm.get(d.getTime()) || 0 });
  }
  return cells;
}

function bestPaceOver(runs, minKm) {
  const eligible = runs.filter(r => r.distance >= minKm * 1000);
  if (!eligible.length) return null;
  return eligible.reduce((best, r) => (paceOf(r) < paceOf(best) ? r : best));
}

function computeRecords(runs) {
  const records = [];
  const longest = runs.reduce((b, r) => (!b || r.distance > b.distance ? r : b), null);
  if (longest) records.push({ name: 'Plus longue sortie', value: `${fmtKm(longest.distance)} km`, detail: `${longest.name} — ${fmtDate(longest.date)}`, icon: '🏔️' });

  [[5, '5 km et +'], [10, '10 km et +'], [21, 'Semi et +']].forEach(([dist, label]) => {
    const best = bestPaceOver(runs, dist);
    if (best) records.push({ name: `Meilleure allure (${label})`, value: fmtPace(paceOf(best)), detail: `${fmtKm(best.distance)} km — ${fmtDate(best.date)}`, icon: '⚡' });
  });

  const weeks = weeklySeries(runs, 156);
  const bestWeek = weeks.reduce((b, w) => (w.km > (b ? b.km : 0) ? w : b), null);
  if (bestWeek && bestWeek.km > 0) records.push({ name: 'Plus grosse semaine', value: `${bestWeek.km.toFixed(1).replace('.', ',')} km`, detail: `Semaine du ${bestWeek.label} — ${bestWeek.count} sorties`, icon: '📦' });

  const maxElev = runs.reduce((b, r) => (!b || (r.elev || 0) > (b.elev || 0) ? r : b), null);
  if (maxElev && maxElev.elev > 0) records.push({ name: 'Plus gros dénivelé', value: `${Math.round(maxElev.elev)} m D+`, detail: `${maxElev.name} — ${fmtDate(maxElev.date)}`, icon: '⛰️' });

  const bestVo2 = runs.reduce((b, r) => (!b || (r.vo2max || 0) > (b.vo2max || 0) ? r : b), null);
  if (bestVo2 && bestVo2.vo2max > 0) records.push({ name: 'Meilleur VO2max', value: `${Math.round(bestVo2.vo2max)}`, detail: `${bestVo2.name} — ${fmtDate(bestVo2.date)}`, icon: '🫀' });

  return records;
}

function estimateZones(runs, ref = new Date()) {
  const recent = runs.filter(r => inLastDays(r, 90, ref));
  const pool = recent.length >= 3 ? recent : runs.slice(0, 30);
  if (!pool.length) return null;
  const longRuns = pool.filter(r => r.distance >= 8000);
  const threshold = longRuns.length ? Math.min(...longRuns.map(paceOf)) : median(pool.map(paceOf));
  return { threshold, easy: threshold + 60, marathon: threshold + 25, interval: Math.max(threshold - 40, threshold * 0.85) };
}

function withinDays(arr, days, ref = new Date()) {
  const limit = addDays(startOfDay(ref), -(days - 1));
  return arr.filter(a => new Date(a.date) >= limit);
}

function paceZoneDistribution(runs, days = 365, ref = new Date()) {
  const pool = withinDays(runs, days, ref);
  const z = estimateZones(runs, ref);
  if (!z || !pool.length) return [];
  const T = z.threshold;
  const zones = [
    { label: 'VMA', max: T - 20, color: '#ef4444', seconds: 0 },
    { label: 'Seuil', max: T + 15, color: '#007cc3', seconds: 0 },
    { label: 'Tempo', max: T + 45, color: '#fbbf24', seconds: 0 },
    { label: 'Endurance', max: T + 85, color: '#34d399', seconds: 0 },
    { label: 'Récup', max: Infinity, color: '#22d3ee', seconds: 0 }
  ];
  pool.forEach(r => {
    const p = paceOf(r);
    const zone = zones.find(z => p <= z.max) || zones[zones.length - 1];
    zone.seconds += r.moving_time;
  });
  const total = zones.reduce((s, z) => s + z.seconds, 0) || 1;
  return zones.filter(z => z.seconds > 0).map(z => ({ ...z, pct: Math.round((z.seconds / total) * 100) }));
}

function hrPaceScatter(runs, days = 365, ref = new Date()) {
  return withinDays(runs, days, ref).filter(r => r.avg_hr)
    .map(r => ({ pace: paceOf(r) / 60, hr: r.avg_hr, km: r.distance / 1000, name: r.name, date: new Date(r.date) }));
}

function efficiencySeries(runs, days = 365, ref = new Date()) {
  const pool = withinDays(runs, days, ref).filter(r => r.avg_hr && r.avg_hr > 0).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const points = pool.map(r => ({ date: new Date(r.date), ef: r.distance / (r.avg_hr * (r.moving_time / 60)) }));
  const rolling = points.map((p, i) => { const w = points.slice(Math.max(0, i - 4), i + 1); return { date: p.date, ef: w.reduce((s, x) => s + x.ef, 0) / w.length }; });
  return { points, rolling };
}

function cadenceSeries(runs, days = 365, ref = new Date()) {
  const pool = withinDays(runs, days, ref).filter(r => r.cadence && r.cadence > 0).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const points = pool.map(r => ({ date: new Date(r.date), cadence: r.cadence }));
  const rolling = points.map((p, i) => { const w = points.slice(Math.max(0, i - 4), i + 1); return { date: p.date, cadence: w.reduce((s, x) => s + x.cadence, 0) / w.length }; });
  return { points, rolling };
}

function distanceDistribution(runs, days = 365, ref = new Date()) {
  const buckets = [
    { label: '0–5', min: 0, max: 5, count: 0 }, { label: '5–10', min: 5, max: 10, count: 0 },
    { label: '10–15', min: 10, max: 15, count: 0 }, { label: '15–20', min: 15, max: 20, count: 0 },
    { label: '20–30', min: 20, max: 30, count: 0 }, { label: '30+', min: 30, max: Infinity, count: 0 }
  ];
  withinDays(runs, days, ref).forEach(r => {
    const km = r.distance / 1000;
    const b = buckets.find(b => km >= b.min && km < b.max);
    if (b) b.count++;
  });
  return buckets.filter(b => b.count > 0 || b.max <= 30);
}

function monthlyAggregate(items, days, valueFn, ref = new Date()) {
  const pool = withinDays(items, days, ref);
  const map = new Map();
  pool.forEach(a => {
    const d = new Date(a.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    map.set(key, (map.get(key) || 0) + (valueFn(a) || 0));
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => {
    const [y, m] = key.split('-');
    const label = new Date(+y, +m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    return { label, value };
  });
}

function weeklyEffort(runs, nWeeks = 26, ref = new Date()) {
  const weeks = [];
  const currentWeekStart = startOfWeek(ref);
  for (let i = nWeeks - 1; i >= 0; i--) {
    const start = addDays(currentWeekStart, -7 * i);
    const end = addDays(start, 7);
    const inWeek = runs.filter(r => { const d = new Date(r.date); return d >= start && d < end; });
    weeks.push({ label: start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }), effort: inWeek.reduce((s, r) => s + (r.effort || 0), 0) });
  }
  return weeks;
}

function weekdayDistribution(runs, days = 365, ref = new Date()) {
  const labels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const out = labels.map(label => ({ label, km: 0, count: 0 }));
  withinDays(runs, days, ref).forEach(r => {
    const idx = (new Date(r.date).getDay() + 6) % 7;
    out[idx].km += r.distance / 1000; out[idx].count++;
  });
  return out;
}

function sportBreakdown(activities, days = 365, ref = new Date()) {
  const names = { Run: 'Course', Ride: 'Vélo', Swim: 'Natation', Hike: 'Rando', Walk: 'Marche', Workout: 'Renfo' };
  const map = new Map();
  withinDays(activities, days, ref).forEach(a => {
    const label = names[a.type] || a.type;
    map.set(label, (map.get(label) || 0) + (a.moving_time || 0));
  });
  return [...map.entries()].map(([label, seconds]) => ({ label, seconds })).sort((a, b) => b.seconds - a.seconds);
}

function fitnessStatus(runs, ref = new Date()) {
  const series = fitnessSeries(runs, 182, ref);
  if (!series.length) return { score: 0, label: 'Pas de données', trend: 0, form: 0, advice: 'Synchronise ou importe quelques courses.' };
  const last = series[series.length - 1];
  const maxFitness = Math.max(...series.map(p => p.fitness), 0.001);
  const score = Math.round((last.fitness / maxFitness) * 100);
  const monthAgo = series[Math.max(0, series.length - 30)];
  const trend = last.fitness - monthAgo.fitness;
  const form = last.form;
  let label, advice;
  if (last.fitness < maxFitness * 0.35 && trend >= 0) { label = 'En construction'; advice = 'Tu bâtis ta base. Enchaîne des sorties régulières en endurance.'; }
  else if (form > 8 && trend < -0.5) { label = 'Désentraînement'; advice = 'Bien reposé mais la forme baisse : relance le volume pour ne pas perdre tes acquis.'; }
  else if (form > 5) { label = 'Affûté'; advice = 'Frais et en forme — idéal pour une séance clé, un test ou une course.'; }
  else if (form < -12) { label = 'Fatigue élevée'; advice = 'Grosse charge récente. Place une journée de récup ou de repos avant de repartir fort.'; }
  else if (trend > 0.5) { label = 'En progression'; advice = 'Ta condition monte. Continue ainsi en surveillant la fatigue.'; }
  else { label = 'En forme'; advice = 'Charge et fraîcheur équilibrées. Bon moment pour progresser.'; }
  return { score, label, trend, form, fitness: last.fitness, advice };
}

const WEEK_TEMPLATES = {
  1: ['Endurance'], 2: ['Endurance', 'Sortie longue'], 3: ['Endurance', 'Tempo', 'Sortie longue'],
  4: ['Endurance', 'Fractionné', 'Allure course', 'Sortie longue'],
  5: ['Endurance', 'Fractionné', 'Endurance', 'Allure course', 'Sortie longue'],
  6: ['Récup', 'Fractionné', 'Endurance', 'Allure course', 'Endurance', 'Sortie longue'],
  7: ['Récup', 'Fractionné', 'Endurance', 'Allure course', 'Endurance', 'Tempo', 'Sortie longue']
};

function racePaceOffsets(km) {
  if (km <= 6) return { easy: 75, long: 85, tempo: 18, threshold: 12, interval: -8 };
  if (km <= 15) return { easy: 62, long: 78, tempo: 12, threshold: 2, interval: -15 };
  if (km <= 30) return { easy: 50, long: 22, tempo: -3, threshold: -10, interval: -28 };
  return { easy: 45, long: 12, tempo: -12, threshold: -22, interval: -40 };
}

function predictRaceTime(runs, raceKm, ref = new Date()) {
  const pool = runs.filter(r => inLastDays(r, 120, ref) && r.distance >= 3000);
  if (!pool.length) return null;
  let best = Infinity;
  pool.forEach(r => { const predicted = r.moving_time * Math.pow(raceKm / (r.distance / 1000), 1.06); if (predicted < best) best = predicted; });
  return Number.isFinite(best) ? best : null;
}

function fmtClock(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function buildTrainingPlan(runs, opts = {}) {
  const ref = opts.ref || new Date();
  const sessions = Math.max(1, Math.min(7, opts.sessionsPerWeek || 4));
  const zones = estimateZones(runs, ref) || { easy: 360, threshold: 300, interval: 260 };
  const stats = periodStats(runs, ref);
  const round = v => Math.max(3, Math.round(v));
  const avgDist = stats.last28.count ? Math.max(stats.last28.km / stats.last28.count, 4) : 6;
  const last90 = runs.filter(r => inLastDays(r, 90, ref));
  const longest90 = Math.max(...last90.map(r => r.distance / 1000), avgDist * 1.4);
  const isRace = opts.objective === 'race' && opts.raceKm > 0 && opts.targetSeconds > 0;

  if (!isRace) {
    const progression = opts.objective === 'progression';
    const vf = progression ? 1.1 : 1.0;
    const longTarget = Math.min(longest90 * (progression ? 1.15 : 1.0), avgDist * 2 + 4);
    const roles = WEEK_TEMPLATES[sessions].map(r => (r === 'Allure course' ? 'Endurance' : r));
    const detail = role => {
      switch (role) {
        case 'Sortie longue': return { dist: round(longTarget), pace: fmtPace(zones.easy + 10), focus: 'Endurance, allure souple — on cherche la durée.' };
        case 'Tempo': return { dist: round(avgDist * vf), pace: `${fmtPace(zones.threshold)} sur les blocs`, focus: '15 min échauffement + 2×10 min au seuil (récup 3 min) + retour au calme.' };
        case 'Fractionné': return { dist: round(avgDist * 0.9 * vf), pace: `${fmtPace(zones.interval)} sur les fractions`, focus: '15 min échauffement + 8×400 m vite (récup 1 min) + retour au calme.' };
        case 'Récup': return { dist: round(avgDist * 0.6), pace: fmtPace(zones.easy + 30), focus: 'Footing très léger de récupération active.' };
        default: return { dist: round(avgDist * vf), pace: fmtPace(zones.easy), focus: 'Endurance fondamentale, allure conversationnelle.' };
      }
    };
    const plan = roles.map(role => ({ type: role, ...detail(role) }));
    return { mode: 'fitness', objectiveLabel: progression ? 'Progression du volume' : 'Forme générale', sessionsPerWeek: sessions, weeklyKm: plan.reduce((s, p) => s + (p.dist || p.distance), 0), sessions: plan.map(p => ({ type: p.type, distance: p.dist, pace: p.pace, focus: p.focus })) };
  }

  const raceKm = opts.raceKm;
  const racePace = opts.targetSeconds / raceKm;
  const off = racePaceOffsets(raceKm);
  const pace = { easy: racePace + off.easy, long: racePace + off.long, tempo: racePace + off.tempo, threshold: racePace + off.threshold, interval: racePace + off.interval, race: racePace };
  let longTarget;
  if (raceKm <= 6) longTarget = Math.min(Math.max(avgDist * 1.5, 8), 14);
  else if (raceKm <= 15) longTarget = Math.min(Math.max(avgDist * 1.6, 12), 18);
  else if (raceKm <= 30) longTarget = Math.min(Math.max(longest90 * 1.1, 16), 24);
  else longTarget = Math.min(Math.max(longest90 * 1.1, 24), 34);
  const detail = role => {
    switch (role) {
      case 'Sortie longue': return { dist: round(longTarget), pace: fmtPace(pace.long), focus: raceKm > 15 ? 'Endurance longue, derniers km à allure course.' : 'Endurance longue, allure souple.' };
      case 'Allure course': return { dist: round(Math.max(avgDist, raceKm <= 15 ? raceKm * 0.7 : 10)), pace: `${fmtPace(pace.race)} (allure objectif)`, focus: `Bloc spécifique à l’allure visée (${fmtPace(pace.race)}) pour mémoriser le rythme de course.` };
      case 'Tempo': return { dist: round(avgDist), pace: `${fmtPace(pace.threshold)} au seuil`, focus: '15 min échauffement + 2×12 min au seuil (récup 3 min) + retour au calme.' };
      case 'Fractionné': return { dist: round(avgDist * 0.9), pace: `${fmtPace(pace.interval)} sur les fractions`, focus: '15 min échauffement + 6×600 m rapides (récup 90 s) + retour au calme.' };
      case 'Récup': return { dist: round(avgDist * 0.6), pace: fmtPace(pace.easy + 25), focus: 'Footing de récupération active.' };
      default: return { dist: round(avgDist), pace: fmtPace(pace.easy), focus: 'Endurance fondamentale, allure facile.' };
    }
  };
  const plan = WEEK_TEMPLATES[sessions].map(role => { const d = detail(role); return { type: role, distance: d.dist, pace: d.pace, focus: d.focus }; });
  const predicted = predictRaceTime(runs, raceKm, ref);
  let feasibility = { label: 'À évaluer', detail: 'Pas assez de courses récentes pour estimer.' };
  if (predicted) {
    const ratio = opts.targetSeconds / predicted;
    const predStr = fmtClock(predicted);
    if (ratio >= 1.04) feasibility = { label: 'Confortable', tone: 'good', detail: `Ton niveau actuel projette ~${predStr}. L’objectif a de la marge.` };
    else if (ratio >= 0.99) feasibility = { label: 'Réaliste', tone: 'good', detail: `Cohérent avec ta forme actuelle (projection ~${predStr}).` };
    else if (ratio >= 0.95) feasibility = { label: 'Ambitieux', tone: 'warn', detail: `Au-dessus de ta forme actuelle (projection ~${predStr}). Tenable avec une bonne prépa.` };
    else feasibility = { label: 'Très ambitieux', tone: 'bad', detail: `Bien plus rapide que ta forme actuelle (projection ~${predStr}). Vise une progression par étapes.` };
  }
  return { mode: 'race', objectiveLabel: `${opts.raceLabel || (raceKm + ' km')} en ${fmtClock(opts.targetSeconds)}`, racePace, racePaceStr: fmtPace(racePace), feasibility, weeksToRace: opts.weeksToRace > 0 ? opts.weeksToRace : null, sessionsPerWeek: sessions, weeklyKm: plan.reduce((s, p) => s + p.distance, 0), sessions: plan };
}

function suggestRun(runs, ref = new Date()) {
  const zones = estimateZones(runs, ref);
  if (!runs.length || !zones) return { type: 'Endurance', title: 'Première sortie !', desc: 'Pas encore assez de données : pars sur une sortie facile en aisance respiratoire pour poser la première brique.', distance: '5 km', pace: 'Allure conversationnelle', reason: 'Aucun historique récent.' };
  const today = startOfDay(ref);
  const stats = periodStats(runs, ref);
  const last7 = sumStats(runs.filter(r => inLastDays(r, 7, ref)));
  /* Baseline = recent 4-week weekly average (not 4–8 weeks ago), so a legit,
     established ramp-up isn't mistaken for an acute spike. */
  const weeklyAvg = Math.max(stats.last28.km / 4, 5);
  const lastRun = runs[0];
  const daysSince = Math.round((today - startOfDay(new Date(lastRun.date))) / 86400000);
  const avgDist = stats.last28.count ? stats.last28.km / stats.last28.count : last7.km / Math.max(last7.count, 1) || 6;
  const last90 = runs.filter(r => inLastDays(r, 90, ref));
  const longest90 = Math.max(...last90.map(r => r.distance / 1000), avgDist);
  const lastWasHard = paceOf(lastRun) <= zones.threshold + 10;
  const lastWasLong = lastRun.distance / 1000 >= Math.max(avgDist * 1.4, 12);
  const last7Runs = runs.filter(r => inLastDays(r, 7, ref));
  const hadQuality = last7Runs.some(r => paceOf(r) <= zones.threshold + 10);
  const hadLong = last7Runs.some(r => r.distance / 1000 >= Math.max(avgDist * 1.4, 12));
  const km = v => `${Math.round(v)} km`;

  if (daysSince === 0) return { type: 'Récup', title: 'Déjà couru aujourd’hui — récupère', desc: "Tu as déjà une sortie au compteur aujourd'hui. Si tu veux ressortir, contente-toi d'un footing de délassement très court, sinon repos complet.", distance: '0 – 4 km', pace: fmtPace(zones.easy + 30), reason: 'Sortie déjà enregistrée aujourd’hui.' };
  if (last7.km > weeklyAvg * 1.5 && last7.km > 15) return { type: 'Repos', title: 'Lève le pied', desc: `Tu as couru ${last7.km.toFixed(0)} km sur 7 jours contre ${weeklyAvg.toFixed(0)} km habituellement : la charge monte trop vite. Repos ou footing très léger.`, distance: '0 – 5 km', pace: fmtPace(zones.easy + 30), reason: `Charge aiguë : ${last7.km.toFixed(0)} km / 7 j.` };
  if (daysSince >= 4) return { type: 'Reprise', title: 'Reprise en douceur', desc: `${daysSince} jours sans courir : repars sur une sortie courte en endurance fondamentale, sans regarder le chrono.`, distance: km(Math.max(avgDist * 0.7, 4)), pace: fmtPace(zones.easy), reason: `Dernière sortie il y a ${daysSince} jours.` };
  if (daysSince === 1 && (lastWasHard || lastWasLong)) return { type: 'Endurance', title: 'Footing d’assimilation', desc: `Hier c'était ${lastWasLong ? 'long' : 'intense'} (${fmtKm(lastRun.distance)} km à ${fmtPace(paceOf(lastRun))}). Aujourd'hui : endurance fondamentale stricte.`, distance: km(Math.max(avgDist * 0.8, 5)), pace: fmtPace(zones.easy), reason: 'Séance exigeante la veille.' };
  const dow = ref.getDay();
  if ((dow === 6 || dow === 0) && !hadLong && stats.last28.count >= 4) { const target = Math.min(longest90 * 1.1, avgDist * 1.8 + 2); return { type: 'Sortie longue', title: 'C’est le jour de la sortie longue', desc: 'Pas de sortie longue cette semaine : profite du week-end pour construire l’endurance. Allure souple, on cherche la durée.', distance: km(Math.max(target, 10)), pace: fmtPace(zones.easy + 10), reason: 'Week-end + aucune sortie longue sur 7 jours.' }; }
  if (!hadQuality && stats.last28.count >= 6) {
    const weekParity = Math.floor(today.getTime() / (7 * 86400000)) % 2;
    if (weekParity === 0) return { type: 'Tempo', title: 'Séance seuil', desc: 'Échauffement 15 min, puis 2 × 10 min à allure seuil (récup 3 min trot), retour au calme. La séance qui fait progresser ton allure de course.', distance: km(Math.max(avgDist, 8)), pace: `${fmtPace(zones.threshold)} sur les blocs`, reason: 'Aucune séance de qualité sur 7 jours.' };
    return { type: 'Intervalles', title: 'Fractionné court', desc: 'Échauffement 15 min, puis 8 × 400 m vite (récup 1 min trot), retour au calme. Objectif : VMA et économie de course.', distance: km(Math.max(avgDist * 0.9, 7)), pace: `${fmtPace(zones.interval)} sur les 400 m`, reason: 'Aucune séance de qualité sur 7 jours.' };
  }
  return { type: 'Endurance', title: 'Endurance fondamentale', desc: 'Sortie classique en aisance respiratoire : c’est elle qui construit 80 % de la progression. Allure où tu peux tenir une conversation.', distance: km(Math.max(avgDist, 5)), pace: fmtPace(zones.easy), reason: 'Semaine équilibrée — on consolide la base aérobie.' };
}

/* ================================================================ */
/* PART 2 — wellness (Garmin-specific)                              */
/* ================================================================ */

/* Most recent wellness record that has a non-null value for `key`
   (or any record if key omitted). */
function latestWellness(wellness, key) {
  for (let i = wellness.length - 1; i >= 0; i--) {
    const w = wellness[i];
    if (!key) return w;
    if (w[key] != null) return w;
  }
  return null;
}

/* Generic daily numeric series via an accessor, oldest first, with rolling avg. */
function wellnessSeries(wellness, days, accessor, ref = new Date()) {
  const limit = addDays(startOfDay(ref), -(days - 1));
  const pts = wellness
    .filter(w => new Date(w.date) >= limit)
    .map(w => ({ date: new Date(w.date), value: accessor(w) }))
    .filter(p => p.value != null && Number.isFinite(p.value));
  const rolling = pts.map((p, i) => {
    const win = pts.slice(Math.max(0, i - 6), i + 1);
    return { date: p.date, value: win.reduce((s, x) => s + x.value, 0) / win.length };
  });
  return { points: pts, rolling };
}

/* Sleep stages (seconds → hours) per night for the last `days`. */
function sleepStageSeries(wellness, days = 30, ref = new Date()) {
  const limit = addDays(startOfDay(ref), -(days - 1));
  return wellness.filter(w => w.sleep && w.sleep.total && new Date(w.date) >= limit).map(w => ({
    date: new Date(w.date),
    deep: (w.sleep.deep || 0) / 3600,
    light: (w.sleep.light || 0) / 3600,
    rem: (w.sleep.rem || 0) / 3600,
    awake: (w.sleep.awake || 0) / 3600,
    total: (w.sleep.total || 0) / 3600,
    score: w.sleep.score || null
  }));
}

function avgOf(arr, accessor) {
  const vals = arr.map(accessor).filter(v => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/* Headline wellness stats over the last `days`. */
function wellnessStats(wellness, days = 7, ref = new Date()) {
  const pool = withinDays(wellness, days, ref);
  const sleeps = pool.filter(w => w.sleep && w.sleep.total);
  return {
    sleepHours: avgOf(sleeps, w => w.sleep.total / 3600),
    sleepScore: avgOf(sleeps, w => w.sleep.score),
    restingHr: avgOf(pool, w => w.resting_hr),
    stress: avgOf(pool, w => w.stress && w.stress.avg),
    bodyBatteryHigh: avgOf(pool, w => w.body_battery && w.body_battery.high),
    steps: avgOf(pool, w => w.steps),
    intensityMinutes: pool.reduce((s, w) => s + (w.intensity_minutes || 0), 0)
  };
}

const READINESS_TONES = {
  high: { tone: 'good', label: 'Prêt' },
  medium: { tone: 'ok', label: 'Modéré' },
  low: { tone: 'warn', label: 'Prudence' }
};

/* The premium "recommendation of the day": fuses Garmin readiness/Body Battery/
   sleep with the training-load model into one recovery-aware verdict. */
function buildRecommendation(runs, wellness, snapshot, ref = new Date()) {
  const today = latestWellness(wellness) || {};
  const readiness = today.training_readiness ? today.training_readiness.score : null;
  const bb = today.body_battery ? today.body_battery.high : null;
  const lastSleep = (() => { const w = latestWellness(wellness, 'sleep'); return w && w.sleep ? w.sleep : null; })();
  const sleepScore = lastSleep ? lastSleep.score : null;
  const hrv = (() => { const w = latestWellness(wellness, 'hrv'); return w && w.hrv ? w.hrv : null; })();
  const fit = fitnessStatus(runs, ref);

  const factors = [];
  if (readiness != null) factors.push(`Readiness ${readiness}/100`);
  if (bb != null) factors.push(`Body Battery ↑${bb}`);
  if (sleepScore != null) factors.push(`Sommeil ${sleepScore}/100`);
  if (hrv && hrv.status) factors.push(`HRV ${hrv.status.toLowerCase()}`);
  factors.push(`Forme ${fit.label.toLowerCase()} (TSB ${fit.form >= 0 ? '+' : ''}${fit.form.toFixed(0)})`);

  /* Recovery score 0-100: blend the available signals (or fall back to TSB). */
  const signals = [];
  if (readiness != null) signals.push(readiness);
  if (bb != null) signals.push(bb);
  if (sleepScore != null) signals.push(sleepScore);
  let recovery;
  if (signals.length) recovery = Math.round(signals.reduce((s, v) => s + v, 0) / signals.length);
  else recovery = Math.max(0, Math.min(100, Math.round(60 + fit.form * 2)));

  /* Acute training load also gates the verdict: even with great recovery, a
     load spike means "don't pile on more" — keeps this in sync with the
     rule-based session suggestion (suggestRun). */
  const load = acwr(runs, ref);
  if (load && load.ratio > 1.5) { recovery = Math.min(recovery, 38); factors.push(`Charge en pic (ACWR ${load.ratio.toFixed(2)})`); }
  else if (load && load.ratio > 1.3) { recovery = Math.min(recovery, 55); factors.push(`Charge en hausse (ACWR ${load.ratio.toFixed(2)})`); }

  let level, title, desc;
  if (recovery >= 70) {
    level = 'go'; title = 'Feu vert pour une grosse séance';
    desc = "Ta récupération est bonne : c'est le moment idéal pour une séance de qualité (seuil, fractionné) ou une sortie longue. Profite de cette fraîcheur.";
  } else if (recovery >= 45) {
    level = 'steady'; title = 'Séance modérée recommandée';
    desc = "Récupération correcte sans être optimale. Vise une sortie en endurance ou un tempo léger, en gardant de la marge. Évite l'intensité maximale aujourd'hui.";
  } else {
    level = 'easy'; title = 'Priorité à la récupération';
    desc = "Ta récupération est basse (sommeil, Body Battery ou readiness en berne). Privilégie le repos ou un footing très léger — forcer maintenant augmenterait le risque de blessure ou de surentraînement.";
  }

  return { level, title, desc, recovery, readiness, bodyBattery: bb, sleepScore, hrv, factors, fitness: fit };
}

/* ================================================================ */
/* PART 3 — data science: load, risk, correlations, auto-insights   */
/* ================================================================ */

function wellnessByDate(wellness) {
  const m = new Map();
  wellness.forEach(w => m.set(w.date, w));
  return m;
}

function addDaysStr(s, n) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function wellnessAvg(wellness, days, accessor, ref = new Date()) {
  return avgOf(withinDays(wellness, days, ref), accessor);
}

/* Pearson correlation coefficient of two equal-length arrays. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/* Training load (km + D+/100) summed over the last `days`. */
function loadInDays(runs, days, ref = new Date()) {
  return runs.filter(r => inLastDays(r, days, ref)).reduce((s, r) => s + r.distance / 1000 + (r.elev || 0) / 100, 0);
}

/* Acute:Chronic Workload Ratio — the classic injury-risk gauge.
   acute = last 7 days load; chronic = mean weekly load over 28 days. */
function acwr(runs, ref = new Date()) {
  const acute = loadInDays(runs, 7, ref);
  const chronic = loadInDays(runs, 28, ref) / 4;
  if (chronic <= 0) return null;
  const ratio = acute / chronic;
  let zone, tone, advice;
  if (ratio < 0.8) { zone = 'Sous-charge'; tone = 'ok'; advice = 'Charge basse vs ta moyenne — tu peux remonter progressivement.'; }
  else if (ratio <= 1.3) { zone = 'Optimale'; tone = 'good'; advice = 'Zone idéale (0,8–1,3) : tu progresses sans surrisque.'; }
  else if (ratio <= 1.5) { zone = 'Élevée'; tone = 'warn'; advice = 'Charge en hausse rapide — surveille la fatigue et le sommeil.'; }
  else { zone = 'Risque'; tone = 'bad'; advice = 'Pic de charge (>1,5) : risque de blessure accru, lève le pied.'; }
  return { ratio, acute, chronic, zone, tone, advice };
}

/* Composite overtraining-risk score 0-100 (higher = more risk), blending
   ACWR, resting-HR drift, HRV drop and sleep debt against the athlete's own
   28-day baseline. */
function overtrainingRisk(runs, wellness, ref = new Date()) {
  const factors = [];
  let risk = 0, weight = 0;

  const a = acwr(runs, ref);
  if (a) {
    const c = a.ratio > 1.5 ? 100 : a.ratio > 1.3 ? 65 : a.ratio < 0.8 ? 15 : 10;
    risk += c * 0.35; weight += 0.35;
    if (a.ratio > 1.3) factors.push(`Charge aiguë élevée (ACWR ${a.ratio.toFixed(2)})`);
  }
  const rhr7 = wellnessAvg(wellness, 7, w => w.resting_hr, ref);
  const rhr28 = wellnessAvg(wellness, 28, w => w.resting_hr, ref);
  if (rhr7 != null && rhr28 != null) {
    const d = rhr7 - rhr28;
    risk += Math.max(0, Math.min(100, 45 + d * 12)) * 0.25; weight += 0.25;
    if (d >= 3) factors.push(`FC de repos +${d.toFixed(0)} bpm vs base`);
  }
  const hrv7 = wellnessAvg(wellness, 7, w => w.hrv && w.hrv.last_night_avg, ref);
  const hrv28 = wellnessAvg(wellness, 28, w => w.hrv && w.hrv.last_night_avg, ref);
  if (hrv7 != null && hrv28 != null) {
    const d = hrv28 - hrv7;
    risk += Math.max(0, Math.min(100, 40 + d * 4)) * 0.20; weight += 0.20;
    if (d >= 4) factors.push(`HRV en baisse (${hrv7.toFixed(0)} vs ${hrv28.toFixed(0)} ms)`);
  }
  const sl7 = wellnessAvg(wellness, 7, w => w.sleep && w.sleep.total / 3600, ref);
  if (sl7 != null) {
    const debt = 7.5 - sl7;
    risk += Math.max(0, Math.min(100, debt * 30)) * 0.20; weight += 0.20;
    if (debt >= 1) factors.push(`Dette de sommeil (~${(debt * 7).toFixed(0)} h / semaine)`);
  }
  if (weight === 0) return null;
  const score = Math.round(risk / weight);
  let level, tone;
  if (score < 35) { level = 'Faible'; tone = 'good'; }
  else if (score < 60) { level = 'Modéré'; tone = 'warn'; }
  else { level = 'Élevé'; tone = 'bad'; }
  if (!factors.length) factors.push('Tous les signaux sont au vert.');
  return { score, level, tone, factors };
}

function interpretCorr(r, pos, neg) {
  const a = Math.abs(r);
  const strength = a >= 0.5 ? 'forte' : a >= 0.3 ? 'modérée' : 'faible';
  return { strength, dir: r >= 0 ? pos : neg };
}

/* Correlations within the athlete's own daily data — what actually drives
   their recovery/performance. Returns those with enough paired days. */
function correlations(activities, wellness, ref = new Date()) {
  const byDate = wellnessByDate(wellness);
  const dates = [...byDate.keys()].sort();
  const loadMap = new Map();
  runsOnly(activities).forEach(r => {
    const k = startOfDay(new Date(r.date)).toISOString().slice(0, 10);
    loadMap.set(k, (loadMap.get(k) || 0) + r.distance / 1000 + (r.elev || 0) / 100);
  });

  const out = [];
  function add(label, accX, accY, pos, neg, lag = 0) {
    const xs = [], ys = [];
    dates.forEach(d => {
      const wx = byDate.get(d);
      const wy = byDate.get(lag ? addDaysStr(d, lag) : d);
      if (!wy) return;
      const x = accX(wx, d), y = accY(wy, lag ? addDaysStr(d, lag) : d);
      if (x != null && Number.isFinite(x) && y != null && Number.isFinite(y)) { xs.push(x); ys.push(y); }
    });
    const r = pearson(xs, ys);
    if (r == null || xs.length < 8) return;
    const meta = interpretCorr(r, pos, neg);
    out.push({ label, r: Math.round(r * 100) / 100, n: xs.length, strength: meta.strength, text: meta.dir });
  }

  add('Sommeil → readiness du lendemain',
    w => w.sleep && w.sleep.score, w => w.training_readiness && w.training_readiness.score,
    'mieux tu dors, plus tu es prêt le lendemain', 'lien inverse inattendu', 1);
  add('Stress → FC de repos (même jour)',
    w => w.stress && w.stress.avg, w => w.resting_hr,
    'plus de stress = FC de repos plus haute', 'plus de stress = FC plus basse', 0);
  add('HRV → Body Battery (même jour)',
    w => w.hrv && w.hrv.last_night_avg, w => w.body_battery && w.body_battery.high,
    'meilleure HRV = plus d’énergie', 'lien inverse', 0);
  add('Charge du jour → FC de repos du lendemain',
    (w, d) => loadMap.get(d) || 0, w => w.resting_hr,
    'les grosses journées font monter ta FC de repos le lendemain', 'lien inverse', 1);
  add('Sommeil → stress du lendemain',
    w => w.sleep && w.sleep.score, w => w.stress && w.stress.avg,
    'mieux tu dors, moins tu es stressé (idéalement négatif)', 'mieux tu dors, plus de stress', 1);

  return out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

/* Notable auto-detected signals (chips at the top of the dashboard). */
function autoInsights(runs, wellness, snapshot, ref = new Date()) {
  const ins = [];
  const push = (tone, icon, text) => ins.push({ tone, icon, text });

  const rhr7 = wellnessAvg(wellness, 7, w => w.resting_hr, ref);
  const rhr28 = wellnessAvg(wellness, 28, w => w.resting_hr, ref);
  if (rhr7 != null && rhr28 != null) {
    const d = rhr7 - rhr28;
    if (d >= 3) push('warn', '❤️', `FC de repos en hausse : +${d.toFixed(0)} bpm vs ta base 28 j (fatigue/stress possible).`);
    else if (d <= -2) push('good', '❤️', `FC de repos en baisse (${d.toFixed(0)} bpm) : bon signe de récupération.`);
  }
  const sl7 = wellnessAvg(wellness, 7, w => w.sleep && w.sleep.total / 3600, ref);
  if (sl7 != null) {
    if (sl7 < 7) push('warn', '😴', `Sommeil moyen ${sl7.toFixed(1)} h/nuit sur 7 j — sous l’optimal (~7,5–8 h).`);
    else push('good', '😴', `Bon sommeil : ${sl7.toFixed(1)} h/nuit en moyenne sur 7 j.`);
  }
  const hrv7 = wellnessAvg(wellness, 7, w => w.hrv && w.hrv.last_night_avg, ref);
  const hrv28 = wellnessAvg(wellness, 28, w => w.hrv && w.hrv.last_night_avg, ref);
  if (hrv7 != null && hrv28 != null && hrv28 - hrv7 >= 4) push('warn', '📉', `HRV en baisse : ${hrv7.toFixed(0)} ms (vs ${hrv28.toFixed(0)} ms sur 28 j).`);
  const a = acwr(runs, ref);
  if (a) {
    if (a.ratio > 1.5) push('bad', '⚠️', `Charge aiguë très élevée (ACWR ${a.ratio.toFixed(2)}) — risque de blessure.`);
    else if (a.ratio < 0.8) push('ok', '📉', `Charge basse (ACWR ${a.ratio.toFixed(2)}) : marge pour reprendre.`);
    else push('good', '✅', `Charge bien dosée (ACWR ${a.ratio.toFixed(2)}).`);
  }
  const fit = fitnessStatus(runs, ref);
  if (fit.trend > 0.5) push('good', '📈', `Ta forme progresse (${fit.label}).`);
  else if (fit.trend < -0.5) push('warn', '📉', `Ta forme baisse — attention au désentraînement.`);
  const stats = periodStats(runs, ref);
  if (stats.prev28.km > 0) {
    const delta = ((stats.last28.km - stats.prev28.km) / stats.prev28.km) * 100;
    if (delta >= 25) push('warn', '🚀', `Volume +${delta.toFixed(0)} % sur 4 semaines — montée rapide.`);
  }
  return ins.slice(0, 6);
}
