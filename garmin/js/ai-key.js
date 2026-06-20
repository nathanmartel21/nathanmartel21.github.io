/* Encrypted OpenRouter API key for the AI coach (shared with the Strava app).

   This blob is PUBLIC (the repo is public). It is the OpenRouter key encrypted
   with AES-GCM, the key derived from a passphrase via PBKDF2. Without the
   passphrase it is useless; with a weak passphrase it is brute-forceable
   offline — so the key carries no monetary credit (free models only).

   To change it: open strava/keygen.html, paste your OpenRouter key + a
   passphrase, and copy the generated object here, replacing the blob.

   Leave it as `null` to disable the encrypted path — the app then asks each
   user to paste their own key (stored only in their browser). */

window.AI_KEY_BLOB = {
  salt: "Kft+PbAT2wgveWX6u+eykg==",
  iv: "hB7GvJssT7PX9jWk",
  ct: "bXZ4U6IncW6WSRrgC9MYKMudtlTYVekfSbIPjGjynxZRBcAKPmJ63xqAmjW2f8nqjL5CU6jeQsTZIpH7TffmASPeC3sNEbLJU19ofPOVog7lexL7pMv1hwc=",
  iter: 250000
};
