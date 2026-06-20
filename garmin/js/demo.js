/* Demo mode: ~18 months of plausible running history plus ~120 days of
   Garmin-style wellness (sleep, stress, Body Battery, HRV, readiness, resting
   HR, steps), so the full premium dashboard can be explored without a Garmin
   account. Deterministic (seeded PRNG). */

function demoData() {
  let seed = 1337;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  const names = {
    easy: ['Footing du soir', 'Endurance tranquille', 'Footing matinal', 'Sortie récup', 'Tour du lac'],
    tempo: ['Séance seuil', 'Tempo run', '2x10 min allure'],
    interval: ['Fractionné 8x400m', 'VMA piste', '10x30/30'],
    long: ['Sortie longue dominicale', 'Long run', 'Grande boucle']
  };
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  const activities = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeks = 78;
  let id = 1;

  /* Daily training load (km-based) keyed by yyyy-mm-dd, to drive wellness. */
  const loadByDay = new Map();

  for (let w = weeks; w >= 0; w--) {
    const progress = 1 - w / weeks;
    const baseEasyPace = 370 - 45 * progress;
    if (rand() < 0.07) continue;

    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - w * 7 - ((today.getDay() + 6) % 7));
    const nRuns = 2 + Math.floor(rand() * 2) + (progress > 0.4 ? 1 : 0);
    const usedDays = new Set();

    for (let r = 0; r < nRuns; r++) {
      let day; do { day = Math.floor(rand() * 7); } while (usedDays.has(day));
      usedDays.add(day);
      const date = new Date(weekStart);
      date.setDate(date.getDate() + day);
      date.setHours(7 + Math.floor(rand() * 12), Math.floor(rand() * 60), 0, 0);
      if (date > new Date()) continue;

      let kind = 'easy';
      if (day === 6 && rand() < 0.75) kind = 'long';
      else if (rand() < 0.3) kind = rand() < 0.5 ? 'tempo' : 'interval';

      let km, pace;
      if (kind === 'long') { km = 11 + progress * 8 + rand() * 4; pace = baseEasyPace + 5 + rand() * 15; }
      else if (kind === 'tempo') { km = 7 + progress * 3 + rand() * 2; pace = baseEasyPace - 55 + rand() * 12; }
      else if (kind === 'interval') { km = 6 + progress * 2 + rand() * 2; pace = baseEasyPace - 45 + rand() * 15; }
      else { km = 5 + progress * 3 + rand() * 3; pace = baseEasyPace + rand() * 25; }

      const distance = Math.round(km * 1000);
      const movingTime = Math.round((distance / 1000) * pace);
      const elev = Math.round(km * (2 + rand() * 12));
      const te = Math.min(5, 1.5 + (kind === 'easy' ? 0 : 1.3) + progress + rand());

      activities.push({
        id: id++,
        name: pick(names[kind]),
        type: 'Run',
        distance,
        moving_time: movingTime,
        elapsed_time: movingTime + Math.round(rand() * 120),
        elev,
        elev_loss: Math.round(elev * (0.85 + rand() * 0.3)),
        date: date.toISOString().slice(0, 19),
        avg_speed: distance / movingTime,
        max_speed: (distance / movingTime) * (1.2 + rand() * 0.3),
        avg_hr: Math.round(138 + rand() * 25 + (kind === 'easy' || kind === 'long' ? 0 : 14)),
        max_hr: Math.round(168 + rand() * 22),
        cadence: Math.round(168 + progress * 8 + (kind === 'easy' || kind === 'long' ? 0 : 6) + rand() * 4),
        calories: Math.round(km * (62 + rand() * 12)),
        effort: Math.round(km * (3 + rand() * 4)),
        vo2max: Math.round((48 + progress * 8 + rand() * 1.5) * 10) / 10,
        te_aerobic: Math.round(te * 10) / 10,
        te_anaerobic: Math.round((kind === 'interval' ? 2 + rand() * 2 : rand()) * 10) / 10,
        steps: Math.round(km * 1450 + rand() * 200),
        kudos: 0
      });

      const key = date.toISOString().slice(0, 10);
      loadByDay.set(key, (loadByDay.get(key) || 0) + km + elev / 100);
    }
  }

  activities.sort((a, b) => new Date(b.date) - new Date(a.date));

  /* ---- Wellness for the last 120 days ---- */
  const wellness = [];
  const HRV_STATUS = ['BALANCED', 'BALANCED', 'BALANCED', 'UNBALANCED', 'LOW'];
  for (let i = 119; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const load = loadByDay.get(key) || 0;
    const hard = load > 9;

    /* More load yesterday → worse recovery today. */
    const prev = new Date(d); prev.setDate(prev.getDate() - 1);
    const prevLoad = loadByDay.get(prev.toISOString().slice(0, 10)) || 0;
    const fatigue = Math.min(1, prevLoad / 14);

    const sleepTotal = Math.round((6.2 + rand() * 1.8 - fatigue * 0.4) * 3600);
    const deep = Math.round(sleepTotal * (0.16 + rand() * 0.06));
    const rem = Math.round(sleepTotal * (0.18 + rand() * 0.07));
    const awake = Math.round(sleepTotal * (0.04 + rand() * 0.04));
    const light = sleepTotal - deep - rem - awake;
    const sleepScore = Math.max(35, Math.min(95, Math.round(82 - fatigue * 22 + rand() * 14 - 7)));

    const restingHr = Math.round(46 + fatigue * 6 + rand() * 4);
    const stressAvg = Math.round(28 + fatigue * 22 + rand() * 14);
    const bbHigh = Math.max(30, Math.min(100, Math.round(92 - fatigue * 30 + rand() * 10 - 5)));
    const bbLow = Math.max(5, Math.round(bbHigh - 35 - rand() * 25));
    const readiness = Math.max(15, Math.min(100, Math.round(sleepScore * 0.5 + (100 - stressAvg) * 0.3 + bbHigh * 0.2 - fatigue * 8)));
    const readinessLevel = readiness >= 70 ? 'HIGH' : readiness >= 45 ? 'MODERATE' : 'LOW';

    wellness.push({
      date: key,
      resting_hr: restingHr,
      steps: Math.round(6000 + rand() * 9000 + load * 350),
      steps_goal: 10000,
      floors: Math.round(4 + rand() * 14),
      intensity_minutes: Math.round(load * 9),
      calories_total: Math.round(2300 + load * 90 + rand() * 250),
      sleep: { total: sleepTotal, deep, light, rem, awake, score: sleepScore, resp_avg: Math.round((13 + rand() * 3) * 10) / 10 },
      stress: { avg: stressAvg, max: Math.min(99, stressAvg + 30 + Math.round(rand() * 20)), rest_min: Math.round(200 + rand() * 200) },
      body_battery: { high: bbHigh, low: bbLow, charged: Math.round(40 + rand() * 40), drained: Math.round(40 + rand() * 40) },
      hrv: { weekly_avg: Math.round(58 + (1 - fatigue) * 18 + rand() * 6), last_night_avg: Math.round(55 + (1 - fatigue) * 22 + rand() * 8), status: hard ? 'UNBALANCED' : pick(HRV_STATUS) },
      training_readiness: { score: readiness, level: readinessLevel }
    });
  }

  const lastVo2 = activities.find(a => a.vo2max);
  return {
    athlete: { name: 'Nathan Martel (démo)', id: 'demo' },
    activities,
    wellness,
    snapshot: {
      vo2max_running: lastVo2 ? lastVo2.vo2max : 55,
      vo2max_cycling: null,
      fitness_age: 24,
      training_status: 'PRODUCTIVE',
      acute_load: 320
    }
  };
}
