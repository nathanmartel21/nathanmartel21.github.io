/* Coffre autofill — popup logic.

   The extension keeps its OWN copy of the vault: you import the encrypted backup
   exported from the web app (same format: {kdf:{salt,iters},iv,ct}). Unlock with
   the master password (+ an IP-based France/VPN check) decrypts it. Decrypted
   entries live in chrome.storage.session (memory only, wiped on browser close)
   with a short auto-lock window. Passwords are filled into the active tab via
   chrome.scripting — they never transit any server. */

'use strict';
const SESSION_MIN = 5;
const enc = new TextEncoder(), dec = new TextDecoder();
const $ = id => document.getElementById(id);
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ---------------- crypto ----------------
async function decryptBlob(blob, password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(blob.kdf.salt), iterations: blob.kdf.iters || 600000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return JSON.parse(dec.decode(pt));   // throws if wrong password
}

// ---------------- storage ----------------
const getBlob = async () => (await chrome.storage.local.get('coffre_blob')).coffre_blob || null;
const setBlob = b => chrome.storage.local.set({ coffre_blob: b });
const getSession = async () => (await chrome.storage.session.get('unlocked')).unlocked || null;
const setSession = s => chrome.storage.session.set({ unlocked: s });
const clearSession = () => chrome.storage.session.remove('unlocked');

// ---------------- access gate (IP France / VPN) ----------------
async function accessOk() {
  $('dot').className = 'dot dot-busy'; $('acc').textContent = 'Vérification réseau (VPN)…';
  try {
    const j = await (await fetch('https://ipwho.is/')).json();
    if (j.success === false) throw 0;
    if ((j.country_code || '').toUpperCase() !== 'FR') {
      $('dot').className = 'dot dot-bad';
      const isp = j.connection && j.connection.isp ? ' · ' + j.connection.isp : '';
      $('acc').textContent = `IP hors France (${j.country_code || '?'}${isp}) — refusé.`;
      return false;
    }
    $('dot').className = 'dot dot-ok'; $('acc').textContent = `Accès validé · ${(j.connection && j.connection.isp) || 'IP FR'}`;
    return true;
  } catch {
    $('dot').className = 'dot dot-bad'; $('acc').textContent = 'Vérification réseau impossible (hors-ligne ?).';
    return false;
  }
}

// ---------------- current tab ----------------
let tabHost = '';
async function currentHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabHost = tab && tab.url ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
  } catch { tabHost = ''; }
}

// ---------------- fill (injected into the page) ----------------
function pageFill(user, pass, submit) {
  const pw = [...document.querySelectorAll('input[type=password]')].find(i => i.offsetParent !== null)
          || document.querySelector('input[type=password]');
  if (!pw) return 'nopass';
  const scope = pw.closest('form') || document;
  const isText = i => ['text', 'email', 'tel', ''].includes((i.getAttribute('type') || '').toLowerCase());
  let userEl = [...scope.querySelectorAll('input')].filter(i => i !== pw && isText(i) && i.offsetParent !== null)[0]
            || document.querySelector('input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[type=email]');
  const set = (el, v) => { if (!el) return; el.focus(); const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  if (userEl && user) set(userEl, user);
  set(pw, pass);
  if (submit) { const b = scope.querySelector('button[type=submit], input[type=submit], button:not([type])'); if (b) b.click(); else if (pw.form) pw.form.submit(); }
  return 'ok';
}

async function fillActiveTab(entry, submit) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageFill, args: [entry.username || '', entry.password || '', !!submit] });
    const r = res && res[0] && res[0].result;
    msg($('list-msg'), r === 'ok' ? '✓ Rempli' : 'Aucun champ mot de passe trouvé sur la page.', r === 'ok');
    if (r === 'ok') setTimeout(() => window.close(), 500);
  } catch { msg($('list-msg'), 'Remplissage impossible sur cette page.', false); }
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); msg($('list-msg'), `${label} copié`, true); } catch { msg($('list-msg'), 'Copie impossible.', false); }
}

function msg(el, t, ok) { el.textContent = t; el.className = 'msg ' + (ok ? 'ok' : (t ? 'err' : '')); }

