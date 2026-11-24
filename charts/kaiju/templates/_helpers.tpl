{{/* Name prefix for every resource: the release name. */}}
{{- define "kaiju.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/*
Name for cluster-scoped objects: unique per (namespace, release) even when truncation or dashes
would make "<release>-<namespace>" ambiguous.
*/}}
{{- define "kaiju.clusterName" -}}
{{- printf "%s-%s-%s" (include "kaiju.fullname" .root | trunc 30 | trimSuffix "-") (printf "%s/%s" .root.Release.Namespace .root.Release.Name | sha256sum | trunc 10) .suffix -}}
{{- end -}}

{{/* Secret holding the kobe_app password in CloudNativePG mode. */}}
{{- define "kaiju.cnpgAppSecretName" -}}
{{- default (printf "%s-db-app" (include "kaiju.fullname" .)) .Values.postgres.cnpg.existingAppSecret -}}
{{- end -}}

{{/*
Generated kobe_app password, computed once per render (memoized) so the Secret and the pod
checksum annotation agree. Reuses the existing Secret's value on upgrades.
*/}}
{{- define "kaiju.cnpgAppPassword" -}}
{{- if not (hasKey .Values.postgres.cnpg "__password") -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "kaiju.cnpgAppSecretName" .) -}}
{{- $pw := "" -}}
{{- if and $existing $existing.data (hasKey $existing.data "password") -}}
{{- $pw = index $existing.data "password" | b64dec -}}
{{- else -}}
{{- $pw = randAlphaNum 32 -}}
{{- end -}}
{{- $_ := set .Values.postgres.cnpg "__password" $pw -}}
{{- end -}}
{{- index .Values.postgres.cnpg "__password" -}}
{{- end -}}

{{/* Pod annotations that roll workloads when the generated DB password changes. */}}
{{- define "kaiju.dbChecksumAnnotations" -}}
{{- if and (eq .Values.postgres.mode "cnpg") (not .Values.postgres.cnpg.existingAppSecret) -}}
checksum/db-app: {{ include "kaiju.cnpgAppPassword" . | sha256sum }}
{{- end -}}
{{- end -}}

{{/* The app must never connect with the owner/migration URL. */}}
{{- define "kaiju.validateDatabase" -}}
{{- $e := .Values.postgres.external -}}
{{- if and (eq .Values.postgres.mode "external") (eq $e.appUrlKey $e.migrateUrlKey) -}}
{{- fail "postgres.external.appUrlKey must differ from migrateUrlKey: the app connects as a non-owner role, never with the owner (migration) URL" -}}
{{- end -}}
{{- end -}}

{{/*
Value of the app.kubernetes.io/name label. It stays `kobe` after the rename to Kaiju (KOBE-750):
Deployment and StatefulSet selectors are immutable, so an existing release could not upgrade in
place with a new value, and the server's team NetworkPolicies select the chart's pods by it.
*/}}
{{- define "kaiju.appName" -}}kobe{{- end -}}

{{- define "kaiju.labels" -}}
app.kubernetes.io/name: {{ include "kaiju.appName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "kaiju.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kaiju.appName" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Replicated workloads (KOBE-515): spread replicas across nodes, softly (ScheduleAnyway, so
  single-node installs and k3d still schedule), and keep one available during voluntary
  disruptions. Both only when replicas > 1: a minAvailable-1 PDB on one replica blocks node drains.
  Takes (dict "root" "component" "values"); each switch is <component>.topologySpread /
  <component>.podDisruptionBudget, on by default. */}}
{{- define "kaiju.topologySpread" -}}
{{- if and (gt (int .values.replicas) 1) (dig "topologySpread" "enabled" true .values) -}}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: {{ dig "topologySpread" "topologyKey" "kubernetes.io/hostname" .values }}
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "kaiju.selectorLabels" (dict "root" .root "component" .component) | nindent 8 }}
    # Count only the current ReplicaSet's pods, so a rolling update spreads the new ones too.
    matchLabelKeys: [pod-template-hash]
{{- end -}}
{{- end -}}

