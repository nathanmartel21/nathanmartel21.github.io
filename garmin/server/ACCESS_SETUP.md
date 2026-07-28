# Système d'accès — demande / approbation / connexion par email

Distribution sur **approbation** + **connexion par email (code OTP)**, stockée dans
**Elasticsearch**, emails via **Gmail SMTP**. L'email-OTP est une **couche d'accès** :
il n'ouvre jamais le coffre (celui-ci garde son mot de passe maître zero-knowledge).

Pages : `/acces/` (demander l'accès + se connecter + télécharger) · `/admin/` (approuver).
Endpoints (Space) : `/api/access/request`, `/api/auth/request-otp`, `/api/auth/verify-otp`,
`/api/me`, `/api/admin/requests`, `/api/admin/decide`.

## 1. Fournisseur email — Brevo (⚠️ PAS de SMTP : Hugging Face bloque les ports SMTP sortants)
On envoie via l'**API HTTPS** d'un fournisseur. Recommandé : **Brevo** (gratuit 300 mails/jour).
1. Crée un compte sur **brevo.com**.
2. **Senders, Domains & Dedicated IPs → Senders** → ajoute un expéditeur (ton email, ex.
   `moi@gmail.com`) et **valide-le** (Brevo t'envoie un mail de confirmation).
3. **SMTP & API → API Keys** → crée une clé **API v3** → c'est ta valeur `BREVO_API_KEY`.
(Alternative : Resend → `RESEND_API_KEY`, mais il faut vérifier un **domaine** pour écrire à d'autres.)

## 2. Secrets du Space (Settings → Variables and secrets)

| Nom | Valeur |
|-----|--------|
| `BREVO_API_KEY` | la clé API v3 de Brevo |
| `MAIL_FROM` | l'email expéditeur **validé** dans Brevo (ex. `moi@gmail.com`) |
| `MAIL_FROM_NAME` | (option) nom affiché, ex. `Accès Nathan` |
| `ADMIN_EMAIL` | **ton** email → tu deviens admin en te connectant avec |
| `SESSION_SECRET` | chaîne aléatoire longue (`openssl rand -hex 32`) |
| `SITE_URL` | (option) `https://nathanmartel21.github.io` (liens dans les emails) |
| `ES_URL`, `ES_API_KEY` | Elasticsearch (déjà posés pour les alertes coffre) |

La clé API Elastic doit pouvoir **créer/lire** sur `access-requests*`, `access-users*`,
`access-logs*` (en plus de `coffre-events*`). Rôle suggéré :
```json
{ "app-writer": { "indices": [
  { "names": ["access-requests*","access-users*","access-logs*","coffre-events*"],
    "privileges": ["create","create_doc","index","read","auto_configure"] } ] } }
```

Redéploie le Space (push de `app.py`) après avoir posé les secrets.

## 3. Flux
1. Un visiteur va sur `/acces/` → **Demander l'accès** (email, prénom, nom, motif).
   Tu reçois un email ; la demande apparaît dans Kibana (`access-requests`).
2. Tu vas sur `/admin/`, tu te connectes avec `ADMIN_EMAIL` (code par email), tu
   **approuves** ou **refuses**. L'approbation ajoute l'email dans `access-users` et
   envoie un mail au demandeur.
3. Le demandeur retourne sur `/acces/` → **Se connecter** (code par email) → il voit
   les apps et peut **télécharger l'extension**.

## 4. Kibana (audit)
Data views : `access-requests*`, `access-users*`, `access-logs*`.
`access-logs` contient : `access_request`, `otp_sent`, `login`, `decision` avec
horodatage, email, IP (ajoute un pipeline **geoip** sur `ip` pour une carte).

## Notes de sécurité
- Le téléchargement de l'extension est un **lien révélé après connexion** (dissuasif) —
  le fichier `.zip` reste techniquement accessible par URL sur GitHub Pages. Pour un
  **verrouillage fort**, il faut servir le fichier depuis le Space derrière l'auth
  (faisable en extension de cet endpoint — demande-le si tu veux).
- Sessions = jetons signés (HMAC `SESSION_SECRET`), valables 7 jours, sans état serveur.
- Les codes OTP vivent en mémoire (10 min) — si le Space redémarre, redemande un code.
