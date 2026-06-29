/* Dashboard orchestration: loads data (live sync, import cache or demo),
   runs the analysis engine and renders every section — including the
   Garmin-specific recovery metrics, the AI recommendation of the day, and
   the wellness charts (sleep, stress, Body Battery, HRV, resting HR). */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  if (!activeHasSession()) { window.location.replace('index.html'); return; }

  /* Which dashboard page is this? Set via <body data-page="…">. The dashboard is
     split across 4 pages (today / graphs / coach / perf) that share this script;
     renderAll dispatches to the right section group. */
  const PAGE = document.body.dataset.page || 'today';

  /* ---------------- Chart.js theme (graphs page only loads Chart.js) ---------------- */
  const FONT_MONO = "'JetBrains Mono', monospace";
  if (window.Chart) {
    Chart.defaults.color = '#9aa7b7';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.font.size = 11;
  }

  const ACCENT = '#00a8e8';
  const ACCENT_SOFT = 'rgba(0,168,232,0.35)';
  const BLUE = '#60a5fa';
  const GREEN = '#34d399';
  const YELLOW = '#fbbf24';
  const PURPLE = '#a78bfa';
  const TEAL = '#22d3ee';
  const RED = '#f87171';

  const charts = {};
  const RANGES = [{ label: '1M', days: 31 }, { label: '3M', days: 92 }, { label: '6M', days: 183 }, { label: '1A', days: 365 }];
  const WELLNESS_RANGES = [{ label: '7J', days: 7 }, { label: '14J', days: 14 }, { label: '30J', days: 30 }, { label: '90J', days: 90 }];

  function setupRange(container, ranges, defaultDays, onChange) {
    if (!container) return;
    container.innerHTML = ranges.map(r => `<button type="button" data-days="${r.days}"${r.days === defaultDays ? ' class="active"' : ''}>${r.label}</button>`).join('');
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(Number(btn.getAttribute('data-days')));
      });
    });
    onChange(defaultDays);
  }

  function showError(text) { const el = $('dash-status'); el.className = 'status-msg show error'; el.textContent = text; }
  function setLoader(visible, msg) { $('loader').classList.toggle('show', visible); if (msg) $('loader-msg').textContent = msg; }

  /* ---------------- Data loading ---------------- */

  async function loadData(forceSync) {
    if (isActiveDemo()) {
      const d = demoData();
      return { athlete: d.athlete, activities: d.activities, wellness: d.wellness, snapshot: d.snapshot };
    }
    if (isActiveImport()) {
      const profile = getActiveProfile();
      return {
        athlete: getCachedAthlete() || { name: profile.name || 'Athlète' },
        activities: getCachedActivities() || [],
        wellness: getCachedWellness(),
        snapshot: getCachedSnapshot()
      };
    }
    // live
    let activities = getCachedActivities();
    if (!activities || forceSync) {
      setLoader(true, 'Récupération de tes données Garmin… (ça peut prendre ~1 min)');
      await syncLive();
    }
    return {
      athlete: getCachedAthlete() || { name: (getActiveProfile() || {}).name || 'Athlète' },
      activities: getCachedActivities() || [],
      wellness: getCachedWellness(),
      snapshot: getCachedSnapshot()
    };
  }

  /* ---------------- Header ---------------- */

  function renderSwitcher(athlete) {
    if (isActiveDemo()) $('demo-badge').hidden = false;
    if (isActiveImport()) { $('refresh-btn').textContent = '↻ Mettre à jour'; $('refresh-btn').title = 'Réimporter un export plus récent'; }

    const select = $('profile-select');
    const profiles = getProfiles();
    const activeId = getActiveId();
    select.innerHTML = profiles.map(p => `<option value="${p.id}"${p.id === activeId ? ' selected' : ''}>${p.name || 'Athlète'}</option>`).join('');
    select.onchange = () => { setActiveId(select.value); window.location.reload(); };

    const avatarUrl = athlete && athlete.avatar;
    if (avatarUrl) { const img = $('profile-avatar'); img.src = avatarUrl; img.hidden = false; }
    else $('profile-avatar').hidden = true;
  }

  function markActiveNav() {
    const link = document.querySelector(`.dash-nav [data-nav="${PAGE}"]`);
    if (link) link.classList.add('active');
  }

  /* ---------------- Daily session (recovery + workout + weather) ---------------- */

  /* One merged card: the recovery verdict (ring + level) drives the colour, the
     concrete workout (suggestRun) fills the body, and the weather adds a one-liner
     plus, in extreme heat with no good window, an override toward shifting/resting. */
  function renderDaily(runs, wellness, snapshot, weatherAnalysis) {
    const reco = buildRecommendation(runs, wellness, snapshot);
    const sug = suggestRun(runs);
    const card = $('reco-card');
    card.setAttribute('data-level', reco.level);
    $('reco-score').textContent = reco.recovery;
    $('reco-ring').style.setProperty('--p', reco.recovery);
    $('sug-type').textContent = sug.type;
    $('sug-title').textContent = sug.title;
    $('sug-desc').textContent = sug.desc;
    $('sug-distance').textContent = sug.distance;
    $('sug-pace').textContent = sug.pace;
    $('sug-reason').textContent = sug.reason;
    $('reco-line').textContent = `🔋 Récup ${reco.recovery}/100 — ${reco.title}`;

    const wEl = $('daily-weather');
    if (weatherAnalysis) {
      const w = weatherAnalysis;
      wEl.hidden = false;
      wEl.textContent = w.discourage ? `${w.icon} ${w.advice}` : w.oneLiner;
      wEl.setAttribute('data-verdict', w.verdict);
    } else {
      wEl.hidden = true;
    }
  }

  /* ---------------- Key metrics ---------------- */

  function metricCard(cls, icon, label, value, sub) {
    return `<div class="metric-card ${cls}">
      <span class="metric-icon">${icon}</span>
      <p class="metric-label">${label}</p>
      <p class="metric-value">${value}</p>
      <p class="metric-sub">${sub || ''}</p>
    </div>`;
  }

  function renderMetrics(runs, wellness, snapshot) {
    const grid = $('metric-grid');
    const cards = [];
    const today = latestWellness(wellness) || {};
    const w7 = wellnessStats(wellness, 7);

    if (today.training_readiness && today.training_readiness.score != null) {
      const lvl = today.training_readiness.level || '';
      cards.push(metricCard('c-vo2', '🤖', 'Training Readiness', `${today.training_readiness.score}<small>/100</small>`, lvl ? lvl.toLowerCase() : 'aujourd’hui'));
    }
    if (today.body_battery && today.body_battery.high != null) {
      cards.push(metricCard('c-battery', '🔋', 'Body Battery', `${today.body_battery.high}<small>/100</small>`, `bas ${today.body_battery.low ?? '–'} · auj.`));
    }
    const lastSleep = latestWellness(wellness, 'sleep');
    if (lastSleep && lastSleep.sleep) {
      const h = (lastSleep.sleep.total || 0) / 3600;
      cards.push(metricCard('c-sleep', '😴', 'Dernier sommeil', lastSleep.sleep.score != null ? `${lastSleep.sleep.score}<small>/100</small>` : `${h.toFixed(1)}<small> h</small>`, `${h.toFixed(1)} h de sommeil`));
    }
    if (w7.stress != null) cards.push(metricCard('c-stress', '🌡️', 'Stress (7 j)', `${Math.round(w7.stress)}<small>/100</small>`, 'moyenne 7 jours'));
    if (w7.restingHr != null) cards.push(metricCard('c-rhr', '❤️', 'FC de repos (7 j)', `${Math.round(w7.restingHr)}<small> bpm</small>`, 'moyenne 7 jours'));

    const vo2 = snapshot.vo2max_running || (runs.find(r => r.vo2max) || {}).vo2max;
    if (vo2) cards.push(metricCard('c-vo2', '🫀', 'VO2max course', `${Math.round(vo2)}`, snapshot.fitness_age ? `âge forme ${Math.round(snapshot.fitness_age)} ans` : 'ml/kg/min'));

    const hrv = latestWellness(wellness, 'hrv');
    if (hrv && hrv.hrv && hrv.hrv.weekly_avg != null) cards.push(metricCard('c-hrv', '📈', 'HRV', `${hrv.hrv.weekly_avg}<small> ms</small>`, (hrv.hrv.status || '').toLowerCase() || 'moy. semaine'));

    if (snapshot.training_status) cards.push(metricCard('c-vo2', '⚙️', 'Training Status', `<span class="metric-status">${String(snapshot.training_status).replace(/_/g, ' ').toLowerCase()}</span>`, 'statut Garmin'));

    grid.innerHTML = cards.join('') || '<p class="metric-sub">Pas de métriques de récupération dans ces données.</p>';
  }

  /* ---------------- Weather & run windows ---------------- */

  function rangeChip(label, cls) { return `<span class="weather-window ${cls}">${label}</span>`; }
  function fmtWin([a, b]) { return `${a}h–${b + 1}h`; }

  /* Renders the dedicated weather card. `weather` is the normalized forecast (or
     null), `analysis` the run-window analysis (or null). When no city is set, the
     card shows an inline "set city" form. Returns nothing; re-fetches on demand. */
  function renderWeatherCard(weather, analysis) {
    const card = $('weather-card');
    const empty = $('weather-empty');
    const body = $('weather-body');
    const city = Weather.getCity();

    if (!city || !weather) {
      card.setAttribute('data-state', 'empty');
      empty.hidden = false;
      body.hidden = true;
      $('weather-city-input').value = city || '';
      return;
    }

    card.setAttribute('data-state', analysis ? analysis.verdict : 'ok');
    empty.hidden = true;
    body.hidden = false;
    $('weather-place').textContent = weather.label || city;
    const now = weather.now && weather.now.temp != null ? Math.round(weather.now.temp) : '–';
    $('weather-temp').innerHTML = `${now}<small>°C</small>`;
    const max = weather.tempMax != null ? Math.round(weather.tempMax) : null;
    const min = weather.tempMin != null ? Math.round(weather.tempMin) : null;
    $('weather-range').textContent = (max != null && min != null) ? `max ${max}° · min ${min}°` : '';

    $('weather-advice').innerHTML = analysis ? `${analysis.icon} ${analysis.advice}` : '';

    const windows = $('weather-windows');
    if (analysis) {
      const chips = [];
      analysis.bestWindows.forEach(w => chips.push(rangeChip(`✅ ${fmtWin(w)}`, 'good')));
      analysis.rainWindows.forEach(w => chips.push(rangeChip(`🌧️ ${fmtWin(w)}`, 'rain')));
      analysis.hotWindows.forEach(w => chips.push(rangeChip(`🥵 ${fmtWin(w)}`, 'hot')));
      windows.innerHTML = chips.length ? chips.join('') : '<span class="weather-window">Pas de créneau franc aujourd’hui.</span>';
    } else {
      windows.innerHTML = '';
    }
  }

  /* Loads weather for the active profile and renders both the weather card and the
     daily-session weather line. Tolerant: any failure leaves the rest intact. */
  async function loadAndRenderWeather(runs, wellness, snapshot) {
    let weather = null, analysis = null;
    try {
      weather = await Weather.fetchToday();
      analysis = Weather.analyzeForRun(weather);
    } catch (err) {
      const msg = $('weather-msg');
      if (msg && Weather.getCity()) msg.textContent = err.message === 'city-not-found'
        ? '❌ Ville introuvable — vérifie l’orthographe.'
        : '⚠️ Météo indisponible pour le moment.';
    }
    renderWeatherCard(weather, analysis);
    // refresh the daily card's weather line now that we have data
    const wEl = $('daily-weather');
    if (analysis) { wEl.hidden = false; wEl.textContent = analysis.discourage ? `${analysis.icon} ${analysis.advice}` : analysis.oneLiner; wEl.setAttribute('data-verdict', analysis.verdict); }
  }

  function wireWeatherControls(onCityChange) {
    const submit = () => {
      const v = $('weather-city-input').value.trim();
      if (!v) return;
      $('weather-msg').textContent = '';
      Weather.setCity(v);
      onCityChange();
    };
    $('weather-city-btn').addEventListener('click', submit);
    $('weather-city-input').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    $('weather-change-city').addEventListener('click', () => {
      $('weather-card').setAttribute('data-state', 'empty');
      $('weather-empty').hidden = false;
      $('weather-body').hidden = true;
      $('weather-city-input').value = Weather.getCity();
      $('weather-city-input').focus();
    });
  }

  /* ---------------- KPIs ---------------- */

  function kpiCard(period, stats, sub) {
    return `<div class="kpi-card">
      <p class="kpi-period">${period}</p>
      <p class="kpi-value">${stats.km.toFixed(1).replace('.', ',')} <small>km</small></p>
      <p class="kpi-sub">${stats.count} sortie${stats.count > 1 ? 's' : ''} · ${fmtDuration(stats.time)} · ${Math.round(stats.elev)} m D+${sub || ''}</p>
    </div>`;
  }

  function renderKpis(runs) {
    const stats = periodStats(runs);
    const delta = stats.prev28.km > 0 ? ((stats.last28.km - stats.prev28.km) / stats.prev28.km) * 100 : 0;
    const deltaHtml = stats.prev28.km > 0 ? `<br /><span class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)} %</span> vs 4 semaines précédentes` : '';
    $('kpi-grid').innerHTML = kpiCard('Cette semaine', stats.week) + kpiCard('4 dernières semaines', stats.last28, deltaHtml) + kpiCard(`Année ${new Date().getFullYear()}`, stats.year) + kpiCard('Au total', stats.total);
  }

  /* ---------------- Condition ---------------- */

  function renderCondition(runs) {
    const st = fitnessStatus(runs);
    const card = $('condition-card');
    $('cond-score').textContent = st.score;
    $('cond-label').textContent = st.label;
    $('cond-advice').textContent = st.advice;
    $('cond-form').textContent = st.form >= 0 ? `+${st.form.toFixed(1)} (frais)` : `${st.form.toFixed(1)} (chargé)`;
    $('cond-trend').textContent = st.trend >= 0 ? '▲ en hausse' : '▼ en baisse';
    let tone = 'ok';
    if (/fatigue|repos/i.test(st.label)) tone = 'warn';
    else if (/affûté|progression/i.test(st.label)) tone = 'good';
    else if (/construction|désentra/i.test(st.label)) tone = 'build';
    card.setAttribute('data-tone', tone);
  }

  /* ---------------- Auto signals / load & risk / correlations ---------------- */

  function renderInsights(runs, wellness, snapshot) {
    const list = autoInsights(runs, wellness, snapshot);
    const sec = $('insights-section');
    if (!list.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('insights-list').innerHTML = list.map(s => `<span class="insight-chip" data-tone="${s.tone}">${s.icon} ${s.text}</span>`).join('');
  }

  function renderLoadRisk(runs, wellness) {
    const a = acwr(runs);
    const risk = overtrainingRisk(runs, wellness);
    const sec = $('load-section');
    if (!a && !risk) { sec.hidden = true; return; }
    sec.hidden = false;

    const acwrCard = $('acwr-card');
    if (a) {
      acwrCard.hidden = false;
      acwrCard.setAttribute('data-tone', a.tone);
      $('acwr-ratio').textContent = a.ratio.toFixed(2);
      $('acwr-zone').textContent = a.zone;
      $('acwr-advice').textContent = a.advice;
      $('acwr-acute').textContent = Math.round(a.acute);
      $('acwr-chronic').textContent = Math.round(a.chronic);
    } else acwrCard.hidden = true;

    const riskCard = $('risk-card');
    if (risk) {
      riskCard.hidden = false;
      riskCard.setAttribute('data-tone', risk.tone);
      $('risk-score').textContent = risk.score;
      $('risk-level').textContent = risk.level;
      $('risk-factors').innerHTML = risk.factors.map(f => `<li>${f}</li>`).join('');
    } else riskCard.hidden = true;
  }

  function renderCorrelations(activities, wellness) {
    const corr = correlations(activities, wellness);
    const sec = $('corr-section');
    if (!corr.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('corr-grid').innerHTML = corr.map(c => {
      const tone = Math.abs(c.r) >= 0.5 ? 'strong' : Math.abs(c.r) >= 0.3 ? 'mod' : 'weak';
      const pct = Math.round(Math.abs(c.r) * 100);
      const sign = c.r >= 0 ? '+' : '−';
      return `<div class="corr-card" data-tone="${tone}">
        <p class="corr-label">${c.label}</p>
        <p class="corr-r">${sign}${Math.abs(c.r).toFixed(2)}</p>
        <div class="corr-bar"><div class="corr-bar-fill" style="width:${pct}%"></div></div>
        <p class="corr-text">${c.text} · ${c.n} jours</p>
      </div>`;
    }).join('');
  }

  /* ---------------- Charts: axes helper ---------------- */

  const timeAxis = {
    type: 'linear', grid: { display: false },
    ticks: { maxTicksLimit: 6, font: { family: FONT_MONO, size: 10 }, callback: v => new Date(v).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) }
  };

  /* ---------------- Progression charts ---------------- */

  function renderWeeklyChart(runs, days) {
    const nWeeks = Math.max(4, Math.ceil(days / 7));
    const weeks = weeklySeries(runs, nWeeks);
    if (charts.weekly) charts.weekly.destroy();
    charts.weekly = new Chart($('weekly-chart'), {
      type: 'bar',
      data: { labels: weeks.map(w => w.label), datasets: [{ label: 'km', data: weeks.map(w => Number(w.km.toFixed(1))), backgroundColor: weeks.map((_, i) => (i === weeks.length - 1 ? ACCENT : ACCENT_SOFT)), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} km — ${weeks[ctx.dataIndex].count} sortie(s)` } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 13, font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'km / semaine' } } } }
    });
  }

  function renderFitnessChart(runs, days) {
    const series = fitnessSeries(runs, days);
    const labels = series.map(p => p.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));
    if (charts.fitness) charts.fitness.destroy();
    charts.fitness = new Chart($('fitness-chart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Forme (CTL)', data: series.map(p => Number(p.fitness.toFixed(1))), borderColor: ACCENT, backgroundColor: 'rgba(0,168,232,0.08)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.3 },
        { label: 'Fatigue (ATL)', data: series.map(p => Number(p.fatigue.toFixed(1))), borderColor: RED, pointRadius: 0, borderWidth: 1.5, tension: 0.3 },
        { label: 'Fraîcheur (TSB)', data: series.map(p => Number(p.form.toFixed(1))), borderColor: GREEN, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, tension: 0.3 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 7, font: { family: FONT_MONO, size: 10 } } }, y: { title: { display: true, text: 'charge' } } } }
    });
  }

  function renderPaceChart(runs, days) {
    const { points, rolling } = paceTrend(runs, days);
    if (charts.pace) charts.pace.destroy();
    charts.pace = new Chart($('pace-chart'), {
      type: 'scatter',
      data: { datasets: [
        { label: 'Sortie', data: points.map(p => ({ x: p.date.getTime(), y: p.pace / 60, name: p.name, km: p.km })), backgroundColor: ACCENT_SOFT, pointRadius: 3.5 },
        { type: 'line', label: 'Moyenne glissante', data: rolling.map(p => ({ x: p.date.getTime(), y: p.pace / 60 })), borderColor: YELLOW, pointRadius: 0, borderWidth: 2, tension: 0.35 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } }, tooltip: { callbacks: { label: ctx => { const r = ctx.raw; const pace = fmtPace(r.y * 60); return r.name ? ` ${r.name} — ${r.km.toFixed(1)} km à ${pace}` : ` ${pace}`; } } } }, scales: { x: timeAxis, y: { reverse: true, title: { display: true, text: 'allure (min/km)' }, ticks: { callback: v => { const m = Math.floor(v), s = Math.round((v - m) * 60); return `${m}:${String(s).padStart(2, '0')}`; } } } } }
    });
  }

  function renderVo2Chart(runs, days) {
    const pool = withinDays(runs, days).filter(r => r.vo2max).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    if (charts.vo2) charts.vo2.destroy();
    charts.vo2 = new Chart($('vo2-chart'), {
      type: 'line',
      data: { datasets: [{ label: 'VO2max', data: pool.map(r => ({ x: new Date(r.date).getTime(), y: r.vo2max })), borderColor: ACCENT, backgroundColor: 'rgba(0,168,232,0.08)', fill: true, pointRadius: 2, borderWidth: 2, tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` VO2max ${ctx.parsed.y.toFixed(1)}` } } }, scales: { x: timeAxis, y: { title: { display: true, text: 'ml/kg/min' } } } }
    });
  }

  function renderHeatmap(runs, days) {
    const cells = calendarSeries(runs, days);
    const container = $('heatmap');
    container.innerHTML = '';
    const firstDow = (cells[0].date.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) { const pad = document.createElement('span'); pad.style.visibility = 'hidden'; pad.className = 'cell'; container.appendChild(pad); }
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

  /* ---------------- Wellness charts ---------------- */

  function renderSleepChart(wellness, days) {
    const series = sleepStageSeries(wellness, days);
    const labels = series.map(s => s.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));
    if (charts.sleep) charts.sleep.destroy();
    charts.sleep = new Chart($('sleep-chart'), {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Profond', data: series.map(s => Number(s.deep.toFixed(2))), backgroundColor: '#3b2f8f' },
        { label: 'Léger', data: series.map(s => Number(s.light.toFixed(2))), backgroundColor: PURPLE },
        { label: 'Paradoxal', data: series.map(s => Number(s.rem.toFixed(2))), backgroundColor: TEAL },
        { label: 'Éveil', data: series.map(s => Number(s.awake.toFixed(2))), backgroundColor: '#33404f' }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label} : ${ctx.parsed.y.toFixed(1)} h` } } }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, font: { family: FONT_MONO, size: 10 } } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'heures' } } } }
    });
  }

  /* Generic daily wellness line (points + rolling avg). */
  function wellnessLine(key, canvasId, wellness, days, accessor, label, color, yTitle) {
    const { points, rolling } = wellnessSeries(wellness, days, accessor);
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart($(canvasId), {
      type: 'scatter',
      data: { datasets: [
        { label, data: points.map(p => ({ x: p.date.getTime(), y: Number(p.value.toFixed(1)) })), backgroundColor: color, pointRadius: 2.5 },
        { type: 'line', label: 'Tendance', data: rolling.map(p => ({ x: p.date.getTime(), y: Number(p.value.toFixed(1)) })), borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.35 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} ${yTitle}` } } }, scales: { x: timeAxis, y: { title: { display: true, text: yTitle } } } }
    });
  }

  function renderBatteryChart(wellness, days) {
    const hi = wellnessSeries(wellness, days, w => w.body_battery && w.body_battery.high).points;
    const lo = wellnessSeries(wellness, days, w => w.body_battery && w.body_battery.low).points;
    if (charts.battery) charts.battery.destroy();
    charts.battery = new Chart($('battery-chart'), {
      type: 'line',
      data: { datasets: [
        { label: 'Max', data: hi.map(p => ({ x: p.date.getTime(), y: p.value })), borderColor: GREEN, backgroundColor: 'rgba(52,211,153,0.10)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.3 },
        { label: 'Min', data: lo.map(p => ({ x: p.date.getTime(), y: p.value })), borderColor: YELLOW, pointRadius: 0, borderWidth: 1.5, tension: 0.3 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } }, scales: { x: timeAxis, y: { beginAtZero: true, max: 100, title: { display: true, text: 'Body Battery' } } } }
    });
  }

  function renderHrvChart(wellness, days) {
    const weekly = wellnessSeries(wellness, days, w => w.hrv && w.hrv.weekly_avg).points;
    const night = wellnessSeries(wellness, days, w => w.hrv && w.hrv.last_night_avg).points;
    if (charts.hrv) charts.hrv.destroy();
    charts.hrv = new Chart($('hrv-chart'), {
      type: 'line',
      data: { datasets: [
        { label: 'Dernière nuit', data: night.map(p => ({ x: p.date.getTime(), y: p.value })), borderColor: TEAL, pointRadius: 1.5, borderWidth: 1.5, tension: 0.3 },
        { label: 'Moy. semaine', data: weekly.map(p => ({ x: p.date.getTime(), y: p.value })), borderColor: ACCENT, backgroundColor: 'rgba(0,168,232,0.08)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.3 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } }, scales: { x: timeAxis, y: { title: { display: true, text: 'HRV (ms)' } } } }
    });
  }

  /* ---------------- Advanced charts ---------------- */

  function renderZonesChart(runs, days) {
    const zones = paceZoneDistribution(runs, days);
    if (charts.zones) charts.zones.destroy();
    charts.zones = new Chart($('zones-chart'), {
      type: 'doughnut',
      data: { labels: zones.map(z => z.label), datasets: [{ data: zones.map(z => z.seconds), backgroundColor: zones.map(z => z.color), borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => ` ${ctx.label} : ${fmtDuration(ctx.parsed)} (${zones[ctx.dataIndex].pct} %)` } } } }
    });
  }

  const SPORT_COLORS = ['#00a8e8', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#94a3b8', '#22d3ee'];

  function renderSportChart(activities, days) {
    const sports = sportBreakdown(activities, days);
    if (charts.sport) charts.sport.destroy();
    charts.sport = new Chart($('sport-chart'), {
      type: 'doughnut',
      data: { labels: sports.map(s => s.label), datasets: [{ data: sports.map(s => s.seconds), backgroundColor: SPORT_COLORS, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => ` ${ctx.label} : ${fmtDuration(ctx.parsed)}` } } } }
    });
  }

  function renderEfficiencyChart(runs, days) {
    const { points, rolling } = efficiencySeries(runs, days);
    if (charts.eff) charts.eff.destroy();
    charts.eff = new Chart($('eff-chart'), {
      type: 'scatter',
      data: { datasets: [
        { label: 'Sortie', data: points.map(p => ({ x: p.date.getTime(), y: p.ef })), backgroundColor: 'rgba(96,165,250,0.4)', pointRadius: 3 },
        { type: 'line', label: 'Tendance', data: rolling.map(p => ({ x: p.date.getTime(), y: p.ef })), borderColor: GREEN, borderWidth: 2, pointRadius: 0, tension: 0.35 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } }, tooltip: { callbacks: { label: ctx => ` efficience ${ctx.parsed.y.toFixed(2)} m/battement` } } }, scales: { x: timeAxis, y: { title: { display: true, text: 'm / battement (↑ = mieux)' } } } }
    });
  }

  function renderHrPaceChart(runs, days) {
    const pts = hrPaceScatter(runs, days);
    if (charts.hrpace) charts.hrpace.destroy();
    charts.hrpace = new Chart($('hrpace-chart'), {
      type: 'scatter',
      data: { datasets: [{ label: 'Sortie', data: pts.map(p => ({ x: p.pace, y: p.hr, km: p.km })), backgroundColor: 'rgba(0,168,232,0.45)', pointRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw.km.toFixed(1)} km — ${fmtPace(ctx.raw.x * 60)} · ${Math.round(ctx.raw.y)} bpm` } } }, scales: { x: { title: { display: true, text: 'allure (min/km)' }, reverse: true, ticks: { callback: v => { const m = Math.floor(v), s = Math.round((v - m) * 60); return `${m}:${String(s).padStart(2, '0')}`; } } }, y: { title: { display: true, text: 'FC moyenne (bpm)' } } } }
    });
  }

  function renderCadenceChart(runs, days) {
    const { points, rolling } = cadenceSeries(runs, days);
    if (charts.cadence) charts.cadence.destroy();
    charts.cadence = new Chart($('cadence-chart'), {
      type: 'scatter',
      data: { datasets: [
        { label: 'Sortie', data: points.map(p => ({ x: p.date.getTime(), y: p.cadence })), backgroundColor: 'rgba(251,191,36,0.4)', pointRadius: 3 },
        { type: 'line', label: 'Moyenne glissante', data: rolling.map(p => ({ x: p.date.getTime(), y: p.cadence })), borderColor: YELLOW, borderWidth: 2, pointRadius: 0, tension: 0.35 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } }, tooltip: { callbacks: { label: ctx => ` ${Math.round(ctx.parsed.y)} pas/min` } } }, scales: { x: timeAxis, y: { title: { display: true, text: 'cadence (pas/min)' } } } }
    });
  }

  function renderDistanceChart(runs, days) {
    const buckets = distanceDistribution(runs, days);
    if (charts.distrib) charts.distrib.destroy();
    charts.distrib = new Chart($('distrib-chart'), {
      type: 'bar',
      data: { labels: buckets.map(b => b.label + ' km'), datasets: [{ data: buckets.map(b => b.count), backgroundColor: ACCENT_SOFT, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} sortie(s)` } } }, scales: { x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'nb de sorties' } } } }
    });
  }

  function renderWeekdayChart(runs, days) {
    const wd = weekdayDistribution(runs, days);
    if (charts.weekday) charts.weekday.destroy();
    charts.weekday = new Chart($('weekday-chart'), {
      type: 'bar',
      data: { labels: wd.map(d => d.label), datasets: [{ data: wd.map(d => Number(d.km.toFixed(1))), backgroundColor: ACCENT_SOFT, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} km — ${wd[ctx.dataIndex].count} sortie(s)` } } }, scales: { x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 11 } } }, y: { beginAtZero: true, title: { display: true, text: 'km cumulés' } } } }
    });
  }

  function renderEffortChart(runs, days) {
    const weeks = weeklyEffort(runs, Math.max(4, Math.ceil(days / 7)));
    if (charts.effort) charts.effort.destroy();
    charts.effort = new Chart($('effort-chart'), {
      type: 'bar',
      data: { labels: weeks.map(w => w.label), datasets: [{ data: weeks.map(w => Math.round(w.effort)), backgroundColor: 'rgba(0,168,232,0.5)', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` charge ${ctx.parsed.y}` } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 13, font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'charge / sem.' } } } }
    });
  }

  /* Aerobic vs anaerobic Training Effect, stacked per week + focus caption. */
  function renderTeChart(runs, days) {
    const bal = trainingEffectBalance(runs, days);
    const caption = $('te-focus');
    if (!bal.hasData) {
      caption.textContent = 'Données de Training Effect indisponibles dans cet export.';
      if (charts.te) { charts.te.destroy(); charts.te = null; }
      return;
    }
    caption.textContent = `${bal.focus.label} · ${Math.round(bal.anaeroPct)}% anaérobie — ${bal.focus.advice}`;
    if (charts.te) charts.te.destroy();
    charts.te = new Chart($('te-chart'), {
      type: 'bar',
      data: { labels: bal.weeks.map(w => w.label), datasets: [
        { label: 'Aérobie', data: bal.weeks.map(w => Math.round(w.aerobic * 10) / 10), backgroundColor: 'rgba(0,168,232,0.55)', borderRadius: 4 },
        { label: 'Anaérobie', data: bal.weeks.map(w => Math.round(w.anaerobic * 10) / 10), backgroundColor: 'rgba(248,113,113,0.6)', borderRadius: 4 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label} : ${ctx.parsed.y}` } } }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 13, font: { family: FONT_MONO, size: 10 } } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Training Effect cumulé' } } } }
    });
  }

  function renderElevChart(runs, days) {
    const data = monthlyAggregate(runs, days, r => r.elev);
    if (charts.elev) charts.elev.destroy();
    charts.elev = new Chart($('elev-chart'), {
      type: 'bar',
      data: { labels: data.map(d => d.label), datasets: [{ data: data.map(d => Math.round(d.value)), backgroundColor: ACCENT_SOFT, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toLocaleString('fr-FR')} m D+` } } }, scales: { x: { grid: { display: false }, ticks: { font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'm D+' } } } }
    });
  }

  /* Weekly intensity minutes from wellness. */
  function renderIntensityChart(wellness, days) {
    const start = addDays(startOfWeek(new Date()), -7 * (Math.max(1, Math.ceil(days / 7)) - 1));
    const weeks = [];
    for (let s = new Date(start); s <= new Date(); s = addDays(s, 7)) {
      const end = addDays(s, 7);
      const mins = wellness.filter(w => { const d = new Date(w.date); return d >= s && d < end; }).reduce((acc, w) => acc + (w.intensity_minutes || 0), 0);
      weeks.push({ label: s.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }), mins });
    }
    if (charts.intensity) charts.intensity.destroy();
    charts.intensity = new Chart($('intensity-chart'), {
      type: 'bar',
      data: { labels: weeks.map(w => w.label), datasets: [{ data: weeks.map(w => Math.round(w.mins)), backgroundColor: 'rgba(52,211,153,0.5)', borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} min intensives` } } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 13, font: { family: FONT_MONO, size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'min / semaine' } } } }
    });
  }

  /* ---------------- Records / goal / plan / activities ---------------- */

  function renderRecords(runs) {
    const records = computeRecords(runs);
    $('records-grid').innerHTML = records.length
      ? records.map(r => `<div class="record-card"><span class="trophy">${r.icon}</span><p class="record-name">${r.name}</p><p class="record-value">${r.value}</p><p class="record-detail">${r.detail}</p></div>`).join('')
      : '<p class="metric-sub">Pas encore assez de courses pour calculer des records.</p>';
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

  /* ---------------- Race goal, projections & best efforts ---------------- */

  function parseClock(str) {
    if (!str) return 0;
    const parts = String(str).trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return 0;
    return parts.reduce((a, p) => a * 60 + p, 0);
  }

  function raceCard(label, time, pace, extra) {
    const paceStr = pace ? `${fmtPace(pace)} /km` : '';
    return `<div class="race-card${time ? '' : ' empty'}">
      <p class="race-card-dist">${label}</p>
      <p class="race-card-time">${time || '–'}</p>
      <p class="race-card-sub">${time ? paceStr : 'pas assez de données'}${extra ? ` · ${extra}` : ''}</p>
    </div>`;
  }

  function renderRaceBoards(runs) {
    $('race-predict-cards').innerHTML = racePredictions(runs)
      .map(p => raceCard(p.label, p.time, p.pace)).join('');
    $('race-best-cards').innerHTML = bestEfforts(runs)
      .map(b => raceCard(b.label, b.time, b.pace, b.date ? fmtDate(b.date) : '')).join('');
  }

  function getRaceGoal() {
    const km = Number(Profile.get(PKEY.raceKm));
    const date = Profile.get(PKEY.raceDate);
    if (!km || !date) return null;
    return { km, date, targetSeconds: parseClock(Profile.get(PKEY.raceTarget)) };
  }

  function renderRaceGoal(runs) {
    const card = $('race-goal-card');
    const setEl = $('race-goal-set');
    const readout = $('race-goal-readout');
    const goal = getRaceGoal();
    const status = goal ? raceGoalStatus(runs, goal) : null;

    if (status) {
      setEl.hidden = true;
      readout.hidden = false;
      const distLabel = STD_RACES.find(r => Math.abs(r.km - goal.km) < 0.01)?.label || `${goal.km} km`;
      const daysTxt = status.days > 0 ? `J−${status.days}` : status.days === 0 ? 'Jour J' : 'terminée';
      const ot = status.onTrack;
      readout.innerHTML = `
        <div class="race-goal-main">
          <span class="race-goal-countdown" data-phase="${status.phase.key}">${daysTxt}</span>
          <div>
            <p class="race-goal-name">${distLabel}${status.targetStr ? ` · objectif ${status.targetStr}` : ''}</p>
            <p class="race-goal-phase">${status.phase.label}</p>
          </div>
          <button class="btn btn-ghost btn-sm" id="race-goal-edit">Modifier</button>
        </div>
        <div class="suggestion-meta">
          <span class="pill"><span class="pill-label">Projection</span><span>${status.predictedStr || '–'}</span></span>
          ${ot ? `<span class="pill race-ot" data-tone="${ot.tone}"><span class="pill-label">Faisabilité</span><span>${ot.label}</span></span>` : ''}
        </div>
        ${ot ? `<p class="race-goal-detail">${ot.detail}</p>` : ''}`;
      $('race-goal-edit').addEventListener('click', () => { setEl.hidden = false; readout.hidden = true; });
    } else {
      setEl.hidden = false;
      readout.hidden = true;
    }
  }

  function wireRaceGoal(runs) {
    const kmSelect = $('race-goal-km');
    const customField = $('race-goal-customkm');
    const goal = getRaceGoal();
    if (goal) {
      const std = ['5', '10', '21.0975', '42.195'].includes(String(goal.km));
      kmSelect.value = std ? String(goal.km) : 'custom';
      customField.hidden = std;
      if (!std) $('race-goal-customkm-input').value = goal.km;
      $('race-goal-date').value = goal.date;
      $('race-goal-target').value = Profile.get(PKEY.raceTarget) || '';
    }
    kmSelect.addEventListener('change', () => { customField.hidden = kmSelect.value !== 'custom'; });
    $('race-goal-save').addEventListener('click', () => {
      const km = kmSelect.value === 'custom' ? Number($('race-goal-customkm-input').value) : Number(kmSelect.value);
      const date = $('race-goal-date').value;
      if (!km || !date) { return; }
      Profile.set(PKEY.raceKm, String(km));
      Profile.set(PKEY.raceDate, date);
      Profile.set(PKEY.raceTarget, $('race-goal-target').value.trim());
      renderRaceGoal(runs);
    });
  }

  function renderRace(runs) {
    renderRaceBoards(runs);
    wireRaceGoal(runs);
    renderRaceGoal(runs);
  }

  /* ---------------- Weather vs performance (async) ---------------- */

  async function loadWeatherPerformance(runs) {
    const section = $('temppace-section');
    if (!Weather.getCity()) { section.hidden = true; return; }
    let tempMap = null;
    try { tempMap = await Weather.fetchRunTemps(getActiveId(), runs); }
    catch { section.hidden = true; return; }

    const analysis = tempPaceAnalysis(runs, tempMap);
    if (!analysis || analysis.n < 6) { section.hidden = true; return; }

    section.hidden = false;
    $('temppace-note').textContent = analysis.takeaway || `${analysis.n} sorties avec température connue`;
    if (charts.temppace) charts.temppace.destroy();
    charts.temppace = new Chart($('temppace-chart'), {
      type: 'scatter',
      data: { datasets: [{ label: 'Sortie', data: analysis.points.map(p => ({ x: p.temp, y: p.pace / 60, km: p.km })), backgroundColor: 'rgba(0,168,232,0.45)', pointRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw.km.toFixed(1)} km — ${fmtPace(ctx.raw.y * 60)} à ${Math.round(ctx.raw.x)}°C` } } }, scales: { x: { title: { display: true, text: 'température (°C)' } }, y: { title: { display: true, text: 'allure (min/km)' }, ticks: { callback: v => { const m = Math.floor(v), s = Math.round((v - m) * 60); return `${m}:${String(s).padStart(2, '0')}`; } } } } }
    });
  }

  function renderActivities(activities) {
    const tbody = $('activities-body');
    const moreBtn = $('more-activities-btn');
    const canDetail = isActiveLive() && Boolean($('act-modal'));   // detail needs a session token
    let shown = 0;
    const STEP = 15;
    function row(act) {
      const run = isRun(act);
      const pace = run ? fmtPace(paceOf(act)) : '–';
      const attrs = canDetail ? ` class="act-row" data-aid="${act.id}" title="Voir le détail"` : '';
      return `<tr${attrs}><td>${fmtDate(act.date)}</td><td class="act-name">${act.name}</td><td><span class="act-type-badge ${run ? '' : 'other'}">${act.type}</span></td><td>${fmtKm(act.distance)} km</td><td>${fmtDuration(act.moving_time)}</td><td>${pace}</td><td>${Math.round(act.elev || 0)} m</td><td>${act.avg_hr ? Math.round(act.avg_hr) + ' bpm' : '–'}</td><td>${act.vo2max ? Math.round(act.vo2max) : '–'}</td></tr>`;
    }
    function showMore() { const next = activities.slice(shown, shown + STEP); tbody.insertAdjacentHTML('beforeend', next.map(row).join('')); shown += next.length; moreBtn.hidden = shown >= activities.length; }
    moreBtn.addEventListener('click', showMore);
    showMore();

    if (canDetail) {
      tbody.addEventListener('click', e => {
        const tr = e.target.closest('.act-row');
        if (!tr) return;
        const act = activities.find(a => String(a.id) === tr.getAttribute('data-aid'));
        if (act) openActivityModal(act);
      });
      setupActivityModal();
    }
  }

  /* ---------------- Activity detail modal (live: splits, HR zones, GPS) ---------------- */

  const HR_ZONES = [
    { color: '#9aa7b7', name: 'Z1 · Récup' },
    { color: '#60a5fa', name: 'Z2 · Endurance' },
    { color: '#34d399', name: 'Z3 · Tempo' },
    { color: '#fbbf24', name: 'Z4 · Seuil' },
    { color: '#f87171', name: 'Z5 · VO2max' }
  ];

  let modalWired = false;
  function setupActivityModal() {
    if (modalWired) return;
    modalWired = true;
    $('act-modal-close').addEventListener('click', closeActivityModal);
    $('act-modal-backdrop').addEventListener('click', closeActivityModal);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('act-modal').hidden) closeActivityModal(); });
  }

  function closeActivityModal() {
    $('act-modal').hidden = true;
    document.body.style.overflow = '';
  }

  function showActMsg(text) { const m = $('act-modal-msg'); m.textContent = text; m.hidden = false; }

  async function openActivityModal(act) {
    const modal = $('act-modal');
    $('act-modal-title').textContent = act.name || 'Sortie';
    $('act-modal-sub').textContent = `${fmtDate(act.date)} · ${fmtKm(act.distance)} km · ${fmtDuration(act.moving_time)}${isRun(act) ? ` · ${fmtPace(paceOf(act))}` : ''}`;
    $('act-modal-content').hidden = true;
    $('act-modal-msg').hidden = true;
    $('act-modal-loading').hidden = false;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    try {
      const detail = await getActivityDetail(act.id);
      $('act-modal-loading').hidden = true;
      const hasTrack = detail.track && detail.track.length > 1;
      const hasZones = detail.hr_zones && detail.hr_zones.some(z => z.secs > 0);
      const hasSplits = detail.splits && detail.splits.length > 0;
      if (!hasTrack && !hasZones && !hasSplits) { showActMsg('Pas de détail disponible pour cette activité.'); return; }
      $('act-modal-content').hidden = false;
      drawTrack(detail.track);
      renderHrZones(detail.hr_zones);
      renderSplits(detail.splits);
    } catch (err) {
      $('act-modal-loading').hidden = true;
      showActMsg(err.message || 'Erreur de chargement du détail.');
    }
  }

  function renderHrZones(zones) {
    const block = $('act-hrzones-block');
    const valid = (zones || []).filter(z => z.zone >= 1 && z.zone <= 5 && z.secs > 0);
    const total = valid.reduce((s, z) => s + z.secs, 0);
    if (!total) { block.hidden = true; return; }
    block.hidden = false;
    $('hrzone-bar').innerHTML = valid.map(z => {
      const c = HR_ZONES[z.zone - 1];
      return `<span class="hrzone-seg" style="width:${(z.secs / total * 100).toFixed(1)}%;background:${c.color}" title="${c.name}"></span>`;
    }).join('');
    $('hrzone-legend').innerHTML = valid.map(z => {
      const c = HR_ZONES[z.zone - 1];
      return `<span class="hrzone-leg"><span class="hrzone-dot" style="background:${c.color}"></span>${c.name} · ${fmtDuration(z.secs)} (${Math.round(z.secs / total * 100)}%)</span>`;
    }).join('');
  }

  function renderSplits(splits) {
    const block = $('act-splits-block');
    if (!splits || !splits.length) { block.hidden = true; return; }
    block.hidden = false;
    const paces = splits.map(s => s.pace).filter(Boolean);
    const fast = Math.min(...paces), slow = Math.max(...paces);
    const width = p => (slow === fast ? 100 : 100 - ((p - fast) / (slow - fast)) * 55);   // faster → longer bar
    $('splits-list').innerHTML = splits.map(s => {
      const label = s.partial ? `${s.km}` : `${s.km}`;
      const hr = s.avg_hr ? `${s.avg_hr} bpm` : '';
      return `<div class="split-row${s.partial ? ' partial' : ''}">
        <span class="split-km">${label}<small>km</small></span>
        <span class="split-bar-wrap"><span class="split-bar" style="width:${width(s.pace).toFixed(0)}%"></span></span>
        <span class="split-pace">${fmtPace(s.pace)}<small>/km</small></span>
        <span class="split-hr">${hr}</span>
      </div>`;
    }).join('');
  }

  /* Draws a GPS track on a canvas — no map library. Equirectangular projection
     with longitude compressed by cos(latitude); fits + centres with padding. */
  function drawTrack(track) {
    const wrap = $('act-map-wrap');
    const canvas = $('act-map-canvas');
    if (!track || track.length < 2) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth || 600;
    const cssH = wrap.clientHeight || 240;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    track.forEach(([la, lo]) => { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); });
    const kx = Math.cos((minLat + maxLat) / 2 * Math.PI / 180) || 1;   // lon compression
    const pad = 16;
    const spanX = Math.max((maxLon - minLon) * kx, 1e-6);
    const spanY = Math.max(maxLat - minLat, 1e-6);
    const scale = Math.min((cssW - 2 * pad) / spanX, (cssH - 2 * pad) / spanY);
    const offX = (cssW - spanX * scale) / 2;
    const offY = (cssH - spanY * scale) / 2;
    const px = lo => offX + (lo - minLon) * kx * scale;
    const py = la => cssH - (offY + (la - minLat) * scale);            // invert Y (north up)

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.lineWidth = 3; ctx.strokeStyle = '#00a8e8'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    track.forEach(([la, lo], i) => { const x = px(lo), y = py(la); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    const dot = (la, lo, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px(lo), py(la), 4.5, 0, Math.PI * 2); ctx.fill(); };
    dot(track[0][0], track[0][1], '#34d399');                          // start
    dot(track[track.length - 1][0], track[track.length - 1][1], '#f87171');  // finish
  }

  /* ---------------- Render all ---------------- */

  function renderAll(data) {
    const activities = data.activities || [];
    const wellness = data.wellness || [];
    const snapshot = data.snapshot || {};
    const runs = runsOnly(activities);

    renderSwitcher(data.athlete);
    markActiveNav();

    if (PAGE === 'today') renderTodayPage(runs, wellness, snapshot, activities);
    else if (PAGE === 'coach') renderCoachPage(activities, wellness, snapshot);
    else if (PAGE === 'graphs') renderGraphsPage(runs, wellness, snapshot, activities);
    else if (PAGE === 'perf') renderPerfPage(runs, wellness, snapshot, activities);

    setLoader(false);
    $('dash-content').classList.add('show');
  }

  /* ---------------- Per-page render groups ---------------- */

  function renderTodayPage(runs, wellness, snapshot, activities) {
    renderDaily(runs, wellness, snapshot, null);
    renderInsights(runs, wellness, snapshot);
    renderMetrics(runs, wellness, snapshot);
    renderCondition(runs);
    renderLoadRisk(runs, wellness);
    if (window.AICoach) AICoach.mount({ activities, wellness, snapshot });   // AI tips + signal alert
    /* Weather (async): fills the weather card + the daily-session weather line. */
    wireWeatherControls(() => loadAndRenderWeather(runs, wellness, snapshot));
    loadAndRenderWeather(runs, wellness, snapshot);
  }

  function renderCoachPage(activities, wellness, snapshot) {
    if (window.AICoach) AICoach.mount({ activities, wellness, snapshot });
  }

  function renderGraphsPage(runs, wellness, snapshot, activities) {
    renderCorrelations(activities, wellness);
    loadWeatherPerformance(runs);

    /* Running progression */
    setupRange($('range-weekly'), RANGES, 183, days => renderWeeklyChart(runs, days));
    setupRange($('range-fitness'), RANGES, 183, days => renderFitnessChart(runs, days));
    setupRange($('range-pace'), RANGES, 183, days => renderPaceChart(runs, days));
    setupRange($('range-vo2'), RANGES, 365, days => renderVo2Chart(runs, days));
    setupRange($('range-heatmap'), RANGES, 365, days => renderHeatmap(runs, days));

    /* Wellness */
    const hasWellness = wellness.length > 0;
    $('recovery-section').hidden = !hasWellness;
    if (hasWellness) {
      const maxDays = Math.min(90, Math.max(7, wellness.length));
      const defDays = Math.min(30, maxDays);
      setupRange($('range-sleep'), WELLNESS_RANGES, defDays, days => renderSleepChart(wellness, days));
      setupRange($('range-sleepscore'), WELLNESS_RANGES, defDays, days => wellnessLine('sleepscore', 'sleepscore-chart', wellness, days, w => w.sleep && w.sleep.score, 'Score', PURPLE, '/100'));
      setupRange($('range-rhr'), WELLNESS_RANGES, defDays, days => wellnessLine('rhr', 'rhr-chart', wellness, days, w => w.resting_hr, 'FC repos', RED, 'bpm'));
      setupRange($('range-battery'), WELLNESS_RANGES, defDays, days => renderBatteryChart(wellness, days));
      setupRange($('range-stress'), WELLNESS_RANGES, defDays, days => wellnessLine('stress', 'stress-chart', wellness, days, w => w.stress && w.stress.avg, 'Stress', YELLOW, '/100'));
      setupRange($('range-hrv'), WELLNESS_RANGES, defDays, days => renderHrvChart(wellness, days));
      setupRange($('range-intensity'), RANGES, 92, days => renderIntensityChart(wellness, days));
    } else {
      const intensityCard = $('range-intensity') && $('range-intensity').closest('.chart-card');
      if (intensityCard) intensityCard.hidden = true;
    }

    /* Advanced */
    setupRange($('range-zones'), RANGES, 365, days => renderZonesChart(runs, days));
    setupRange($('range-sport'), RANGES, 365, days => renderSportChart(activities, days));
    setupRange($('range-eff'), RANGES, 365, days => renderEfficiencyChart(runs, days));
    setupRange($('range-hrpace'), RANGES, 365, days => renderHrPaceChart(runs, days));
    setupRange($('range-cadence'), RANGES, 365, days => renderCadenceChart(runs, days));
    setupRange($('range-effort'), RANGES, 183, days => renderEffortChart(runs, days));
    setupRange($('range-distrib'), RANGES, 365, days => renderDistanceChart(runs, days));
    setupRange($('range-weekday'), RANGES, 365, days => renderWeekdayChart(runs, days));
    setupRange($('range-elev'), RANGES, 365, days => renderElevChart(runs, days));
    setupRange($('range-te'), RANGES, 92, days => renderTeChart(runs, days));
  }

  function renderPerfPage(runs, wellness, snapshot, activities) {
    renderKpis(runs);
    renderRace(runs);
    renderRecords(runs);
    renderGoal(runs);
    renderActivities(activities);
    if (window.AICoach) AICoach.mount({ activities, wellness, snapshot });   // last-run AI comment
  }

  /* ---------------- Events ---------------- */

  $('logout-btn').addEventListener('click', () => {
    const profile = getActiveProfile();
    const label = profile ? profile.name : 'ce profil';
    if (confirm(`Déconnecter « ${label} » ? Ses données mises en cache sur ce navigateur seront effacées.`)) logoutActive();
  });

  $('refresh-btn').addEventListener('click', async () => {
    if (isActiveDemo()) { window.location.reload(); return; }
    if (isActiveImport()) { window.location.href = 'index.html?import=' + encodeURIComponent(getActiveId()); return; }
    const btn = $('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Synchronisation…';
    try { await syncLive(); window.location.reload(); }
    catch (err) { showError(err.message); btn.disabled = false; btn.textContent = '↻ Synchroniser'; }
  });

  /* ---------------- Mobile: tap a chart to enlarge it ---------------- */

  (function setupChartZoom() {
    const mq = window.matchMedia('(max-width: 640px)');
    let backdrop = null, closeBtn = null;

    function close() {
      document.querySelectorAll('.chart-card.zoomed').forEach(c => c.classList.remove('zoomed'));
      if (backdrop) { backdrop.remove(); backdrop = null; }
      if (closeBtn) { closeBtn.remove(); closeBtn = null; }
      document.body.style.overflow = '';
      window.dispatchEvent(new Event('resize'));   // let Chart.js re-fit
    }

    document.addEventListener('click', (e) => {
      if (!mq.matches) return;
      const card = e.target.closest('.chart-card');
      if (!card || card.classList.contains('zoomed')) return;          // already open: let tooltips work
      if (e.target.closest('button, a, select, .range-toggle')) return; // don't zoom when using a control

      close();
      card.classList.add('zoomed');
      backdrop = document.createElement('div');
      backdrop.className = 'chart-zoom-backdrop';
      backdrop.addEventListener('click', close);
      closeBtn = document.createElement('button');
      closeBtn.className = 'chart-zoom-close';
      closeBtn.setAttribute('aria-label', 'Fermer');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', close);
      document.body.appendChild(backdrop);
      document.body.appendChild(closeBtn);
      document.body.style.overflow = 'hidden';
      window.dispatchEvent(new Event('resize'));
    });

    if (mq.addEventListener) mq.addEventListener('change', () => { if (!mq.matches) close(); });
  })();

  /* ---------------- Boot ---------------- */

  (async function boot() {
    try {
      setLoader(true, isActiveDemo() ? 'Génération des données de démo…' : 'Chargement…');
      const data = await loadData(false);
      renderAll(data);
    } catch (err) {
      console.error(err);
      setLoader(false);
      showError(err.message || 'Erreur de chargement. Reconnecte-toi depuis la page d’accueil.');
    }
  })();
})();
