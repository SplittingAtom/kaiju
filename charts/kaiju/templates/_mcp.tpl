{{/*
MCP proxy values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates these keys still renders. Keep in sync with values.yaml.
*/}}
{{- define "kaiju.mcpProxyValues" -}}
{{- $defaults := dict
  "allowInsecureHttp" false
  "allowedPorts" (list 443)
  "allowedInternalCidrs" (list)
  "deniedCidrs" (list)
  "internalKeySecret" ""
  "limits" (dict "maxRequestBytes" 1048576 "maxResponseBytes" 4194304 "upstreamTimeoutSeconds" 55 "callsPerSandbox" 8 "concurrentCalls" 256 "requestBurst" 60 "requestsPerSecond" 10)
  "networkPolicy" (dict "restrictEgress" true "extraEgress" (list)) -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.mcpProxy | default dict)) | toJson -}}
{{- end -}}

{{/* Secret holding the key the MCP proxy presents to the server's internal listener (KOBE-58). */}}
{{- define "kaiju.mcpInternalKeySecretName" -}}
{{- $m := include "kaiju.mcpProxyValues" . | fromJson -}}
{{- default (printf "%s-mcp-proxy-internal" (include "kaiju.fullname" .)) $m.internalKeySecret -}}
{{- end -}}

{{/* The server's internal listener port (MCP proxy policy re-check). */}}
{{- define "kaiju.serverInternalPort" -}}8082{{- end -}}

{{/* The MCP proxy's internal routes (probe, app calls): their own port, server pods only (KOBE-693). */}}
{{- define "kaiju.mcpProxyInternalPort" -}}8081{{- end -}}

{{/*
Server env: the internal listener and the key the MCP proxy must present, the proxy's internal
routes (the pinning probe, KOBE-101, and app calls; their own port and key since KOBE-693), and the connector URL policy (the proxy's own values, so the registry accepts only what the proxy will connect to).
*/}}
{{- define "kaiju.serverInternalEnv" -}}
{{- $m := include "kaiju.mcpProxyValues" . | fromJson -}}
- name: KAIJU_MCP_ALLOW_INSECURE_HTTP
  value: {{ ternary "true" "false" $m.allowInsecureHttp | quote }}
- name: KAIJU_MCP_ALLOWED_PORTS
  value: {{ join "," $m.allowedPorts | quote }}
- name: KAIJU_MCP_ALLOWED_INTERNAL_CIDRS
  value: {{ join "," $m.allowedInternalCidrs | quote }}
- name: KAIJU_MCP_DENIED_CIDRS
  value: {{ join "," $m.deniedCidrs | quote }}
- name: KAIJU_INTERNAL_PORT
  value: {{ include "kaiju.serverInternalPort" . | quote }}
- name: KAIJU_MCP_PROXY_URL
  value: {{ printf "http://%s-mcp-proxy:%s" (include "kaiju.fullname" .) (include "kaiju.mcpProxyInternalPort" .) | quote }}
- name: KAIJU_MCP_PROXY_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.mcpInternalKeySecretName" . }}
      key: key
{{- /* Optional: an operator's own Secret may predate it; then the one key serves both ways. */}}
- name: KAIJU_MCP_PROXY_ROUTES_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.mcpInternalKeySecretName" . }}
      key: routes-key
      optional: true
{{ include "kaiju.serverEgressGitEnv" . }}
{{- end -}}

{{/*
MCP proxy env (services/mcp-proxy/src/config.ts): its audience's session-token public key only
(never a private key, never the other audiences', KOBE-513), the server's internal listener and its key, the upstream policy and limits. No
database: the server decides every call.
*/}}
{{- define "kaiju.mcpProxyEnv" -}}
{{- $m := include "kaiju.mcpProxyValues" . | fromJson -}}
{{ include "kaiju.sessionVerifyKeyEnv" (dict "root" . "env" "MCP_PROXY" "aud" "mcp-proxy") }}
- name: KAIJU_MCP_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.mcpInternalKeySecretName" . }}
      key: key
- name: KAIJU_MCP_ROUTES_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.mcpInternalKeySecretName" . }}
      key: routes-key
      optional: true
- name: KAIJU_MCP_INTERNAL_PORT
  value: {{ include "kaiju.mcpProxyInternalPort" . | quote }}
- name: KAIJU_MCP_SERVER_URL
  value: {{ printf "http://%s-server:%s" (include "kaiju.fullname" .) (include "kaiju.serverInternalPort" .) | quote }}
- name: KAIJU_MCP_ALLOW_INSECURE_HTTP
  value: {{ ternary "true" "false" $m.allowInsecureHttp | quote }}
- name: KAIJU_MCP_ALLOWED_PORTS
  value: {{ join "," $m.allowedPorts | quote }}
- name: KAIJU_MCP_ALLOWED_INTERNAL_CIDRS
  value: {{ join "," $m.allowedInternalCidrs | quote }}
- name: KAIJU_MCP_DENIED_CIDRS
  value: {{ join "," $m.deniedCidrs | quote }}
- name: KAIJU_MCP_MAX_REQUEST_BYTES
  value: {{ int $m.limits.maxRequestBytes | quote }}
- name: KAIJU_MCP_MAX_RESPONSE_BYTES
  value: {{ int $m.limits.maxResponseBytes | quote }}
- name: KAIJU_MCP_UPSTREAM_TIMEOUT_MS
  value: {{ mul (int $m.limits.upstreamTimeoutSeconds) 1000 | quote }}
- name: KAIJU_MCP_CALLS_PER_SANDBOX
  value: {{ int $m.limits.callsPerSandbox | quote }}
- name: KAIJU_MCP_MAX_CONCURRENT_CALLS
  value: {{ int $m.limits.concurrentCalls | quote }}
- name: KAIJU_MCP_REQUEST_BURST
  value: {{ int $m.limits.requestBurst | quote }}
- name: KAIJU_MCP_REQUESTS_PER_SECOND
  value: {{ int $m.limits.requestsPerSecond | quote }}
{{- end -}}
