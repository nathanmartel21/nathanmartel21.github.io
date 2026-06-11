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

  function renderWeeklyChart(runs) {
    const weeks = weeklySeries(runs, 26);
    new Chart($('weekly-chart'), {
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

  function renderFitnessChart(runs) {
    const series = fitnessSeries(runs, 182);
    const labels = series.map(p =>
      p.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    );
    new Chart($('fitness-chart'), {
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

  function renderPaceChart(runs) {
    const { points, rolling } = paceTrend(runs, 182);
    const fmt = d => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    new Chart($('pace-chart'), {
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

  function renderHeatmap(runs) {
    const cells = calendarSeries(runs);
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
    renderKpis(runs);
    renderWeeklyChart(runs);
    renderFitnessChart(runs);
    renderPaceChart(runs);
    renderHeatmap(runs);
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
