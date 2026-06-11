/* Analysis engine: stats, fitness/fatigue model, records, pace zones
   and the daily run suggestion. All functions are pure — they take the
   activity list (most recent first) and return plain data. */

/* ---------------------------------------------------------------- */
/* Formatting helpers                                                */
/* ---------------------------------------------------------------- */

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
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

/* ---------------------------------------------------------------- */
/* Basics                                                            */
/* ---------------------------------------------------------------- */

function isRun(act) {
  return typeof act.type === 'string' && act.type.toLowerCase().includes('run');
}

function runsOnly(activities) {
  return activities.filter(isRun).filter(a => a.distance > 500 && a.moving_time > 60);
}

function paceOf(act) {
  return act.moving_time / (act.distance / 1000);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/* Monday of the week containing `date`. */
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
  return runs.reduce(
    (acc, r) => {
      acc.km += r.distance / 1000;
      acc.time += r.moving_time;
      acc.elev += r.elev || 0;
      acc.count += 1;
      return acc;
    },
    { km: 0, time: 0, elev: 0, count: 0 }
  );
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ---------------------------------------------------------------- */
/* Period stats (KPI cards)                                          */
/* ---------------------------------------------------------------- */

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

/* ---------------------------------------------------------------- */
/* Time series                                                       */
/* ---------------------------------------------------------------- */

/* Weekly km/time/count for the last `nWeeks` weeks (oldest first). */
function weeklySeries(runs, nWeeks = 26, ref = new Date()) {
  const weeks = [];
  const currentWeekStart = startOfWeek(ref);
  for (let i = nWeeks - 1; i >= 0; i--) {
    const start = addDays(currentWeekStart, -7 * i);
    const end = addDays(start, 7);
    const inWeek = runs.filter(r => {
      const d = new Date(r.date);
      return d >= start && d < end;
    });
    const stats = sumStats(inWeek);
    weeks.push({
      label: start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
      ...stats
    });
  }
  return weeks;
}

/* Banister-style fitness (CTL, 42d), fatigue (ATL, 7d) and form (TSB).
   Daily training load ≈ km weighted by elevation. */
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
  let ctl = 0;
  let atl = 0;
  /* Warm up the model on the year preceding the window. */
  for (let d = addDays(first, -365); d < first; d = addDays(d, 1)) {
    const load = dailyLoad.get(d.getTime()) || 0;
    ctl += (load - ctl) / 42;
    atl += (load - atl) / 7;
  }
  for (let d = new Date(first); d <= today; d = addDays(d, 1)) {
    const load = dailyLoad.get(d.getTime()) || 0;
    ctl += (load - ctl) / 42;
    atl += (load - atl) / 7;
    series.push({
      date: new Date(d),
      fitness: ctl,
      fatigue: atl,
      form: ctl - atl
    });
  }
  return series;
}

/* Average pace per run over the last `days`, oldest first, with a
   5-run rolling average. */
function paceTrend(runs, days = 182, ref = new Date()) {
  const recent = runs
    .filter(r => inLastDays(r, days, ref))
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const points = recent.map(r => ({
    date: new Date(r.date),
    pace: paceOf(r),
    km: r.distance / 1000,
    name: r.name
  }));

  const rolling = points.map((p, i) => {
    const window = points.slice(Math.max(0, i - 4), i + 1);
    return {
      date: p.date,
      pace: window.reduce((s, w) => s + w.pace, 0) / window.length
    };
  });

  return { points, rolling };
}

/* GitHub-style calendar: one cell per day over the last `days` days
   (aligned to whole weeks). */
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

/* ---------------------------------------------------------------- */
/* Records                                                           */
/* ---------------------------------------------------------------- */

function bestPaceOver(runs, minKm) {
  const eligible = runs.filter(r => r.distance >= minKm * 1000);
  if (!eligible.length) return null;
  return eligible.reduce((best, r) => (paceOf(r) < paceOf(best) ? r : best));
}

