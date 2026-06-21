/* PWA glue: registers the service worker and shows an "Installer l'app"
   button when the browser offers an install prompt. Self-contained — injects
   its own styles so no CSS file changes are required. */
(function () {
  'use strict';

  // 1. Register the service worker (scope = /garmin/).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err);
      });
    });
  }

  // 2. Install prompt (Android / desktop Chromium). iOS uses "Add to Home Screen".
  let deferredPrompt = null;

  function makeButton() {
    if (document.getElementById('pwa-install-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'pwa-install-btn';
    btn.type = 'button';
    btn.textContent = '⤓ Installer l’app';
    btn.setAttribute('aria-label', 'Installer l’application');
    Object.assign(btn.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '9999',
      padding: '10px 16px', borderRadius: '999px', border: '0',
      background: 'linear-gradient(135deg,#2bc4ff,#00a8e8)', color: '#04121b',
      font: '600 14px/1 "Space Grotesk",Inter,system-ui,sans-serif',
      cursor: 'pointer', boxShadow: '0 8px 24px rgba(0,168,232,.35)',
    });
    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.remove();
    });
    document.body.appendChild(btn);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    makeButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const btn = document.getElementById('pwa-install-btn');
    if (btn) btn.remove();
  });
})();
