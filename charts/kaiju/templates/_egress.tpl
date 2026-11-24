{{/*
Egress proxy values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates these keys still renders. Keep in sync with values.yaml.
*/}}
{{- define "kaiju.egressProxyValues" -}}
{{- $defaults := dict
  "allowedPorts" (list 443)
  "allowedInternalCidrs" (list)
  "clusterIngress" (dict "enabled" false "addresses" (list) "podSelector" (dict) "namespace" "" "ports" (list))
  "deniedCidrs" (list)
  "auditFlushSeconds" 60
  "headerSecret" ""
  "upgrade" (dict "maxRequestBytes" 104857600 "maxResponseBytes" 2147483648 "timeoutSeconds" 600)
  "git" (dict "internalKeySecret" "" "maxFetchRequestBytes" 67108864 "maxResponseBytes" 4294967296 "timeoutSeconds" 1800 "concurrentPerSandbox" 8 "requestBurst" 60 "requestsPerSecond" 2 "lookupsPerMinute" 30)
  "limits" (dict "connectionsPerSandbox" 64 "connections" 4096 "bandwidthBytesPerSecond" 20971520 "idleTimeoutSeconds" 300 "maxTunnelSeconds" 3600 "unauthenticatedPerSource" 16 "unauthenticated" 1024)
  "networkPolicy" (dict "restrictEgress" true "databasePeers" (list) "databasePort" 5432 "extraEgress" (list))
  "database" (dict "poolMax" 10) -}}
{{- $e := mustMergeOverwrite $defaults (deepCopy (.Values.egressProxy | default dict)) -}}
{{- with $e.clusterIngress }}
{{- if .enabled }}
{{- if or (empty .addresses) (empty .namespace) (empty .ports) (empty .podSelector) }}
{{- fail "egressProxy.clusterIngress.enabled needs addresses, namespace, podSelector and ports" }}
{{- end }}
{{- end }}
{{- end }}
{{- $e | toJson -}}
{{- end -}}

{{/* Internal targets for internal patterns only (EA4): the cluster ingress addresses when enabled. */}}
{{- define "kaiju.egressInternalTargets" -}}
{{- $e := include "kaiju.egressProxyValues" . | fromJson -}}
{{- if $e.clusterIngress.enabled }}{{ join "," $e.clusterIngress.addresses }}{{ end -}}
{{- end -}}

{{/* Secret sealing the teams' injected egress header values (KOBE-39): server and proxy only. */}}
{{- define "kaiju.egressHeaderSecretName" -}}
{{- $e := include "kaiju.egressProxyValues" . | fromJson -}}
{{- default (printf "%s-egress-headers" (include "kaiju.fullname" .)) $e.headerSecret -}}
{{- end -}}

{{/* The header secret (current, and previous when the Secret holds one) as env, for server and proxy. */}}
{{- define "kaiju.egressHeaderEnv" -}}
- name: KAIJU_EGRESS_HEADER_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.egressHeaderSecretName" . }}
      key: secret
- name: KAIJU_EGRESS_HEADER_SECRET_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.egressHeaderSecretName" . }}
      key: secret-previous
      optional: true
{{- end -}}

{{/* Secret holding the key the egress proxy presents for git decisions (KOBE-763): server and proxy only. */}}
{{- define "kaiju.egressInternalKeySecretName" -}}
{{- $e := include "kaiju.egressProxyValues" . | fromJson -}}
{{- default (printf "%s-egress-proxy-internal" (include "kaiju.fullname" .)) $e.git.internalKeySecret -}}
{{- end -}}

{{/* Server env: the key the egress proxy presents on the internal listener for git decisions (KOBE-763). */}}
{{- define "kaiju.serverEgressGitEnv" -}}
- name: KAIJU_EGRESS_PROXY_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.egressInternalKeySecretName" . }}
      key: key
{{- end -}}

{{/* Address ranges the proxy's own NetworkPolicy never sends to (internet rule `except`). */}}
{{- define "kaiju.egressPrivateRanges" -}}
{{- toJson (list "0.0.0.0/8" "10.0.0.0/8" "100.64.0.0/10" "127.0.0.0/8" "169.254.0.0/16" "172.16.0.0/12" "192.0.0.0/24" "192.168.0.0/16" "198.18.0.0/15" "224.0.0.0/4" "240.0.0.0/4") -}}
{{- end -}}