function computeRecords(runs) {
  const records = [];

  const longest = runs.reduce((b, r) => (!b || r.distance > b.distance ? r : b), null);
  if (longest) {
    records.push({
      name: 'Plus longue sortie',
      value: `${fmtKm(longest.distance)} km`,
      detail: `${longest.name} — ${fmtDate(longest.date)}`,
      icon: '🏔️'
    });
  }

  [[5, '5 km et +'], [10, '10 km et +'], [21, 'Semi et +']].forEach(([dist, label]) => {
    const best = bestPaceOver(runs, dist);
    if (best) {
      records.push({
        name: `Meilleure allure (${label})`,
        value: fmtPace(paceOf(best)),
        detail: `${fmtKm(best.distance)} km — ${fmtDate(best.date)}`,
        icon: '⚡'
      });
    }
  });

  const weeks = weeklySeries(runs, 156);
  const bestWeek = weeks.reduce((b, w) => (w.km > (b ? b.km : 0) ? w : b), null);
  if (bestWeek && bestWeek.km > 0) {
    records.push({
      name: 'Plus grosse semaine',
      value: `${bestWeek.km.toFixed(1).replace('.', ',')} km`,
      detail: `Semaine du ${bestWeek.label} — ${bestWeek.count} sorties`,
      icon: '📦'
    });
  }

  const maxElev = runs.reduce((b, r) => (!b || (r.elev || 0) > (b.elev || 0) ? r : b), null);
  if (maxElev && maxElev.elev > 0) {
    records.push({
      name: 'Plus gros dénivelé',
      value: `${Math.round(maxElev.elev)} m D+`,
      detail: `${maxElev.name} — ${fmtDate(maxElev.date)}`,
      icon: '⛰️'
    });
  }

  const mostKudos = runs.reduce((b, r) => (!b || r.kudos > b.kudos ? r : b), null);
  if (mostKudos && mostKudos.kudos > 0) {
    records.push({
      name: 'Sortie la plus likée',
      value: `${mostKudos.kudos} kudos`,
      detail: `${mostKudos.name} — ${fmtDate(mostKudos.date)}`,
      icon: '👏'
    });
  }

  return records;
}

/* ---------------------------------------------------------------- */
/* Pace zones                                                        */
/* ---------------------------------------------------------------- */

/* Threshold pace estimated from the best sustained effort of the last
   90 days (runs ≥ 8 km), falling back to the median pace. */
function estimateZones(runs, ref = new Date()) {
  const recent = runs.filter(r => inLastDays(r, 90, ref));
  const pool = recent.length >= 3 ? recent : runs.slice(0, 30);
  if (!pool.length) return null;

  const longRuns = pool.filter(r => r.distance >= 8000);
  const threshold = longRuns.length
    ? Math.min(...longRuns.map(paceOf))
    : median(pool.map(paceOf));

  return {
    threshold,
    easy: threshold + 60,
    marathon: threshold + 25,
    interval: Math.max(threshold - 40, threshold * 0.85)
  };
}

/* ---------------------------------------------------------------- */
/* Fitness condition                                                 */
/* ---------------------------------------------------------------- */

/* Reads the current fitness model and turns it into a human status:
   a 0-100 form index (fitness relative to the athlete's own peak over
   the window) plus a qualitative label and advice. */