{{- define "kaiju.podDisruptionBudget" -}}
{{- if and (gt (int .values.replicas) 1) (dig "podDisruptionBudget" "enabled" true .values) -}}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "kaiju.fullname" .root }}-{{ .component }}
  labels:
    {{- include "kaiju.labels" .root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      {{- include "kaiju.selectorLabels" (dict "root" .root "component" .component) | nindent 6 }}
{{- end -}}
{{- end -}}

{{/* Kaiju image: <registry>/kaiju-<name>:<tag or appVersion>. */}}
{{- define "kaiju.image" -}}
{{- printf "%s/kaiju-%s:%s" .root.Values.global.imageRegistry .name (default .root.Chart.AppVersion .root.Values.global.imageTag) -}}
{{- end -}}

{{- define "kaiju.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "kaiju.podSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "kaiju.containerSecurityContext" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{/* Postgres app-role connection (never the owner). */}}
{{- define "kaiju.databaseEnv" -}}
{{- $fullname := include "kaiju.fullname" . -}}
{{- if eq .Values.postgres.mode "cnpg" }}
- name: KAIJU_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.cnpgAppSecretName" . }}
      key: password
- name: KAIJU_DATABASE_URL
  value: {{ printf "postgres://kobe_app:$(KAIJU_DB_PASSWORD)@%s-pg-rw:5432/kobe" $fullname | quote }}
{{- else }}
- name: KAIJU_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.external.existingSecret }}
      key: {{ .Values.postgres.external.appUrlKey }}
{{- end }}
{{- end -}}

{{/*
Postgres connection budget (KOBE-736). The server's pool sizes, its replica count and the full
pools of every other component that connects (scheduler, model gateway, egress proxy: replicas x
(pool + 1 LISTEN connection); the model gateway also holds the member rate limiter's own pool,
`modelGateway.database.ratePoolMax`, KOBE-810), so the server can warn at start when the total nears
max_connections. An estimate: rollout surge pods, the migrate Job and `kaiju backup` come on top.
*/}}
{{- define "kaiju.serverDbEnv" -}}
{{- $s := .Values.server.database -}}
{{- $sched := .Values.scheduler -}}
{{- $g := include "kaiju.modelGatewayValues" . | fromJson -}}
{{- $e := include "kaiju.egressProxyValues" . | fromJson -}}
{{- $peers := add (mul (int $sched.replicas) (add1 (int $sched.database.poolMax))) (mul (int $g.replicas) (add1 (add (int $g.database.poolMax) (int $g.database.ratePoolMax)))) (mul (int (default 1 $e.replicas)) (add1 (int $e.database.poolMax))) -}}
- name: KAIJU_DB_POOL_MAX
  value: {{ int $s.poolMax | quote }}
- name: KAIJU_DB_STREAM_POOL_MAX
  value: {{ int $s.streamPoolMax | quote }}
- name: KAIJU_DB_BUDGET_SERVER_REPLICAS
  value: {{ int .Values.server.replicas | quote }}
- name: KAIJU_DB_BUDGET_PEER_CONNECTIONS
  value: {{ $peers | quote }}
{{- end -}}

{{/* Public origin: explicit publicUrl, else derived from the ingress host and TLS setting. */}}
{{- define "kaiju.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl -}}
{{- else -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{- define "kaiju.authSecretName" -}}
{{- default (printf "%s-auth" (include "kaiju.fullname" .)) (.Values.auth).existingSecret -}}
{{- end -}}

{{/* Auth configuration: the API server only (the scheduler never gets these secrets). */}}
{{/* KOBE-695: HSTS includeSubDomains for the server and the web (default off). */}}
{{- define "kaiju.hstsEnv" -}}
- name: KAIJU_HSTS_INCLUDE_SUBDOMAINS
  value: {{ ternary "true" "false" (((.Values.ingress).hsts).includeSubDomains | default false) | quote }}
{{- end -}}

{{- define "kaiju.authEnv" -}}
- name: KAIJU_PUBLIC_URL
  value: {{ include "kaiju.publicUrl" . | quote }}
{{ include "kaiju.hstsEnv" . }}
- name: KAIJU_INGRESS_RATE_LIMIT
  value: {{ include "kaiju.ingress.rateLimitSource" . | quote }}
- name: KAIJU_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.authSecretName" . }}
      key: secret
- name: KAIJU_SETUP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.authSecretName" . }}
      key: setup-token
- name: KAIJU_TRUSTED_PROXIES
  value: {{ join "," (default (list "10.42.0.0/16") (.Values.auth).trustedProxies) | quote }}
{{ include "kaiju.ssoEnv" . }}
{{- end -}}

{{/* Outgoing email (KOBE-13): the API server only. Credentials come from a Secret, never values. */}}
{{- define "kaiju.smtpEnv" -}}
{{- $smtp := .Values.smtp | default dict -}}
- name: KAIJU_SMTP_HOST
  value: {{ required "smtp.host is required (spec D7: Kaiju sends invitations and password resets by email)" $smtp.host | quote }}
- name: KAIJU_SMTP_PORT
  value: {{ $smtp.port | default 587 | quote }}
- name: KAIJU_SMTP_SECURITY
  value: {{ $smtp.security | default "starttls" | quote }}
- name: KAIJU_SMTP_FROM
  value: {{ required "smtp.from is required, e.g. \"Kaiju <kaiju@example.com>\"" $smtp.from | quote }}
{{- with $smtp.existingSecret }}
- name: KAIJU_SMTP_USERNAME
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: username
- name: KAIJU_SMTP_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: password
{{- end }}
{{- end -}}

{{/* True when Helm can reach the cluster (install/upgrade); false for offline renders. */}}
{{- define "kaiju.online" -}}
{{- if lookup "v1" "Namespace" "" "kube-system" -}}true{{- end -}}
{{- end -}}

{{/*
Generated secrets are kept by looking up the existing Secret. Offline renders (helm template,
Argo CD, Flux) can't look anything up and would rotate them on every render, so they must use an
existing Secret, unless explicitly allowed for throwaway environments (dev, CI).
*/}}
{{- define "kaiju.requireOnlineToGenerate" -}}
{{- if and (not (include "kaiju.online" .root)) (not .root.Values.global.allowGeneratedSecretsOffline) -}}
{{- fail (printf "Cannot generate %s in an offline render (it would change on every render). Set %s to a pre-created Secret, or global.allowGeneratedSecretsOffline=true for a throwaway environment." .what .value) -}}
{{- end -}}
{{- end -}}

{{- define "kaiju.s3Env" -}}
- name: KAIJU_S3_ENDPOINT
  value: {{ .Values.s3.endpoint | quote }}
- name: KAIJU_S3_REGION
  value: {{ .Values.s3.region | quote }}
- name: KAIJU_S3_BUCKET
  value: {{ .Values.s3.bucket | quote }}
- name: KAIJU_S3_FORCE_PATH_STYLE
  value: {{ .Values.s3.forcePathStyle | quote }}
- name: KAIJU_S3_PREFIX
  value: {{ .Values.s3.prefix | default "" | quote }}
- name: KAIJU_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.s3.existingSecret }}
      key: access-key-id
- name: KAIJU_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.s3.existingSecret }}
      key: secret-access-key
{{- end -}}

