/* AI coach for the Strava Premium app.

   100% browser-side, no backend. The flow is:
     1. Build a COMPACT structured summary of the athlete from the rich
        analysis already computed by analysis.js (volumes, paces, HR zones,
        records, Riegel race predictions, CTL/TSB form…) + a sample of the
        most recent runs. We never ship hundreds of raw activities — the
        summary is what the LLM "crawls" before proposing anything.
     2. Resolve the OpenRouter API key. Two paths:
        - an AES-GCM blob committed in ai-key.js, decrypted in-browser with
          a passphrase the user types (PBKDF2 250k iters). The repo is public
          so the blob is public too — only a strong passphrase + a free model
          (no monetary credit on the key) keep this sane.
        - or the user pastes their own key (stored in localStorage on their
          device, like the Strava client secret already is).
     3. Call OpenRouter's chat-completions endpoint directly (streaming SSE),
        once for the "generate plan" form and conversationally for the chat.

   This file relies on globals from config.js (Store) and analysis.js
   (runsOnly, periodStats, fitnessStatus, computeRecords, predictRaceTime,
   estimateZones, paceZoneDistribution, sportBreakdown, weeklySeries,
   fmtPace, fmtClock, fmtKm, fmtDuration, paceOf, inLastDays). */

(function () {
  'use strict';

  const OR_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  const SS_KEY = 'ai_or_key';            // sessionStorage: decrypted/active key (this tab)
  const LS_KEY = 'strava_ai_key';        // localStorage: user's own pasted key (this device)
  const LS_MODEL = 'strava_ai_model';    // localStorage: chosen model id

  const FREE_MODELS = [
    { id: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (recommandé)' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B' },
    { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 Next 80B' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 405B' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B' }
  ];
  const DEFAULT_MODEL = FREE_MODELS[0].id;

  /* ---------------------------------------------------------------- */
  /* Crypto — decrypt the committed OpenRouter key with a passphrase   */
  /* ---------------------------------------------------------------- */

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  async function decryptKey(blob, passphrase) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBuf(blob.salt), iterations: blob.iter || 250000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(blob.iv) },
      aesKey,
      b64ToBuf(blob.ct)
    );
    return new TextDecoder().decode(plain);
  }

  /* ---------------------------------------------------------------- */
  /* Key resolution                                                    */
  /* ---------------------------------------------------------------- */

  function hasEncryptedKey() {
    return Boolean(window.AI_KEY_BLOB && window.AI_KEY_BLOB.ct);
  }
  function activeKey() {
    return sessionStorage.getItem(SS_KEY) || localStorage.getItem(LS_KEY) || null;
  }
  function setSessionKey(key) { sessionStorage.setItem(SS_KEY, key); }
  function setDeviceKey(key) { localStorage.setItem(LS_KEY, key); }
  function clearKeys() { sessionStorage.removeItem(SS_KEY); localStorage.removeItem(LS_KEY); }

  function chosenModel() {
    const stored = localStorage.getItem(LS_MODEL);
    return FREE_MODELS.some(m => m.id === stored) ? stored : DEFAULT_MODEL;
  }
  function setChosenModel(m) { localStorage.setItem(LS_MODEL, m); }

  /* Conversation persistence — one stored history per athlete profile, so
     reloading the dashboard (or coming back later) keeps the discussion. */
  function chatKey() {
    const id = (typeof getActiveId === 'function' && getActiveId()) || 'default';
    return `strava_ai_chat_${id}`;
  }
  function loadTurns() {
    try { return JSON.parse(localStorage.getItem(chatKey())) || []; }
    catch { return []; }
  }
  function saveTurns(turns) {
    try { localStorage.setItem(chatKey(), JSON.stringify(turns)); } catch {}
  }
  function clearTurns() { localStorage.removeItem(chatKey()); }

  /* ---------------------------------------------------------------- */
  /* Athlete summary — what the LLM reads before answering             */
  /* ---------------------------------------------------------------- */

  function round1(v) { return Math.round(v * 10) / 10; }

  function summarizePeriod(s) {
    return {
      sorties: s.count,
      km: round1(s.km),
      duree: fmtDuration(s.time),
      denivele_m: Math.round(s.elev)
    };
  }

  function buildAthleteSummary(activities) {
    const runs = runsOnly(activities);
    const ref = new Date();
    const out = { genere_le: ref.toISOString().slice(0, 10) };

    if (!runs.length) {
      out.note = "Aucune course dans les données — propose un plan d'initiation prudent.";
      return out;
    }

    const ps = periodStats(runs, ref);
    out.volumes = {
      cette_semaine: summarizePeriod(ps.week),
      _28_derniers_jours: summarizePeriod(ps.last28),
      _28_jours_precedents: summarizePeriod(ps.prev28),
      cette_annee: summarizePeriod(ps.year),
      total_historique: summarizePeriod(ps.total)
    };

    /* Weekly volume, last 12 weeks (oldest→newest). */
    out.volume_hebdo_12s = weeklySeries(runs, 12, ref).map(w => ({
      semaine: w.label, km: round1(w.km), sorties: w.count
    }));

    const zones = estimateZones(runs, ref);
    if (zones) {
      out.allures_estimees = {
        seuil: fmtPace(zones.threshold) + '/km',
        endurance_facile: fmtPace(zones.easy) + '/km',
        allure_marathon: fmtPace(zones.marathon) + '/km',
        fractionne: fmtPace(zones.interval) + '/km'
      };
    }

    out.projections_chrono = {};
    [[5, '5 km'], [10, '10 km'], [21.1, 'semi'], [42.2, 'marathon']].forEach(([km, lbl]) => {
      const t = predictRaceTime(runs, km, ref);
      if (t) out.projections_chrono[lbl] = fmtClock(t);
    });

    const fs = fitnessStatus(runs, ref);
    out.forme_actuelle = {
      indice_0_100: fs.score,
      etat: fs.label,
      fraicheur_TSB: round1(fs.form),
      tendance_30j: round1(fs.trend),
      conseil_systeme: fs.advice
    };

    out.records = computeRecords(runs).map(r => `${r.name}: ${r.value} (${r.detail})`);

    const zd = paceZoneDistribution(runs, 365, ref);
    if (zd && zd.length) {
      out.repartition_intensite_1an = zd.map(z => `${z.label}: ${z.pct}%`);
    }

    const last90 = runs.filter(r => inLastDays(r, 90, ref));
    out.plus_longues_sorties_90j = [...last90]
      .sort((a, b) => b.distance - a.distance)
      .slice(0, 3)
      .map(r => `${fmtKm(r.distance)} km en ${fmtDuration(r.moving_time)} (${fmtPace(paceOf(r))}/km)`);

    const sb = sportBreakdown(activities, 365, ref);
    if (sb && sb.length) {
      const totalSec = sb.reduce((s, x) => s + x.seconds, 0) || 1;
      out.multisport_1an = sb.map(x => `${x.label}: ${Math.round((x.seconds / totalSec) * 100)}%`);
    }

    /* Sample of the 15 most recent runs so the LLM sees real sessions. */
    out.sorties_recentes = [...runs]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 15)
      .map(r => ({
        date: r.date.slice(0, 10),
        nom: r.name,
        km: round1(r.distance / 1000),
        duree: fmtDuration(r.moving_time),
        allure: fmtPace(paceOf(r)) + '/km',
        fc_moy: r.avg_hr || null,
        denivele_m: Math.round(r.elev || 0)
      }));

    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Prompts                                                           */
  /* ---------------------------------------------------------------- */

  function systemPrompt(summary) {
    return [
      "Tu es un coach de course à pied expert, francophone, rigoureux et bienveillant.",
      "On te fournit ci-dessous un RÉSUMÉ STRUCTURÉ des données d'entraînement réelles de l'athlète",
      "(volumes, allures estimées, zones d'intensité, records, projections de chrono de type Riegel,",
      "indice de forme CTL/TSB, et un échantillon de sorties récentes).",
      "",
      "Règles :",
      "1. ANALYSE D'ABORD les données : commente brièvement le niveau actuel, le volume, la régularité,",
      "   les points forts et les limites avant toute recommandation.",
      "2. Si l'athlète vise un objectif (distance + temps + nombre de semaines), évalue sa FAISABILITÉ",
      "   à partir des projections de chrono et du volume actuel. Si c'est irréaliste dans le délai donné,",
      "   dis-le clairement et RECOMMANDE une cible atteignable : nombre de semaines nécessaire,",
      "   chrono intermédiaire réaliste, ou volume hebdo à atteindre d'abord.",
      "3. Propose ensuite un PLAN concret : structure semaine par semaine (ou bloc par bloc si beaucoup",
      "   de semaines), avec pour chaque séance le type, la distance/durée, l'allure cible et l'objectif.",
      "   Inclus montée en charge progressive, semaines d'assimilation, et affûtage avant la course.",
      "4. Base TOUTES les allures sur les données réelles ci-dessous, pas sur des standards génériques.",
      "5. Reste concret et actionnable. Utilise le Markdown (titres, listes, tableaux) pour la lisibilité.",
      "",
      "DONNÉES DE L'ATHLÈTE (JSON) :",
      "```json",
      JSON.stringify(summary, null, 2),
      "```"
    ].join('\n');
  }

  function planRequestPrompt(form) {
    const lines = ["Prépare-moi un plan d'entraînement personnalisé."];
    if (form.objective) lines.push(`Objectif : ${form.objective}.`);
    if (form.raceKm) lines.push(`Distance de course : ${form.raceKm} km.`);
    if (form.targetTime) lines.push(`Temps visé : ${form.targetTime}.`);
    if (form.weeks) lines.push(`Délai avant la course : ${form.weeks} semaines.`);
    if (form.sessions) lines.push(`Séances disponibles par semaine : ${form.sessions}.`);
    if (form.notes) lines.push(`Contraintes / remarques : ${form.notes}`);
    lines.push("Évalue d'abord la faisabilité au vu de mes données, puis donne le plan détaillé.");
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- */
  /* OpenRouter streaming call                                         */
  /* ---------------------------------------------------------------- */

  async function streamChat(messages, onToken, signal) {
    const key = activeKey();
    if (!key) throw new Error('NO_KEY');

    const res = await fetch(OR_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'Strava Premium - Coach IA'
      },
      body: JSON.stringify({
        model: chosenModel(),
        messages,
        stream: true,
        temperature: 0.4
      })
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
    let buffer = '';
    let full = '';

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
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onToken(delta, full); }
        } catch { /* keepalive / partial */ }
      }
    }
    return full;
  }

  /* ---------------------------------------------------------------- */
  /* Tiny Markdown renderer (headings, bold, lists, code, tables)      */
  /* ---------------------------------------------------------------- */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdown(md) {
    const esc = escapeHtml(md);
    const lines = esc.split('\n');
    let html = '';
    let inUl = false, inOl = false, inCode = false;
    const closeLists = () => {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    };
    const inline = t => t
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

    for (let raw of lines) {
      if (/^```/.test(raw)) {
        if (inCode) { html += '</code></pre>'; inCode = false; }
        else { closeLists(); html += '<pre><code>'; inCode = true; }
        continue;
      }
      if (inCode) { html += raw + '\n'; continue; }

      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeLists(); const lvl = Math.min(h[1].length + 1, 5); html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }

      if (/^\s*[-*]\s+/.test(raw)) {
        if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
        html += `<li>${inline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(raw)) {
        if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
        html += `<li>${inline(raw.replace(/^\s*\d+\.\s+/, ''))}</li>`;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        // collected below; simple fallback: render as preformatted row
        closeLists();
        if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; // separator row
        const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map(c => `<span>${inline(c.trim())}</span>`).join('');
        html += `<div class="md-row">${cells}</div>`;
        continue;
      }
      if (raw.trim() === '') { closeLists(); continue; }
      closeLists();
      html += `<p>${inline(raw)}</p>`;
    }
    closeLists();
    if (inCode) html += '</code></pre>';
    return html;
  }

  /* ---------------------------------------------------------------- */
  /* UI                                                                */
  /* ---------------------------------------------------------------- */

  const $ = id => document.getElementById(id);

  function AICoach() {
    let summary = null;
    let turns = [];            // persisted user/assistant turns (no system msg)
    let busy = false;
    let controller = null;

    /* True when the log is scrolled (near) the bottom — used so streaming
       doesn't yank the view down while the user scrolls up to read. */
    function isPinned(el) {
      return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    }

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

    function renderTurn(t) {
      appendMessage(t.role, t.role === 'user' ? escapeHtml(t.content) : renderMarkdown(t.content));
    }

    async function runConversation(userText) {
      if (busy) return;
      const key = activeKey();
      if (!key) { showKeyGate(); return; }

      appendMessage('user', escapeHtml(userText));
      turns.push({ role: 'user', content: userText });
      saveTurns(turns);

      const messages = [{ role: 'system', content: systemPrompt(summary) }, ...turns];
      const log = $('ai-chat-log');
      const bodyEl = appendMessage('assistant', '<span class="ai-cursor">▍</span>');
      busy = true;
      controller = new AbortController();
      setBusy(true);

      let acc = '';
      try {
        acc = await streamChat(messages, (_d, full) => {
          const pinned = isPinned(log);
          bodyEl.innerHTML = renderMarkdown(full) + '<span class="ai-cursor">▍</span>';
          if (pinned) log.scrollTop = log.scrollHeight;
        }, controller.signal);
        bodyEl.innerHTML = renderMarkdown(acc);
        turns.push({ role: 'assistant', content: acc });
        saveTurns(turns);
      } catch (err) {
        if (err.name === 'AbortError') {
          bodyEl.innerHTML = renderMarkdown(acc) + '<p class="ai-aborted">— interrompu —</p>';
          if (acc) { turns.push({ role: 'assistant', content: acc }); saveTurns(turns); }
        } else if (err.message === 'NO_KEY') {
          bodyEl.remove(); turns.pop(); saveTurns(turns); showKeyGate();
        } else {
          bodyEl.innerHTML = `<p class="ai-error">⚠️ ${escapeHtml(err.message)}</p>`;
          turns.pop(); saveTurns(turns); // drop the unanswered user turn
        }
      } finally {
        busy = false; controller = null; setBusy(false);
      }
    }

    function setBusy(b) {
      $('ai-send').disabled = b;
      $('ai-plan-generate').disabled = b;
      $('ai-stop').hidden = !b;
      $('ai-input').disabled = b;
    }

    /* ---- Key gate ---- */
    function showKeyGate() {
      $('ai-key-gate').hidden = false;
      $('ai-main').hidden = true;
      const encrypted = hasEncryptedKey();
      // With an embedded encrypted key: show ONLY the passphrase field.
      // Without one: hide the passphrase field, offer the paste-your-own path.
      $('ai-pass-row').hidden = !encrypted;
      $('ai-ownkey-block').hidden = encrypted;
      if (encrypted) setTimeout(() => $('ai-pass-input').focus(), 0);
    }
    function hideKeyGate() {
      $('ai-key-gate').hidden = true;
      $('ai-main').hidden = false;
    }

    async function unlockWithPassphrase() {
      const pass = $('ai-pass-input').value;
      const msg = $('ai-key-msg');
      if (!pass) { msg.textContent = 'Entre ton mot de passe.'; return; }
      msg.textContent = 'Déchiffrement…';
      try {
        const key = await decryptKey(window.AI_KEY_BLOB, pass);
        if (!/^sk-or-/.test(key)) throw new Error('bad');
        setSessionKey(key);
        msg.textContent = '';
        $('ai-pass-input').value = '';
        hideKeyGate();
      } catch {
        msg.textContent = '❌ Mot de passe incorrect.';
      }
    }

    function saveOwnKey() {
      const key = $('ai-own-key-input').value.trim();
      const msg = $('ai-key-msg');
      if (!/^sk-or-/.test(key)) { msg.textContent = 'Clé OpenRouter invalide (commence par sk-or-…).'; return; }
      setDeviceKey(key);
      $('ai-own-key-input').value = '';
      msg.textContent = '';
      hideKeyGate();
    }

    /* ---- Plan form ---- */
    function readPlanForm() {
      return {
        objective: $('ai-plan-objective').value,
        raceKm: $('ai-plan-km').value.trim(),
        targetTime: $('ai-plan-time').value.trim(),
        weeks: $('ai-plan-weeks').value.trim(),
        sessions: $('ai-plan-sessions').value.trim(),
        notes: $('ai-plan-notes').value.trim()
      };
    }

    function mount(activities) {
      summary = buildAthleteSummary(activities);

      // restore the saved conversation for the active profile
      turns = loadTurns();
      $('ai-chat-log').innerHTML = '';
      turns.forEach(renderTurn);

      // model selector (changing model keeps the conversation)
      const sel = $('ai-model');
      sel.innerHTML = FREE_MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
      sel.value = chosenModel();
      sel.addEventListener('change', () => setChosenModel(sel.value));

      // key gate buttons
      $('ai-unlock-btn').addEventListener('click', unlockWithPassphrase);
      $('ai-pass-input').addEventListener('keydown', e => { if (e.key === 'Enter') unlockWithPassphrase(); });
      $('ai-own-key-btn').addEventListener('click', saveOwnKey);
      $('ai-forget-key').addEventListener('click', () => { clearKeys(); showKeyGate(); });

      // chat
      const send = () => {
        const text = $('ai-input').value.trim();
        if (!text) return;
        $('ai-input').value = '';
        $('ai-input').style.height = 'auto';
        runConversation(text);
      };
      $('ai-send').addEventListener('click', send);
      $('ai-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
      $('ai-input').addEventListener('input', e => {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
      });
      $('ai-stop').addEventListener('click', () => { if (controller) controller.abort(); });

      // plan form — appends to the ongoing conversation
      $('ai-plan-generate').addEventListener('click', () => {
        runConversation(planRequestPrompt(readPlanForm()));
      });
      $('ai-clear-chat').addEventListener('click', () => {
        if (turns.length && !confirm('Effacer toute la conversation ?')) return;
        $('ai-chat-log').innerHTML = '';
        turns = [];
        clearTurns();
      });

      // initial gate state
      if (activeKey()) hideKeyGate(); else showKeyGate();
    }

    return { mount };
  }

  window.AICoach = AICoach();
})();
