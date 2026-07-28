# Coffre — alertes push + Elastic/Kibana

Le coffre envoie ses **événements de sécurité** (type, succès/échec, ville, opérateur —
**jamais un mot de passe**) au Space, qui : (1) les **indexe dans Elasticsearch**
pour un dashboard Kibana, et (2) envoie une **notification push** pour les
événements sensibles (accès refusé géo/VPN, échec de déverrouillage,
auto-destruction, changement de mot de passe maître, effacement, import).

Endpoint : `POST /api/coffre/event` (déjà déployé avec le reste du Space).

## 1. Activer côté app

Coffre → ⚙️ Réglages → **Alertes de sécurité** → active l’interrupteur.
Ça demande la permission notifications, abonne l’appareil au push, et lance
l’envoi des événements. (Sur iPhone : coffre **installé sur l’écran d’accueil**.)

## 2. Variables d’environnement du Space (Settings → Secrets)

| Nom | Valeur |
|-----|--------|
| `ES_URL` | URL de ton Elasticsearch, ex. `https://xxxx.es.europe-west1.gcp.cloud.es.io:443` |
| `ES_API_KEY` | une clé API Elasticsearch encodée (voir ci-dessous) |
| `ES_INDEX` | (option) nom d’index, défaut `coffre-events` |
| `COFFRE_TOKEN` | (option) jeton anti-abus — mets **la même** valeur dans `coffre/app.js` (`COFFRE_TOKEN`) |

Les clés VAPID / `CRON_SECRET` du push sont déjà en place (cf. `PUSH_SETUP.md`).
Sans `ES_URL`/`ES_API_KEY`, l’indexation est simplement ignorée (le push marche quand même).

### Créer la clé API Elasticsearch
Kibana → **Stack Management → API keys → Create API key**, nomme-la `coffre`,
restreins-la à l’index `coffre-events` (privilège `create_doc`), puis copie la
valeur **encoded** (base64) → c’est `ES_API_KEY`.

Restriction de rôle recommandée (dans « Security privileges ») :
```json
{ "coffre-writer": { "indices": [ { "names": ["coffre-events*"], "privileges": ["create_doc","auto_configure"] } ] } }
```

## 3. Mapping d’index (optionnel mais propre)

Dans Kibana → **Dev Tools** :
```
PUT _index_template/coffre-events
{
  "index_patterns": ["coffre-events*"],
  "template": {
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "event":      { "type": "keyword" },
        "ok":         { "type": "boolean" },
        "ip":         { "type": "ip" },
        "meta": { "properties": {
          "city": { "type": "keyword" },
          "isp":  { "type": "keyword" },
          "dev":  { "type": "keyword" },
          "reason": { "type": "text" },
          "fails": { "type": "integer" }
        } }
      }
    }
  }
}
```

## 4. Dashboard Kibana

1. **Stack Management → Data Views → Create** : nom `coffre-events*`, champ temps `@timestamp`.
2. **Discover** : tu vois les événements en direct.
3. **Dashboard → Create** — visualisations utiles :
   - *Échecs vs succès* : courbe `count` splittée par `ok`.
   - *Types d’événements* : camembert sur `event`.
   - *Accès refusés par ville/opérateur* : table `meta.city` / `meta.isp` filtrée `event: access_denied`.
   - *Carte des IP* (si tu enrichis avec un ingest pipeline geoip sur `ip`).
4. **Alerting** (option) : règle « si `event: unlock_fail` count ≥ 3 en 10 min → email/Slack ».

## Test rapide
Active les alertes, puis provoque un **échec de déverrouillage** (mauvais mot de passe)
ou un **accès hors France** (VPN) : tu dois recevoir la notif push, et l’événement
apparaît dans Kibana Discover en quelques secondes.