{{/*
Deployment + Service for a Kaiju Node service.
Args: root, name (image + component), values, env (YAML list string), serviceAccount, healthPath,
extraVolumes / extraMounts / extraPorts / extraServicePorts (YAML list strings), preflight (isolation initContainer), migrations
(wait-for-migrations initContainer).
*/}}
{{- define "kaiju.nodeService" -}}
{{- $root := .root -}}
{{- $fullname := include "kaiju.fullname" $root -}}
{{- $sel := dict "root" $root "component" .component -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $fullname }}-{{ .component }}
  labels:
    {{- include "kaiju.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  replicas: {{ .values.replicas }}
  selector:
    matchLabels:
      {{- include "kaiju.selectorLabels" $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "kaiju.selectorLabels" $sel | nindent 8 }}
      {{- with .annotations }}
      annotations:
        {{- . | nindent 8 }}
      {{- end }}
    spec:
      {{- include "kaiju.imagePullSecrets" $root | nindent 6 }}
      serviceAccountName: {{ .serviceAccount | default (printf "%s-workload" $fullname) }}
      automountServiceAccountToken: {{ .automountToken | default false }}
      {{- with include "kaiju.topologySpread" (dict "root" $root "component" .component "values" .values) }}
      {{- . | nindent 6 }}
      {{- end }}
      {{- include "kaiju.podSecurityContext" $root | nindent 6 }}
      {{- if or .preflight .migrations }}
      initContainers:
        {{- if .preflight }}
        {{- include "kaiju.preflightContainer" $root | nindent 8 }}
        {{- end }}
        {{- if .migrations }}
        {{- include "kaiju.waitForMigrationsContainer" $root | nindent 8 }}
        {{- end }}
      {{- end }}
      containers:
        - name: {{ .component }}
          image: {{ include "kaiju.image" (dict "root" $root "name" .image) }}
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          {{- include "kaiju.containerSecurityContext" $root | nindent 10 }}
          ports:
            - name: http
              containerPort: 8080
            {{- with .extraPorts }}
            {{- . | nindent 12 }}
            {{- end }}
          env:
            - name: PORT
              value: "8080"
            {{- with .env }}
            {{- . | nindent 12 }}
            {{- end }}
          readinessProbe:
            httpGet: { path: {{ .readyPath | default "/readyz" }}, port: http }
            periodSeconds: 5
          # Liveness starts only once this passes: a slow start (busy node, first migration wait)
          # gets up to 3 minutes instead of being restarted after the liveness budget of ~30 s.
          startupProbe:
            httpGet: { path: {{ .healthPath | default "/healthz" }}, port: http }
            periodSeconds: 2
            failureThreshold: 90
          livenessProbe:
            httpGet: { path: {{ .healthPath | default "/healthz" }}, port: http }
            periodSeconds: 10
          resources:
            {{- toYaml .values.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            {{- with .extraMounts }}
            {{- . | nindent 12 }}
            {{- end }}
      volumes:
        - name: tmp
          {{- if .values.tmpSizeLimit }}
          emptyDir:
            sizeLimit: {{ .values.tmpSizeLimit | quote }}
          {{- else }}
          emptyDir: {}
          {{- end }}
        {{- with .extraVolumes }}
        {{- . | nindent 8 }}
        {{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $fullname }}-{{ .component }}
  labels:
    {{- include "kaiju.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  selector:
    {{- include "kaiju.selectorLabels" $sel | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
    {{- with .extraServicePorts }}
    {{- . | nindent 4 }}
    {{- end }}
{{- with include "kaiju.podDisruptionBudget" (dict "root" $root "component" .component "values" .values) }}
---
{{ . }}
{{- end }}
{{- end -}}


{{/* Isolation gate container: refuses to start unless the sandbox RuntimeClass isolates. */}}
{{- define "kaiju.preflightContainer" -}}
- name: isolation-preflight
  image: {{ include "kaiju.image" (dict "root" . "name" "server") }}
  imagePullPolicy: {{ .Values.global.imagePullPolicy }}
  command: ["node", "dist/cli/preflight.js"]
  env:
    - name: KAIJU_RUNTIME_CLASS
      value: {{ .Values.isolation.runtimeClassName | quote }}
  {{- include "kaiju.containerSecurityContext" . | nindent 2 }}
  terminationMessagePolicy: FallbackToLogsOnError
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits: { cpu: 500m, memory: 256Mi }
{{- end -}}


{{/* Holds a pod until this build's migrations are applied; runs as the app role. */}}
{{- define "kaiju.waitForMigrationsContainer" -}}
- name: wait-for-migrations
  image: {{ include "kaiju.image" (dict "root" . "name" "server") }}
  imagePullPolicy: {{ .Values.global.imagePullPolicy }}
  command: ["node", "node_modules/@kaiju/db/dist/cli/wait.js"]
  env:
    {{- include "kaiju.databaseEnv" . | nindent 4 }}
  {{- include "kaiju.containerSecurityContext" . | nindent 2 }}
  terminationMessagePolicy: FallbackToLogsOnError
  resources:
    requests: { cpu: 20m, memory: 64Mi }
    limits: { cpu: 200m, memory: 128Mi }
{{- end -}}

{{/* Audit forwarding destinations (KOBE-19); nothing is rendered when both are off. */}}
{{- define "kaiju.auditForwardingEnv" -}}
{{- $f := .Values.auditForwarding | default dict -}}
{{- $syslog := $f.syslog | default dict -}}
{{- $otlp := $f.otlp | default dict -}}
{{- if $syslog.enabled }}
- name: KAIJU_AUDIT_SYSLOG_URL
  value: {{ printf "%s://%s:%d" (ternary "tls" "tcp" ($syslog.tls | default false)) (required "auditForwarding.syslog.host is required when syslog forwarding is enabled" $syslog.host) ($syslog.port | default 6514 | int) | quote }}
{{- $pen := $syslog.enterpriseNumber | default 32473 }}
- name: KAIJU_AUDIT_SYSLOG_ENTERPRISE_NUMBER
  value: {{ ternary $pen ($pen | int64 | toString) (kindIs "string" $pen) | quote }}
{{- end }}
{{- if $otlp.enabled }}
- name: KAIJU_AUDIT_OTLP_URL
  value: {{ required "auditForwarding.otlp.endpoint is required when OTLP forwarding is enabled" $otlp.endpoint | quote }}
{{- with $otlp.headersSecret }}
- name: KAIJU_AUDIT_OTLP_HEADERS
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: headers
{{- end }}
{{- end }}
{{- end -}}

{{/* Extra CA bundle for the server's outgoing TLS (KOBE-182): a Secret or ConfigMap key mounted
  read-only at one fixed path, named by NODE_EXTRA_CA_CERTS. Empty when not configured. */}}
{{- define "kaiju.extraCaPath" -}}/etc/kaiju/extra-ca{{- end -}}

{{/*
The catalog git mirror (KOBE-343): the remote's token from an existing Secret (optional, so a
missing Secret leaves the mirror unable to push rather than the server down), and the identity.
*/}}
{{- define "kaiju.skillMirrorEnv" -}}
{{- $m := .Values.server.skillMirror | default dict -}}
{{- $t := $m.tokenSecret | default dict -}}
- name: KAIJU_SKILL_MIRROR_USERNAME
  value: {{ $m.username | default "x-access-token" | quote }}
- name: KAIJU_SKILL_MIRROR_AUTHOR_NAME
  value: {{ $m.authorName | default "Kaiju Registry" | quote }}
- name: KAIJU_SKILL_MIRROR_AUTHOR_EMAIL
  value: {{ $m.authorEmail | default "registry@kaiju.invalid" | quote }}
{{- if $t.name }}
- name: KAIJU_SKILL_MIRROR_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $t.name }}
      key: {{ $t.key | default "token" }}
      optional: true
{{- end }}
{{- end -}}

{{- define "kaiju.extraCaEnv" -}}
{{- $b := .Values.server.extraCaBundle | default dict -}}
{{- if or $b.secretName $b.configMapName -}}
- name: NODE_EXTRA_CA_CERTS
  value: {{ printf "%s/ca-bundle.pem" (include "kaiju.extraCaPath" .) | quote }}
{{- end -}}
{{- end -}}

{{- define "kaiju.extraCaMounts" -}}
{{- $b := .Values.server.extraCaBundle | default dict -}}
{{- if or $b.secretName $b.configMapName -}}
- name: extra-ca
  mountPath: {{ include "kaiju.extraCaPath" . }}
  readOnly: true
{{- end -}}
{{- end -}}

{{- define "kaiju.extraCaVolumes" -}}
{{- $b := .Values.server.extraCaBundle | default dict -}}
{{- $items := list (dict "key" ($b.key | default "ca.crt") "path" "ca-bundle.pem") -}}
{{- if $b.secretName -}}
- name: extra-ca
  secret:
    secretName: {{ $b.secretName }}
    items: {{ toJson $items }}
{{- else if $b.configMapName -}}
- name: extra-ca
  configMap:
    name: {{ $b.configMapName }}
    items: {{ toJson $items }}
{{- end -}}
{{- end -}}

{{/* Upload limits and the team storage quota (KOBE-143/185) as server env. */}}
{{- define "kaiju.uploadEnv" -}}
{{- $u := .Values.server.uploads -}}
- name: KAIJU_UPLOAD_MAX_FILE_BYTES
  value: {{ printf "%d" (int64 $u.maxFileBytes) | quote }}
- name: KAIJU_UPLOAD_MAX_MESSAGE_BYTES
  value: {{ printf "%d" (int64 $u.maxMessageBytes) | quote }}
- name: KAIJU_TEAM_STORAGE_QUOTA_BYTES
  value: {{ printf "%d" (int64 $u.teamStorageQuotaBytes) | quote }}
- name: KAIJU_UPLOAD_ORPHAN_HOURS
  value: {{ printf "%d" (int64 $u.orphanHours) | quote }}
- name: KAIJU_TEAM_MAX_OBJECTS
  value: {{ printf "%d" (int64 ($u.teamMaxObjects | default 2000000)) | quote }}
- name: KAIJU_PROJECT_HISTORY_MAX_COMMITS
  value: {{ printf "%d" (int64 ($u.projectHistoryMaxCommits | default 1000)) | quote }}
{{- if .Values.clamav.enabled }}
# Scanning on: every upload is streamed to clamd; clamd unreachable refuses uploads (fail closed).
- name: KAIJU_CLAMAV_HOST
  value: {{ printf "%s-clamav" (include "kaiju.fullname" .) | quote }}
- name: KAIJU_CLAMAV_PORT
  value: "3310"
{{- end }}
{{- end -}}

{{- /* Limits of catalog models without their own (KOBE-259): server and scheduler. */ -}}
{{- define "kaiju.modelDefaultsEnv" -}}
{{- $d := .Values.server.modelDefaults -}}
- name: KAIJU_MODEL_DEFAULT_MAX_OUTPUT_TOKENS
  value: {{ $d.maxOutputTokens | int | toString | quote }}
- name: KAIJU_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS
  value: {{ $d.reasoningMaxOutputTokens | int | toString | quote }}
- name: KAIJU_MODEL_DEFAULT_CONTEXT_WINDOW
  value: {{ $d.contextWindow | int | toString | quote }}
{{- end -}}

{{/* Pauses the nightly retention pass (KOBE-243): set after restoring the database from an older backup. */}}
{{- define "kaiju.retentionEnv" -}}
{{- $sw := .Values.retention.sweeps | default dict -}}
{{- $ev := $sw.events | default dict -}}
{{- $rn := $sw.readNotifications | default dict -}}
{{- $ru := $sw.runUsage | default dict -}}
{{- $eh := $sw.evalHistory | default dict -}}
- name: KAIJU_RETENTION_PAUSED
  value: {{ .Values.retention.paused | default false | toString | quote }}
{{- /* Table sweeps (KOBE-741): the period, or 0 when the sweep is turned off. */}}
- name: KAIJU_RETENTION_EVENTS_DAYS
  value: {{ ternary ($ev.days | default 30 | int) 0 (ne $ev.enabled false) | toString | quote }}
- name: KAIJU_RETENTION_READ_NOTIFICATIONS_DAYS
  value: {{ ternary ($rn.days | default 180 | int) 0 (ne $rn.enabled false) | toString | quote }}
- name: KAIJU_RETENTION_RUN_USAGE_MONTHS
  value: {{ ternary ($ru.months | default 13 | int) 0 (ne $ru.enabled false) | toString | quote }}
- name: KAIJU_RETENTION_EVAL_HISTORY_MONTHS
  value: {{ ternary ($eh.months | default 12 | int) 0 (ne $eh.enabled false) | toString | quote }}
{{- end -}}

{{/* Branding defaults (KOBE-503): seeded by the API server only while each setting is unset. Only set values render. */}}
{{- define "kaiju.brandingEnv" -}}
{{- $b := .Values.branding | default dict -}}
{{- if $b.appName }}
- name: KAIJU_BRANDING_APP_NAME
  value: {{ $b.appName | quote }}
{{- end }}
{{- if $b.preset }}
- name: KAIJU_BRANDING_PRESET
  value: {{ $b.preset | quote }}
{{- end }}
{{- if eq (toString $b.showName) "false" }}
- name: KAIJU_BRANDING_SHOW_NAME
  value: "false"
{{- end }}
{{- end -}}
