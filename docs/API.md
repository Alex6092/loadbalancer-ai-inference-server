# Contrat d’API

Voir `openapi.json` pour les schémas de l’API applicative. Les exemples utilisent une URL de base du service sans `/v1` final.

## Authentification et identité

`Authorization: Bearer <clé>` est requis sous `/v1`. `X-End-User-ID` est un identifiant **opaque**, stable et fourni par un serveur applicatif de confiance. Le service n’authentifie pas les élèves à la place de Moodle/Algomaze. Les clés d’une même application ont accès aux jobs de cette application ; les applications restent isolées. Une révocation bloque les nouveaux appels et les départs encore en attente, sans interrompre une génération déjà commencée.

Une liste vide de modèles, modes ou IP signifie aucune restriction de cette catégorie. Les modes sont `async`, `sync`, `stream`. En présence d’un reverse proxy, configurer uniquement ses IP/CIDR dans `TRUST_PROXY`.

## Jobs et chat

`POST /v1/jobs` : corps Chat Completions avec `callbackURL` facultatif et `stream` absent ou faux. Réponse `202` et en-tête `Location`. `Idempotency-Key` est facultatif et limité à 200 caractères ; même clé API + même identifiant + même payload et utilisateur renvoient le job existant avec `200`. Un contenu différent renvoie `409`. Les métadonnées d’idempotence persistent après purge du contenu ; utiliser un nouvel identifiant pour une nouvelle génération.

`GET /v1/jobs/{id}` renvoie les états `queued`, `running`, `succeeded`, `failed`, `cancelled`, `expired`. Les champs `result` et `error` sont nuls après purge, avec `content_expired=true`. `usage` cumule toutes les tentatives. Une callback en échec n’affecte pas le succès du job.

`queue.estimated_jobs_ahead` est un rang estimé à l’instant `calculated_at`, pour le modèle demandé. Il est nul pendant le délai d’un réessai. `reason` distingue `capacity`, `workers_unavailable`, `retry_backoff`. Ce rang ne prend pas en compte les demandes futures et ne garantit pas une durée.

`POST /v1/jobs/{id}/cancel` est idempotent, y compris sur un job terminé. L’arrêt distant est tenté en fermant la requête ; l’absence d’accusé d’arrêt crée une tentative incertaine, visible à l’administrateur.

`POST /v1/chat/completions` : même ordonnanceur, sans `callbackURL`. Sans streaming, attendre la réponse OpenAI normale. Avec `stream:true`, les en-têtes HTTP et `X-Job-ID` arrivent avant l’attribution. Les commentaires SSE `: queued` / `: heartbeat` ne contiennent pas de résultat. Le client doit les ignorer. Les fragments OpenAI sont suivis de `data: [DONE]`. Si une erreur survient après ouverture du flux, un événement `data: {"error":{…}}` précède `[DONE]` ; le statut HTTP est déjà `200`. Une interruption après le premier fragment n’est pas retentée automatiquement.

Le service transmet `stream_options.include_usage=true` au worker. Si les tokens finaux manquent, leur consommation est estimée et marquée. Les champs d’outils et de sortie structurée sont relayés ; aucune exécution d’outil n’a lieu dans le répartiteur. Seuls texte et images en entrée sont acceptés ; `n=1`. Les paramètres propres aux modèles restent validés par les workers.

## Quotas et erreurs

Exemple de politique, utilisé par l’administration :

```json
{
  "count": "both",
  "credit": { "enabled": true, "tokens": 1000000 },
  "windows": [
    { "enabled": true, "hours": 6, "tokens": 10000 },
    { "enabled": true, "hours": 24, "tokens": 30000 }
  ]
}
```

Le comptage vaut `input`, `output` ou `both`. Les crédits et fenêtres actifs doivent tous être respectés, à chaque niveau application/clé/utilisateur. Les réservations de jobs en attente ou en cours réduisent le budget disponible. Une modification de politique s’applique aux prochains contrôles ; avant le départ d’un job, le service revérifie son admission.

Les crédits ajoutés par recharge sont conservés dans un journal distinct. Modifier le crédit initial ne remet pas la consommation à zéro. Une politique utilisateur nulle hérite du défaut de l’application ; `{}` définit une exception sans quota utilisateur.

`GET /v1/usage?group=day&since=…&until=…` : période ISO et regroupement `application`, `key`, `user`, `model` ou `day`. Les filtres `key_id` et `user_id` utilisent les identifiants internes ; `X-End-User-ID` permet d’inclure les budgets de cet utilisateur s’il existe. L’API de consommation est un outil serveur d’application, pas un endpoint destiné directement aux élèves.

Toutes les erreurs applicatives ont la forme `{"error":{"code":"…","message":"…","details":{…}}}`. Principaux statuts :

| HTTP      | Sens                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| 400       | Corps, modèle, taille estimée, destination ou paramètres invalides            |
| 401 / 403 | Clé absente, désactivée ou droit insuffisant                                  |
| 404       | Job absent ou d’une autre application                                         |
| 409       | Conflit d’idempotence ou de configuration                                     |
| 429       | Quota insuffisant ; détails sur périmètre et budget, `retry_at` si calculable |
| 503       | File saturée ; réessayer plus tard                                            |
| 502 / 504 | Échec de génération ou expiration pour le chat synchrone                      |

