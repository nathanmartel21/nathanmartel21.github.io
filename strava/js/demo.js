/* Demo mode: generates ~18 months of plausible running history with a
   gentle progression, so the dashboard can be explored without
   connecting a Strava account. Deterministic (seeded PRNG). */

function demoData() {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

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

  for (let w = weeks; w >= 0; w--) {
    /* Progression: ~22 km/week 18 months ago → ~42 km/week now,
       with an easy-pace drift from 6:10 to 5:25 /km. */
    const progress = 1 - w / weeks;
    const baseEasyPace = 370 - 45 * progress;

    /* Occasional off week (holidays, illness). */
    if (rand() < 0.07) continue;

    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - w * 7 - ((today.getDay() + 6) % 7));

    const nRuns = 2 + Math.floor(rand() * 2) + (progress > 0.4 ? 1 : 0);
    const usedDays = new Set();

    for (let r = 0; r < nRuns; r++) {
      let day;
      do { day = Math.floor(rand() * 7); } while (usedDays.has(day));
      usedDays.add(day);

      const date = new Date(weekStart);
      date.setDate(date.getDate() + day);
      date.setHours(7 + Math.floor(rand() * 12), Math.floor(rand() * 60), 0, 0);
      if (date > new Date()) continue;

      let kind = 'easy';
      if (day === 6 && rand() < 0.75) kind = 'long';
      else if (rand() < 0.3) kind = rand() < 0.5 ? 'tempo' : 'interval';

      let km, pace;
      if (kind === 'long') {
        km = 11 + progress * 8 + rand() * 4;
        pace = baseEasyPace + 5 + rand() * 15;
      } else if (kind === 'tempo') {
        km = 7 + progress * 3 + rand() * 2;
        pace = baseEasyPace - 55 + rand() * 12;
      } else if (kind === 'interval') {
        km = 6 + progress * 2 + rand() * 2;
        pace = baseEasyPace - 45 + rand() * 15;
      } else {
        km = 5 + progress * 3 + rand() * 3;
        pace = baseEasyPace + rand() * 25;
      }

      const distance = Math.round(km * 1000);
      const movingTime = Math.round((distance / 1000) * pace);
      const elev = Math.round(km * (2 + rand() * 12));

      activities.push({
        id: id++,
        name: pick(names[kind]),
        type: 'Run',
        distance,
        moving_time: movingTime,
        elapsed_time: movingTime + Math.round(rand() * 120),
        elev,
        date: date.toISOString().slice(0, 19),
        avg_speed: distance / movingTime,
        max_speed: (distance / movingTime) * (1.2 + rand() * 0.3),
        avg_hr: Math.round(138 + rand() * 25 + (kind === 'easy' || kind === 'long' ? 0 : 14)),
        max_hr: Math.round(168 + rand() * 22),
        /* Cadence rises with progression and with intensity. */
        cadence: Math.round(168 + progress * 8 + (kind === 'easy' || kind === 'long' ? 0 : 6) + rand() * 4),
        calories: Math.round(km * (62 + rand() * 12)),
        effort: Math.round(km * (3 + rand() * 4)),
        gap_speed: (distance / movingTime) * (1 + elev / Math.max(distance, 1) * 6),
        avg_grade: Math.round((rand() * 2 - 0.5) * 10) / 10,
        steps: Math.round(km * 1450 + rand() * 200),
        temp: Math.round(8 + rand() * 18),
        elev_loss: Math.round(elev * (0.85 + rand() * 0.3)),
        kudos: Math.floor(rand() * 14)
      });
    }
  }

  activities.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    athlete: {
      firstname: 'Nathan',
      lastname: 'Martel (démo)',
      profile_medium: null
    },
    activities
  };
}