{{/*
Egress proxy env (services/egress-proxy/src/config.ts): the database (app role), its audience's
session-token public key only (never a private key, never the other audiences', KOBE-513), the header-injection secret (KOBE-39), and limits.
*/}}
{{- define "kaiju.egressProxyEnv" -}}
{{- $e := include "kaiju.egressProxyValues" . | fromJson -}}
{{ include "kaiju.databaseEnv" . }}
- name: KAIJU_DB_POOL_MAX
  value: {{ int $e.database.poolMax | quote }}
{{ include "kaiju.sessionVerifyKeyEnv" (dict "root" . "env" "EGRESS_PROXY" "aud" "egress-proxy") }}
- name: KAIJU_EGRESS_ALLOWED_PORTS
  value: {{ join "," $e.allowedPorts | quote }}
- name: KAIJU_EGRESS_ALLOWED_INTERNAL_CIDRS
  value: {{ join "," $e.allowedInternalCidrs | quote }}
- name: KAIJU_EGRESS_INTERNAL_TARGETS
  value: {{ include "kaiju.egressInternalTargets" . | quote }}
- name: KAIJU_EGRESS_DENIED_CIDRS
  value: {{ join "," $e.deniedCidrs | quote }}
- name: KAIJU_EGRESS_MAX_CONNECTIONS_PER_SANDBOX
  value: {{ int $e.limits.connectionsPerSandbox | quote }}
- name: KAIJU_EGRESS_MAX_CONNECTIONS
  value: {{ int $e.limits.connections | quote }}
- name: KAIJU_EGRESS_BANDWIDTH_BYTES_PER_SECOND
  value: {{ int64 $e.limits.bandwidthBytesPerSecond | quote }}
- name: KAIJU_EGRESS_IDLE_TIMEOUT_MS
  value: {{ mul (int $e.limits.idleTimeoutSeconds) 1000 | quote }}
- name: KAIJU_EGRESS_MAX_TUNNEL_SECONDS
  value: {{ int $e.limits.maxTunnelSeconds | quote }}
- name: KAIJU_EGRESS_PREAUTH_PER_SOURCE
  value: {{ int $e.limits.unauthenticatedPerSource | quote }}
- name: KAIJU_EGRESS_PREAUTH_TOTAL
  value: {{ int $e.limits.unauthenticated | quote }}
- name: KAIJU_EGRESS_AUDIT_FLUSH_MS
  value: {{ mul (int $e.auditFlushSeconds) 1000 | quote }}
{{ include "kaiju.egressHeaderEnv" . }}
- name: KAIJU_EGRESS_UPGRADE_MAX_REQUEST_BYTES
  value: {{ int64 $e.upgrade.maxRequestBytes | quote }}
- name: KAIJU_EGRESS_UPGRADE_MAX_RESPONSE_BYTES
  value: {{ int64 $e.upgrade.maxResponseBytes | quote }}
- name: KAIJU_EGRESS_UPGRADE_TIMEOUT_MS
  value: {{ mul (int $e.upgrade.timeoutSeconds) 1000 | quote }}
{{- /* Git smart-HTTP for connected organizations (KOBE-763): the server decides and mints. */}}
- name: KAIJU_EGRESS_SERVER_URL
  value: {{ printf "http://%s-server:%s" (include "kaiju.fullname" .) (include "kaiju.serverInternalPort" .) | quote }}
- name: KAIJU_EGRESS_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.egressInternalKeySecretName" . }}
      key: key
- name: KAIJU_EGRESS_GIT_MAX_FETCH_REQUEST_BYTES
  value: {{ int64 $e.git.maxFetchRequestBytes | quote }}
- name: KAIJU_EGRESS_GIT_MAX_RESPONSE_BYTES
  value: {{ int64 $e.git.maxResponseBytes | quote }}
- name: KAIJU_EGRESS_GIT_TIMEOUT_MS
  value: {{ mul (int $e.git.timeoutSeconds) 1000 | quote }}
- name: KAIJU_EGRESS_GIT_CONCURRENT_PER_SANDBOX
  value: {{ int $e.git.concurrentPerSandbox | quote }}
- name: KAIJU_EGRESS_GIT_REQUEST_BURST
  value: {{ int $e.git.requestBurst | quote }}
- name: KAIJU_EGRESS_GIT_REQUESTS_PER_SECOND
  value: {{ int $e.git.requestsPerSecond | quote }}
- name: KAIJU_EGRESS_GIT_LOOKUPS_PER_MINUTE
  value: {{ int $e.git.lookupsPerMinute | quote }}
{{- end -}}
