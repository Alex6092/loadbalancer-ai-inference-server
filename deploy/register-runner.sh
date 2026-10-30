#!/usr/bin/env bash
# sudo bash deploy/register-runner.sh VERSION SHA256 < registration-token
# Only the short-lived repository registration token is read from stdin.
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID -eq 0 && $# -eq 2 ]] || { printf 'Root, version et SHA256 requis.\n' >&2; exit 1; }
version=$1
checksum=$2
[[ $version =~ ^2\.[0-9]+\.[0-9]+$ && $checksum =~ ^[0-9a-f]{64}$ ]]
IFS= read -r registration_token
registration_token=${registration_token%$'\r'}
[[ -n $registration_token ]] || { printf 'Jeton d’enregistrement absent.\n' >&2; exit 1; }
cd /opt/actions-runner
if [[ ! -f .runner ]]; then
  archive="actions-runner-linux-x64-$version.tar.gz"
  curl --fail --silent --show-error --location "https://github.com/actions/runner/releases/download/v$version/$archive" -o "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check -
  tar -xzf "$archive" --no-same-owner
  rm -f -- "$archive"
  ./bin/installdependencies.sh
  chown -R actions-runner:actions-runner /opt/actions-runner
  runuser -u actions-runner -- ./config.sh --unattended \
    --url https://github.com/Alex6092/loadbalancer-ai-inference-server \
    --token "$registration_token" --name providence-ai-debian-21 \
    --labels providence-ai-production --work _work
fi
unset registration_token
if [[ ! -f .service ]]; then ./svc.sh install actions-runner; fi
./svc.sh start
./svc.sh status
