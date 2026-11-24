{{- define "kaiju.migrateJob" -}}
{{- $root := .root -}}
{{- $fullname := include "kaiju.fullname" $root -}}
{{- $cnpg := eq $root.Values.postgres.mode "cnpg" }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .name }}
  labels:
    {{- include "kaiju.labels" $root | nindent 4 }}
  {{- with .hook }}
  annotations:
    helm.sh/hook: {{ . }}
    helm.sh/hook-weight: "0"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
  {{- end }}
spec:
  backoffLimit: 0
  # The runner cancels its own statements on SIGTERM (KOBE-734), within the grace period below.
  activeDeadlineSeconds: {{ (($root.Values.postgres.migrateJob | default dict).activeDeadlineSeconds) | default 1800 }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ include "kaiju.appName" $root }}
        app.kubernetes.io/instance: {{ $root.Release.Name }}
        # Selected by the CloudNativePG ingress policy (networkpolicies.yaml, KOBE-699).
        app.kubernetes.io/component: migrate
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 30
      {{- include "kaiju.imagePullSecrets" $root | nindent 6 }}
      # No serviceAccountName: as a pre-install hook it runs before release ServiceAccounts exist,
      # and it needs no API access (token not mounted).
      automountServiceAccountToken: false
      enableServiceLinks: false
      {{- include "kaiju.podSecurityContext" $root | nindent 6 }}
      containers:
        - name: migrate
          image: {{ include "kaiju.image" (dict "root" $root "name" "server") }}
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          command: ["node", "node_modules/@kaiju/db/dist/cli/migrate.js"]
          env:
            - name: KAIJU_DB_MIGRATE_URL
              valueFrom:
                secretKeyRef:
                  {{- if $cnpg }}
                  name: {{ $fullname }}-pg-app
                  key: uri
                  {{- else }}
                  name: {{ $root.Values.postgres.external.existingSecret }}
                  key: {{ $root.Values.postgres.external.migrateUrlKey }}
                  {{- end }}
            - name: KAIJU_DB_APP_ROLE
              value: {{ ternary "kobe_app" (default "kobe_app" $root.Values.postgres.external.appRole) $cnpg | quote }}
          {{- include "kaiju.containerSecurityContext" $root | nindent 10 }}
          terminationMessagePolicy: FallbackToLogsOnError
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { cpu: "1", memory: 512Mi }
{{- end -}}
