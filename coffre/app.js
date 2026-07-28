/* Coffre — a local, zero-knowledge password vault.

   Security model (be honest about it):
   - The vault is encrypted client-side with AES-GCM 256. The key is derived from
     the master password with PBKDF2-HMAC-SHA256 (600k iterations) + a random salt.
     Decryption success IS the password check — no password hash is ever stored.
   - Nothing leaves the device: the ciphertext lives in localStorage only.
   - The master password and derived key are kept in memory only while unlocked,
     and wiped on lock / idle / tab close.

   Access policy (a deterrent layer, NOT the crypto boundary — an attacker with a
   copy of the ciphertext bypasses all of this and attacks offline):
   - Every unlock requires geolocation, resolves the GPS country and the IP
     country, and only proceeds if BOTH are France. A foreign IP (typical VPN
     exit) is refused as "VPN/proxy suspected". Fail-closed: no network → no unlock.

   - The "lock after 3 tries" is UX (back-off + optional local self-destruct). */

(function () {
  'use strict';

  // ---------------------------------------------------------------- storage keys
  const K_VAULT = 'coffre_vault';       // { v, kdf:{salt,iters,algo}, iv, ct }
  const K_GUARD = 'coffre_guard';       // { fails, until }
  const K_EVENTS = 'coffre_events';     // [ {ts,type,ok,meta} ]  (metadata only)
  const K_DEVICE = 'coffre_device';     // random device id (not secret)
  const ITERS = 600000;

  // Phase 3 — security alerts (push + Elastic) go through the stateless Space.
  const BACKEND = 'https://ayress21-homemadegarmin.hf.space';
  const COFFRE_TOKEN = '';   // optionnel : même valeur que COFFRE_TOKEN côté serveur pour verrouiller l'endpoint

  const enc = new TextEncoder(), dec = new TextDecoder();
  const $ = id => document.getElementById(id);

  // in-memory session (never persisted)
  let sessionKey = null;   // CryptoKey
  let vault = null;        // { entries:[], settings:{} }
  let idleTimer = null;
  let clipTimer = null;
  let editingId = null;

  // ---------------------------------------------------------------- helpers
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const escapeHtml = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nowSec = () => Math.floor(Date.now() / 1000);

  function deviceId() {
    let d = localStorage.getItem(K_DEVICE);
    if (!d) { d = b64(crypto.getRandomValues(new Uint8Array(9))); localStorage.setItem(K_DEVICE, d); }
    return d;
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // ---------------------------------------------------------------- crypto
  async function deriveKey(password, salt, iters) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptObj(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decryptObj(key, iv, ct) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    return JSON.parse(dec.decode(pt));
  }

  function readBlob() { try { return JSON.parse(localStorage.getItem(K_VAULT)); } catch { return null; } }
  async function persist() {
    const { iv, ct } = await encryptObj(sessionKey, vault);
    const blob = readBlob();
    localStorage.setItem(K_VAULT, JSON.stringify({ v: 1, kdf: blob.kdf, iv, ct }));
  }

  // ---------------------------------------------------------------- events (metadata only)
  function record(type, ok, meta) {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(K_EVENTS)) || []; } catch {}
    arr.push({ ts: Date.now(), type, ok: !!ok, meta: meta || {} });
    if (arr.length > 300) arr = arr.slice(-300);
    localStorage.setItem(K_EVENTS, JSON.stringify(arr));
    forwardEvent(type, ok, meta);   // → server (push alert + Elastic), metadata only
  }

  // Read the "alerts enabled" flag even on the lock screen (vault not decrypted):
  // it's mirrored (non-secret) into coffre_settings_cache.
  function alertsEnabled() {
    if (vault && vault.settings) return !!vault.settings.alerts;
    try { return !!JSON.parse(localStorage.getItem('coffre_settings_cache')).alerts; } catch { return false; }
  }
  function forwardEvent(type, ok, meta) {
    if (!alertsEnabled()) return;
    try {
      fetch(`${BACKEND}/api/coffre/event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ token: COFFRE_TOKEN, type, ok: !!ok, ts: Date.now(), meta: meta || {} })
      }).catch(() => {});
    } catch {}
  }
  function urlB64(base64) {
    const pad = '='.repeat((4 - base64.length % 4) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  async function subscribeAlerts() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { toast('Notifications non supportées ici.'); return false; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Permission notifications refusée.'); return false; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const vk = (await (await fetch(`${BACKEND}/api/push/vapid`)).json()).key;
        if (!vk) { toast('Serveur push non configuré.'); return false; }
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(vk) });
      }
      await fetch(`${BACKEND}/api/push/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub, prefs: { coffre: true }, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
      });
      return true;
    } catch (e) { toast('Abonnement aux alertes impossible.'); return false; }
  }

  // ---------------------------------------------------------------- guard (3 tries)
  function guard() { try { return JSON.parse(localStorage.getItem(K_GUARD)) || { fails: 0, until: 0 }; } catch { return { fails: 0, until: 0 }; } }
  function setGuard(g) { localStorage.setItem(K_GUARD, JSON.stringify(g)); }
  function cooldownFor(fails) { return fails >= 6 ? 1800 : fails >= 5 ? 600 : fails >= 4 ? 120 : 30; } // seconds
  function lockedFor() { const g = guard(); return Math.max(0, g.until - nowSec()); }

  // ---------------------------------------------------------------- access gate (geo + VPN + France)
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject({ code: 0 });
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        e => reject(e), { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    });
  }
  async function gpsCountry(lat, lon) {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=fr`);
    if (!r.ok) throw new Error('geo');
    const j = await r.json();
    return { code: (j.countryCode || '').toUpperCase(), city: j.city || j.locality || '' };
  }
  async function ipInfo() {
    const r = await fetch('https://ipwho.is/');
    if (!r.ok) throw new Error('ip');
    const j = await r.json();
    if (j.success === false) throw new Error('ip');
    return { code: (j.country_code || '').toUpperCase(), isp: (j.connection && j.connection.isp) || '' };
  }

  async function checkAccess() {
    setDot('busy'); setAccess('Vérification de la localisation…');
    // 1. geolocation (mandatory)
    let pos;
    try { pos = await getPosition(); }
    catch (e) {
      return deny(e && e.code === 1
        ? 'Localisation refusée. Elle est obligatoire pour déverrouiller.'
        : 'Localisation indisponible — impossible de vérifier l’accès.');
    }
    // 2. GPS country
    let gps;
    try { gps = await gpsCountry(pos.lat, pos.lon); }
    catch { return deny('Vérification du pays impossible (hors-ligne ?). Accès refusé.'); }
    if (gps.code !== 'FR') return deny(`Accès autorisé uniquement depuis la France (position : ${gps.code || '?'}).`);
    // 3. IP country (VPN/proxy heuristic)
    setAccess('Vérification du réseau (VPN)…');
    let ip;
    try { ip = await ipInfo(); }
    catch { return deny('Vérification réseau impossible (hors-ligne ?). Accès refusé.'); }
    if (ip.code !== 'FR') return deny(`IP hors de France (${ip.code || '?'}${ip.isp ? ' · ' + ip.isp : ''}) — VPN/proxy suspecté. Accès refusé.`);
    setDot('ok'); setAccess(`Accès validé · ${gps.city || 'France'} · ${ip.isp || 'IP FR'}`);
    return { ok: true, meta: { city: gps.city, isp: ip.isp, dev: deviceId() } };
  }
  function deny(reason) { setDot('bad'); setAccess(reason); return { ok: false, reason }; }
  function setAccess(t) { $('acc-text').textContent = t; }
  function setDot(s) { $('acc-dot').className = 'dot dot-' + s; }

  // ---------------------------------------------------------------- password generator
  function genPassword(o) {
    const amb = 'Il1O0o';
    let lower = 'abcdefghijklmnopqrstuvwxyz', upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        digit = '0123456789', sym = '!@#$%^&*()-_=+[]{};:,.?';
    if (o.noAmbiguous) { const f = s => [...s].filter(c => !amb.includes(c)).join(''); lower = f(lower); upper = f(upper); digit = f(digit); }
    const sets = []; if (o.upper) sets.push(upper); if (o.lower) sets.push(lower); if (o.digit) sets.push(digit); if (o.sym) sets.push(sym);
    if (!sets.length) return '';
    const pool = sets.join('');
    const pick = s => s[randInt(s.length)];
    const out = sets.map(pick);                 // guarantee one of each class
    for (let i = out.length; i < o.len; i++) out.push(pick(pool));
    // Fisher-Yates shuffle with CSPRNG
    for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out.join('');
  }
  function randInt(max) { // unbiased [0,max)
    const r = new Uint32Array(1); const lim = Math.floor(0xFFFFFFFF / max) * max;
    let x; do { crypto.getRandomValues(r); x = r[0]; } while (x >= lim);
    return x % max;
  }

  function strength(pw) {
    if (!pw) return { score: 0, label: '—' };
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26; if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10; if (/[^a-zA-Z0-9]/.test(pw)) pool += 30;
    const bits = pw.length * Math.log2(pool || 1);
    const score = Math.max(0, Math.min(4, Math.floor(bits / 25)));
    return { score, bits: Math.round(bits), label: ['Très faible', 'Faible', 'Moyen', 'Bon', 'Excellent'][score] };
  }
  function renderStrength(el, pw) {
    const s = strength(pw);
    el.querySelector('i').style.width = (s.score / 4 * 100) + '%';
    el.querySelector('i').dataset.score = s.score;
    el.querySelector('span').textContent = pw ? `${s.label} · ${s.bits} bits` : '';
  }

  // ---------------------------------------------------------------- lock screen
  function isCreate() { return !readBlob(); }

  function showLock() {
    $('vault').hidden = true; $('lock').hidden = false;
    const create = isCreate();
    $('lock-title').textContent = create ? 'Créer ton coffre' : 'Coffre';
    $('lock-sub').textContent = create ? 'Choisis un mot de passe maître fort. Il n’est stockable nulle part : sans lui, tout est perdu.' : 'Déverrouille ton coffre-fort.';
    $('confirm-field').hidden = !create;
    $('create-strength').hidden = !create;
    $('lock-btn').textContent = create ? 'Créer le coffre' : 'Déverrouiller';
    $('master').value = ''; $('master2').value = '';
    setDot(''); setAccess('L’accès exige la localisation, en France, sans VPN.');
    refreshLockout();
    setTimeout(() => $('master').focus(), 50);
  }

  function refreshLockout() {
    const left = lockedFor();
    const btn = $('lock-btn'), msg = $('lock-msg');
    if (left > 0 && !isCreate()) {
      btn.disabled = true;
      const m = Math.floor(left / 60), s = left % 60;
      msg.textContent = `🚫 Trop d’essais. Réessaie dans ${m ? m + ' min ' : ''}${s} s.`;
      msg.className = 'lock-msg err';
      setTimeout(refreshLockout, 1000);
    } else {
      btn.disabled = false;
      if (msg.className.includes('err') && msg.textContent.startsWith('🚫')) { msg.textContent = ''; msg.className = 'lock-msg'; }
    }
  }

  async function onLockSubmit() {
    const btn = $('lock-btn'), msg = $('lock-msg');
    const pw = $('master').value;
    if (!pw) { msg.textContent = 'Entre ton mot de passe maître.'; msg.className = 'lock-msg err'; return; }
    const create = isCreate();
    if (create) {
      if (pw.length < 10) { msg.textContent = 'Au moins 10 caractères pour le mot de passe maître.'; msg.className = 'lock-msg err'; return; }
      if (pw !== $('master2').value) { msg.textContent = 'Les deux mots de passe ne correspondent pas.'; msg.className = 'lock-msg err'; return; }
    } else if (lockedFor() > 0) { return; }

    btn.disabled = true; msg.className = 'lock-msg'; msg.textContent = '';

    // Access gate FIRST (geo + VPN + France), for both create and unlock.
    const acc = await checkAccess();
    if (!acc.ok) {
      record(create ? 'create_denied' : 'access_denied', false, { reason: acc.reason, dev: deviceId() });
      msg.textContent = acc.reason; msg.className = 'lock-msg err';
      btn.disabled = false; return;
    }

    setAccess('Déchiffrement…');
    try {
      if (create) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        sessionKey = await deriveKey(pw, salt, ITERS);
        vault = { entries: [], settings: { autolock: 300, selfDestruct: false, threshold: 10, alerts: false } };
        const { iv, ct } = await encryptObj(sessionKey, vault);
        localStorage.setItem(K_VAULT, JSON.stringify({ v: 1, kdf: { salt: b64(salt), iters: ITERS, algo: 'PBKDF2-SHA256' }, iv, ct }));
        record('vault_created', true, acc.meta);
      } else {
        const blob = readBlob();
        const key = await deriveKey(pw, unb64(blob.kdf.salt), blob.kdf.iters || ITERS);
        vault = await decryptObj(key, blob.iv, blob.ct);     // throws → wrong password
        sessionKey = key;
        setGuard({ fails: 0, until: 0 });
        record('unlock_success', true, acc.meta);
      }
      onUnlocked();
    } catch (e) {
      // wrong password (create can't reach here normally)
      const g = guard(); g.fails += 1;
      if (g.fails >= 3) g.until = nowSec() + cooldownFor(g.fails);
      setGuard(g);
      record('unlock_fail', false, { fails: g.fails, dev: deviceId(), city: acc.meta.city, isp: acc.meta.isp });

      const settings = (function () { try { return JSON.parse(localStorage.getItem('coffre_settings_cache')) || {}; } catch { return {}; } })();
      // self-destruct (opt-in) — uses last-known settings snapshot
      if (settings.selfDestruct && g.fails >= (settings.threshold || 10)) {
        localStorage.removeItem(K_VAULT);
        record('self_destruct', false, { fails: g.fails, dev: deviceId() });
        msg.textContent = '💥 Trop d’échecs : le coffre local a été effacé (auto-destruction).';
        msg.className = 'lock-msg err'; btn.disabled = false; showLock(); return;
      }
      msg.textContent = `Mot de passe incorrect. Essai ${g.fails}${g.fails >= 3 ? ' — verrouillage temporaire.' : '/3.'}`;
      msg.className = 'lock-msg err';
      btn.disabled = false;
      refreshLockout();
      setAccess('L’accès exige la localisation, en France, sans VPN.'); setDot('');
    }
  }

  // ---------------------------------------------------------------- vault UI
  function onUnlocked() {
    // cache non-secret settings so self-destruct can read them on the lock screen
    try { localStorage.setItem('coffre_settings_cache', JSON.stringify({ selfDestruct: vault.settings.selfDestruct, threshold: vault.settings.threshold, alerts: vault.settings.alerts })); } catch {}
    $('lock').hidden = true; $('vault').hidden = false;
    $('master').value = '';
    $('search').value = '';
    renderEntries();
    armIdle();
  }

  function lock(reason) {
    sessionKey = null; vault = null; editingId = null;
    if (clipTimer) { clearTimeout(clipTimer); }
    clearTimeout(idleTimer);
    closeModal('entry'); closeModal('settings');
    showLock();
    if (reason) toast(reason);
  }

  function filteredEntries() {
    const q = $('search').value.trim().toLowerCase();
    let list = vault.entries.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (q) list = list.filter(e => (e.title + ' ' + e.username + ' ' + e.url).toLowerCase().includes(q));
    return list;
  }

  function renderEntries() {
    const wrap = $('entries'), empty = $('empty');
    const list = filteredEntries();
    if (!vault.entries.length) { wrap.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    wrap.innerHTML = list.map(e => {
      const initial = (e.title || '?').trim().charAt(0).toUpperCase();
      const host = (() => { try { return e.url ? new URL(e.url).hostname : ''; } catch { return e.url || ''; } })();
      return `<div class="entry" data-id="${e.id}">
        <div class="entry-ava">${escapeHtml(initial)}</div>
        <div class="entry-main">
          <div class="entry-title">${escapeHtml(e.title || 'Sans titre')}</div>
          <div class="entry-sub">${escapeHtml(e.username || '')}${host ? ' · ' + escapeHtml(host) : ''}</div>
        </div>
        <div class="entry-quick">
          <button class="btn btn-ghost btn-sm" data-act="user" title="Copier l’identifiant">👤</button>
          <button class="btn btn-ghost btn-sm" data-act="pass" title="Copier le mot de passe">🔑</button>
          <button class="btn btn-ghost btn-sm" data-act="edit" title="Modifier">✎</button>
        </div>
      </div>`;
    }).join('');
  }

  async function copyClip(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copié — effacé dans 20 s`);
      if (clipTimer) clearTimeout(clipTimer);
      clipTimer = setTimeout(async () => {
        try { if (document.hasFocus()) await navigator.clipboard.writeText(''); } catch {}
      }, 20000);
    } catch { toast('Copie impossible (autorise le presse-papier).'); }
    kickIdle();
  }

  // ---------------------------------------------------------------- entry modal
  function openEntry(id) {
    editingId = id || null;
    const e = id ? vault.entries.find(x => x.id === id) : null;
    $('entry-modal-title').textContent = e ? 'Modifier l’entrée' : 'Nouvelle entrée';
    $('e-title').value = e ? e.title || '' : '';
    $('e-user').value = e ? e.username || '' : '';
    $('e-pass').value = e ? e.password || '' : '';
    $('e-url').value = e ? e.url || '' : '';
    $('e-notes').value = e ? e.notes || '' : '';
    $('del-entry').hidden = !e;
    $('gen-panel').hidden = true;
    renderStrength($('e-strength'), $('e-pass').value);
    openModal('entry');
    setTimeout(() => $('e-title').focus(), 50);
  }

  async function saveEntry() {
    const title = $('e-title').value.trim();
    if (!title) { toast('Donne au moins un titre.'); return; }
    const data = { title, username: $('e-user').value.trim(), password: $('e-pass').value,
      url: $('e-url').value.trim(), notes: $('e-notes').value, updated: Date.now() };
    if (editingId) {
      const e = vault.entries.find(x => x.id === editingId); Object.assign(e, data);
      record('entry_edited', true, { dev: deviceId() });
    } else {
      data.id = b64(crypto.getRandomValues(new Uint8Array(9)));
      vault.entries.push(data);
      record('entry_added', true, { dev: deviceId() });
    }
    await persist(); renderEntries(); closeModal('entry'); toast('Enregistré'); kickIdle();
  }

  async function deleteEntry() {
    if (!editingId) return;
    if (!confirm('Supprimer cette entrée définitivement ?')) return;
    vault.entries = vault.entries.filter(x => x.id !== editingId);
    record('entry_deleted', true, { dev: deviceId() });
    await persist(); renderEntries(); closeModal('entry'); toast('Supprimé'); kickIdle();
  }

  // ---------------------------------------------------------------- generator panel
  function genOpts() {
    return { len: +$('gen-len').value, upper: $('gen-upper').checked, lower: $('gen-lower').checked,
      digit: $('gen-digit').checked, sym: $('gen-sym').checked, noAmbiguous: $('gen-amb').checked };
  }
  function doGenerate() {
    const pw = genPassword(genOpts());
    if (!pw) { toast('Choisis au moins un type de caractères.'); return; }
    $('e-pass').value = pw; renderStrength($('e-strength'), pw);
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    $('set-autolock').value = String(vault.settings.autolock || 300);
    $('set-selfdestruct').checked = !!vault.settings.selfDestruct;
    $('threshold-row').hidden = !vault.settings.selfDestruct;
    $('set-threshold').value = vault.settings.threshold || 10;
    $('set-alerts').checked = !!vault.settings.alerts;
    $('cm-old').value = ''; $('cm-new').value = ''; $('cm-new2').value = '';
    renderEvents();
    openModal('settings');
  }
  async function saveSettings() {
    vault.settings.autolock = +$('set-autolock').value;
    vault.settings.selfDestruct = $('set-selfdestruct').checked;
    vault.settings.threshold = Math.max(3, +$('set-threshold').value || 10);
    vault.settings.alerts = $('set-alerts').checked;
    try { localStorage.setItem('coffre_settings_cache', JSON.stringify({ selfDestruct: vault.settings.selfDestruct, threshold: vault.settings.threshold, alerts: vault.settings.alerts })); } catch {}
    await persist(); armIdle();
  }

  async function changeMaster() {
    const oldp = $('cm-old').value, np = $('cm-new').value, np2 = $('cm-new2').value;
    if (!np || np.length < 10) { toast('Nouveau mot de passe : 10 caractères minimum.'); return; }
    if (np !== np2) { toast('La confirmation ne correspond pas.'); return; }
    const blob = readBlob();
    try { await decryptObj(await deriveKey(oldp, unb64(blob.kdf.salt), blob.kdf.iters), blob.iv, blob.ct); }
    catch { toast('Mot de passe actuel incorrect.'); return; }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    sessionKey = await deriveKey(np, salt, ITERS);
    const { iv, ct } = await encryptObj(sessionKey, vault);
    localStorage.setItem(K_VAULT, JSON.stringify({ v: 1, kdf: { salt: b64(salt), iters: ITERS, algo: 'PBKDF2-SHA256' }, iv, ct }));
    record('master_changed', true, { dev: deviceId() });
    toast('Mot de passe maître mis à jour'); closeModal('settings');
  }

  function exportVault() {
    const blob = readBlob();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }));
    a.download = `coffre-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    record('export', true, { dev: deviceId() }); toast('Export chiffré téléchargé');
  }
  function importVault(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const blob = JSON.parse(r.result);
        if (!blob.kdf || !blob.ct || !blob.iv) throw new Error('format');
        if (!confirm('Remplacer le coffre de cet appareil par la sauvegarde importée ?')) return;
        localStorage.setItem(K_VAULT, JSON.stringify(blob));
        record('import', true, { dev: deviceId() });
        toast('Sauvegarde importée — déverrouille avec son mot de passe.');
        lock();
      } catch { toast('Fichier de sauvegarde invalide.'); }
    };
    r.readAsText(file);
  }

  function renderEvents() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(K_EVENTS)) || []; } catch {}
    const labels = { vault_created: 'Coffre créé', unlock_success: 'Déverrouillage', unlock_fail: 'Échec déverrouillage',
      access_denied: 'Accès refusé (géo/VPN)', create_denied: 'Création refusée (géo/VPN)', entry_added: 'Entrée ajoutée',
      entry_edited: 'Entrée modifiée', entry_deleted: 'Entrée supprimée', master_changed: 'Mot de passe maître changé',
      export: 'Export', import: 'Import', self_destruct: 'Auto-destruction' };
    $('events').innerHTML = arr.slice(-12).reverse().map(e => {
      const d = new Date(e.ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const extra = e.meta && (e.meta.city || e.meta.isp) ? ` · ${escapeHtml(e.meta.city || '')}${e.meta.isp ? ' / ' + escapeHtml(e.meta.isp) : ''}` : '';
      return `<div class="ev ${e.ok ? 'ok' : 'bad'}"><span>${e.ok ? '✓' : '✕'}</span><span>${labels[e.type] || e.type}</span><time>${d}${extra}</time></div>`;
    }).join('') || '<p class="muted small">Aucun événement.</p>';
  }

  function wipe() {
    if (!confirm('Effacer DÉFINITIVEMENT le coffre de cet appareil ? Sans sauvegarde, c’est irréversible.')) return;
    localStorage.removeItem(K_VAULT); localStorage.removeItem('coffre_settings_cache');
    record('wipe', true, { dev: deviceId() });
    lock('Coffre effacé.');
  }

  // ---------------------------------------------------------------- idle auto-lock
  function armIdle() { kickIdle(); }
  function kickIdle() {
    clearTimeout(idleTimer);
    if (!sessionKey || !vault) return;
    const sec = (vault.settings && vault.settings.autolock) || 300;
    idleTimer = setTimeout(() => lock('🔒 Verrouillé (inactivité).'), sec * 1000);
  }

  // ---------------------------------------------------------------- modal helpers
  function openModal(name) { $(name + '-modal').hidden = false; }
  function closeModal(name) { const m = $(name + '-modal'); if (m) m.hidden = true; }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $('lock-btn').addEventListener('click', onLockSubmit);
    $('master').addEventListener('keydown', e => { if (e.key === 'Enter') { if (isCreate()) $('master2').focus(); else onLockSubmit(); } });
    $('master2').addEventListener('keydown', e => { if (e.key === 'Enter') onLockSubmit(); });
    $('master').addEventListener('input', () => { if (isCreate()) renderStrength($('create-strength'), $('master').value); });

    $('add-btn').addEventListener('click', () => openEntry(null));
    $('empty-add').addEventListener('click', () => openEntry(null));
    $('settings-btn').addEventListener('click', openSettings);
    $('lock-now-btn').addEventListener('click', () => lock('🔒 Verrouillé.'));
    $('search').addEventListener('input', renderEntries);

    $('entries').addEventListener('click', e => {
      const row = e.target.closest('.entry'); if (!row) return;
      const id = row.dataset.id; const entry = vault.entries.find(x => x.id === id); if (!entry) return;
      const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
      if (act === 'user') copyClip(entry.username || '', 'Identifiant');
      else if (act === 'pass') copyClip(entry.password || '', 'Mot de passe');
      else openEntry(id);
    });

    // entry modal
    $('save-entry').addEventListener('click', saveEntry);
    $('del-entry').addEventListener('click', deleteEntry);
    $('e-pass').addEventListener('input', () => renderStrength($('e-strength'), $('e-pass').value));
    $('copy-user-form').addEventListener('click', () => copyClip($('e-user').value, 'Identifiant'));
    $('gen-toggle').addEventListener('click', () => { const p = $('gen-panel'); p.hidden = !p.hidden; if (!p.hidden) doGenerate(); });
    $('gen-len').addEventListener('input', () => { $('gen-len-val').textContent = $('gen-len').value; doGenerate(); });
    ['gen-upper', 'gen-lower', 'gen-digit', 'gen-sym', 'gen-amb'].forEach(id => $(id).addEventListener('change', doGenerate));
    $('gen-regen').addEventListener('click', doGenerate);
    $('gen-use').addEventListener('click', () => { $('gen-panel').hidden = true; });

    // settings modal
    $('set-selfdestruct').addEventListener('change', () => { $('threshold-row').hidden = !$('set-selfdestruct').checked; saveSettings(); });
    $('set-autolock').addEventListener('change', saveSettings);
    $('set-threshold').addEventListener('change', saveSettings);
    $('set-alerts').addEventListener('change', async () => {
      if ($('set-alerts').checked) { const ok = await subscribeAlerts(); if (!ok) $('set-alerts').checked = false; }
      await saveSettings();
      if ($('set-alerts').checked) { forwardEvent('alerts_enabled', true, { dev: deviceId() }); toast('Alertes de sécurité activées'); }
    });
    $('cm-btn').addEventListener('click', changeMaster);
    $('export-btn').addEventListener('click', exportVault);
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', e => { if (e.target.files[0]) importVault(e.target.files[0]); });
    $('wipe-btn').addEventListener('click', wipe);

    document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => closeModal(el.dataset.close)));

    // idle activity + safety locks
    ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (sessionKey) kickIdle(); }, { passive: true }));
    document.addEventListener('visibilitychange', () => { if (document.hidden && sessionKey) lock(); });
    window.addEventListener('pagehide', () => { sessionKey = null; vault = null; });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // secure context guard (WebCrypto/geolocation require HTTPS)
  if (!window.isSecureContext || !crypto.subtle) {
    document.body.innerHTML = '<p style="color:#fff;font-family:sans-serif;padding:2rem">⚠️ Le coffre nécessite HTTPS (contexte sécurisé). Ouvre-le via https://…</p>';
    return;
  }

  wire();
  showLock();
})();
