# shellcheck shell=bash
# Sourced by the e2e scripts that install the chart (e2e/run/10-deploy.sh, e2e/gate4-restore.sh).
#
# KOBE-839: with KAIJU_E2E_MODEL_PORT set (CI: the runner serves the embeddings model there, from
# the GitHub Actions cache, see scripts/ci-embeddings-model.sh), the install takes the model from
# the runner instead of the internet: embeddings.local.model.url points at the k3d network's
# gateway (the Docker host as the nodes see it) and the embeddings pod may reach it. Everything
# else, the sha256 check included, is the chart's own. Unset (local runs): nothing changes, the
# init container downloads from the public URL.

embeddings_model_args() { # → helm arguments, one per line (none without KAIJU_E2E_MODEL_PORT)
  local port="${KAIJU_E2E_MODEL_PORT:-}" net gw
  [[ -n "$port" ]] || return 0
  [[ "$port" =~ ^[0-9]{2,5}$ ]] || { echo "KAIJU_E2E_MODEL_PORT must be a port number" >&2; return 1; }
  net="k3d-${KAIJU_CLUSTER:-kaiju}"
  gw=$(docker network inspect "$net" --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' \
    | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1) || true
  [[ -n "$gw" ]] || { echo "no IPv4 gateway on Docker network $net" >&2; return 1; }
  # The server must answer on that address before the chart's init container depends on it.
  curl -fsS -o /dev/null -r 0-0 --connect-timeout 5 "http://$gw:$port/model.gguf" \
    || { echo "the embeddings model is not served at http://$gw:$port/model.gguf" >&2; return 1; }
  printf '%s\n' --set "embeddings.local.model.url=http://$gw:$port/model.gguf" \
    --set-json "embeddings.local.networkPolicy.extraEgress=[{\"to\":[{\"ipBlock\":{\"cidr\":\"$gw/32\"}}],\"ports\":[{\"protocol\":\"TCP\",\"port\":$port}]}]"
}