function fitnessStatus(runs, ref = new Date()) {
  const series = fitnessSeries(runs, 182, ref);
  if (!series.length) {
    return { score: 0, label: 'Pas de données', trend: 0, form: 0, advice: 'Importe ou enregistre quelques courses.' };
  }

  const last = series[series.length - 1];
  const maxFitness = Math.max(...series.map(p => p.fitness), 0.001);
  const score = Math.round((last.fitness / maxFitness) * 100);

  const monthAgo = series[Math.max(0, series.length - 30)];
  const trend = last.fitness - monthAgo.fitness;
  const form = last.form; // TSB: positive = fresh, negative = loaded

  let label, advice;
  if (last.fitness < maxFitness * 0.35 && trend >= 0) {
    label = 'En construction';
    advice = 'Tu bâtis ta base. Enchaîne des sorties régulières en endurance.';
  } else if (form > 8 && trend < -0.5) {
    label = 'Désentraînement';
    advice = 'Bien reposé mais la forme baisse : relance le volume pour ne pas perdre tes acquis.';
  } else if (form > 5) {
    label = 'Affûté';
    advice = 'Frais et en forme — idéal pour une séance clé, un test ou une course.';
  } else if (form < -12) {
    label = 'Fatigue élevée';
    advice = 'Grosse charge récente. Place une journée de récup ou de repos avant de repartir fort.';
  } else if (trend > 0.5) {
    label = 'En progression';
    advice = 'Ta condition monte. Continue ainsi en surveillant la fatigue.';
  } else {
    label = 'En forme';
    advice = 'Charge et fraîcheur équilibrées. Bon moment pour progresser.';
  }

  return { score, label, trend, form, fitness: last.fitness, advice };
}

/* ---------------------------------------------------------------- */
/* Training program                                                  */
/* ---------------------------------------------------------------- */

const PLAN_OBJECTIVES = {
  maintien: { label: 'Maintien de forme', longFactor: 1.0, volumeFactor: 1.0 },
  progression: { label: 'Progression du volume', longFactor: 1.15, volumeFactor: 1.1 },
  race5: { label: 'Préparer un 5 km', longFactor: 1.0, volumeFactor: 1.0, race: 5 },
  race10: { label: 'Préparer un 10 km', longFactor: 1.1, volumeFactor: 1.05, race: 10 },
  race21: { label: 'Préparer un semi-marathon', longFactor: 1.25, volumeFactor: 1.1, race: 21.1 },
  race42: { label: 'Préparer un marathon', longFactor: 1.4, volumeFactor: 1.15, race: 42.2 }
};

const WEEK_TEMPLATES = {
  1: ['Endurance'],
  2: ['Endurance', 'Sortie longue'],
  3: ['Endurance', 'Tempo', 'Sortie longue'],
  4: ['Endurance', 'Fractionné', 'Endurance', 'Sortie longue'],
  5: ['Endurance', 'Fractionné', 'Endurance', 'Tempo', 'Sortie longue'],
  6: ['Récup', 'Fractionné', 'Endurance', 'Tempo', 'Endurance', 'Sortie longue'],
  7: ['Récup', 'Fractionné', 'Endurance', 'Tempo', 'Endurance', 'Endurance', 'Sortie longue']
};

/* Builds a week of planned sessions sized to the athlete's recent volume,
   the chosen number of sessions and the objective. */
