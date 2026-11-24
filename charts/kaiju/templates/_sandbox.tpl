{{/*
Sandbox values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates the `sandbox` key still renders. Keep in sync with values.yaml.
*/}}
{{- define "kaiju.sandboxValues" -}}
{{- $defaults := dict
  "teamNamespacePrefix" ""
  "resources" (dict "requests" (dict "cpu" "500m" "memory" "1Gi") "limits" (dict "cpu" "2" "memory" "4Gi"))
  "workspace" (dict "size" "10Gi" "storageClass" "" "longhornStrictLocal" (dict "enabled" false))
  "tmpSize" "2Gi"
  "homeSize" "1Gi"
  "ephemeralStorage" (dict "request" "1Gi" "limit" "4Gi")
  "modelGatewayAccess" true
  "teamQuota" (dict "requests.cpu" "20" "requests.memory" "40Gi" "limits.cpu" "40" "limits.memory" "80Gi" "requests.ephemeral-storage" "40Gi" "limits.ephemeral-storage" "160Gi" "requests.storage" "500Gi" "persistentvolumeclaims" "50" "pods" "50")
  "warmPool" (dict "replicasPerTeam" 1)
  "hibernation" (dict "enabled" true "idleMinutes" 15 "sweepSeconds" 60 "reclaim" (dict "enabled" false "dormantDays" 30))
  "workspaceSync" (dict "enabled" true "pushIntervalSeconds" 60 "maxFileSize" "1Gi" "maxWorkspaceSize" "" "maxFiles" 100000 "collectSeconds" 3600)
  "toolExecutor" (dict "enabled" false)
  "volumeLoss" (dict "detection" true "graceMinutes" 30)
  "skillEval" (dict "maxConcurrentPerTeam" 4 "workspaceSize" "2Gi")
  "orbitEval" (dict "deadlineSeconds" 900 "resources" (dict "requests" (dict "cpu" "250m" "memory" "512Mi") "limits" (dict "cpu" "1" "memory" "2Gi")))
  "skillScan" (dict "enabled" false "deadlineSeconds" 300 "resources" (dict "requests" (dict "cpu" "250m" "memory" "512Mi") "limits" (dict "cpu" "1" "memory" "2Gi")))
  "sessionKeysSecret" ""
  "sessionVerifyKeysConfigMap" "" -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.sandbox | default dict)) | toJson -}}
{{- end -}}

{{/*
StorageClass of sandbox workspaces: the chart's Longhorn strict-local class when enabled, else
sandbox.workspace.storageClass ("" = the cluster default). Setting both is refused.
*/}}
{{- define "kaiju.workspaceStorageClass" -}}
{{- $s := include "kaiju.sandboxValues" . | fromJson -}}
{{- if $s.workspace.longhornStrictLocal.enabled -}}
{{- if $s.workspace.storageClass -}}
{{- fail "sandbox.workspace: set either storageClass or longhornStrictLocal.enabled, not both" -}}
{{- end -}}
{{- include "kaiju.clusterName" (dict "root" . "suffix" "workspace-strict-local") -}}
{{- else -}}
{{- $s.workspace.storageClass -}}
{{- end -}}
{{- end -}}

{{/*
KOBE-751: the team namespace prefix, exactly one per install: sandbox.teamNamespacePrefix when set,
else detected from the existing team namespaces (labelled kobe.splittingatom.io/team-namespace;
`lookup` needs a reachable cluster), else "kaiju-team-". An offline render (helm template, Argo CD,
Flux, client-side --dry-run) cannot detect it, so it must set the value, unless it is a throwaway
environment (global.allowGeneratedSecretsOffline, like generated secrets). Whenever the cluster is
reachable, team namespaces under another prefix than the resolved one fail the render, naming the
value to set; the server refuses to start in the same case (services/server/src/sandbox/
namespace-prefix.ts), which also covers offline renders. Keep the list in step with the server's
TEAM_NAMESPACE_PREFIXES (sandbox/constants.ts).
*/}}
{{- define "kaiju.teamNamespacePrefix" -}}
{{- $s := include "kaiju.sandboxValues" . | fromJson -}}
{{- $online := include "kaiju.online" . | eq "true" -}}
{{- include "kaiju.resolveTeamNamespacePrefix" (dict
  "set" (toString ($s.teamNamespacePrefix | default ""))
  "online" $online
  "namespaces" (ternary ((lookup "v1" "Namespace" "" "").items | default list) list $online)
  "allowOffline" (.Values.global.allowGeneratedSecretsOffline | default false)) -}}
{{- end -}}

