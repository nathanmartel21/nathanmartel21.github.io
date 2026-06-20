/* AI coach for the Garmin Premium app.

   Same browser-side, no-backend design as the Strava coach (shared encrypted
   OpenRouter key + passphrase, or paste-your-own; SSE streaming). The
   difference is the athlete summary: it fuses the running analysis with
   Garmin's recovery data (sleep, stress, Body Battery, HRV, training
   readiness, VO2max), so the coach reasons about recovery, not just load.

   Relies on globals from config.js (Store, getActiveId) and analysis.js
   (runsOnly, periodStats, fitnessStatus, computeRecords, predictRaceTime,
   estimateZones, paceZoneDistribution, weeklySeries, wellnessStats,
   latestWellness, buildRecommendation, fmtPace, fmtClock, fmtKm, fmtDuration,
   paceOf, inLastDays). */

(function () {
  'use strict';

  const OR_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  const SS_KEY = 'ai_or_key';
  const LS_KEY = 'garmin_ai_key';
  const LS_MODEL = 'garmin_ai_model';

  const FREE_MODELS = [
    { id: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (recommandé)' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
    { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 Next 80B' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 405B' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B' }
  ];
  const DEFAULT_MODEL = FREE_MODELS[0].id;

  /* ---------------- Crypto ---------------- */

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  async function decryptKey(blob, passphrase) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBuf(blob.salt), iterations: blob.iter || 250000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(blob.iv) }, aesKey, b64ToBuf(blob.ct));
    return new TextDecoder().decode(plain);
  }

  /* ---------------- Key resolution ---------------- */

  function hasEncryptedKey() { return Boolean(window.AI_KEY_BLOB && window.AI_KEY_BLOB.ct); }
  function activeKey() { return sessionStorage.getItem(SS_KEY) || localStorage.getItem(LS_KEY) || null; }
  function setSessionKey(key) { sessionStorage.setItem(SS_KEY, key); }
  function setDeviceKey(key) { localStorage.setItem(LS_KEY, key); }
  function clearKeys() { sessionStorage.removeItem(SS_KEY); localStorage.removeItem(LS_KEY); }

  function chosenModel() {
    const stored = localStorage.getItem(LS_MODEL);
    return FREE_MODELS.some(m => m.id === stored) ? stored : DEFAULT_MODEL;
  }
  function setChosenModel(m) { localStorage.setItem(LS_MODEL, m); }

  function chatKey() {
    const id = (typeof getActiveId === 'function' && getActiveId()) || 'default';
    return `garmin_ai_chat_${id}`;
  }
  function loadTurns() { try { return JSON.parse(localStorage.getItem(chatKey())) || []; } catch { return []; } }
  function saveTurns(turns) { try { localStorage.setItem(chatKey(), JSON.stringify(turns)); } catch {} }
  function clearTurns() { localStorage.removeItem(chatKey()); }

  /* ---------------- Athlete summary ---------------- */

  function round1(v) { return Math.round(v * 10) / 10; }
  function summarizePeriod(s) { return { sorties: s.count, km: round1(s.km), duree: fmtDuration(s.time), denivele_m: Math.round(s.elev) }; }

  function buildAthleteSummary(data) {
    const activities = data.activities || [];
    const wellness = data.wellness || [];
    const snapshot = data.snapshot || {};
    const runs = runsOnly(activities);
    const ref = new Date();
    const out = { genere_le: ref.toISOString().slice(0, 10) };

    if (!runs.length && !wellness.length) {
      out.note = "Aucune donnée — propose un plan d'initiation prudent.";
      return out;
    }

    if (runs.length) {
      const ps = periodStats(runs, ref);
      out.volumes = {
        cette_semaine: summarizePeriod(ps.week),
        _28_derniers_jours: summarizePeriod(ps.last28),
        _28_jours_precedents: summarizePeriod(ps.prev28),
        cette_annee: summarizePeriod(ps.year),
        total_historique: summarizePeriod(ps.total)
      };
      out.volume_hebdo_12s = weeklySeries(runs, 12, ref).map(w => ({ semaine: w.label, km: round1(w.km), sorties: w.count }));

      const zones = estimateZones(runs, ref);
      if (zones) out.allures_estimees = { seuil: fmtPace(zones.threshold) + '/km', endurance_facile: fmtPace(zones.easy) + '/km', allure_marathon: fmtPace(zones.marathon) + '/km', fractionne: fmtPace(zones.interval) + '/km' };

      out.projections_chrono = {};
      [[5, '5 km'], [10, '10 km'], [21.1, 'semi'], [42.2, 'marathon']].forEach(([km, lbl]) => {
        const t = predictRaceTime(runs, km, ref);
        if (t) out.projections_chrono[lbl] = fmtClock(t);
      });

      const fs = fitnessStatus(runs, ref);
      out.forme_actuelle = { indice_0_100: fs.score, etat: fs.label, fraicheur_TSB: round1(fs.form), tendance_30j: round1(fs.trend), conseil_systeme: fs.advice };
      out.records = computeRecords(runs).map(r => `${r.name}: ${r.value} (${r.detail})`);

      out.sorties_recentes = [...runs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 12).map(r => ({
        date: r.date.slice(0, 10), nom: r.name, km: round1(r.distance / 1000), duree: fmtDuration(r.moving_time),
        allure: fmtPace(paceOf(r)) + '/km', fc_moy: r.avg_hr || null, vo2max: r.vo2max || null, effet_aerobie: r.te_aerobic || null
      }));
    }

    /* ---- Garmin recovery / wellness ---- */
    if (wellness.length) {
      const w7 = wellnessStats(wellness, 7, ref);
      const w28 = wellnessStats(wellness, 28, ref);
      const today = latestWellness(wellness) || {};
      out.recuperation_7j = {
        sommeil_moyen_h: w7.sleepHours != null ? round1(w7.sleepHours) : null,
        score_sommeil_moyen: w7.sleepScore != null ? Math.round(w7.sleepScore) : null,
        fc_repos_moyenne: w7.restingHr != null ? Math.round(w7.restingHr) : null,
        stress_moyen: w7.stress != null ? Math.round(w7.stress) : null,
        body_battery_max_moyen: w7.bodyBatteryHigh != null ? Math.round(w7.bodyBatteryHigh) : null,
        pas_moyens: w7.steps != null ? Math.round(w7.steps) : null
      };
      out.recuperation_28j = { fc_repos_moyenne: w28.restingHr != null ? Math.round(w28.restingHr) : null, stress_moyen: w28.stress != null ? Math.round(w28.stress) : null };
      out.etat_du_jour = {
        readiness: today.training_readiness ? today.training_readiness.score : null,
        body_battery: today.body_battery ? today.body_battery.high : null,
        derniere_nuit_score: (() => { const s = latestWellness(wellness, 'sleep'); return s && s.sleep ? s.sleep.score : null; })(),
        hrv_statut: (() => { const h = latestWellness(wellness, 'hrv'); return h && h.hrv ? h.hrv.status : null; })()
      };
    }

    out.metriques_garmin = {
      vo2max_course: snapshot.vo2max_running || null,
      vo2max_velo: snapshot.vo2max_cycling || null,
      age_forme: snapshot.fitness_age || null,
      training_status: snapshot.training_status || null
    };

    if (runs.length || wellness.length) {
      const reco = buildRecommendation(runs, wellness, snapshot, ref);
      out.reco_du_jour = { niveau: reco.level, indice_recuperation_0_100: reco.recovery, resume: reco.title };
    }

    /* ---- Data-science layer (so the AI reasons on correlations, not just raw numbers) ---- */
    if (runs.length) {
      const a = acwr(runs, ref);
      if (a) out.charge_acwr = { ratio: round1(a.ratio), zone: a.zone, charge_aigue_7j: Math.round(a.acute), charge_chronique_hebdo: Math.round(a.chronic) };
      const risk = overtrainingRisk(runs, wellness, ref);
      if (risk) out.risque_surentrainement = { score_0_100: risk.score, niveau: risk.level, facteurs: risk.factors };
    }
    if (wellness.length) {
      const corr = correlations(activities, wellness, ref);
      if (corr.length) out.correlations_perso = corr.slice(0, 5).map(c => `${c.label} : r=${c.r} (${c.strength}) — ${c.text}`);
    }
    const signals = autoInsights(runs, wellness, snapshot, ref);
    if (signals.length) out.signaux_detectes = signals.map(s => s.text);

    return out;
  }

  /* ---------------- Prompts ---------------- */

  function systemPrompt(summary) {
    return [
      "Tu es un coach sportif expert, francophone, rigoureux et bienveillant, spécialiste de la course à pied ET de la récupération.",
      "On te fournit un RÉSUMÉ STRUCTURÉ des données d'un athlète issu de sa montre Garmin :",
      "volumes et allures de course, records, projections de chrono (Riegel), indice de forme CTL/TSB,",
      "ET ses données de récupération Garmin (sommeil, stress, Body Battery, HRV, Training Readiness, VO2max).",
      "",
      "Règles :",
      "1. ANALYSE D'ABORD les données : niveau de course, volume, régularité, MAIS AUSSI l'état de récupération",
      "   (sommeil, stress, readiness, HRV). Croise charge d'entraînement et récupération.",
      "2. Si la récupération est basse (mauvais sommeil, readiness/Body Battery faibles, HRV déséquilibrée),",
      "   recommande explicitement de lever le pied, même si le plan prévoyait une grosse séance.",
      "3. Si l'athlète vise un objectif (distance + temps + semaines), évalue sa FAISABILITÉ via les projections",
      "   et le volume. Si irréaliste, dis-le et propose une cible atteignable (semaines, chrono intermédiaire, volume).",
      "4. Propose un PLAN concret semaine par semaine : pour chaque séance type, distance/durée, allure cible, objectif.",
      "   Intègre montée en charge progressive, semaines d'assimilation, affûtage, ET des jours de récup calés sur les données Garmin.",
      "5. Base TOUTES les allures sur les données réelles ci-dessous, pas sur des standards génériques.",
      "6. Reste concret et actionnable. Utilise le Markdown (titres, listes, tableaux) pour la lisibilité.",
      "",
      "DONNÉES DE L'ATHLÈTE (JSON) :",
      "```json",
      JSON.stringify(summary, null, 2),
      "```"
    ].join('\n');
  }

  function planRequestPrompt(form) {
    const lines = ["Prépare-moi un plan d'entraînement personnalisé en tenant compte de ma récupération Garmin."];
    if (form.objective) lines.push(`Objectif : ${form.objective}.`);
    if (form.raceKm) lines.push(`Distance de course : ${form.raceKm} km.`);
    if (form.targetTime) lines.push(`Temps visé : ${form.targetTime}.`);
    if (form.weeks) lines.push(`Délai avant la course : ${form.weeks} semaines.`);
    if (form.sessions) lines.push(`Séances disponibles par semaine : ${form.sessions}.`);
    if (form.notes) lines.push(`Contraintes / remarques : ${form.notes}`);
    lines.push("Évalue d'abord la faisabilité au vu de mes données (course + récupération), puis donne le plan détaillé.");
    return lines.join('\n');
  }

  /* ---------------- OpenRouter streaming ---------------- */

  async function streamChat(messages, onToken, signal, opts = {}) {
    const key = activeKey();
    if (!key) throw new Error('NO_KEY');
    const body = { model: chosenModel(), messages, stream: true, temperature: opts.temperature ?? 0.4 };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const res = await fetch(OR_ENDPOINT, {
      method: 'POST', signal,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': location.origin, 'X-Title': 'Garmin Premium - Coach IA' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch {}
      if (res.status === 401) throw new Error('Clé refusée (401). Vérifie ta clé OpenRouter.');
      if (res.status === 429) throw new Error('Quota atteint (429). Le modèle gratuit est limité (~50 req/jour) — réessaie plus tard ou change de modèle.');
      throw new Error(`Erreur OpenRouter ${res.status}. ${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', full = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try { const json = JSON.parse(payload); const delta = json.choices?.[0]?.delta?.content; if (delta) { full += delta; onToken(delta, full); } } catch {}
      }
    }
    return full;
  }

  /* ---------------- Markdown ---------------- */

  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function renderMarkdown(md) {
    const esc = escapeHtml(md);
    const lines = esc.split('\n');
    let html = '', inUl = false, inOl = false, inCode = false;
    const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
    const inline = t => t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>');
    for (let raw of lines) {
      if (/^```/.test(raw)) { if (inCode) { html += '</code></pre>'; inCode = false; } else { closeLists(); html += '<pre><code>'; inCode = true; } continue; }
      if (inCode) { html += raw + '\n'; continue; }
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeLists(); const lvl = Math.min(h[1].length + 1, 5); html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
      if (/^\s*[-*]\s+/.test(raw)) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += `<li>${inline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`; continue; }
      if (/^\s*\d+\.\s+/.test(raw)) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += `<li>${inline(raw.replace(/^\s*\d+\.\s+/, ''))}</li>`; continue; }
      if (/^\s*\|.*\|\s*$/.test(raw)) { closeLists(); if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map(c => `<span>${inline(c.trim())}</span>`).join(''); html += `<div class="md-row">${cells}</div>`; continue; }
      if (raw.trim() === '') { closeLists(); continue; }
      closeLists(); html += `<p>${inline(raw)}</p>`;
    }
    closeLists();
    if (inCode) html += '</code></pre>';
    return html;
  }

  /* ---------------- UI ---------------- */

  const $ = id => document.getElementById(id);

  function AICoach() {
    let summary = null, turns = [], busy = false, controller = null;

    function isPinned(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }

    function appendMessage(role, contentHtml) {
      const log = $('ai-chat-log');
      const wrap = document.createElement('div');
      wrap.className = `ai-msg ai-${role}`;
      const body = document.createElement('div');
      body.className = 'ai-msg-body';
      body.innerHTML = contentHtml;
      wrap.appendChild(body);
      log.appendChild(wrap);
      log.scrollTop = log.scrollHeight;
      return body;
    }

    function renderTurn(t) { appendMessage(t.role, t.role === 'user' ? escapeHtml(t.content) : renderMarkdown(t.content)); }

    async function runConversation(userText) {
      if (busy) return;
      if (!activeKey()) { showKeyGate(); return; }
      appendMessage('user', escapeHtml(userText));
      turns.push({ role: 'user', content: userText });
      saveTurns(turns);
      const messages = [{ role: 'system', content: systemPrompt(summary) }, ...turns];
      const log = $('ai-chat-log');
      const bodyEl = appendMessage('assistant', '<span class="ai-cursor">▍</span>');
      busy = true; controller = new AbortController(); setBusy(true);
      let acc = '';
      try {
        acc = await streamChat(messages, (_d, full) => { const pinned = isPinned(log); bodyEl.innerHTML = renderMarkdown(full) + '<span class="ai-cursor">▍</span>'; if (pinned) log.scrollTop = log.scrollHeight; }, controller.signal);
        bodyEl.innerHTML = renderMarkdown(acc);
        turns.push({ role: 'assistant', content: acc }); saveTurns(turns);
      } catch (err) {
        if (err.name === 'AbortError') { bodyEl.innerHTML = renderMarkdown(acc) + '<p class="ai-aborted">— interrompu —</p>'; if (acc) { turns.push({ role: 'assistant', content: acc }); saveTurns(turns); } }
        else if (err.message === 'NO_KEY') { bodyEl.remove(); turns.pop(); saveTurns(turns); showKeyGate(); }
        else { bodyEl.innerHTML = `<p class="ai-error">⚠️ ${escapeHtml(err.message)}</p>`; turns.pop(); saveTurns(turns); }
      } finally { busy = false; controller = null; setBusy(false); }
    }

    function setBusy(b) { $('ai-send').disabled = b; $('ai-plan-generate').disabled = b; $('ai-stop').hidden = !b; $('ai-input').disabled = b; }

    function showKeyGate() {
      $('ai-key-gate').hidden = false; $('ai-main').hidden = true;
      const encrypted = hasEncryptedKey();
      $('ai-pass-row').hidden = !encrypted;
      $('ai-ownkey-block').hidden = encrypted;
      if (encrypted) setTimeout(() => $('ai-pass-input').focus(), 0);
    }
    function hideKeyGate() { $('ai-key-gate').hidden = true; $('ai-main').hidden = false; }

    async function unlockWithPassphrase() {
      const pass = $('ai-pass-input').value;
      const msg = $('ai-key-msg');
      if (!pass) { msg.textContent = 'Entre ton mot de passe.'; return; }
      msg.textContent = 'Déchiffrement…';
      try {
        const key = await decryptKey(window.AI_KEY_BLOB, pass);
        if (!/^sk-or-/.test(key)) throw new Error('bad');
        setSessionKey(key); msg.textContent = ''; $('ai-pass-input').value = ''; hideKeyGate(); generateTips(false);
      } catch { msg.textContent = '❌ Mot de passe incorrect.'; }
    }

    function saveOwnKey() {
      const key = $('ai-own-key-input').value.trim();
      const msg = $('ai-key-msg');
      if (!/^sk-or-/.test(key)) { msg.textContent = 'Clé OpenRouter invalide (commence par sk-or-…).'; return; }
      setDeviceKey(key); $('ai-own-key-input').value = ''; msg.textContent = ''; hideKeyGate(); generateTips(false);
    }

    /* ---- One-shot AI briefing (proactive analysis, not the chat) ---- */
    function briefingKey() {
      const id = (typeof getActiveId === 'function' && getActiveId()) || 'default';
      const d = new Date();
      const wk = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 604800000);
      return `garmin_ai_briefing_${id}_${d.getFullYear()}w${wk}`;
    }

    const BRIEFING_PROMPT = [
      "Établis un BILAN structuré et chiffré de ma forme et de ma récupération, à partir UNIQUEMENT de mes données fournies (course + Garmin).",
      "Structure en Markdown avec ces sections :",
      "## 🩺 État de forme & récupération — sommeil, stress, HRV, Body Battery, readiness : que disent-ils ?",
      "## 📊 Charge & risque — commente l'ACWR et le score de risque de surentraînement.",
      "## 🔗 Corrélations dans MES données — interprète les corrélations perso fournies (ce qui influence vraiment ma forme).",
      "## 🎯 Plan des 7 prochains jours — 3 à 5 recommandations concrètes et chiffrées.",
      "Sois synthétique, factuel et personnalisé. Pas de généralités."
    ].join('\n');

    async function streamInto(el, userPrompt) {
      const messages = [{ role: 'system', content: systemPrompt(summary) }, { role: 'user', content: userPrompt }];
      el.innerHTML = '<span class="ai-cursor">▍</span>';
      controller = new AbortController();
      let acc = '';
      acc = await streamChat(messages, (_d, full) => { el.innerHTML = renderMarkdown(full) + '<span class="ai-cursor">▍</span>'; }, controller.signal);
      el.innerHTML = renderMarkdown(acc);
      controller = null;
      return acc;
    }

    async function generateBriefing() {
      if (busy) return;
      if (!activeKey()) { showKeyGate(); return; }
      const out = $('ai-briefing-output');
      const btn = $('ai-briefing-btn');
      busy = true; setBusy(true); btn.disabled = true; btn.textContent = '⏳ Analyse en cours…';
      try {
        const text = await streamInto(out, BRIEFING_PROMPT);
        try { localStorage.setItem(briefingKey(), text); } catch {}
      } catch (err) {
        if (err.name === 'AbortError') { /* leave what streamed */ }
        else if (err.message === 'NO_KEY') { out.innerHTML = ''; showKeyGate(); }
        else out.innerHTML = `<p class="ai-error">⚠️ ${escapeHtml(err.message)}</p>`;
      } finally {
        busy = false; setBusy(false); btn.disabled = false; btn.textContent = '✨ Générer mon bilan';
      }
    }

    /* ---- Lightweight "tips of the day" (short punchy one-liners) ---- */
    function tipsKey() {
      const id = (typeof getActiveId === 'function' && getActiveId()) || 'default';
      return `garmin_ai_tips_${id}_${new Date().toISOString().slice(0, 10)}`;
    }

    const TIPS_PROMPT = [
      "Donne EXACTEMENT 4 tips ultra-courts (max 12 mots chacun), concrets et personnalisés à mes données du moment",
      "(récupération, charge/ACWR, sommeil, stress, HRV, corrélations perso).",
      "Style punchy et stylé, comme un coach qui te glisse un conseil. UNE ligne par tip, commençant par un emoji pertinent.",
      "Aucune intro, aucune conclusion, aucun titre — juste les 4 lignes."
    ].join(' ');

    function parseTips(text) {
      return text.split('\n').map(l => l.trim())
        .filter(Boolean)
        .map(l => l.replace(/^[-*\d.)\s]+/, '').trim())
        .filter(l => l.length > 2)
        .slice(0, 4);
    }

    function renderTips(tips) {
      const wrap = $('ai-tips');
      if (!wrap) return;
      wrap.innerHTML = tips.map(t => `<div class="tip-card">${escapeHtml(t)}</div>`).join('');
    }

    async function generateTips(force) {
      const wrap = $('ai-tips');
      if (!wrap) return;
      const cached = localStorage.getItem(tipsKey());
      if (cached && !force) { try { renderTips(JSON.parse(cached)); return; } catch {} }
      if (!activeKey()) {
        wrap.innerHTML = '<div class="tip-card tip-locked">🔒 Déverrouille le coach IA (plus bas) pour tes tips du jour.</div>';
        return;
      }
      wrap.innerHTML = '<div class="tip-card tip-loading"><span class="ai-cursor">▍</span> génération de tes tips…</div>';
      const ctrl = new AbortController();
      try {
        const full = await streamChat(
          [{ role: 'system', content: systemPrompt(summary) }, { role: 'user', content: TIPS_PROMPT }],
          () => {}, ctrl.signal, { maxTokens: 240, temperature: 0.7 }
        );
        const tips = parseTips(full);
        if (tips.length) { renderTips(tips); try { localStorage.setItem(tipsKey(), JSON.stringify(tips)); } catch {} }
        else wrap.innerHTML = '<div class="tip-card tip-locked">Pas de tips cette fois — réessaie.</div>';
      } catch (err) {
        if (err.message === 'NO_KEY') wrap.innerHTML = '<div class="tip-card tip-locked">🔒 Déverrouille le coach IA pour tes tips.</div>';
        else wrap.innerHTML = `<div class="tip-card tip-locked">⚠️ ${escapeHtml(err.message)}</div>`;
      }
    }

    function readPlanForm() {
      return { objective: $('ai-plan-objective').value, raceKm: $('ai-plan-km').value.trim(), targetTime: $('ai-plan-time').value.trim(), weeks: $('ai-plan-weeks').value.trim(), sessions: $('ai-plan-sessions').value.trim(), notes: $('ai-plan-notes').value.trim() };
    }

    function mount(data) {
      summary = buildAthleteSummary(data);
      turns = loadTurns();
      $('ai-chat-log').innerHTML = '';
      turns.forEach(renderTurn);

      const sel = $('ai-model');
      sel.innerHTML = FREE_MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
      sel.value = chosenModel();
      sel.addEventListener('change', () => setChosenModel(sel.value));

      $('ai-unlock-btn').addEventListener('click', unlockWithPassphrase);
      $('ai-pass-input').addEventListener('keydown', e => { if (e.key === 'Enter') unlockWithPassphrase(); });
      $('ai-own-key-btn').addEventListener('click', saveOwnKey);
      $('ai-forget-key').addEventListener('click', () => { clearKeys(); showKeyGate(); });

      const send = () => { const text = $('ai-input').value.trim(); if (!text) return; $('ai-input').value = ''; $('ai-input').style.height = 'auto'; runConversation(text); };
      $('ai-send').addEventListener('click', send);
      $('ai-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      $('ai-input').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; });
      $('ai-stop').addEventListener('click', () => { if (controller) controller.abort(); });

      $('ai-plan-generate').addEventListener('click', () => runConversation(planRequestPrompt(readPlanForm())));
      $('ai-clear-chat').addEventListener('click', () => { if (turns.length && !confirm('Effacer toute la conversation ?')) return; $('ai-chat-log').innerHTML = ''; turns = []; clearTurns(); });

      // AI briefing (proactive analysis): restore this week's cached one, else invite to generate
      const briefingBtn = $('ai-briefing-btn');
      if (briefingBtn) {
        const cached = localStorage.getItem(briefingKey());
        if (cached) $('ai-briefing-output').innerHTML = renderMarkdown(cached);
        briefingBtn.addEventListener('click', generateBriefing);
      }

      // Lightweight tips of the day: cached → render; else auto-generate once if unlocked
      const tipsRefresh = $('ai-tips-refresh');
      if (tipsRefresh) tipsRefresh.addEventListener('click', () => generateTips(true));
      generateTips(false);

      if (activeKey()) hideKeyGate(); else showKeyGate();
    }

    return { mount };
  }

  window.AICoach = AICoach();
})();