function buildTrainingPlan(runs, opts = {}) {
  const ref = opts.ref || new Date();
  const sessions = Math.max(1, Math.min(7, opts.sessionsPerWeek || 4));
  const obj = PLAN_OBJECTIVES[opts.objective] || PLAN_OBJECTIVES.maintien;
  const zones = estimateZones(runs, ref) || { easy: 360, threshold: 300, interval: 260 };
  const stats = periodStats(runs, ref);

  const avgDist = stats.last28.count
    ? Math.max(stats.last28.km / stats.last28.count, 4)
    : 6;
  const last90 = runs.filter(r => inLastDays(r, 90, ref));
  const longest90 = Math.max(...last90.map(r => r.distance / 1000), avgDist * 1.4);

  let longTarget = Math.min(longest90 * obj.longFactor, avgDist * 2 + 4);
  if (obj.race) longTarget = Math.min(Math.max(longTarget, obj.race * 0.7), obj.race * 1.05);

  const roles = WEEK_TEMPLATES[sessions];
  const vf = obj.volumeFactor;
  const round = v => Math.max(3, Math.round(v));

  const detail = role => {
    switch (role) {
      case 'Sortie longue':
        return { dist: round(longTarget), pace: fmtPace(zones.easy + 10),
          focus: 'Endurance, allure souple — on cherche la durée.' };
      case 'Tempo':
        return { dist: round(avgDist * vf), pace: `${fmtPace(zones.threshold)} sur les blocs`,
          focus: '15 min échauffement + 2×10 min au seuil (récup 3 min) + retour au calme.' };
      case 'Fractionné':
        return { dist: round(avgDist * 0.9 * vf), pace: `${fmtPace(zones.interval)} sur les fractions`,
          focus: '15 min échauffement + 8×400 m vite (récup 1 min) + retour au calme.' };
      case 'Récup':
        return { dist: round(avgDist * 0.6), pace: fmtPace(zones.easy + 30),
          focus: 'Footing très léger de récupération active.' };
      default:
        return { dist: round(avgDist * vf), pace: fmtPace(zones.easy),
          focus: 'Endurance fondamentale, allure conversationnelle.' };
    }
  };

  const plan = roles.map(role => {
    const d = detail(role);
    return { type: role, distance: d.dist, pace: d.pace, focus: d.focus };
  });

  const weeklyKm = plan.reduce((s, p) => s + p.distance, 0);

  return {
    objectiveLabel: obj.label,
    sessionsPerWeek: sessions,
    weeklyKm,
    sessions: plan
  };
}

/* ---------------------------------------------------------------- */
/* Run of the day                                                    */
/* ---------------------------------------------------------------- */

