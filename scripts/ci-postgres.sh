#!/usr/bin/env bash
# PostgreSQL 17 on localhost:5432 for the CI database jobs (KOBE-415). A service container cannot
# retry its pull, and Google's Docker Hub mirror sometimes answers 429 (toomanyrequests) at once;
# this tries the mirror and ECR Public's copy of the official image, three rounds a little apart.
# With --pgvector (KOBE-409) it also installs pgvector from PGDG (the official image's apt source),
# so vector memory tests run; without it the server has no pgvector, which proves migrations and the
# FTS-only path on such a Postgres (external installs).
set -euo pipefail

password="${1:?usage: ci-postgres.sh <password> [--pgvector]}"
pgvector="${2:-}"
images=(mirror.gcr.io/library/postgres:17 public.ecr.aws/docker/library/postgres:17)
name=kobe-ci-postgres

image=""
for attempt in 1 2 3; do
  for candidate in "${images[@]}"; do
    if docker pull -q "$candidate"; then
      image="$candidate"
      break 2
    fi
    echo "::warning::could not pull $candidate (round $attempt of 3)"
  done
  if [ "$attempt" -lt 3 ]; then sleep $((attempt * 15)); fi
done
if [ -z "$image" ]; then
  echo "::error::could not pull postgres:17 from ${images[*]}"
  exit 1
fi

# Debian package from the PGDG source the image already carries; tried three times.
install_pgvector() {
  for attempt in 1 2 3; do
    if docker exec -e DEBIAN_FRONTEND=noninteractive "$name" sh -c \
      'apt-get update -q >/dev/null && apt-get install -y -q --no-install-recommends postgresql-17-pgvector >/dev/null'; then
      echo "pgvector installed: $(docker exec "$name" sh -c "dpkg-query -W -f='\${Version}' postgresql-17-pgvector")"
      return 0
    fi
    echo "::warning::could not install pgvector (round $attempt of 3)"
    sleep $((attempt * 10))
  done
  echo "::error::could not install postgresql-17-pgvector"
  exit 1
}

docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -p 5432:5432 "$image" >/dev/null
# Over TCP: the image's init server listens on its socket only, so this sees the real one.
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
    if [ "$pgvector" = "--pgvector" ]; then
      install_pgvector
    fi
    echo "postgres:17 ready from $image"
    exit 0
  fi
  sleep 1
done
docker logs "$name" 2>&1 | tail -n 20
echo "::error::postgres did not become ready within 60 s"
exit 1
