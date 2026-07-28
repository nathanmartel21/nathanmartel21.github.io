/* Admin console — review access requests (approve / deny). Admin-only, gated by
   the same email-OTP token; the server enforces the admin role on every call. */
'use strict';
const BACKEND = 'https://ayress21-homemadegarmin.hf.space';
const K_TOKEN = 'access_token';
const $ = id => document.getElementById(id);
let filter = 'pending';
let all = [];

const tokenGet = () => localStorage.getItem(K_TOKEN) || '';
const tokenSet = t => localStorage.setItem(K_TOKEN, t);
const tokenClear = () => localStorage.removeItem(K_TOKEN);

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const t = tokenGet(); if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(BACKEND + path, Object.assign({}, opts, { headers }));
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.detail || ('Erreur ' + res.status)); e.status = res.status; throw e; }
  return data;
}
function msg(t, ok) { const el = $('login-msg'); el.textContent = t || ''; el.className = 'msg ' + (ok ? 'ok' : (t ? 'err' : '')); }
function show(sec, on) { $(sec).hidden = !on; }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function boot() {
  if (!tokenGet()) return showLogin();
  try {
    const me = await api('/api/me');
    if (me.role === 'admin') { $('who').textContent = me.email; show('console', true); show('login', false); show('denied', false); loadReqs(); }
    else { show('denied', true); show('login', false); show('console', false); }
  } catch { tokenClear(); showLogin(); }
}
function showLogin() { show('login', true); show('console', false); show('denied', false); $('step-code').hidden = true; $('step-email').hidden = false; }

let pendingEmail = '';
async function sendCode() {
  const email = $('login-email').value.trim().toLowerCase();
  if (!email.includes('@')) { msg('Email invalide.'); return; }
  $('send-code').disabled = true;
  try { await api('/api/auth/request-otp', { method: 'POST', body: JSON.stringify({ email }) });
    pendingEmail = email; $('step-email').hidden = true; $('step-code').hidden = false; msg('', true); setTimeout(() => $('login-code').focus(), 30);
  } catch (e) { msg(e.message); }
  $('send-code').disabled = false;
}
async function verifyCode() {
  const code = $('login-code').value.trim();
  if (code.length < 6) { msg('Code à 6 chiffres.'); return; }
  $('verify-code').disabled = true;
  try { const r = await api('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email: pendingEmail, code }) });
    tokenSet(r.token); boot();
  } catch (e) { msg(e.message); }
  $('verify-code').disabled = false;
}

async function loadReqs() {
  $('reqs').innerHTML = '<p class="muted small">Chargement…</p>';
  try { all = (await api('/api/admin/requests')).requests || []; render(); }
  catch (e) { $('reqs').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}
function render() {
  const list = filter === 'all' ? all : all.filter(r => r.status === filter);
  if (!list.length) { $('reqs').innerHTML = '<p class="muted small">Aucune demande.</p>'; return; }
  $('reqs').innerHTML = list.map(r => {
    const when = r.ts ? new Date(r.ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const acts = r.status === 'pending'
      ? `<div class="req-acts"><button class="btn btn-ok btn-sm" data-id="${esc(r.id)}" data-d="approve">✓ Approuver</button>
         <button class="btn btn-no btn-sm" data-id="${esc(r.id)}" data-d="deny">✕ Refuser</button></div>`
      : `<span class="pill ${r.status}">${r.status === 'approved' ? 'approuvé' : 'refusé'}</span>`;
    return `<div class="req">
      <div class="req-h"><b>${esc((r.first || '') + ' ' + (r.last || '')).trim() || r.email}</b><time>${when}</time></div>
      <div class="req-mail">${esc(r.email)}</div>
      ${r.reason ? `<div class="req-reason">${esc(r.reason)}</div>` : ''}
      ${acts}
    </div>`;
  }).join('');
}
async function decide(id, decision) {
  try { await api('/api/admin/decide', { method: 'POST', body: JSON.stringify({ id, decision }) }); loadReqs(); }
  catch (e) { alert(e.message); }
}

$('send-code').addEventListener('click', sendCode);
$('login-code').addEventListener('keydown', e => { if (e.key === 'Enter') verifyCode(); });
$('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(); });
$('verify-code').addEventListener('click', verifyCode);
$('logout').addEventListener('click', () => { tokenClear(); showLogin(); });
$('logout2').addEventListener('click', () => { tokenClear(); showLogin(); });
$('refresh').addEventListener('click', loadReqs);
document.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.fbtn').forEach(x => x.classList.remove('active')); b.classList.add('active'); filter = b.dataset.f; render();
}));
$('reqs').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (b) decide(b.dataset.id, b.dataset.d); });

boot();