{{/*
The rule itself, without lookups (charts/kaiju/tests/team-namespace-prefix.test.ts renders it with
made-up namespaces): .set (the value), .online (cluster reachable), .namespaces (Namespace objects
from the cluster), .allowOffline (global.allowGeneratedSecretsOffline).
*/}}
{{/* Both team namespace prefixes Kaiju knows (the server's TEAM_NAMESPACE_PREFIXES), as JSON. */}}
{{- define "kaiju.teamNamespacePrefixes" -}}
{{- toJson (list "kaiju-team-" "kobe-team-") -}}
{{- end -}}

{{- define "kaiju.resolveTeamNamespacePrefix" -}}
{{- $known := include "kaiju.teamNamespacePrefixes" . | fromJsonArray -}}
{{- $set := .set -}}
{{- if and $set (not (has $set $known)) -}}
{{- fail (printf "sandbox.teamNamespacePrefix must be \"kaiju-team-\" or \"kobe-team-\" (empty: detect it), not %q" $set) -}}
{{- end -}}
{{- $teamNamespaces := list -}}
{{- $found := dict -}}
{{- range .namespaces -}}
{{- $labels := .metadata.labels | default dict -}}
{{- if eq (toString (index $labels "kobe.splittingatom.io/team-namespace" | default "")) "true" -}}
{{- $name := .metadata.name -}}
{{- $teamNamespaces = append $teamNamespaces $name -}}
{{- range $known -}}
{{- if hasPrefix . $name -}}{{- $_ := set $found . true -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $prefix := $set -}}
{{- if not $prefix -}}
{{- if .online -}}
{{- if gt (len $found) 1 -}}
{{- fail (printf "Team namespaces exist under both prefixes %s: exactly one may be in force. Set sandbox.teamNamespacePrefix to the prefix of this install's team namespaces." (keys $found | sortAlpha | join " and ")) -}}
{{- end -}}
{{- $prefix = default "kaiju-team-" (first (keys $found)) -}}
{{- else if .allowOffline -}}
{{- $prefix = "kaiju-team-" -}}
{{- else -}}
{{- fail "Cannot detect the team namespace prefix in an offline render. Set sandbox.teamNamespacePrefix: \"kaiju-team-\" for a new install, or the prefix of the existing team namespaces (\"kobe-team-\" for an install created before the rename)." -}}
{{- end -}}
{{- end -}}
{{- $foreign := list -}}
{{- range $teamNamespaces -}}
{{- if not (hasPrefix $prefix .) -}}{{- $foreign = append $foreign . -}}{{- end -}}
{{- end -}}
{{- if $foreign -}}
{{- $other := "" -}}
{{- range $known -}}{{- if and (ne . $prefix) (hasKey $found .) -}}{{- $other = . -}}{{- end -}}{{- end -}}
{{- $hint := "the prefix of this install's team namespaces (and remove the team-namespace label from namespaces Kaiju did not create)" -}}
{{- if $other -}}{{- $hint = quote $other -}}{{- end -}}
{{- fail (printf "Team namespaces exist under another prefix than sandbox.teamNamespacePrefix %q: %s. Set sandbox.teamNamespacePrefix to %s; moving an install to another prefix is not supported." $prefix (sortAlpha $foreign | join ", ") $hint) -}}
{{- end -}}
{{- $prefix -}}
{{- end -}}

