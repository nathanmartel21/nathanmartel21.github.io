/* Background service worker — keyboard shortcut (Ctrl+Shift+L) auto-fill.
   Uses the already-unlocked session; if locked or no match, opens the popup. */
'use strict';

function pageFill(user, pass, submit) {
  const pw = [...document.querySelectorAll('input[type=password]')].find(i => i.offsetParent !== null)
          || document.querySelector('input[type=password]');
  if (!pw) return 'nopass';
  const scope = pw.closest('form') || document;
  const isText = i => ['text', 'email', 'tel', ''].includes((i.getAttribute('type') || '').toLowerCase());
  const userEl = [...scope.querySelectorAll('input')].filter(i => i !== pw && isText(i) && i.offsetParent !== null)[0]
            || document.querySelector('input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[type=email]');
  const set = (el, v) => { if (!el) return; el.focus(); const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  if (userEl && user) set(userEl, user);
  set(pw, pass);
  if (submit) { const b = scope.querySelector('button[type=submit], input[type=submit], button:not([type])'); if (b) b.click(); else if (pw.form) pw.form.submit(); }
  return 'ok';
}

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function flash(text) {
  try { await chrome.action.setBadgeText({ text }); await chrome.action.setBadgeBackgroundColor({ color: '#7c6cf6' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500); } catch {}
}

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'fill-login') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const sess = (await chrome.storage.session.get('unlocked')).unlocked;
  if (!sess || sess.until < Date.now() || !Array.isArray(sess.entries)) {
    try { await chrome.action.openPopup(); } catch { flash('🔒'); }
    return;
  }
  const host = hostOf(tab.url);
  const match = sess.entries.find(e => host && (hostOf(e.url).includes(host) || host.includes(hostOf(e.url))));
  if (!match) { try { await chrome.action.openPopup(); } catch { flash('?'); } return; }
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageFill, args: [match.username || '', match.password || '', false] }); flash('✓'); }
  catch { flash('✕'); }
});
