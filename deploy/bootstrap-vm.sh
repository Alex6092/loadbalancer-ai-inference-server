#!/usr/bin/env bash
# One-time, explicit root installation. Never executed by a pull request.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 ]] || { printf 'Exécuter avec sudo.\n' >&2; exit 1; }
source_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -m) == x86_64 ]] || { printf 'Cette installation cible Linux x64.\n' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx python3 openssl xz-utils build-essential libicu72 libssl3 zlib1g

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  temporary=$(mktemp -d)
  trap 'rm -rf -- "$temporary"' EXIT
  curl --fail --silent --show-error https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$temporary/SHASUMS256.txt"
  filename=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' "$temporary/SHASUMS256.txt")
  [[ $filename =~ ^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]]
  curl --fail --silent --show-error "https://nodejs.org/dist/latest-v24.x/$filename" -o "$temporary/$filename"
  (cd "$temporary"; grep " $filename$" SHASUMS256.txt | sha256sum --check -)
  install -d /usr/local/lib/nodejs
  tar -xJf "$temporary/$filename" -C /usr/local/lib/nodejs --no-same-owner
  runtime="/usr/local/lib/nodejs/${filename%.tar.xz}"
  for executable in node npm npx; do ln -sfn "$runtime/bin/$executable" "/usr/local/bin/$executable"; done
  rm -rf -- "$temporary"
  trap - EXIT
fi
node --version
npm --version
for account in providence-ai providence-build actions-runner; do
  case "$account" in
    providence-ai) home=/var/lib/providence-ai ;;
    providence-build) home=/var/lib/providence-ai-build ;;
    actions-runner) home=/opt/actions-runner ;;
  esac
  if ! id "$account" >/dev/null 2>&1; then useradd --system --user-group --create-home --home-dir "$home" --shell /usr/sbin/nologin "$account"; fi
done
install -d -o providence-ai -g providence-ai -m 0700 /var/lib/providence-ai
install -d -o providence-build -g providence-build -m 0700 /var/lib/providence-ai-build
install -d -o actions-runner -g actions-runner -m 0700 /opt/actions-runner
install -d -o root -g root -m 0755 /opt/providence-ai /opt/providence-ai/releases /var/lib/providence-ai-deploy
install -d -o root -g providence-ai -m 0750 /etc/providence-ai
if [[ ! -f /etc/providence-ai/service.env ]]; then
  key=$(openssl rand -base64 32)
  (umask 077; cat > /etc/providence-ai/service.env <<EOF
ENCRYPTION_KEY=$key
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/var/lib/providence-ai/service.sqlite
SECURE_COOKIES=false
TRUST_PROXY=127.0.0.1,::1
RETENTION_DAYS=7
STATISTICS_DAYS=365
ASYNC_WAIT_SECONDS=86400
CHAT_WAIT_SECONDS=600
ATTEMPT_TIMEOUT_SECONDS=1800
PROBE_INTERVAL_SECONDS=15
MAX_QUEUED=2000
MAX_QUEUED_PER_APP=500
EOF
  )
  unset key
  chown root:providence-ai /etc/providence-ai/service.env
  chmod 0640 /etc/providence-ai/service.env
fi
install -o root -g root -m 0755 "$source_directory/deploy/deploy-release.sh" /usr/local/sbin/providence-ai-deploy
printf 'actions-runner ALL=(root) NOPASSWD: /usr/local/sbin/providence-ai-deploy *\n' > /etc/sudoers.d/providence-ai-deploy
chmod 0440 /etc/sudoers.d/providence-ai-deploy
visudo -cf /etc/sudoers.d/providence-ai-deploy
install -m 0644 "$source_directory/deploy/providence-ai.service" /etc/systemd/system/
install -m 0644 "$source_directory/deploy/providence-ai-backup.service" "$source_directory/deploy/providence-ai-backup.timer" /etc/systemd/system/
install -m 0644 "$source_directory/deploy/nginx-internal.conf" /etc/nginx/sites-available/providence-ai
ln -sfn /etc/nginx/sites-available/providence-ai /etc/nginx/sites-enabled/providence-ai
# This VM was checked before installation: it has no existing website.
if [[ -L /etc/nginx/sites-enabled/default ]]; then unlink /etc/nginx/sites-enabled/default; fi
nginx -t
systemctl daemon-reload
touch /run/providence-ai-maintenance
systemctl enable --now nginx.service
systemctl reload nginx.service
systemctl enable providence-ai.service
systemctl enable --now providence-ai-backup.timer
printf 'VM prête. Enregistrer ensuite le runner GitHub, puis pousser le workflow sur main.\n'
