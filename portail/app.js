/* Portail — app hub with a real auth gate.

   Auth reuses the Coffre vault: same origin => shared localStorage, so entering
   the master password here decrypts the vault blob to authenticate (no separate
   password store, no fake gate). The same geo/VPN/France access policy as the
   Coffre runs on every unlock. When unlocked, a short session window (in
   sessionStorage) avoids re-checking geo each time you come back from an app. */

(function () {
  'use strict';
  const K_VAULT = 'coffre_vault';
  const K_SESSION = 'portail_session_until';   // epoch seconds
  const SESSION_MIN = 15;                       // stay unlocked this long between visits
  const enc = new TextEncoder();
  const $ = id => document.getElementById(id);
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  function hasVault() { try { return !!JSON.parse(localStorage.getItem(K_VAULT)); } catch { return false; } }
  function blob() { try { return JSON.parse(localStorage.getItem(K_VAULT)); } catch { return null; } }

  function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, 2000); }
  function setDot(s) { $('acc-dot').className = 'dot dot-' + s; }
  function setAccess(t) { $('acc-text').textContent = t; }

  // ---- crypto: verify master password by decrypting the vault ----
  async function verify(password) {
    const b = blob(); if (!b) throw new Error('novault');
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(b.kdf.salt), iterations: b.kdf.iters || 600000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) }, key, unb64(b.ct)); // throws if wrong
    return true;
  }

  // ---- access gate (geo + IP country = FR) ----
  function getPosition() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej({ code: 0 });
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), rej,
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    });
  }
  async function gpsCountry(lat, lon) {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=fr`);
    if (!r.ok) throw 0; const j = await r.json(); return (j.countryCode || '').toUpperCase();
  }
  async function ipCountry() {
    const r = await fetch('https://ipwho.is/'); if (!r.ok) throw 0;
    const j = await r.json(); if (j.success === false) throw 0; return (j.country_code || '').toUpperCase();
  }
  async function checkAccess() {
    setDot('busy'); setAccess('Vérification de la localisation…');
    let pos; try { pos = await getPosition(); } catch (e) { return deny(e && e.code === 1 ? 'Localisation refusée (obligatoire).' : 'Localisation indisponible.'); }
    let g; try { g = await gpsCountry(pos.lat, pos.lon); } catch { return deny('Vérification pays impossible (hors-ligne ?).'); }
    if (g !== 'FR') return deny(`Accès autorisé uniquement depuis la France (${g || '?'}).`);
    setAccess('Vérification réseau (VPN)…');
    let ip; try { ip = await ipCountry(); } catch { return deny('Vérification réseau impossible (hors-ligne ?).'); }
    if (ip !== 'FR') return deny(`IP hors de France (${ip || '?'}) — VPN/proxy suspecté.`);
    setDot('ok'); setAccess('Accès validé · France');
    return { ok: true };
  }
  function deny(reason) { setDot('bad'); setAccess(reason); return { ok: false, reason }; }

  // ---- session window ----
  function sessionValid() { try { return Number(sessionStorage.getItem(K_SESSION) || 0) > Math.floor(Date.now() / 1000); } catch { return false; } }
  function openSession() { try { sessionStorage.setItem(K_SESSION, String(Math.floor(Date.now() / 1000) + SESSION_MIN * 60)); } catch {} }
  function closeSession() { try { sessionStorage.removeItem(K_SESSION); } catch {} }

  // ---- screens ----
  function showAuth() {
    $('hub').hidden = true; $('auth').hidden = false;
    $('no-vault').hidden = hasVault();
    $('master').value = ''; setDot(''); setAccess('Accès : localisation en France, sans VPN.');
    $('auth-msg').textContent = '';
    if (!hasVault()) { $('auth-sub').textContent = 'Aucun coffre : le portail n’est pas encore protégé.'; }
    setTimeout(() => $('master').focus(), 50);
  }
  function showHub() { $('auth').hidden = true; $('hub').hidden = false; }

  async function onAuth() {
    const btn = $('auth-btn'), msg = $('auth-msg');
    msg.textContent = ''; msg.className = 'auth-msg';
    // No vault yet → portal is open (nothing to protect); just enter.
    if (!hasVault()) { openSession(); showHub(); return; }
    const pw = $('master').value;
    if (!pw) { msg.textContent = 'Entre ton mot de passe maître.'; msg.className = 'auth-msg err'; return; }
    btn.disabled = true;
    const acc = await checkAccess();
    if (!acc.ok) { msg.textContent = acc.reason; msg.className = 'auth-msg err'; btn.disabled = false; return; }
    setAccess('Vérification…');
    try {
      await verify(pw);
      openSession(); btn.disabled = false; showHub();
    } catch (e) {
      msg.textContent = (e && e.message === 'novault') ? 'Aucun coffre trouvé.' : 'Mot de passe incorrect.';
      msg.className = 'auth-msg err'; btn.disabled = false;
      setDot(''); setAccess('Accès : localisation en France, sans VPN.');
    }
  }

  function lock() { closeSession(); showAuth(); }

  // ---- wire ----
  $('auth-btn').addEventListener('click', onAuth);
  $('master').addEventListener('keydown', e => { if (e.key === 'Enter') onAuth(); });
  $('lock-btn').addEventListener('click', () => { lock(); toast('🔒 Verrouillé'); });

  if (!window.isSecureContext || !crypto.subtle) {
    document.body.innerHTML = '<p style="color:#fff;font-family:sans-serif;padding:2rem">⚠️ HTTPS requis.</p>';
  } else if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Enter directly if a recent session is still valid (came back from an app).
  if (sessionValid() && hasVault()) showHub(); else showAuth();
})();
