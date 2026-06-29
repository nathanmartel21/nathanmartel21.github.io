/* Shared OpenRouter-key unlock helper.

   Single source of truth for: decrypting the public AI_KEY_BLOB with a passphrase
   (PBKDF2 → AES-GCM), and the localStorage key the AI coach reads from. Used both
   by the login transition page (index.html) and the AI coach (ai.js), so the two
   never drift on the storage key or the crypto parameters.

   Loads before ai.js. Depends only on window.AI_KEY_BLOB (ai-key.js). */

(function () {
  'use strict';

  const LS_KEY = 'garmin_ai_key';   // device key the AI coach picks up
  const SS_KEY = 'ai_or_key';       // per-session key

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

  function hasEncryptedKey() { return Boolean(window.AI_KEY_BLOB && window.AI_KEY_BLOB.ct); }

  /* Decrypts the shared key with `passphrase` and stores it on this device so the
     AI coach is unlocked on app.html. Throws if the passphrase is wrong. */
  async function unlock(passphrase) {
    const key = await decryptKey(window.AI_KEY_BLOB, passphrase);
    if (!/^sk-or-/.test(key)) throw new Error('bad-passphrase');
    localStorage.setItem(LS_KEY, key);
    return key;
  }

  window.AiUnlock = { decryptKey, unlock, hasEncryptedKey, LS_KEY, SS_KEY };
})();
