# La Providence — Ordonnanceur IA

Service Node.js qui met en file les générations texte/vision et les distribue à des workers compatibles **OpenAI Chat Completions**. Stockage SQLite, callbacks signés, chat synchrone et streaming SSE, quotas combinables et administration en français. Installation Linux directe ; aucun conteneur requis.

## Démarrage local

Prérequis : **Node.js 24 LTS**, npm et disque local. Les dépendances sont verrouillées dans `package-lock.json`.

```sh
npm ci
npm run init
npm run admin:create -- administrateur
npm start
```

La commande de création demande le mot de passe en saisie masquée (12 caractères minimum). En exécution non interactive, elle le lit sur l’entrée standard, jamais dans les arguments. Ouvrir **http://127.0.0.1:3000/admin/**.

Dans l’administration :

1. Déclarer un modèle avec son identifiant exact, son contexte, sa sortie maximale et ses capacités vision.
2. Déclarer un worker avec son URL de base **incluant `/v1` si nécessaire**, sa clé et ses modèles. Le contrôle appelle `GET {base}/models` ; la génération appelle `POST {base}/chat/completions`. Cocher **Arrêt fiable à la fermeture de la connexion** si le serveur interrompt la génération quand la requête HTTP est fermée (vLLM, llama.cpp, LM Studio) : voir [Pannes et tentatives incertaines](#pannes-et-tentatives-incertaines).
3. Créer une application, ses quotas éventuels et ses destinations de callback. Conserver son secret de signature.
4. Créer une clé d’API. Elle n’est affichée qu’une fois. Par défaut, l’application demande un identifiant utilisateur ; désactiver cette obligation pour les traitements techniques sans utilisateur.
5. Appeler l’API depuis le serveur applicatif, avec `Authorization: Bearer …` et, si nécessaire, `X-End-User-ID`.

```sh
curl http://127.0.0.1:3000/v1/jobs \
  -H 'Authorization: Bearer VOTRE_CLE' \
  -H 'Content-Type: application/json' \
  -H 'X-End-User-ID: identifiant-opaque' \
  -H 'Idempotency-Key: correction-exercice-123' \
  -d '{"model":"VOTRE_MODELE","messages":[{"role":"user","content":"Explique le DNS."}],"max_tokens":512}'
```

## Fonctionnement

- Les jobs acceptés et les réservations sont écrits dans **une transaction**, avant l’accusé de réception. L’attribution d’une place et la création de sa tentative sont également atomiques.
- L’ordonnanceur remplit toutes les capacités compatibles. Il partage les départs entre applications puis utilisateurs, en conservant l’ordre d’arrivée au sein d’un groupe. Si les deux catégories attendent, trois départs de chat alternent avec un départ asynchrone. Aucune préemption.
- L’indication d’attente est une **estimation de rang pour le modèle**, calculée à partir des jobs éligibles et de l’état de l’ordonnanceur. Elle change avec les arrivées, priorités, réessais et workers. Elle n’est ni une durée ni une promesse d’ordre global.
- Les modèles sont déclarés manuellement. Le service ne charge pas les modèles et ne remplace pas silencieusement un modèle par un autre.
- Les quotas d’application, de clé et d’utilisateur s’appliquent ensemble. Une exception utilisateur remplace seulement sa politique utilisateur par défaut. Un utilisateur est identifié par le couple application/identifiant externe.
- Chaque politique choisit entrée, sortie ou les deux. Crédit et plusieurs fenêtres glissantes sont cumulables et désactivables. Sans règle active, aucun quota de tokens ne limite la clé ; les limites globales de capacité et de file restent applicables.
- Le budget estimé réserve l’entrée et la sortie maximale. L’estimation vision utilise un forfait configurable par image. Une sortie non précisée utilise le maximum configuré du modèle. Le comptage réel régularise la consommation ; un dépassement résiduel crée une dette et bloque les demandes suivantes.
- Les appels rejetés par un worker sans génération comptent zéro token. Une interruption dont le résultat est inconnu réserve comptablement l’estimation maximale, marquée comme estimée. Une annulation sur un worker à arrêt fiable compte les caractères déjà reçus en streaming (au plus la sortie maximale), ou la sortie maximale sans streaming, également marqués comme estimés. Les tentatives restent distinctes dans le registre de consommation.
- Les callbacks sont persistants, signés et réessayés pendant 24 heures. Leur livraison peut se répéter ; le destinataire déduplique `X-Event-ID`. Une panne de livraison ne relance pas la génération.
- En streaming, le client reçoit immédiatement `X-Job-ID`, puis des commentaires SSE pendant l’attente et les fragments OpenAI pendant la génération. Le statut se consulte séparément. Une déconnexion annule la demande et ferme la requête au worker. Aucun rejeu après le premier fragment exposé.

## Exploitation et sécurité

Configuration complète dans `.env.example`. `npm run init` crée `.env` sans écraser une configuration existante. Le mode HTTP local désactive les cookies HTTPS : **en production, régler `SECURE_COOKIES=true`** et utiliser le reverse proxy fourni.

- `TRUST_PROXY` contient uniquement les adresses/CIDR du proxy de confiance. Ne pas utiliser une confiance générale : les restrictions d’IP reposent sur l’adresse client ainsi obtenue.
- L’API est destinée aux serveurs Moodle/Algomaze. Ne jamais exposer une clé d’application dans le navigateur d’un élève. Ces serveurs sont responsables de l’identité utilisateur qu’ils transmettent et de l’autorisation de consulter les jobs de leurs utilisateurs.
- Les clés clientes sont hachées. Les secrets workers/callbacks sont chiffrés AES-256-GCM avec `ENCRYPTION_KEY`, hors base. Les mots de passe utilisent scrypt. Sessions administrateur de 12 h, cookies HttpOnly/SameSite, protection CSRF, limitation des tentatives de connexion.
- Une application autorise explicitement ses URL de base de callbacks (origine et préfixe de chemin). Les redirections sont interdites. Les administrateurs sont de confiance pour ces destinations et les URL workers ; filtrer les sorties réseau du service selon votre infrastructure.
- Les images distantes sont transmises aux workers sans téléchargement par le répartiteur. Leur accessibilité et les restrictions de récupération doivent aussi être configurées sur les workers. Les data URLs sont acceptées.
- Contenus purgés sept jours après fin, délai réglable. Requêtes, résultats, erreurs de contenu et payloads de callbacks sont supprimés ; aucune purge d’un callback encore à livrer. Les sauvegardes ont leur propre rétention.
- Les statistiques exposées couvrent 365 jours par défaut. Le registre comptable sans contenu est conservé pour les crédits à vie et les longues fenêtres ; les identifiants utilisateurs doivent donc être opaques. Les métadonnées de jobs et l’audit persistent sans contenu après purge.
- `/health/live` indique la présence du service ; `/health/ready` vérifie la base. La disponibilité des modèles se consulte via l’API authentifiée.

### Pannes et tentatives incertaines

Une rupture réseau, un délai de tentative dépassé ou un arrêt du service ne prouve pas l’arrêt d’un calcul distant. La tentative devient **incertaine** et continue d’occuper une place. Les autres places restent utilisables jusqu’à son échéance ; après celle-ci, le worker est exclu des attributions tant que l’incertitude subsiste. Un contrôle HTTP réussi ne suffit pas à libérer cette place.

Après vérification ou arrêt des calculs sur le worker, utiliser **Confirmer l’arrêt** dans l’administration. Ce choix conservateur évite de surcharger le serveur distant après une annulation. Les appels HTTP OpenAI compatibles n’offrent pas tous un accusé d’annulation fiable. Une reprise sur un autre worker peut néanmoins doubler du calcul ; un seul résultat final est enregistré.

**Annulations décidées par le service.** Quand le service ferme lui-même la requête au worker — client de streaming déconnecté (bouton « Arrêter », onglet fermé) ou `POST /v1/jobs/{id}/cancel` sur un job en cours — le résultat dépend du réglage du worker :

- **Arrêt fiable à la fermeture de la connexion** coché : la tentative se termine `cancelled`, sa place est libérée aussitôt et le worker reste disponible, sans confirmation. À réserver aux serveurs qui interrompent réellement le calcul à la fermeture de la connexion HTTP (vLLM, llama.cpp/llama-server, LM Studio). Vérifier ce comportement sur la version déployée, et le désactiver derrière un intermédiaire qui maintiendrait la requête vers le serveur d’inférence.
- Non coché (par défaut, et pour les workers existants) : la tentative devient incertaine, comme ci-dessus.

Ce réglage par worker a été préféré à une libération automatique après un court délai : un délai fixe bloquerait inutilement une place sur un serveur qui s’arrête immédiatement, et libérerait à tort une place sur un serveur qui continue de générer jusqu’à la sortie maximale. Les ruptures réseau, délais dépassés et redémarrages restent incertains quel que soit ce réglage, car le service n’a alors pas lui-même fermé la connexion de façon contrôlée.

Un arrêt propre conserve pour reprise les jobs asynchrones réessayables et annule les chats déconnectés. Après crash, les jobs en attente reprennent ; les tentatives actives deviennent incertaines et leur consommation est estimée une seule fois. Trois tentatives maximum, délai d’attente initial conservé.

## Installation Linux et sauvegarde

Le déploiement automatique par GitHub Actions sur la VM Debian est décrit dans [le guide CI/CD](docs/CICD.md). Les tests des pull requests utilisent GitHub ; seuls les déploiements de `main` utilisent le runner autohébergé.

Voir [le guide d’exploitation](docs/OPERATIONS.md), l’unité [systemd](deploy/providence-ai.service) et la configuration [Nginx](deploy/nginx.conf).

```sh
npm run backup
```

Cette commande utilise la sauvegarde en ligne SQLite, même si le service tourne, vers `backups/` à côté de la base. Ne pas copier seulement le fichier principal d’une base ouverte en mode WAL. Conserver la clé de chiffrement séparément et tester la restauration.

## Contrat d’API et exemples

- [Contrat et administration](docs/API.md).
- [OpenAPI 3.1](docs/openapi.json), également servi sur `/openapi.json`.
- [Job asynchrone JavaScript](examples/async-job.js).
- [Chat en streaming JavaScript avec suivi d’attente](examples/stream-chat.js).
- [Extraits PHP pour Moodle et signature de callback](examples/moodle-client.php).

L’adaptation réelle de Moodle et d’Algomaze est le **second lot**, après validation de ce contrat et accès à leurs sources. Audio, génération d’images, embeddings, Responses API, haute disponibilité et chargement automatique des modèles sont hors première version.

## Vérifications

```sh
npm run check
npm test
```

Tests avec de vrais échanges HTTP vers des workers simulés : rafale de 200 jobs, capacité, équité, routage, quotas concurrents, vision, flux SSE, annulation, pannes, callbacks, reprise, sauvegarde/restauration et isolation. Les compatibilités et capacités réelles devront être validées avec les workers de l’établissement avant la mise en production.
