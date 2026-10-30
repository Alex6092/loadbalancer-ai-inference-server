# Installation Linux

Pour la VM `172.29.254.21` et le runner GitHub, suivre **[le guide CI/CD](CICD.md)**. Les instructions manuelles ci-dessous sont une alternative, sans runner. Les unités fournies utilisent désormais `/opt/providence-ai/current`.

## Préparer la machine

Installer Node.js **24 LTS** et npm, puis copier le projet dans `/opt/providence-ai/current`. Les commandes ci-dessous sont à exécuter par l’administrateur du serveur et à adapter à votre distribution.

```sh
sudo useradd --system --home-dir /var/lib/providence-ai --create-home --shell /usr/sbin/nologin providence-ai
sudo install -d -m 0750 -o root -g providence-ai /etc/providence-ai
sudo install -d -m 0700 -o providence-ai -g providence-ai /var/lib/providence-ai
cd /opt/providence-ai/current
npm ci --omit=dev
npm run init
sudo install -m 0640 -o root -g providence-ai .env /etc/providence-ai/service.env
```

Dans `/etc/providence-ai/service.env`, définir au minimum :

```ini
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/var/lib/providence-ai/service.sqlite
SECURE_COOKIES=true
TRUST_PROXY=127.0.0.1,::1
```

Conserver l’`ENCRYPTION_KEY` générée. Ne pas déployer un `.env` de développement différent à côté du code. L’unité systemd fournit sa configuration via `EnvironmentFile` ; ne pas lancer le service en cluster ou avec plusieurs instances PM2.

Créer le premier compte avec l’identité système du service :

```sh
sudo -u providence-ai /usr/bin/env node --env-file=/etc/providence-ai/service.env scripts/create-admin.js administrateur
sudo install -m 0644 deploy/providence-ai.service /etc/systemd/system/
sudo install -m 0644 deploy/providence-ai-backup.service deploy/providence-ai-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now providence-ai.service
sudo systemctl enable --now providence-ai-backup.timer
sudo journalctl -u providence-ai -f
```

Configurer Nginx avec `deploy/nginx.conf`, un vrai nom DNS et ses certificats. Le port Node doit rester accessible uniquement au proxy local. Le buffering SSE est désactivé et le délai proxy couvre l’attente puis une génération. Le minuteur de sauvegarde s’exécute vers 02:30, heure système ; régler le fuseau du serveur sur Europe/Paris si souhaité.

## Mise à jour

1. Sauvegarder la base et vérifier l’accès à la clé de chiffrement.
2. Arrêter le service, déployer le code et exécuter `npm ci --omit=dev`.
3. Redémarrer. Les migrations s’appliquent transactionnellement avant l’écoute HTTP.
4. Vérifier les deux endpoints de santé, les workers et un job texte/streaming.

Les migrations sont ascendantes. Un retour à une ancienne version nécessitant un ancien schéma doit utiliser sa sauvegarde correspondante. Le service refuse une base dont la version de schéma est plus récente que le code.

## Sauvegarder

```sh
sudo -u providence-ai /usr/bin/env node --env-file=/etc/providence-ai/service.env scripts/backup.js
```

Les sauvegardes cohérentes sont créées dans `/var/lib/providence-ai/backups/`. Copier ces fichiers vers un stockage de sauvegarde contrôlé, et conserver le fichier d’environnement chiffré séparément. Le minuteur ne supprime aucune sauvegarde : configurer une rétention explicite, par exemple sept sauvegardes quotidiennes, selon les données d’élèves et la politique de l’établissement.

## Restaurer

1. Arrêter le service et vérifier qu’aucun processus n’utilise la base.
2. Préserver l’ensemble actuel : `service.sqlite`, `service.sqlite-wal` et `service.sqlite-shm` s’ils existent, dans un répertoire de récupération.
3. Installer la sauvegarde choisie à l’emplacement `DATABASE_PATH`, sans anciens fichiers WAL/SHM à cet emplacement. Rétablir propriétaire `providence-ai` et permissions `0600`.
4. Restaurer l’`ENCRYPTION_KEY` correspondant à la sauvegarde.
5. Redémarrer, vérifier les données et traiter les tentatives incertaines après vérification des workers.

Une restauration peut réémettre des callbacks déjà livrés après la date de sauvegarde. Les destinataires doivent conserver leurs identifiants d’événements dédupliqués. Elle peut également rejouer des jobs dont la fin n’est pas dans la sauvegarde : réconcilier les applications avant de rouvrir les envois si nécessaire.

## Surveillance

- File en attente et ancienneté des jobs, capacité occupée et tentatives incertaines.
- Erreurs workers, erreurs de livraison des callbacks et épuisement de quotas.
- Espace disque, croissance de la base et de ses sauvegardes, disponibilité du service systemd.
- Test régulier d’une restauration sur une machine isolée.

Le répertoire `service.sqlite.lock` empêche un deuxième ordonnanceur. Après un crash, un verrou dont le PID n’existe plus est retiré automatiquement. Si le PID est actif ou le verrou illisible, le service refuse de démarrer ; vérifier le processus avant toute suppression manuelle.

Les limites de file et de taille de corps bornent l’admission mais ne constituent pas une estimation précise de l’espace disque maximal. Les gros contenus vision doivent être dimensionnés selon votre stockage. Aucun test sur votre Linux, votre proxy ou vos GPU n’est exécuté par la suite locale Windows.
