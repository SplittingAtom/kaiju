#!/usr/bin/env bash
# The embeddings model for the k3d e2e shards (KOBE-839), without the internet per cluster.
#
# Every shard creates a fresh cluster, and the chart's embeddings init container (`model`) used to
# download the GGUF from its public URL each time: slow enough that `helm --wait` ran out of time.
# CI now fetches the file once into the GitHub Actions cache (keyed by its sha256) and serves it to
# the cluster from the runner; the install points embeddings.local.model.url at that server
# (e2e/lib/embeddings-model.sh). The init container still checks the sha256, unchanged.
#
#   ci-embeddings-model.sh pin            prints url=… and sha256=… from charts/kaiju/values.yaml
#   ci-embeddings-model.sh fetch <dir>    downloads the model to <dir>/model.gguf (retries, sha256 checked)
#   ci-embeddings-model.sh verify <dir>   checks <dir>/model.gguf against the pinned sha256
#   ci-embeddings-model.sh serve <dir> <port>
#                                         serves <dir> over HTTP on every address of the runner, in
#                                         the background; the k3d nodes reach it at their Docker
#                                         network's gateway
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="${KAIJU_CHART_VALUES:-$ROOT/charts/kaiju/values.yaml}"
FILE=model.gguf

pin() { # → "url sha256" of embeddings.local.model in the chart's values
  local url sha
  read -r url sha < <(awk '
    /^embeddings:/ { e = 1; next }
    e && /^[^ #]/ { exit }
    e && /^    model:/ { m = 1; next }
    m && /^    [^ ]/ { exit }
    m && /^      url:/ { u = $2 }
    m && /^      sha256:/ { s = $2 }
    END { print u, s }
  ' "$VALUES")
  [[ "$url" =~ ^https?:// ]] || { echo "no embeddings.local.model.url in $VALUES" >&2; exit 1; }
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "no embeddings.local.model.sha256 in $VALUES" >&2; exit 1; }
  echo "$url $sha"
}

verify() { # dir → 0 when dir/model.gguf matches the pinned sha256
  local url sha
  read -r url sha < <(pin)
  echo "$sha  $1/$FILE" | sha256sum -c -
}

case "${1:-}" in
  pin)
    read -r url sha < <(pin)
    printf 'url=%s\nsha256=%s\n' "$url" "$sha"
    ;;
  verify) verify "${2:?usage: verify <dir>}" ;;
  fetch)
    dir="${2:?usage: fetch <dir>}"
    mkdir -p "$dir"
    read -r url sha < <(pin)
    for attempt in 1 2 3; do
      # A stalled transfer fails and resumes instead of hanging (as the chart's init container does).
      if curl -fsSL --connect-timeout 20 --speed-limit 1024 --speed-time 30 \
        --retry 5 --retry-delay 5 --retry-all-errors -C - -o "$dir/$FILE.part" "$url" \
        && echo "$sha  $dir/$FILE.part" | sha256sum -c -; then
        mv "$dir/$FILE.part" "$dir/$FILE"
        exit 0
      fi
      rm -f "$dir/$FILE.part"
      echo "::warning::embeddings model download failed (attempt $attempt of 3)"
      if [ "$attempt" -lt 3 ]; then sleep $((attempt * 20)); fi
    done
    exit 1
    ;;
  serve)
    dir="${2:?usage: serve <dir> <port>}"
    port="${3:?usage: serve <dir> <port>}"
    verify "$dir" >/dev/null
    command -v python3 >/dev/null || { echo "python3 missing: cannot serve the model" >&2; exit 1; }
    # All addresses: the k3d network (and its gateway) is created later, and the restore shard
    # deletes and recreates it. The runner is thrown away after the job.
    nohup python3 -m http.server "$port" --bind 0.0.0.0 --directory "$dir" >"${dir%/}-server.log" 2>&1 &
    for _ in $(seq 1 20); do
      if curl -fsS -o /dev/null -r 0-0 "http://127.0.0.1:$port/$FILE" 2>/dev/null; then
        echo "serving $dir/$FILE on port $port"
        exit 0
      fi
      sleep 0.5
    done
    echo "the model server did not answer on port $port" >&2
    exit 1
    ;;
  *)
    echo "usage: ci-embeddings-model.sh pin | fetch <dir> | verify <dir> | serve <dir> <port>" >&2
    exit 2
    ;;
esac