function suggestRun(runs, ref = new Date()) {
  const zones = estimateZones(runs, ref);

  if (!runs.length || !zones) {
    return {
      type: 'Endurance',
      title: 'Première sortie !',
      desc: "Pas encore assez de données : pars sur une sortie facile en aisance respiratoire pour poser la première brique.",
      distance: '5 km',
      pace: 'Allure conversationnelle',
      reason: 'Aucun historique récent.'
    };
  }

  const today = startOfDay(ref);
  const stats = periodStats(runs, ref);
  const last7 = sumStats(runs.filter(r => inLastDays(r, 7, ref)));
  const weeklyAvg = Math.max(stats.prev28.km / 4, 5);

  const lastRun = runs[0];
  const lastRunDay = startOfDay(new Date(lastRun.date));
  const daysSince = Math.round((today - lastRunDay) / 86400000);

  const avgDist = stats.last28.count
    ? stats.last28.km / stats.last28.count
    : last7.km / Math.max(last7.count, 1) || 6;

  const last90 = runs.filter(r => inLastDays(r, 90, ref));
  const longest90 = Math.max(...last90.map(r => r.distance / 1000), avgDist);

  const lastWasHard = paceOf(lastRun) <= zones.threshold + 10;
  const lastWasLong = lastRun.distance / 1000 >= Math.max(avgDist * 1.4, 12);

  const last7Runs = runs.filter(r => inLastDays(r, 7, ref));
  const hadQuality = last7Runs.some(r => paceOf(r) <= zones.threshold + 10);
  const hadLong = last7Runs.some(r => r.distance / 1000 >= Math.max(avgDist * 1.4, 12));

  const km = v => `${Math.round(v)} km`;

  /* Already ran today → recovery. */
  if (daysSince === 0) {
    return {
      type: 'Récup',
      title: 'Déjà couru aujourd’hui — récupère',
      desc: "Tu as déjà une sortie au compteur aujourd'hui. Si tu veux vraiment ressortir, contente-toi d'un footing de délassement très court, sinon repos complet.",
      distance: '0 – 4 km',
      pace: fmtPace(zones.easy + 30),
      reason: 'Sortie déjà enregistrée aujourd’hui.'
    };
  }

  /* Acute overload → rest. */
  if (last7.km > weeklyAvg * 1.5 && last7.km > 15) {
    return {
      type: 'Repos',
      title: 'Lève le pied',
      desc: `Tu as couru ${last7.km.toFixed(0)} km sur 7 jours contre ${weeklyAvg.toFixed(0)} km de moyenne habituelle : la charge monte trop vite. Repos ou footing très léger pour assimiler.`,
      distance: '0 – 5 km',
      pace: fmtPace(zones.easy + 30),
      reason: `Charge aiguë : ${last7.km.toFixed(0)} km / 7 j (moyenne ${weeklyAvg.toFixed(0)} km).`
    };
  }

  /* Back from a break → progressive restart. */
  if (daysSince >= 4) {
    return {
      type: 'Reprise',
      title: 'Reprise en douceur',
      desc: `${daysSince} jours sans courir : repars sur une sortie courte en endurance fondamentale, sans regarder le chrono, pour relancer la machine.`,
      distance: km(Math.max(avgDist * 0.7, 4)),
      pace: fmtPace(zones.easy),
      reason: `Dernière sortie il y a ${daysSince} jours.`
    };
  }

  /* Day after a hard or long session → easy run. */
  if (daysSince === 1 && (lastWasHard || lastWasLong)) {
    return {
      type: 'Endurance',
      title: 'Footing d’assimilation',
      desc: `Hier c'était ${lastWasLong ? 'long' : 'intense'} (${fmtKm(lastRun.distance)} km à ${fmtPace(paceOf(lastRun))}). Aujourd'hui : endurance fondamentale stricte pour encaisser la séance.`,
      distance: km(Math.max(avgDist * 0.8, 5)),
      pace: fmtPace(zones.easy),
      reason: 'Séance exigeante la veille.'
    };
  }

  /* Weekend without a recent long run → long run. */
  const dow = ref.getDay();
  if ((dow === 6 || dow === 0) && !hadLong && stats.last28.count >= 4) {
    const target = Math.min(longest90 * 1.1, avgDist * 1.8 + 2);
    return {
      type: 'Sortie longue',
      title: 'C’est le jour de la sortie longue',
      desc: `Pas de sortie longue cette semaine : profite du week-end pour construire l'endurance. Allure souple, on cherche la durée, pas la vitesse.`,
      distance: km(Math.max(target, 10)),
      pace: fmtPace(zones.easy + 10),
      reason: 'Week-end + aucune sortie longue sur 7 jours.'
    };
  }

  /* No quality this week → tempo or intervals (alternating). */
  if (!hadQuality && stats.last28.count >= 6) {
    const weekParity = Math.floor(today.getTime() / (7 * 86400000)) % 2;
    if (weekParity === 0) {
      return {
        type: 'Tempo',
        title: 'Séance seuil',
        desc: `Échauffement 15 min, puis 2 × 10 min à allure seuil (récup 3 min trot), retour au calme 10 min. C'est la séance qui fait progresser ton allure de course.`,
        distance: km(Math.max(avgDist, 8)),
        pace: `${fmtPace(zones.threshold)} sur les blocs`,
        reason: 'Aucune séance de qualité sur 7 jours.'
      };
    }
    return {
      type: 'Intervalles',
      title: 'Fractionné court',
      desc: `Échauffement 15 min, puis 8 × 400 m vite (récup 1 min trot), retour au calme 10 min. Objectif : développer la VMA et l'économie de course.`,
      distance: km(Math.max(avgDist * 0.9, 7)),
      pace: `${fmtPace(zones.interval)} sur les 400 m`,
      reason: 'Aucune séance de qualité sur 7 jours.'
    };
  }

  /* Default: aerobic base. */
  return {
    type: 'Endurance',
    title: 'Endurance fondamentale',
    desc: `Sortie classique en aisance respiratoire : c'est elle qui construit 80 % de la progression. Garde une allure où tu peux tenir une conversation.`,
    distance: km(Math.max(avgDist, 5)),
    pace: fmtPace(zones.easy),
    reason: 'Semaine équilibrée — on consolide la base aérobie.'
  };
}
