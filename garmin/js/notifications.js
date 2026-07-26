/* Web Push notifications: hydration reminders (10h/15h/21h) and a morning
   "session of the day" reminder — delivered even when the app is closed.

   How it works (see garmin/server/app.py + .github/workflows/push-cron.yml):
     - The browser subscribes to Web Push (VAPID) and POSTs the subscription,
       the user's prefs, timezone, and a 3-day session PLAN to the backend.
     - A GitHub Actions cron pings the backend hourly; the backend computes each
       subscriber's LOCAL hour and sends the matching slot (handles DST + the
       Space sleeping). No Garmin token is ever stored — the plan is precomputed
       client-side by suggestRun, so the reminder knows the session without the
       server ever touching Garmin.

   iOS note: Web Push only works when the site is installed to the Home Screen
   (iOS 16.4+). Until then PushManager is unavailable and we show a hint.

   Relies on globals: getBackendUrl (config.js), runsOnly, suggestRun, addDays,
   startOfDay (analysis.js). Exposes window.Notif. */

(function () {
  'use strict';

  const PREFS_KEY = 'garmin_notif_prefs';           // { hydration, run }
  const PLAN_DAYS = 3;

  const $ = id => document.getElementById(id);

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || { hydration: false, run: false }; }
    catch { return { hydration: false, run: false }; }
  }
  function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} }

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function tz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'; }
    catch { return 'Europe/Paris'; }
  }

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  /* 3-day session forecast from the same rule engine the dashboard uses, so the
     morning reminder carries the right session (or nothing, on rest days). */
  function computePlan(data) {
    const runs = runsOnly(data.activities || []);
    const wellness = data.wellness || [];
    const snapshot = data.snapshot || {};
    // Local YYYY-MM-DD (NOT toISOString, which is UTC and can shift the day).
    const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const plan = [];
    for (let i = 0; i < PLAN_DAYS; i++) {
      const ref = addDays(startOfDay(new Date()), i);
      // suggestRun keys "today" off ref, so a future ref yields a forecast.
      const sug = suggestRun(runs, wellness, snapshot, ref);
      const hasSession = sug.type !== 'Repos';
      plan.push({
        date: localDate(ref),
        session: hasSession,
        type: sug.type,
        title: sug.title,
        body: hasSession ? `${sug.title} · ${sug.distance} · ${sug.pace}` : ''
      });
    }
    return plan;
  }

  async function getVapidKey(backend) {
    const res = await fetch(`${backend}/api/push/vapid`);
    if (!res.ok) throw new Error('vapid-unavailable');
    const j = await res.json();
    if (!j.key) throw new Error('vapid-empty');
    return j.key;
  }

  async function getSubscription(backend) {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = await getVapidKey(backend);
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });
    }
    return sub;
  }

  async function pushToServer(backend, sub, prefs, plan) {
    await fetch(`${backend}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub, prefs, tz: tz(), plan })
    });
  }

  async function unsubscribeServer(backend, sub) {
    try {
      await fetch(`${backend}/api/push/unsubscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    } catch {}
  }

  const Notif = { mounted: null };

  function setMsg(t, ok) {
    const el = $('notif-msg');
    if (!el) return;
    el.textContent = t || '';
    el.dataset.tone = ok ? 'good' : (t ? 'warn' : '');
  }

  /* Apply the current checkbox state: (un)subscribe + sync prefs/plan. */
  async function apply(data) {
    const backend = getBackendUrl();
    const prefs = { hydration: $('notif-hydration').checked, run: $('notif-run').checked };
    savePrefs(prefs);

    if (!backend) { setMsg('Configure d’abord le backend (page d’accueil).'); return; }

    // Turning everything off → remove the subscription server-side.
    if (!prefs.hydration && !prefs.run) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await unsubscribeServer(backend, sub);
      } catch {}
      setMsg('Rappels désactivés.');
      return;
    }

    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        $('notif-hydration').checked = false; $('notif-run').checked = false;
        savePrefs({ hydration: false, run: false });
        setMsg('Permission refusée — active les notifications pour ce site dans les réglages.');
        return;
      }
      const sub = await getSubscription(backend);
      await pushToServer(backend, sub, prefs, computePlan(data));
      $('notif-test').hidden = false;
      setMsg('✅ Rappels activés sur cet appareil.', true);
    } catch (err) {
      setMsg(`⚠️ Impossible d’activer les rappels : ${err.message}`);
    }
  }

  /* Silent refresh on app open: if already subscribed, resend fresh prefs+plan
     (also repopulates the server after the Space restarts / clears memory). */
  async function refresh(data) {
    const backend = getBackendUrl();
    if (!backend || Notification.permission !== 'granted') return;
    const prefs = loadPrefs();
    if (!prefs.hydration && !prefs.run) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await pushToServer(backend, sub, prefs, computePlan(data));
    } catch {}
  }

  async function sendTest(data) {
    const backend = getBackendUrl();
    if (!backend) return;
    setMsg('Envoi du test…');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) { setMsg('Active d’abord un rappel.'); return; }
      const res = await fetch(`${backend}/api/push/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
      setMsg(res.ok ? '📨 Test envoyé — regarde tes notifications.' : 'Échec de l’envoi du test.', res.ok);
    } catch (err) { setMsg(`⚠️ ${err.message}`); }
  }

  function mount(data) {
    Notif.mounted = data;
    const section = $('notif-section');
    if (!section) return;                 // only on the Today page
    section.hidden = false;

    // iOS Safari (not installed): push is unavailable → guide to Home Screen.
    if (!supported) {
      if (isIOS && !standalone) $('notif-ios-hint').hidden = false;
      else setMsg('Ton navigateur ne supporte pas les notifications push.');
      $('notif-hydration').disabled = true; $('notif-run').disabled = true;
      return;
    }

    const prefs = loadPrefs();
    $('notif-hydration').checked = prefs.hydration && Notification.permission === 'granted';
    $('notif-run').checked = prefs.run && Notification.permission === 'granted';
    if ((prefs.hydration || prefs.run) && Notification.permission === 'granted') $('notif-test').hidden = false;

    $('notif-hydration').addEventListener('change', () => apply(data));
    $('notif-run').addEventListener('change', () => apply(data));
    $('notif-test').addEventListener('click', () => sendTest(data));

    refresh(data);
  }

  window.Notif = { mount };
})();
