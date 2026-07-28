# Déployer la stack Elastic (pour les logs + Kibana)

Le Space HF doit joindre Elasticsearch **par internet** (HTTPS + clé API). Deux temps :
**(1)** faire tourner ES+Kibana, **(2)** l'exposer publiquement.

## 1. Démarrer ES + Kibana

```bash
cd elastic
cp .env.example .env          # puis édite les 2 mots de passe
sudo sysctl -w vm.max_map_count=262144   # Linux/WSL, requis par ES
docker compose up -d
docker compose ps             # attendre que es soit "healthy" et kibana "running"
```
- Elasticsearch : http://localhost:9200 (user `elastic`, mot de passe du `.env`)
- Kibana : http://localhost:5601

## 2. Créer la clé API pour les apps

```bash
source .env
curl -s -u elastic:$ELASTIC_PASSWORD -X POST http://localhost:9200/_security/api_key \
  -H 'Content-Type: application/json' -d '{
    "name": "app-writer",
    "role_descriptors": { "w": { "indices": [
      { "names": ["access-requests*","access-users*","access-logs*","coffre-events*"],
        "privileges": ["create","create_doc","index","read","auto_configure"] } ] } }
  }'
```
Dans la réponse, le champ **`encoded`** = ta valeur **`ES_API_KEY`** pour le Space.

## 3. Modèles d'index (Kibana → Dev Tools, ou via curl)

Colle le contenu de **`index-templates.txt`** dans **Dev Tools** de Kibana et exécute.
(Optionnel mais donne des types propres : dates, `keyword`, `ip`.)

## 4. Exposer publiquement (pour le Space)

Choisis **une** option :

**A. Cloudflare Tunnel (gratuit, rapide)** — donne une URL HTTPS publique vers ton ES local :
```bash
# installe cloudflared, puis :
cloudflared tunnel --url http://localhost:9200
```
→ tu obtiens `https://xxxx.trycloudflare.com` = ta valeur **`ES_URL`**.
⚠️ Le tunnel « quick » est éphémère et ne tourne que si ta machine est allumée.
Pour du stable : `cloudflared` **tunnel nommé** + un domaine (gratuit avec un domaine Cloudflare).

**B. VPS** — mets la stack sur un petit serveur (avec un reverse-proxy TLS type Caddy/nginx),
`ES_URL = https://es.tondomaine.tld`.

**C. Elastic Cloud** — zéro infra, essai gratuit 14 j (puis payant) : crée un déploiement sur
cloud.elastic.co, récupère l'endpoint HTTPS + une clé API. Pas besoin de ce docker-compose.

**D. Bonsai.io (managé, gratuit perma — RECOMMANDÉ)** — crée un cluster gratuit sur bonsai.io.
La chaîne « Connect » est `https://USER:PASS@HOST` → `ES_URL` = **l'hôte seul** (sans `USER:PASS@`,
sans slash final), `ES_USER`/`ES_PASS` = les deux identifiants.
⚠️ Bonsai sert du **OpenSearch** (fork d'Elasticsearch) : le Space marche tel quel (basic-auth,
`_doc`/`_search`/`_index_template` compatibles), mais **Kibana ne s'y connecte pas**. Pour les
dashboards : l'onglet **Console** de Bonsai (requêtes ad-hoc) ou **OpenSearch Dashboards** en
local (`opensearchproject/opensearch-dashboards:<version>`). Crée les modèles d'index en collant
`index-templates.txt` dans la **Console** Bonsai. ⚠️ Stockage réduit : prévois une rétention.

## 5. Brancher au Space

Sur le Space (Settings → Secrets), l'auth ES accepte **au choix** :
- **Clé API** (Elastic Cloud, self-host) : `ES_URL` + `ES_API_KEY` (le `encoded` de l'étape 2).
- **Basic auth** (Bonsai) : `ES_URL` + `ES_USER` (access key) + `ES_PASS` (access secret).

Puis, dans Kibana → **Data Views**, crée `access-logs*`, `access-requests*`,
`access-users*`, `coffre-events*` (champ temps `@timestamp`) et construis tes dashboards.

## Test
```bash
source .env
curl -u elastic:$ELASTIC_PASSWORD http://localhost:9200/_cat/indices?v
```
Après une demande d'accès / connexion, les index `access-*` apparaissent.
