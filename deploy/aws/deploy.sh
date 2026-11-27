#!/bin/bash
# Deploys Wolog to the AWS server (apps.marcusbailey.com/wolog/). Run on the Mac, from anywhere
# in the repo, after CI has passed on main:
#
#   deploy/aws/deploy.sh            # the latest commit on main
#   deploy/aws/deploy.sh 1a2b3c4    # a particular commit (e.g. to roll back)
#
# CI pushes images tagged sha-<commit> for every commit on main; the server pulls that tag.
# Database migrations run when the API starts, before it serves. They don't undo on a rollback.
set -euo pipefail
HOST=${HOST:-admin@apps.marcusbailey.com}
cd "$(git rev-parse --show-toplevel)"

git fetch -q origin main
COMMIT=$(git rev-parse --verify "${1:-origin/main}^{commit}")
TAG=sha-${COMMIT:0:7}   # exactly 7, as CI tags
echo "== Deploying $TAG: $(git log -1 --format=%s "$COMMIT")"

scp -q docker-compose.aws.yml "$HOST:/srv/wolog/compose.yml"
ssh "$HOST" TAG="$TAG" bash -s <<'REMOTE'
set -euo pipefail
cd /srv/wolog
[ -f .env ] || { echo ".env missing in /srv/wolog: see README (Deploying to AWS, First time)" >&2; exit 1; }
export WOLOG_TAG=$TAG
if ! docker compose pull -q; then
  echo "Couldn't pull $TAG. Has CI finished on that commit? (gh run list --branch main)" >&2
  exit 1
fi
docker compose up -d --remove-orphans
healthy=
for _ in $(seq 45); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' wolog-backend wolog-frontend | sort -u)" = healthy ]; then
    healthy=1
    break
  fi
  sleep 2
done
docker compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'
if [ -z "$healthy" ]; then
  previous=$(sed -n 's/^WOLOG_TAG=//p' .env)
  echo "$TAG isn't healthy. Logs: docker logs wolog-backend (or wolog-frontend)." >&2
  echo ".env still names ${previous:-no tag}; roll back with deploy/aws/deploy.sh ${previous#sha-}" >&2
  exit 1
fi
# Remember the tag in .env only once healthy, so plain `docker compose ...` (and a reboot's
# restart) runs a release that worked.
if grep -q '^WOLOG_TAG=' .env; then sed -i "s/^WOLOG_TAG=.*/WOLOG_TAG=$TAG/" .env; else echo "WOLOG_TAG=$TAG" >> .env; fi
# Old releases' images (CI's registry keeps 20 to roll back to), and dangling layers.
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^ghcr.io/marcus-bailey/wolog-' \
  | grep -v ":$TAG\$" | xargs -r docker image rm >/dev/null 2>&1 || true
docker image prune -f >/dev/null
REMOTE
echo "== https://apps.marcusbailey.com/wolog/"
