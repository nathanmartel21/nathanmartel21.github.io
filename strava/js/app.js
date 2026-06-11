/* Dashboard orchestration: loads data (Strava API or demo), runs the
   analysis engine and renders every section. */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ---------------- Guard ---------------- */

  if (!activeHasSession()) {
    window.location.replace('index.html');
    return;
  }

  /* ---------------- Chart.js theme ---------------- */

  const FONT_MONO = "'JetBrains Mono', monospace";
  Chart.defaults.color = '#a89e97';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 11;

  const ORANGE = '#fc4c02';
  const ORANGE_SOFT = 'rgba(252, 76, 2, 0.35)';
  const BLUE = '#60a5fa';
  const GREEN = '#34d399';
  const YELLOW = '#fbbf24';

  /* ---------------- Chart registry & range toggles ---------------- */

  const charts = {};
  const RANGES = [
    { label: '1M', days: 31 },
    { label: '3M', days: 92 },
    { label: '6M', days: 183 },
    { label: '1A', days: 365 }
  ];

  /* Fills a `.range-toggle` container with the 1M/3M/6M/1A buttons and
     calls `onChange(days)` on click and once for the default. */
  function setupRange(container, defaultDays, onChange) {
    if (!container) return;
    container.innerHTML = RANGES
      .map(r => `<button type="button" data-days="${r.days}"${r.days === defaultDays ? ' class="active"' : ''}>${r.label}</button>`)
      .join('');
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(Number(btn.getAttribute('data-days')));
      });
    });
    onChange(defaultDays);
  }

  /* ---------------- UI helpers ---------------- */

  function showError(text) {
    const el = $('dash-status');
    el.className = 'status-msg show error';
    el.textContent = text;
  }

  function setLoader(visible, msg) {
    $('loader').classList.toggle('show', visible);
    if (msg) $('loader-msg').textContent = msg;
  }

  /* ---------------- Data loading ---------------- */

  async function loadData(forceSync) {
    if (isActiveDemo()) {
      const demo = demoData();
      return { athlete: demo.athlete, activities: demo.activities };
    }

    if (isActiveImport()) {
      const profile = getActiveProfile();
      return {
        athlete: { firstname: profile.name || 'Athlète', lastname: '', profile_medium: profile.avatar },
        activities: getCachedActivities() || []
      };
    }

    let athlete = getCachedAthlete();
    if (!athlete || forceSync) {
      athlete = await fetchAthlete();
    }

    let activities = getCachedActivities();
    if (!activities || forceSync) {
      activities = await syncActivities(count =>
        setLoader(true, `Récupération des activités… (${count})`)
      );
    }
    return { athlete, activities };
  }

  /* ---------------- Rendering ---------------- */

  function renderSwitcher(athlete) {
    if (isActiveDemo()) $('demo-badge').hidden = false;
    if (isActiveImport()) {
      $('refresh-btn').textContent = '↻ Mettre à jour';
      $('refresh-btn').title = 'Réimporter un export Strava plus récent';
    }

    const select = $('profile-select');
    const profiles = getProfiles();
    const activeId = getActiveId();
    select.innerHTML = profiles
      .map(p => `<option value="${p.id}"${p.id === activeId ? ' selected' : ''}>${p.name || 'Athlète'}</option>`)
      .join('');
    select.onchange = () => {
      setActiveId(select.value);
      window.location.reload();
    };

    const avatarUrl = (athlete && (athlete.profile_medium || athlete.profile)) || null;
    if (avatarUrl && !String(avatarUrl).includes('avatar/athlete')) {
      const img = $('profile-avatar');
      img.src = avatarUrl;
      img.hidden = false;
    } else {
      $('profile-avatar').hidden = true;
    }
  }

  function renderSuggestion(runs) {
    const sug = suggestRun(runs);
    $('sug-type').innerHTML = `${sug.type}<small>séance du jour</small>`;
    $('sug-title').textContent = sug.title;
    $('sug-desc').textContent = sug.desc;
    $('sug-distance').textContent = sug.distance;
    $('sug-pace').textContent = sug.pace;
    $('sug-reason').textContent = sug.reason;
  }

  function kpiCard(period, stats, sub) {
    return `
      <div class="kpi-card">
        <p class="kpi-period">${period}</p>
        <p class="kpi-value">${stats.km.toFixed(1).replace('.', ',')} <small>km</small></p>
        <p class="kpi-sub">${stats.count} sortie${stats.count > 1 ? 's' : ''} · ${fmtDuration(stats.time)} · ${Math.round(stats.elev)} m D+${sub || ''}</p>
      </div>`;
  }

  function renderKpis(runs) {
    const stats = periodStats(runs);
    const delta = stats.prev28.km > 0
      ? ((stats.last28.km - stats.prev28.km) / stats.prev28.km) * 100
      : 0;
    const deltaHtml = stats.prev28.km > 0
      ? `<br /><span class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)} %</span> vs 4 semaines précédentes`
      : '';

    $('kpi-grid').innerHTML =
      kpiCard('Cette semaine', stats.week) +
      kpiCard('4 dernières semaines', stats.last28, deltaHtml) +
      kpiCard(`Année ${new Date().getFullYear()}`, stats.year) +
      kpiCard('Au total', stats.total);
  }

  function renderWeeklyChart(runs, days) {
    const nWeeks = Math.max(4, Math.ceil(days / 7));
    const weeks = weeklySeries(runs, nWeeks);
    if (charts.weekly) charts.weekly.destroy();
    charts.weekly = new Chart($('weekly-chart'), {
      type: 'bar',
      data: {
        labels: weeks.map(w => w.label),
        datasets: [{
          label: 'km',
          data: weeks.map(w => Number(w.km.toFixed(1))),
          backgroundColor: weeks.map((_, i) => (i === weeks.length - 1 ? ORANGE : ORANGE_SOFT)),
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.parsed.y} km — ${weeks[ctx.dataIndex].count} sortie(s)`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 13, font: { family: FONT_MONO, size: 10 } } },
          y: { beginAtZero: true, title: { display: true, text: 'km / semaine' } }
        }
      }
    });
  }

  function renderFitnessChart(runs, days) {
    const series = fitnessSeries(runs, days);
    const labels = series.map(p =>
      p.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    );
    if (charts.fitness) charts.fitness.destroy();
    charts.fitness = new Chart($('fitness-chart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Forme (CTL)',
            data: series.map(p => Number(p.fitness.toFixed(1))),
            borderColor: BLUE,
            backgroundColor: 'rgba(96,165,250,0.08)',
            fill: true,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.3
          },
          {
            label: 'Fatigue (ATL)',
            data: series.map(p => Number(p.fatigue.toFixed(1))),
            borderColor: ORANGE,
            pointRadius: 0,
            borderWidth: 1.5,
            tension: 0.3
          },
          {
            label: 'Fraîcheur (TSB)',
            data: series.map(p => Number(p.form.toFixed(1))),
            borderColor: GREEN,
            borderDash: [5, 4],
            pointRadius: 0,
            borderWidth: 1.5,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 7, font: { family: FONT_MONO, size: 10 } } },
          y: { title: { display: true, text: 'charge' } }
        }
      }
    });
  }

  function renderPaceChart(runs, days) {
    const { points, rolling } = paceTrend(runs, days);
    const fmt = d => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    if (charts.pace) charts.pace.destroy();
    charts.pace = new Chart($('pace-chart'), {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Sortie',
            data: points.map(p => ({ x: p.date.getTime(), y: p.pace / 60, name: p.name, km: p.km })),
            backgroundColor: ORANGE_SOFT,
            pointRadius: 3.5
          },
          {
            type: 'line',
            label: 'Moyenne glissante',
            data: rolling.map(p => ({ x: p.date.getTime(), y: p.pace / 60 })),
            borderColor: YELLOW,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.35
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { boxWidth: 14, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const raw = ctx.raw;
                const pace = fmtPace(raw.y * 60);
                return raw.name ? ` ${raw.name} — ${raw.km.toFixed(1)} km à ${pace}` : ` ${pace}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            grid: { display: false },
            ticks: {
              maxTicksLimit: 6,
              font: { family: FONT_MONO, size: 10 },
              callback: value => fmt(new Date(value))
            }
          },
          y: {
            reverse: true,
            title: { display: true, text: 'allure (min/km)' },
            ticks: {
              callback: value => {
                const m = Math.floor(value);
                const s = Math.round((value - m) * 60);
                return `${m}:${String(s).padStart(2, '0')}`;
              }
            }
          }
        }
      }
    });
  }

  function renderHeatmap(runs, days) {
    const cells = calendarSeries(runs, days);
    const container = $('heatmap');
    container.innerHTML = '';
    /* Pad so the first column starts on Monday. */
    const firstDow = (cells[0].date.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) {
      const pad = document.createElement('span');
      pad.style.visibility = 'hidden';
      pad.className = 'cell';
      container.appendChild(pad);
    }
    cells.forEach(c => {
      const span = document.createElement('span');
      let level = '';
      if (c.km > 0) level = 'l1';
      if (c.km >= 6) level = 'l2';
      if (c.km >= 11) level = 'l3';
      if (c.km >= 17) level = 'l4';
      span.className = `cell ${level}`;
      span.title = `${c.date.toLocaleDateString('fr-FR')} — ${c.km > 0 ? c.km.toFixed(1) + ' km' : 'repos'}`;
      container.appendChild(span);
    });
  }

  const timeAxis = {
    type: 'linear',
    grid: { display: false },
    ticks: {
      maxTicksLimit: 6,
      font: { family: FONT_MONO, size: 10 },
      callback: v => new Date(v).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    }
  };

  function renderZonesChart(runs, days) {
    const zones = paceZoneDistribution(runs, days);
    if (charts.zones) charts.zones.destroy();
    charts.zones = new Chart($('zones-chart'), {
      type: 'doughnut',
      data: {
        labels: zones.map(z => z.label),
        datasets: [{ data: zones.map(z => z.seconds), backgroundColor: zones.map(z => z.color), borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label} : ${fmtDuration(ctx.parsed)} (${zones[ctx.dataIndex].pct} %)` } }
        }
      }
    });
  }

  function renderHrPaceChart(runs, days) {
    const pts = hrPaceScatter(runs, days);
    if (charts.hrpace) charts.hrpace.destroy();
    charts.hrpace = new Chart($('hrpace-chart'), {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Sortie',
          data: pts.map(p => ({ x: p.pace, y: p.hr, name: p.name, km: p.km })),
          backgroundColor: 'rgba(252,76,2,0.45)',
          pointRadius: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${ctx.raw.km.toFixed(1)} km — ${fmtPace(ctx.raw.x * 60)} · ${Math.round(ctx.raw.y)} bpm` } }
        },
        scales: {
          x: { title: { display: true, text: 'allure (min/km)' }, reverse: true,
            ticks: { callback: v => { const m = Math.floor(v), s = Math.round((v - m) * 60); return `${m}:${String(s).padStart(2, '0')}`; } } },
          y: { title: { display: true, text: 'FC moyenne (bpm)' } }
        }
      }
    });
  }

  function renderEfficiencyChart(runs, days) {
    const { points, rolling } = efficiencySeries(runs, days);
    if (charts.eff) charts.eff.destroy();
    charts.eff = new Chart($('eff-chart'), {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Sortie', data: points.map(p => ({ x: p.date.getTime(), y: p.ef })), backgroundColor: 'rgba(96,165,250,0.4)', pointRadius: 3 },
          { type: 'line', label: 'Tendance', data: rolling.map(p => ({ x: p.date.getTime(), y: p.ef })), borderColor: GREEN, borderWidth: 2, pointRadius: 0, tension: 0.35 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } },
          tooltip: { callbacks: { label: ctx => ` efficience ${ctx.parsed.y.toFixed(2)} m/battement` } } },
        scales: { x: timeAxis, y: { title: { display: true, text: 'm / battement (↑ = mieux)' } } }
      }
    });
  }

  function renderCadenceChart(runs, days) {
    const { points, rolling } = cadenceSeries(runs, days);
    if (charts.cadence) charts.cadence.destroy();
    charts.cadence = new Chart($('cadence-chart'), {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Sortie', data: points.map(p => ({ x: p.date.getTime(), y: p.cadence })), backgroundColor: 'rgba(251,191,36,0.4)', pointRadius: 3 },
          { type: 'line', label: 'Moyenne glissante', data: rolling.map(p => ({ x: p.date.getTime(), y: p.cadence })), borderColor: YELLOW, borderWidth: 2, pointRadius: 0, tension: 0.35 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } },
          tooltip: { callbacks: { label: ctx => ` ${Math.round(ctx.parsed.y)} pas/min` } } },
        scales: { x: timeAxis, y: { title: { display: true, text: 'cadence (pas/min)' } } }
      }
    });
  }

  function renderDistanceChart(runs, days) {
    const buckets = distanceDistribution(runs, days);
    if (charts.distrib) charts.distrib.destroy();
    charts.distrib = new Chart($('distrib-chart'), {
      type: 'bar',
      data: { labels: buckets.map(b => b.label + ' km'), datasets: [{ data: buckets.map(b => b.count), backgroundColor: ORANGE_SOFT, borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} sortie(s)` } } },
        scales: { x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'nb de sorties' } } }
      }
    });
  }

  function monthlyBar(key, runs, days, label, color) {
    const data = monthlyAggregate(runs, days, r => r[key === 'elev' ? 'elev' : 'calories']);
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart($(`${key}-chart`), {
      type: 'bar',
      data: { labels: data.map(d => d.label), datasets: [{ data: data.map(d => Math.round(d.value)), backgroundColor: color, borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toLocaleString('fr-FR')} ${label}` } } },
        scales: { x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: label } } }
      }
    });
  }

  function renderEffortChart(runs, days) {
    const weeks = weeklyEffort(runs, Math.max(4, Math.ceil(days / 7)));
    if (charts.effort) charts.effort.destroy();
    charts.effort = new Chart($('effort-chart'), {
      type: 'bar',
      data: { labels: weeks.map(w => w.label), datasets: [{ data: weeks.map(w => Math.round(w.effort)), backgroundColor: 'rgba(239,68,68,0.5)', borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` charge ${ctx.parsed.y}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 13, font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'effort relatif / sem.' } } }
      }
    });
  }

  function renderWeekdayChart(runs, days) {
    const wd = weekdayDistribution(runs, days);
    if (charts.weekday) charts.weekday.destroy();
    charts.weekday = new Chart($('weekday-chart'), {
      type: 'bar',
      data: { labels: wd.map(d => d.label), datasets: [{ data: wd.map(d => Number(d.km.toFixed(1))), backgroundColor: ORANGE_SOFT, borderRadius: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} km — ${wd[ctx.dataIndex].count} sortie(s)` } } },
        scales: { x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 11 } } }, y: { beginAtZero: true, title: { display: true, text: 'km cumulés' } } }
      }
    });
  }

  const SPORT_COLORS = ['#fc4c02', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#94a3b8', '#22d3ee'];

  function renderSportChart(activities, days) {
    const sports = sportBreakdown(activities, days);
    if (charts.sport) charts.sport.destroy();
    charts.sport = new Chart($('sport-chart'), {
      type: 'doughnut',
      data: { labels: sports.map(s => s.label), datasets: [{ data: sports.map(s => s.seconds), backgroundColor: SPORT_COLORS, borderWidth: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label} : ${fmtDuration(ctx.parsed)}` } }
        }
      }
    });
  }

  function renderRecords(runs) {
    const records = computeRecords(runs);
    $('records-grid').innerHTML = records.length
      ? records.map(r => `
          <div class="record-card">
            <span class="trophy">${r.icon}</span>
            <p class="record-name">${r.name}</p>
            <p class="record-value">${r.value}</p>
            <p class="record-detail">${r.detail}</p>
          </div>`).join('')
      : '<p class="loading-copy">Pas encore assez de courses pour calculer des records.</p>';
  }

  function renderGoal(runs) {
    const stats = periodStats(runs);
    const defaultGoal = Math.max(Math.round(stats.prev28.km / 4) || 20, 10);
    const saved = Number(Profile.get(PKEY.weeklyGoal));
    const goal = saved > 0 ? saved : defaultGoal;

    const input = $('goal-input');
    input.value = goal;

    function update() {
      const target = Number(input.value) || defaultGoal;
      Profile.set(PKEY.weeklyGoal, String(target));
      const done = stats.week.km;
      const pct = Math.min((done / target) * 100, 100);
      $('goal-fill').style.width = `${pct}%`;
      const remaining = target - done;
      $('goal-status').textContent = remaining > 0
        ? `${done.toFixed(1).replace('.', ',')} km sur ${target} km cette semaine — plus que ${remaining.toFixed(1).replace('.', ',')} km. 💪`
        : `Objectif atteint : ${done.toFixed(1).replace('.', ',')} km sur ${target} km cette semaine ! 🎉`;
    }

    input.addEventListener('change', update);
    update();
  }

  function renderCondition(runs) {
    const st = fitnessStatus(runs);
    const card = $('condition-card');
    $('cond-score').textContent = st.score;
    $('cond-label').textContent = st.label;
    $('cond-advice').textContent = st.advice;
    $('cond-form').textContent = st.form >= 0
      ? `+${st.form.toFixed(1)} (frais)`
      : `${st.form.toFixed(1)} (chargé)`;
    $('cond-trend').textContent = st.trend >= 0 ? '▲ en hausse' : '▼ en baisse';

    /* Colour the card by broad status family. */
    let tone = 'ok';
    if (/fatigue|repos/i.test(st.label)) tone = 'warn';
    else if (/affûté|progression/i.test(st.label)) tone = 'good';
    else if (/construction|désentra/i.test(st.label)) tone = 'build';
    card.setAttribute('data-tone', tone);
  }

  /* value -> [label, raceKm or null]. Race rows carry their distance. */
  const PLAN_OBJECTIVE_OPTIONS = [
    ['forme', 'Forme générale', null],
    ['progression', 'Progression du volume', null],
    ['race5', 'Course : 5 km', 5],
    ['race10', 'Course : 10 km', 10],
    ['race21', 'Course : Semi (21,1 km)', 21.1],
    ['race42', 'Course : Marathon (42,2 km)', 42.2],
    ['racecustom', 'Course : autre distance…', 'custom']
  ];

  function planSessionCard(s, index) {
    return `
      <div class="plan-session">
        <div class="plan-session-head">
          <span class="plan-session-num">J${index + 1}</span>
          <span class="act-type-badge${/endurance|tempo|fractionn|longue|récup|allure/i.test(s.type) ? '' : ' other'}">${s.type}</span>
        </div>
        <p class="plan-session-dist">${s.distance} km</p>
        <p class="plan-session-pace">${s.pace}</p>
        <p class="plan-session-focus">${s.focus}</p>
      </div>`;
  }

  function defaultSessions(runs) {
    const stats = periodStats(runs);
    const perWeek = Math.round(stats.last28.count / 4);
    return Math.max(2, Math.min(6, perWeek || 4));
  }

  /* "45:00" or "1:45:30" or "45" -> seconds. */
  function parseTimeInput(str) {
    if (!str) return 0;
    const parts = String(str).trim().split(':').map(p => Number(p));
    if (parts.some(p => Number.isNaN(p))) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  function isRaceObjective(o) {
    return o.startsWith('race');
  }

  function renderPlan(runs) {
    const select = $('plan-objective');
    select.innerHTML = PLAN_OBJECTIVE_OPTIONS
      .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

    let sessions = Number(Profile.get(PKEY.planSessions)) || defaultSessions(runs);
    sessions = Math.max(1, Math.min(7, sessions));
    select.value = Profile.get(PKEY.planObjective) || 'forme';
    $('plan-sessions-val').textContent = sessions;
    $('plan-target-time').value = Profile.get(PKEY.planTargetTime) || '';
    $('plan-weeks').value = Profile.get(PKEY.planWeeks) || '';
    $('plan-race-km').value = Profile.get(PKEY.planRaceKm) || '';

    function raceKmFor(value) {
      const opt = PLAN_OBJECTIVE_OPTIONS.find(o => o[0] === value);
      const km = opt && opt[2];
      if (km === 'custom') return Number($('plan-race-km').value) || 0;
      return km || 0;
    }

    function syncFields(value) {
      const race = isRaceObjective(value);
      const custom = value === 'racecustom';
      $('plan-customkm-field').hidden = !custom;
      $('plan-time-field').hidden = !race;
      $('plan-weeks-field').hidden = !race;
      $('plan-race-summary').hidden = !race;
    }

    function update() {
      const s = Number($('plan-sessions-val').textContent);
      const value = select.value;
      const objective = isRaceObjective(value) ? 'race' : value;
      const raceKm = raceKmFor(value);
      const targetSeconds = parseTimeInput($('plan-target-time').value);
      const weeks = Number($('plan-weeks').value) || 0;
      const raceLabel = (PLAN_OBJECTIVE_OPTIONS.find(o => o[0] === value)?.[1] || '').replace('Course : ', '');

      Profile.set(PKEY.planSessions, String(s));
      Profile.set(PKEY.planObjective, value);
      Profile.set(PKEY.planTargetTime, $('plan-target-time').value);
      Profile.set(PKEY.planWeeks, String(weeks || ''));
      Profile.set(PKEY.planRaceKm, String($('plan-race-km').value || ''));

      syncFields(value);

      const plan = buildTrainingPlan(runs, {
        sessionsPerWeek: s, objective, raceKm, targetSeconds, weeksToRace: weeks, raceLabel
      });

      $('plan-weekly-km').textContent = plan.weeklyKm;
      $('plan-sessions').innerHTML = plan.sessions.map(planSessionCard).join('');

      if (plan.mode === 'race') {
        const needTime = !targetSeconds;
        $('plan-race-pace').textContent = needTime ? 'saisis un temps' : plan.racePaceStr;
        const feas = $('plan-feasibility');
        if (needTime) {
          $('plan-feas-label').textContent = '⏱ Temps visé requis';
          $('plan-feas-detail').textContent = 'Indique le temps que tu vises pour calculer l’allure et la prépa.';
          feas.setAttribute('data-tone', 'warn');
        } else {
          $('plan-feas-label').textContent = plan.feasibility.label
            + (plan.weeksToRace ? ` · ${plan.weeksToRace} sem. de prépa` : '');
          $('plan-feas-detail').textContent = plan.feasibility.detail;
          feas.setAttribute('data-tone', plan.feasibility.tone || 'good');
        }
      }
    }

    $('plan-minus').onclick = () => {
      $('plan-sessions-val').textContent = Math.max(1, Number($('plan-sessions-val').textContent) - 1);
      update();
    };
    $('plan-plus').onclick = () => {
      $('plan-sessions-val').textContent = Math.min(7, Number($('plan-sessions-val').textContent) + 1);
      update();
    };
    select.onchange = update;
    ['plan-target-time', 'plan-weeks', 'plan-race-km'].forEach(id => {
      $(id).addEventListener('input', update);
    });

    syncFields(select.value);
    update();
  }

  function renderActivities(activities) {
    const tbody = $('activities-body');
    const moreBtn = $('more-activities-btn');
    let shown = 0;
    const STEP = 15;

    function row(act) {
      const run = isRun(act);
      const pace = run ? fmtPace(paceOf(act)) : '–';
      return `
        <tr>
          <td>${fmtDate(act.date)}</td>
          <td class="act-name">${act.name}</td>
          <td><span class="act-type-badge ${run ? '' : 'other'}">${act.type}</span></td>
          <td>${fmtKm(act.distance)} km</td>
          <td>${fmtDuration(act.moving_time)}</td>
          <td>${pace}</td>
          <td>${Math.round(act.elev || 0)} m</td>
          <td>${act.avg_hr ? Math.round(act.avg_hr) + ' bpm' : '–'}</td>
        </tr>`;
    }

    function showMore() {
      const next = activities.slice(shown, shown + STEP);
      tbody.insertAdjacentHTML('beforeend', next.map(row).join(''));
      shown += next.length;
      moreBtn.hidden = shown >= activities.length;
    }

    moreBtn.addEventListener('click', showMore);
    showMore();
  }

  function renderAll(athlete, activities) {
    const runs = runsOnly(activities);
    renderSwitcher(athlete);
    renderSuggestion(runs);
    renderPlan(runs);
    renderKpis(runs);
    renderCondition(runs);

    /* Charts with their 1M/3M/6M/1A range toggles. */
    setupRange($('range-weekly'), 183, days => renderWeeklyChart(runs, days));
    setupRange($('range-fitness'), 183, days => renderFitnessChart(runs, days));
    setupRange($('range-pace'), 183, days => renderPaceChart(runs, days));
    setupRange($('range-heatmap'), 365, days => renderHeatmap(runs, days));
    setupRange($('range-zones'), 365, days => renderZonesChart(runs, days));
    setupRange($('range-hrpace'), 365, days => renderHrPaceChart(runs, days));
    setupRange($('range-eff'), 365, days => renderEfficiencyChart(runs, days));
    setupRange($('range-cadence'), 365, days => renderCadenceChart(runs, days));
    setupRange($('range-distrib'), 365, days => renderDistanceChart(runs, days));
    setupRange($('range-elev'), 365, days => monthlyBar('elev', runs, days, 'm D+', ORANGE_SOFT));
    setupRange($('range-calories'), 365, days => monthlyBar('calories', runs, days, 'kcal', 'rgba(251,191,36,0.5)'));
    setupRange($('range-effort'), 183, days => renderEffortChart(runs, days));
    setupRange($('range-weekday'), 365, days => renderWeekdayChart(runs, days));
    setupRange($('range-sport'), 365, days => renderSportChart(activities, days));

    renderRecords(runs);
    renderGoal(runs);
    renderActivities(activities);
    setLoader(false);
    $('dash-content').classList.add('show');
  }

  /* ---------------- Events ---------------- */

  $('logout-btn').addEventListener('click', () => {
    const profile = getActiveProfile();
    const label = profile ? profile.name : 'ce profil';
    if (confirm(`Déconnecter « ${label} » ? Ses données mises en cache sur ce navigateur seront effacées.`)) {
      logoutActive();
    }
  });

  $('refresh-btn').addEventListener('click', async () => {
    if (isActiveDemo()) {
      window.location.reload();
      return;
    }
    if (isActiveImport()) {
      window.location.href = 'index.html?import=' + encodeURIComponent(getActiveId());
      return;
    }
    const btn = $('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Synchronisation…';
    try {
      await fetchAthlete();
      await syncActivities();
      window.location.reload();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = '↻ Actualiser';
    }
  });

  /* ---------------- Boot ---------------- */

  (async function boot() {
    try {
      setLoader(true, isActiveDemo() ? 'Génération des données de démo…' : 'Chargement des activités…');
      const { athlete, activities } = await loadData(false);
      renderAll(athlete, activities);
    } catch (err) {
      console.error(err);
      setLoader(false);
      showError(err.message || 'Erreur de chargement. Reconnecte-toi depuis la page d’accueil.');
    }
  })();
})();