`retry_at` ne prédit que le renouvellement du quota signalé, à consommation/réservations constantes. Il reste nul si une recharge est nécessaire, si les réservations empêchent tout calcul fiable ou si le job dépasse le plafond. Un `Retry-After` accompagne une échéance calculable.

## Callbacks

Le destinataire est un chemin sous une URL de base autorisée par application, sur la même origine. Aucune redirection n’est suivie. Les bases sans chemin autorisent tous les chemins de cette origine : préférer un préfixe dédié.

En-têtes : `X-Event-ID`, `X-Callback-Timestamp` (secondes Unix) et `X-Callback-Signature` (`sha256=` suivi du HMAC-SHA256 hexadécimal de `timestamp + "." + corps JSON brut`). Vérifier la signature à temps constant et la fraîcheur du timestamp avant tout traitement. Un nouveau timestamp et une nouvelle signature sont produits à chaque tentative ; le corps et l’identifiant restent stables.

```json
{
  "id": "identifiant-evenement",
  "type": "job.succeeded",
  "created_at": "2026-10-30T12:00:00.000Z",
  "job_id": "identifiant-job",
  "status": "succeeded",
  "result": { "choices": [{ "message": { "role": "assistant", "content": "…" } }] },
  "error": null
}
```

Les autres types sont `job.failed`, `job.cancelled`, `job.expired`. Le destinataire doit utiliser l’identifiant `id` du corps signé, vérifier son égalité avec `X-Event-ID`, puis l’enregistrer sous contrainte UNIQUE et appliquer son résultat dans la même transaction. Répondre `2xx` une fois durablement enregistré, y compris s’il a déjà été traité. Tous les échecs de livraison sont retentés, progressivement, jusqu’à une heure entre deux essais et pendant 24 h. Une relance manuelle renouvelle cette durée si le contenu n’a pas expiré.

## Administration

Les routes `/admin/api` utilisent le cookie de session retourné par `POST /login`, avec `{username,password}`. `GET /me` fournit le jeton CSRF à transmettre dans `X-CSRF-Token` pour toute mutation ; `POST /logout` ferme la session. Tous les administrateurs disposent des mêmes droits.

| Route relative à `/admin/api`                               | Méthode et contenu                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/snapshot`, `/events`                                      | GET : vue sans contenus de jobs / SSE d’actualisation                                                                                  |
| `/jobs?status=…&model=…&app_id=…&search=…&offset=…&limit=…` | GET : recherche par préfixe d’identifiant, filtres et pagination ; 100 par défaut, 200 maximum                                         |
| `/applications`                                             | POST : `name`, `enabled`, `require_user`, `policy`, `default_user_policy`, `callback_bases`                                            |
| `/applications/{id}`                                        | PUT : mêmes champs, remplacement complet                                                                                               |
| `/applications/{id}/rotate-callback-secret`                 | POST : nouveau secret affiché une fois                                                                                                 |
| `/applications/{id}/keys`                                   | POST : `name`, `enabled`, `policy`, `restrictions:{models,modes,ips}` ; clé affichée une fois                                          |
| `/keys/{id}`, `/keys/{id}/rotate`                           | PUT configuration complète / POST remplacement du secret                                                                               |
| `/users?app_id=…&offset=…&limit=…`                          | GET : utilisateurs, 100 par défaut, 500 maximum                                                                                        |
| `/users/{id}`                                               | PUT : `{policy:null}` pour hériter, ou politique d’exception                                                                           |
| `/credits`                                                  | POST : `scope` (`application`, `key`, `user`), `scope_id`, `tokens` positifs, `note`                                                   |
| `/quotas?app_id=…&key_id=…&user_id=…`                       | GET : budgets dans les périmètres indiqués                                                                                             |
| `/models`, `/models/{id}`                                   | POST / PUT : `id` à la création, `context_tokens`, `max_output_tokens`, `input_tokens_per_char`, `image_tokens`, `vision`              |
| `/workers`, `/workers/{id}`                                 | POST / PUT : `name`, `url`, `models`, `concurrency`, `enabled`, `secret` facultatif ; absent conserve le secret, chaîne vide le retire |
| `/workers/{id}/probe`                                       | POST : contrôle HTTP/catalogue immédiat                                                                                                |
| `/workers/{id}/release-uncertain`                           | POST : `{confirmed_remote_stopped:true}` après vérification distante                                                                   |
| `/jobs/{id}`                                                | GET : inspection explicite et auditée des contenus encore conservés                                                                    |
| `/jobs/{id}/cancel`                                         | POST : annulation                                                                                                                      |
| `/callbacks/{id}/retry`                                     | POST : relivraison de l’événement original                                                                                             |
| `/usage`                                                    | GET : mêmes filtres statistiques, toutes applications ou filtre `app_id`                                                               |
| `/accounts`                                                 | GET / POST : liste / création `{username,password}`                                                                                    |
| `/accounts/{id}/password`                                   | PUT : `{password}`, révoque les sessions de ce compte                                                                                  |

Pour une maintenance, modifier le worker avec `enabled:false` : aucune nouvelle attribution, les générations actives continuent. Changer son URL, son secret ou ses modèles exige l’absence de tentative active/incertaine. La création d’application fournit un secret callback à copier, et les vues suivantes ne renvoient aucun secret.