// ---------------- render ----------------
let ENTRIES = [];
function show(sec) { ['import', 'unlock', 'list'].forEach(s => $(s).hidden = s !== sec); $('lock').hidden = sec !== 'list'; }

function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function renderEntries() {
  const q = $('search').value.trim().toLowerCase();
  let list = ENTRIES.map(e => ({ ...e, match: tabHost && (hostOf(e.url).includes(tabHost) || tabHost.includes(hostOf(e.url)) || (e.title || '').toLowerCase().includes(tabHost.split('.')[0])) }));
  if (q) list = list.filter(e => (e.title + ' ' + e.username + ' ' + e.url).toLowerCase().includes(q));
  list.sort((a, b) => (b.match - a.match) || (a.title || '').localeCompare(b.title || ''));
  $('entries').innerHTML = list.map(e => `<div class="entry ${e.match ? 'match' : ''}" data-id="${esc(e.id)}">
    <div class="entry-h"><span class="entry-t">${esc(e.title || 'Sans titre')}</span>${e.match ? '<span class="badge">ce site</span>' : ''}</div>
    <div class="entry-u">${esc(e.username || '')}${e.url ? ' · ' + esc(hostOf(e.url)) : ''}</div>
    <div class="entry-btns">
      <button class="btn btn-primary" data-act="fill">Remplir</button>
      <button class="btn" data-act="fillsubmit">+ Entrée</button>
      <button class="btn" data-act="user">👤</button>
      <button class="btn" data-act="pass">🔑</button>
    </div></div>`).join('') || '<p class="muted">Aucune entrée.</p>';
}

// ---------------- flows ----------------
async function boot() {
  await currentHost();
  const blob = await getBlob();
  if (!blob) { show('import'); return; }
  const sess = await getSession();
  if (sess && sess.until > Date.now() && Array.isArray(sess.entries)) { ENTRIES = sess.entries; show('list'); renderEntries(); return; }
  show('unlock'); setTimeout(() => $('master').focus(), 30);
}

async function doUnlock() {
  const pw = $('master').value; const m = $('unlock-msg');
  if (!pw) { msg(m, 'Entre ton mot de passe maître.', false); return; }
  $('unlock-btn').disabled = true;
  if (!(await accessOk())) { msg(m, 'Accès refusé (France/VPN).', false); $('unlock-btn').disabled = false; return; }
  try {
    const blob = await getBlob();
    const vault = await decryptBlob(blob, pw);
    ENTRIES = vault.entries || [];
    await setSession({ entries: ENTRIES, until: Date.now() + SESSION_MIN * 60000 });
    $('master').value = ''; show('list'); renderEntries();
  } catch { msg(m, 'Mot de passe incorrect.', false); }
  $('unlock-btn').disabled = false;
}

function importFile(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const blob = JSON.parse(r.result);
      if (!blob.kdf || !blob.iv || !blob.ct) throw 0;
      await setBlob(blob); await clearSession();
      msg($('import-msg'), 'Sauvegarde importée ✓', true);
      setTimeout(boot, 400);
    } catch { msg($('import-msg'), 'Fichier invalide (attendu : export chiffré du coffre).', false); }
  };
  r.readAsText(file);
}

// ---------------- wire ----------------
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', e => { if (e.target.files[0]) importFile(e.target.files[0]); });
$('reimport').addEventListener('click', () => show('import'));
$('unlock-btn').addEventListener('click', doUnlock);
$('master').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
$('lock').addEventListener('click', async () => { await clearSession(); ENTRIES = []; show('unlock'); });
$('search').addEventListener('input', renderEntries);
$('entries').addEventListener('click', e => {
  const row = e.target.closest('.entry'); const btn = e.target.closest('[data-act]');
  if (!row || !btn) return;
  const entry = ENTRIES.find(x => x.id === row.dataset.id); if (!entry) return;
  const act = btn.dataset.act;
  if (act === 'fill') fillActiveTab(entry, false);
  else if (act === 'fillsubmit') fillActiveTab(entry, true);
  else if (act === 'user') copy(entry.username || '', 'Identifiant');
  else if (act === 'pass') copy(entry.password || '', 'Mot de passe');
});

boot();
