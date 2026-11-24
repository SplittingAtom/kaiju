# shellcheck shell=bash
# Sourced by e2e/run.sh (KOBE-728 split of the former single script); not run on its own.
echo "==> prerequisites"
$KUBECTL get runtimeclass gvisor >/dev/null 2>&1 || { echo "RuntimeClass gvisor missing: run scripts/dev-cluster.sh" >&2; exit 2; }
$KUBECTL get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 \
  || { echo "agent-sandbox CRDs missing: run scripts/install-agent-sandbox.sh" >&2; exit 2; }

# k3s installs its bundled Traefik and CoreDNS asynchronously through helm-install Jobs that can retry for minutes
# (KOBE-134: Service traefik did not exist for ~4 min, so probes got "bad address"). Wait on the conditions, not time.
INFRA_TIMEOUT=${INFRA_TIMEOUT:-420s}
for d in coredns traefik; do
  $KUBECTL -n kube-system wait --for=create "deployment/$d" --timeout="$INFRA_TIMEOUT" >/dev/null \
    && $KUBECTL -n kube-system rollout status "deployment/$d" --timeout="$INFRA_TIMEOUT" >/dev/null \
    || { echo "kube-system/$d not available within $INFRA_TIMEOUT" >&2; exit 2; }
done
$KUBECTL -n kube-system wait --for=create service/traefik --timeout="$INFRA_TIMEOUT" >/dev/null \
  || { echo "kube-system/traefik Service missing" >&2; exit 2; }

echo "==> clean state"
$HELM uninstall kobe -n "$NS" --wait >/dev/null 2>&1 || true
$KUBECTL delete namespace "$NS" kobe-deps "$SANDBOX_NS" "$TEAM_NS" "$TEAM2_NS" "$UPSTREAM_NS" "$MCP_NS" "$LLM_NS" "$OTEL_NS" --ignore-not-found --wait=false >/dev/null
for ns in "$NS" kobe-deps "$SANDBOX_NS" "$TEAM_NS" "$TEAM2_NS" "$UPSTREAM_NS" "$MCP_NS" "$LLM_NS" "$OTEL_NS"; do
  $KUBECTL wait --for=delete "namespace/$ns" --timeout=180s >/dev/null 2>&1 || true
done

echo "==> deploying dependencies and Kaiju ${TAG}"
$KUBECTL apply -f dev/postgres.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/pg --timeout=180s >/dev/null
$KUBECTL apply -f dev/mailpit.yaml >/dev/null
$KUBECTL -n kobe-deps rollout status deploy/mailpit --timeout=180s >/dev/null
$KUBECTL apply -f dev/s3.yaml >/dev/null # KOBE-27: S3-compatible test fixture (SeaweedFS, Apache-2.0)
$KUBECTL -n kobe-deps rollout status deploy/s3 --timeout=300s >/dev/null
# KOBE-274: the OTLP sink first, so every Kaiju service exports to it from the start.
$KUBECTL create namespace "$OTEL_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
$KUBECTL -n "$OTEL_NS" run otlp --restart=Never --image="ghcr.io/splittingatom/kobe-model-gateway:$TAG" \
  --image-pull-policy=IfNotPresent --labels=app=otlp --command -- node -e "$(cat e2e/lib/otlp-sink.js)" >/dev/null
$KUBECTL -n "$OTEL_NS" expose pod otlp --port=4318 --target-port=4318 --name=otlp >/dev/null
$KUBECTL -n "$OTEL_NS" wait --for=condition=Ready pod/otlp --timeout=180s >/dev/null 2>&1 || true
# KOBE-698: the suite runs with the opt-in server and web egress policies on, so they are proven
# against a working install. The server's in-cluster S3 and SMTP fixtures (kobe-deps) and the OTLP
# sink are not public addresses: extraEgress, as docs/install.md tells a site with a LAN S3 or
# relay. gate1-prep keeps them off: the gates' fake identity and OAuth servers are in-cluster.
restrict_egress=()
if [[ "$SHARD" != gate1-prep && "${KOBE_E2E_RESTRICT_EGRESS:-1}" == 1 ]]; then
  deps_ns='{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kobe-deps"}}}'
  deps_rule="{\"to\":[$deps_ns]}"
  # The chart requires the API server's and the database's peers with restrictEgress on: the API
  # server's own addresses (after the kubernetes Service's DNAT) and the kobe-deps Postgres.
  api_ips=$($KUBECTL -n default get endpoints kubernetes -o jsonpath='{.subsets[*].addresses[*].ip}')
  api_peers=$(for ip in $api_ips; do printf '{"ipBlock":{"cidr":"%s/32"}},' "$ip"; done)
  restrict_egress=(--set server.networkPolicy.restrictEgress=true --set web.networkPolicy.restrictEgress=true
    --set-json "server.networkPolicy.kubernetesApi.peers=[${api_peers%,}]"
    --set-json "server.networkPolicy.databasePeers=[$deps_ns]"
    --set-json "server.networkPolicy.extraEgress=[$deps_rule,$OTEL_RULE]")
fi
$HELM upgrade --install kobe charts/kobe -n "$NS" -f dev/values.yaml \
  --set global.imageTag="$TAG" --set global.imagePullPolicy=IfNotPresent \
  --set telemetry.endpoint="$OTEL_SINK" \
  --set-json "mcpProxy.networkPolicy.extraEgress=[$OTEL_RULE]" \
  --set-json "egressProxy.networkPolicy.extraEgress=[$OTEL_RULE]" \
  --set-json "modelGateway.networkPolicy.extraEgress=[$OTEL_RULE]" \
  "${restrict_egress[@]}" \
  ${KOBE_E2E_TOOL_EXECUTOR:+--set sandbox.toolExecutor.enabled=true} --wait --timeout 10m

