#!/usr/bin/env bash
# Installed once as /usr/local/sbin/providence-ai-deploy, owned by root.
# The runner can request a SHA, but cannot supply executable files or paths.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export GIT_TERMINAL_PROMPT=0
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH

repository=https://github.com/Alex6092/loadbalancer-ai-inference-server.git
base=/opt/providence-ai
state=/var/lib/providence-ai-deploy
build_home=/var/lib/providence-ai-build
data=/var/lib/providence-ai
environment=/etc/providence-ai/service.env
release_environment=/etc/providence-ai/release.env
maintenance=/run/providence-ai-maintenance
current="$base/current"
previous=''
backup=''
database=''
stage=''
incoming=''
transaction=0

die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'Cette commande doit être lancée via sudo.'
[[ $# -eq 1 && $1 =~ ^[0-9a-f]{40}$ ]] || die 'Un unique SHA Git de 40 caractères est requis.'
revision=$1
exec 9>/run/lock/providence-ai-deploy.lock
flock -w 120 9 || die 'Un autre déploiement est en cours.'
[[ -f $environment ]] || die 'Configuration absente ; exécuter bootstrap-vm.sh.'
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || die 'Node.js 24 requis.'

cleanup_stage() {
  if [[ -n $stage && $stage == "$build_home/$revision" && -d $stage ]]; then
    rm -rf --one-file-system -- "$stage"
  fi
  if [[ -n $incoming && $incoming == "$base/releases/.incoming-$revision" && -d $incoming ]]; then
    rm -rf --one-file-system -- "$incoming"
  fi
}
switch_current() {
  [[ ! -e "$base/current.next" || -L "$base/current.next" ]] || return 1
  ln -sfn -- "$1" "$base/current.next"
  mv -Tf -- "$base/current.next" "$current"
}
write_release_environment() {
  printf 'RELEASE_SHA=%s\n' "$1" > "$release_environment"
  chmod 0644 "$release_environment"
}
healthy() {
  local expected=$1 url=${2:-http://127.0.0.1:3000/health/ready} successes=0 body
  for _ in $(seq 1 40); do
    body=$(curl --fail --silent --max-time 3 "$url") || body=''
    if printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ok" and d.get("release")==sys.argv[1] else 1)' "$expected" 2>/dev/null; then
      successes=$((successes+1))
      [[ $successes -ge 3 ]] && return 0
    else
      successes=0
    fi
    sleep 1
  done
  return 1
}
rollback() {
  local result=${1:-$?}
  [[ $result -ne 0 ]] || result=1
  trap - ERR INT TERM
  set +e
  printf 'Échec du déploiement %s ; récupération.\n' "$revision" >&2
  if [[ $transaction -eq 1 ]]; then
    touch "$maintenance"
    systemctl stop providence-ai.service
    if [[ -n $backup && -f $backup && $database == "$data/"* && $database != "$data/backups/"* ]]; then
      rm -f -- "${database}-wal" "${database}-shm"
      install -o providence-ai -g providence-ai -m 0600 -- "$backup" "$database"
    fi
    if [[ -n $previous && -d $previous ]]; then
      switch_current "$previous"
      write_release_environment "${previous##*/}"
      systemctl reset-failed providence-ai.service
      systemctl start providence-ai.service
      if healthy "${previous##*/}" && healthy "${previous##*/}" http://172.29.254.21/health/ready; then
        rm -f -- "$maintenance"
        printf 'Version précédente restaurée : %s\n' "${previous##*/}" >&2
      else
        printf 'Récupération à vérifier : mode maintenance conservé.\n' >&2
      fi
    else
      printf 'Premier déploiement échoué : mode maintenance conservé.\n' >&2
    fi
  fi
  cleanup_stage
  exit "${result:-1}"
}
trap cleanup_stage EXIT
trap rollback ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

install -d -m 0755 "$state" "$base/releases"
if [[ ! -d $state/repository.git ]]; then
  git init --bare "$state/repository.git" >/dev/null
  git --git-dir="$state/repository.git" remote add origin "$repository"
fi
git --git-dir="$state/repository.git" fetch --quiet --depth=1 origin refs/heads/main
head=$(git --git-dir="$state/repository.git" rev-parse FETCH_HEAD)
if [[ $head != "$revision" ]]; then
  printf 'Commit dépassé : %s ; main pointe sur %s. Aucun changement.\n' "$revision" "$head"
  exit 0
fi
release="$base/releases/$revision"
if [[ -L $current ]]; then previous=$(readlink -f "$current"); fi
if [[ $previous == "$release" ]] && healthy "$revision"; then
  rm -f -- "$maintenance"
  printf 'Version déjà active : %s\n' "$revision"
  exit 0
fi

if [[ ! -d $release ]]; then
  stage="$build_home/$revision"
  [[ ! -e $stage ]] || die 'Répertoire de préparation déjà présent ; vérifier le précédent déploiement.'
  install -d -o providence-build -g providence-build -m 0700 "$stage"
  git --git-dir="$state/repository.git" archive "$revision" | tar -x -C "$stage" --no-same-owner
  chown -R --no-dereference providence-build:providence-build "$stage"
  (
    cd "$stage"
    runuser -u providence-build -- env HOME="$build_home" npm ci --omit=dev --no-audit --no-fund
    runuser -u providence-build -- node --input-type=module -e '
      import { createServer } from "./src/server.js";
      const app = await createServer({database:":memory:",encryptionKey:Buffer.alloc(32,1).toString("base64"),logger:false,background:false});
      await app.ready();
      if ((await app.inject("/health/ready")).statusCode !== 200) process.exit(1);
      await app.close();
    '
  )
  incoming="$base/releases/.incoming-$revision"
  install -d -m 0755 "$incoming"
  cp -a -- "$stage/." "$incoming/"
  chown -R --no-dereference root:providence-ai "$incoming"
  chmod -R u+rwX,go+rX,go-w "$incoming"
  mv -T -- "$incoming" "$release"
  incoming=''
  cleanup_stage
  stage=''
fi

# Resolve only the database path, never print or export production secrets.
database=$(
  cd "$release"
  runuser -u providence-ai -- node --env-file="$environment" --input-type=module -e '
    import { configuration } from "./src/config.js"; process.stdout.write(configuration().database);
  '
)
database=$(realpath -m -- "$database")
[[ $database == "$data/"* && $database != "$data/backups/"* && $database != "$data" ]] || die 'La base doit rester dans /var/lib/providence-ai, hors backups.'
[[ ! -L $database ]] || die 'Une base SQLite ne doit pas être un lien symbolique.'
touch "$maintenance"
transaction=1
systemctl stop providence-ai.service
if [[ -f $database ]]; then
  [[ -n $previous ]] || die 'Base existante sans version précédente : intervention manuelle requise.'
  install -d -o providence-ai -g providence-ai -m 0700 "$data/backups"
  backup_target="$data/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ)-$revision.sqlite"
  (
    cd "$previous"
    runuser -u providence-ai -- node --input-type=module -e '
      import Database from "better-sqlite3";
      const db=new Database(process.argv[1],{readonly:true}); await db.backup(process.argv[2]); db.close();
      const snapshot=new Database(process.argv[2],{readonly:true});
      if(snapshot.pragma("integrity_check",{simple:true})!=="ok") throw new Error("Sauvegarde invalide"); snapshot.close();
    ' "$database" "$backup_target"
  )
  backup=$backup_target
  chmod 0600 "$backup"
fi
switch_current "$release"
write_release_environment "$revision"
systemctl reset-failed providence-ai.service
systemctl start providence-ai.service
healthy "$revision"
healthy "$revision" http://172.29.254.21/health/ready

# First installation only: keep the generated login on the VM, never in Actions logs.
admin_count=$(
  cd "$release"
  runuser -u providence-ai -- node --input-type=module -e '
    import Database from "better-sqlite3"; const db=new Database(process.argv[1],{readonly:true});
    process.stdout.write(String(db.prepare("SELECT COUNT(*) n FROM admins").get().n)); db.close();
  ' "$database"
)
if [[ $admin_count == 0 ]]; then
  password=$(openssl rand -base64 24)
  (
    cd "$release"
    printf '%s\n' "$password" | runuser -u providence-ai -- node --env-file="$environment" scripts/create-admin.js administrateur >/dev/null
  )
  (umask 077; printf 'Identifiant : administrateur\nMot de passe : %s\n' "$password" > "$data/initial-admin.txt")
  chown providence-ai:providence-ai "$data/initial-admin.txt"
  unset password
fi
rm -f -- "$maintenance"
transaction=0
printf 'Déploiement terminé : %s\n' "$revision"

# Only reproducible code releases are pruned. Data and backups are never removed.
while IFS= read -r obsolete; do
  [[ $obsolete == "$base/releases/"* && ${obsolete##*/} =~ ^[0-9a-f]{40}$ ]] || continue
  [[ $obsolete != "$release" && $obsolete != "$previous" ]] || continue
  rm -rf --one-file-system -- "$obsolete"
done < <(find "$base/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d ' ' -f2-)