{{/*
The naming generation of the objects in team namespaces and of the chart's copies of them (the
skill eval PriorityClass): "kaiju", or "kobe" with the prefix kobe-team- (KOBE-751). Same rule as
the server's `sandboxNames`, so namespace and object names never mix.
*/}}
{{- define "kaiju.sandboxGeneration" -}}
{{- /* `default`: helm lint ignores `fail`, so the prefix may be empty there. */ -}}
{{- trimSuffix "-team-" (include "kaiju.teamNamespacePrefix" .) | default "kaiju" -}}
{{- end -}}

{{/* Names shared by RBAC, admission policies and the server's sandbox config. */}}
{{- define "kaiju.sandboxManagerRole" -}}
{{- include "kaiju.clusterName" (dict "root" . "suffix" "sandbox-manager") -}}
{{- end -}}

{{- define "kaiju.serverServiceAccount" -}}
{{- printf "%s-server" (include "kaiju.fullname" .) -}}
{{- end -}}

{{- define "kaiju.sessionKeysSecretName" -}}
{{- $s := include "kaiju.sandboxValues" . | fromJson -}}
{{- default (printf "%s-sandbox-session-keys" (include "kaiju.fullname" .)) $s.sessionKeysSecret -}}
{{- end -}}

{{/*
ConfigMap with the session tokens' public keys (KOBE-513): the chart's own, or with a pre-created
sandbox.sessionKeysSecret, sandbox.sessionVerifyKeysConfigMap (required then).
*/}}
{{- define "kaiju.sessionVerifyKeysName" -}}
{{- $s := include "kaiju.sandboxValues" . | fromJson -}}
{{- if $s.sessionKeysSecret -}}
{{- if not $s.sessionVerifyKeysConfigMap -}}
{{- fail "sandbox.sessionKeysSecret is set: also set sandbox.sessionVerifyKeysConfigMap (the session tokens' public keys, keys sandbox-wire, model-gateway, mcp-proxy, egress-proxy; docs/install.md)" -}}
{{- end -}}
{{- $s.sessionVerifyKeysConfigMap -}}
{{- else -}}
{{- printf "%s-sandbox-session-verify-keys" (include "kaiju.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* `<audience>` key of the verify-keys ConfigMap as a verifier's env var (public key only). */}}
{{- define "kaiju.sessionVerifyKeyEnv" -}}
- name: KAIJU_SESSION_VERIFY_KEY_{{ .env }}
  valueFrom:
    configMapKeyRef:
      name: {{ include "kaiju.sessionVerifyKeysName" .root }}
      key: {{ .aud }}
{{- end -}}

{{/* Session-token audiences (env suffix -> Secret/ConfigMap key), one Ed25519 pair each. */}}
{{- define "kaiju.sessionKeyNames" -}}
{{- toJson (dict "SANDBOX_WIRE" "sandbox-wire" "MODEL_GATEWAY" "model-gateway" "MCP_PROXY" "mcp-proxy" "EGRESS_PROXY" "egress-proxy") -}}
{{- end -}}

{{/*
KAIJU_SANDBOX_CONFIG for the server (validated by services/server/src/sandbox/config.ts): the
sandbox image and sizing, and how sandboxes reach Kaiju's services (Service for the ClusterIP,
pod labels and port for the team NetworkPolicy).
*/}}
{{- define "kaiju.sandboxConfig" -}}
{{- $fullname := include "kaiju.fullname" . -}}
{{- $s := include "kaiju.sandboxValues" . | fromJson -}}
{{- $endpoints := dict -}}
{{- /* component, Service port, pod port. The server serves sandboxes on its own port 8081; models
  are reached through the model-gateway shim (KOBE-40), never Bifrost itself. */ -}}
{{- range $key, $e := dict "server" (list "server" 8081 8081) "modelGateway" (list "model-gateway" 80 8080) "mcpProxy" (list "mcp-proxy" 80 8080) "egressProxy" (list "egress-proxy" 80 8080) -}}
{{- $component := index $e 0 -}}
{{- $_ := set $endpoints $key (dict
  "service" (printf "%s-%s" $fullname $component)
  "port" (index $e 1)
  "targetPort" (index $e 2)
  "podLabels" (include "kaiju.selectorLabels" (dict "root" $ "component" $component) | fromYaml)) -}}
{{- end -}}
{{- $pullSecrets := list -}}
{{- range .Values.global.imagePullSecrets -}}
{{- $pullSecrets = append $pullSecrets .name -}}
{{- end -}}
{{- $quota := dict -}}
{{- range $k, $v := $s.teamQuota -}}
{{- $_ := set $quota $k (toString $v) -}}
{{- end -}}
{{- $cfg := (dict
  "image" (include "kaiju.image" (dict "root" . "name" "sandbox"))
  "imagePullPolicy" .Values.global.imagePullPolicy
  "imagePullSecrets" $pullSecrets
  "releaseNamespace" .Release.Namespace
  "teamNamespacePrefix" (include "kaiju.teamNamespacePrefix" .)
  "serverServiceAccount" (include "kaiju.serverServiceAccount" .)
  "managerClusterRole" (include "kaiju.sandboxManagerRole" .)
  "endpoints" $endpoints
  "resources" (dict
    "requests" (dict "cpu" (toString $s.resources.requests.cpu) "memory" (toString $s.resources.requests.memory))
    "limits" (dict "cpu" (toString $s.resources.limits.cpu) "memory" (toString $s.resources.limits.memory)))
  "ephemeralStorage" (dict "request" (toString $s.ephemeralStorage.request) "limit" (toString $s.ephemeralStorage.limit))
  "modelGatewayAccess" $s.modelGatewayAccess
  "workspace" (dict "size" (toString $s.workspace.size) "storageClass" (include "kaiju.workspaceStorageClass" .))
  "tmpSize" (toString $s.tmpSize)
  "homeSize" (toString $s.homeSize)
  "teamQuota" $quota
  "warmPool" (dict "replicasPerTeam" (int $s.warmPool.replicasPerTeam))
  "hibernation" (dict
    "enabled" $s.hibernation.enabled
    "idleMinutes" (int $s.hibernation.idleMinutes)
    "sweepSeconds" (int $s.hibernation.sweepSeconds)
    "reclaim" (dict
      "enabled" $s.hibernation.reclaim.enabled
      "dormantDays" (int $s.hibernation.reclaim.dormantDays)))
  "workspaceSync" (include "kaiju.workspaceSyncConfig" $s | fromJson)
  "toolExecutor" (dict "enabled" $s.toolExecutor.enabled)
  "volumeLoss" (dict "detection" $s.volumeLoss.detection "graceMinutes" (int $s.volumeLoss.graceMinutes))
  "skillEval" (dict "maxConcurrentPerTeam" (int $s.skillEval.maxConcurrentPerTeam) "workspaceSize" (toString $s.skillEval.workspaceSize))
  "orbitEval" (dict
    "image" (include "kaiju.image" (dict "root" . "name" "orbit-eval"))
    "deadlineSeconds" (int $s.orbitEval.deadlineSeconds)
    "resources" (dict
      "requests" (dict "cpu" (toString $s.orbitEval.resources.requests.cpu) "memory" (toString $s.orbitEval.resources.requests.memory))
      "limits" (dict "cpu" (toString $s.orbitEval.resources.limits.cpu) "memory" (toString $s.orbitEval.resources.limits.memory))))) -}}
{{- /* The external skill scanner's image only when the install has it (KOBE-341, review L10). */ -}}
{{- if $s.skillScan.enabled -}}
{{- $_ := set $cfg "skillScan" (dict
    "image" (include "kaiju.image" (dict "root" . "name" "skill-scan"))
    "deadlineSeconds" (int $s.skillScan.deadlineSeconds)
    "resources" (dict
      "requests" (dict "cpu" (toString $s.skillScan.resources.requests.cpu) "memory" (toString $s.skillScan.resources.requests.memory))
      "limits" (dict "cpu" (toString $s.skillScan.resources.limits.cpu) "memory" (toString $s.skillScan.resources.limits.memory)))) -}}
{{- end -}}
{{- toJson $cfg -}}
{{- end -}}

{{/*
KOBE-27 workspace sync settings; maxWorkspaceSize is omitted when empty (the volume size).
maxFileSize is capped at 5Gi (KOBE-743): each file is pushed with one S3 PutObject (uploads copy it
with one CopyObject), and S3 accepts at most 5 GiB in a single request.
*/}}
{{- define "kaiju.workspaceSyncConfig" -}}
{{- $w := .workspaceSync -}}
{{- if gt (include "kaiju.memoryBytes" $w.maxFileSize | int64) (int64 5368709120) -}}
{{- fail (printf "sandbox.workspaceSync.maxFileSize %s exceeds 5Gi: S3 accepts at most 5 GiB in a single PutObject/CopyObject request, which is how workspace sync stores each file" (toString $w.maxFileSize)) -}}
{{- end -}}
{{- $out := dict
  "enabled" $w.enabled
  "pushIntervalSeconds" (int $w.pushIntervalSeconds)
  "maxFileSize" (toString $w.maxFileSize)
  "maxFiles" (int $w.maxFiles)
  "collectSeconds" (int $w.collectSeconds) -}}
{{- if $w.maxWorkspaceSize -}}
{{- $_ := set $out "maxWorkspaceSize" (toString $w.maxWorkspaceSize) -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}

{{/*
Server env: sandbox config, the session-token private keys (the server holds all four and is the
only holder, KOBE-513; the model-gateway key also signs run and server-call tokens, KOBE-521) with
their public bundles (rotation), the trace-span secret (KOBE-274; authorises nothing) and the
approval HMAC key (KOBE-37). The approval key is optional so a pre-created Secret without `approval-hmac`
still starts: the server then denies every tool call that needs approval (fail closed) and logs it.
*/}}
{{- define "kaiju.sandboxEnv" -}}
{{ include "kaiju.sandboxConfigEnv" . }}
{{- range $env, $aud := include "kaiju.sessionKeyNames" . | fromJson }}
- name: KAIJU_SESSION_SIGNING_KEY_{{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.sessionKeysSecretName" $ }}
      key: {{ $aud }}.key
{{- /* The server's own rotation bundle comes from the Secret, never the ConfigMap: a ConfigMap
  editor must not be able to add a key the server accepts (sandbox-wire, MCP /grant). Optional: the
  server always accepts its own key's public half. */}}
- name: KAIJU_SESSION_VERIFY_KEY_{{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.sessionKeysSecretName" $ }}
      key: {{ $aud }}.pub
      optional: true
{{- end }}
{{- /* Optional: a pre-created Secret without `trace-span` only turns the span relay off. */}}
- name: KAIJU_TRACE_SPAN_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.sessionKeysSecretName" . }}
      key: trace-span
      optional: true
- name: KAIJU_APPROVAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.sessionKeysSecretName" . }}
      key: approval-hmac
      optional: true
{{- end -}}

{{/*
Sandbox config alone, for the scheduler (KOBE-174): it wakes sandboxes through the provider but
holds no session-token key, run-token key or approval key (the server signs and verifies those).
*/}}
{{- define "kaiju.sandboxConfigEnv" -}}
- name: KAIJU_SANDBOX_CONFIG
  value: {{ include "kaiju.sandboxConfig" . | quote }}
{{- end -}}
