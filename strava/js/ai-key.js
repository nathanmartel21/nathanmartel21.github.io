/* Encrypted OpenRouter API key for the AI coach.

   This blob is PUBLIC (the repo is public). It is your OpenRouter key
   encrypted with AES-GCM, the key derived from a passphrase via PBKDF2.
   Without the passphrase it is useless; with a weak passphrase it is
   brute-forceable offline — so use a strong passphrase AND a key that
   carries no monetary credit (free models only, credit limit set to 0).

   To fill it in: open strava/keygen.html in your browser, paste your
   OpenRouter key + a passphrase, and copy the generated object here,
   replacing `null`. Then commit this file.

   Leave it as `null` to disable the encrypted path — the app will then
   ask each user to paste their own key (stored only in their browser). */

window.AI_KEY_BLOB = {
  salt: "Kft+PbAT2wgveWX6u+eykg==",
  iv: "hB7GvJssT7PX9jWk",
  ct: "bXZ4U6IncW6WSRrgC9MYKMudtlTYVekfSbIPjGjynxZRBcAKPmJ63xqAmjW2f8nqjL5CU6jeQsTZIpH7TffmASPeC3sNEbLJU19ofPOVog7lexL7pMv1hwc=",
  iter: 250000
};
