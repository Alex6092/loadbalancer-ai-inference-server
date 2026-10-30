# CI/CD et runner Debian

## Déclenchement

Le workflow **Validation et déploiement** lance les vérifications JavaScript, les tests et le contrôle du contrat OpenAPI sur chaque pull request et chaque push sur `main`. Les tests utilisent Node.js 24 sur un runner GitHub Ubuntu. Les actions officielles sont épinglées par SHA, avec mise à jour proposée par Dependabot.

Après réussite des tests de `main`, le job de déploiement utilise le runner dédié `providence-ai-debian-21`, label `providence-ai-production`, sur `172.29.254.21`. L’environnement GitHub `production` est limité à la branche `main`. Un lancement manuel est également disponible dans Actions. Les déploiements sont sérialisés et ne s’annulent pas mutuellement pendant les migrations.

Le dépôt est public : les contributions externes doivent être approuvées avant exécution. Ne jamais approuver un workflow modifié qui exécute une pull request sur le runner de production. Le workflow fourni réserve la VM aux commits de `main`.

## VM et identités

- `actions-runner` : réception des jobs GitHub, sans accès au fichier d’environnement ni à SQLite.
- `providence-build` : installation des dépendances dans un répertoire isolé ; pas d’accès aux secrets ou aux données.
- `providence-ai` : exécution de l’application et accès aux données persistantes.
- `root` : commande de déploiement installée une fois, configuration Nginx et unités systemd.

Le seul sudo accordé au runner est `/usr/local/sbin/providence-ai-deploy SHA`. Cette commande récupère elle-même le dépôt public et vérifie que le SHA demandé est encore la tête de `main`. Elle n’exécute aucun script provenant du workspace du runner. Le runner n’a besoin ni d’une clé SSH ni d’un PAT GitHub pour déployer. Son enregistrement initial utilise un jeton GitHub temporaire transmis par stdin.

## Installation initiale

Depuis une copie vérifiée de ce dépôt sur la VM :

```sh
sudo bash deploy/bootstrap-vm.sh
```

Le script installe Node.js 24 depuis `nodejs.org`, vérifie son archive SHA256, installe Nginx et prépare les comptes, les répertoires et les unités systemd. Il ne remplace pas un fichier `service.env` existant. Il cible Debian 12 x64 et la VM sans site web préexistant vérifiée lors de l’installation.

Dans GitHub, créer un runner Linux x64 pour le dépôt. Utiliser la version et le SHA256 du téléchargement officiel avec :

```sh
# Le jeton temporaire est fourni sur stdin, pas stocké dans le dépôt.
sudo bash deploy/register-runner.sh VERSION SHA256
```

Le script lit le jeton sur une ligne, vérifie l’archive et installe le runner comme service. Les credentials du runner restent dans son répertoire privé `/opt/actions-runner`. Aucun jeton administrateur GitHub permanent n’est enregistré sur la VM.

## Adresses et fichiers

L’application est accessible sur **http://172.29.254.21/admin/**, sur le réseau interne choisi. Nginx écoute l’IP privée au port 80 ; Node écoute seulement `127.0.0.1:3000`. La configuration utilise `SECURE_COOKIES=false` pour cet accès HTTP. Pour une future URL HTTPS, adapter Nginx et passer cette valeur à `true`.

| Emplacement                                | Contenu                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `/opt/providence-ai/releases/SHA`          | Version immuable du code et de ses dépendances, propriétaire root                  |
| `/opt/providence-ai/current`               | Lien vers la version active                                                        |
| `/etc/providence-ai/service.env`           | Configuration et clé de chiffrement ; conservées entre déploiements                |
| `/etc/providence-ai/release.env`           | SHA de la version active, exposé dans les endpoints de santé                       |
| `/var/lib/providence-ai/service.sqlite`    | Base persistante                                                                   |
| `/var/lib/providence-ai/backups/`          | Sauvegardes quotidiennes et sauvegardes avant déploiement                          |
| `/var/lib/providence-ai/initial-admin.txt` | Identifiants générés au premier déploiement, sans apparition dans les logs Actions |
| `/run/providence-ai-maintenance`           | Présence du fichier : Nginx répond 503 pendant le basculement                      |

Récupérer les identifiants initiaux depuis une session SSH autorisée :

```sh
sudo cat /var/lib/providence-ai/initial-admin.txt
```

Modifier ensuite le mot de passe dans l’administration et retirer ce fichier après conservation du nouveau secret dans votre gestionnaire de mots de passe. Les autres déploiements ne réinitialisent aucun compte.

## Séquence de déploiement

1. Verrou exclusif de déploiement ; récupération et vérification de la tête de `main`. Un ancien commit dépassé est ignoré.
2. Préparation de la nouvelle version et `npm ci --omit=dev` sous `providence-build`, avec test de démarrage sur base en mémoire. L’ancienne version reste disponible pendant cette étape.
3. Activation de la maintenance Nginx, arrêt propre de l’application puis sauvegarde SQLite cohérente. Les callbacks et générations reprennent selon les règles habituelles du service.
4. Basculement atomique du lien `current`, écriture du SHA et démarrage systemd ; les migrations restent transactionnelles.
5. Trois contrôles de santé consécutifs, exigeant le bon SHA, sur le backend puis via Nginx ; ouverture du trafic applicatif après validation des deux parcours. La sonde de santé seule reste accessible pendant la maintenance.
6. Conservation des cinq versions de code les plus récentes, en gardant aussi la version précédente. Aucune suppression automatique des données ou sauvegardes.

En cas d’échec après l’arrêt, la commande rétablit la sauvegarde SQLite et la version précédente avant de rouvrir Nginx. Sur le tout premier déploiement, il n’y a pas encore de version précédente ; la maintenance reste active en cas d’échec.

Les arrêts forcés non interceptables (coupure VM, `SIGKILL`) peuvent laisser le mode maintenance actif. Vérifier le service et les journaux avant de relancer le workflow. Le fichier de maintenance n’est retiré que lorsqu’une version cohérente est vérifiée.

## Surveillance et maintenance

```sh
sudo systemctl status providence-ai
sudo journalctl -u providence-ai -n 100 --no-pager
sudo systemctl list-units 'actions.runner.*'
sudo systemctl list-timers providence-ai-backup.timer
curl -fsS http://172.29.254.21/health/ready
```

L’endpoint de santé renvoie `status` et `release`. Le SHA doit correspondre au commit déployé indiqué dans Actions. Surveiller l’espace disque, notamment les sauvegardes et le cache npm. La VM initiale possède environ 10 Go de disque ; les sauvegardes doivent avoir une politique de rétention et être exportées selon votre exploitation.

Les changements aux scripts privilégiés, à Nginx, aux unités systemd ou au runtime nécessitent une nouvelle installation explicite et vérifiée par l’administrateur ; ils ne sont pas installés automatiquement à partir du workspace du runner.
