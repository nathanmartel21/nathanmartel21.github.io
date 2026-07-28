/* Accès — request access + email-OTP login + logged-in hub.
   Auth token (stateless, signed by the Space) is kept in localStorage. This is
   the ACCESS layer only; the vault stays protected by its own master password. */
'use strict';
const BACKEND = 'https://ayress21-homemadegarmin.hf.space';
const K_TOKEN = 'access_token';
const $ = id => document.getElementById(id);

const tokenGet = () => localStorage.getItem(K_TOKEN) || '';
const tokenSet = t => localStorage.setItem(K_TOKEN, t);
const tokenClear = () => localStorage.removeItem(K_TOKEN);

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const t = tokenGet(); if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(BACKEND + path, Object.assign({}, opts, { headers }));
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.detail || ('Erreur ' + res.status));
  return data;
}
function msg(el, t, ok) { el.textContent = t || ''; el.className = 'msg ' + (ok ? 'ok' : (t ? 'err' : '')); }
function show(sec, on) { $(sec).hidden = !on; }

function showLoggedIn(me) {
  $('who').textContent = me.email + (me.role === 'admin' ? ' (admin)' : '');
  $('admin-link').hidden = me.role !== 'admin';
  show('app', true); show('login', false); show('request', false);
}
function showLoggedOut() {
  show('app', false); show('login', true); show('request', true);
  $('step-code').hidden = true; $('step-email').hidden = false;
}

async function boot() {
  if (!tokenGet()) return showLoggedOut();
  try { showLoggedIn(await api('/api/me')); }
  catch { tokenClear(); showLoggedOut(); }
}

// ---- login ----
let pendingEmail = '';
async function sendCode() {
  const email = $('login-email').value.trim().toLowerCase();
  if (!email || !email.includes('@')) { msg($('login-msg'), 'Entre un email valide.'); return; }
  $('send-code').disabled = true;
  try {
    await api('/api/auth/request-otp', { method: 'POST', body: JSON.stringify({ email }) });
    pendingEmail = email; $('code-dest').textContent = email;
    $('step-email').hidden = true; $('step-code').hidden = false;
    msg($('login-msg'), '', true); setTimeout(() => $('login-code').focus(), 30);
  } catch (e) { msg($('login-msg'), e.message); }
  $('send-code').disabled = false;
}
async function verifyCode() {
  const code = $('login-code').value.trim();
  if (code.length < 6) { msg($('login-msg'), 'Code à 6 chiffres.'); return; }
  $('verify-code').disabled = true;
  try {
    const r = await api('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email: pendingEmail, code }) });
    tokenSet(r.token); showLoggedIn(r);
  } catch (e) { msg($('login-msg'), e.message); }
  $('verify-code').disabled = false;
}

// ---- request access ----
async function sendRequest() {
  const email = $('req-email').value.trim().toLowerCase();
  if (!email || !email.includes('@')) { msg($('req-msg'), 'Entre un email valide.'); return; }
  $('req-send').disabled = true;
  try {
    const r = await api('/api/access/request', { method: 'POST', body: JSON.stringify({
      email, first: $('req-first').value.trim(), last: $('req-last').value.trim(), reason: $('req-reason').value.trim() }) });
    msg($('req-msg'), r.message || 'Demande envoyée ✓', true);
    ['req-first', 'req-last', 'req-email', 'req-reason'].forEach(id => $(id).value = '');
  } catch (e) { msg($('req-msg'), e.message); }
  $('req-send').disabled = false;
}

$('send-code').addEventListener('click', sendCode);
$('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
$('verify-code').addEventListener('click', verifyCode);
$('login-code').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
$('back-email').addEventListener('click', () => { $('step-code').hidden = true; $('step-email').hidden = false; });
$('logout').addEventListener('click', () => { tokenClear(); showLoggedOut(); });
$('req-send').addEventListener('click', sendRequest);

boot();
