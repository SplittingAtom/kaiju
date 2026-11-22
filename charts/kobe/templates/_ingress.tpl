{{/*
KOBE-811: optional per-source-IP rate limit at the ingress (Traefik Middleware, off by default).
The main Ingress gets `<release>-ratelimit`; long-lived event streams (SSE) get their own Ingress
with `<release>-ratelimit-streams` (or none), so reconnects of open streams do not spend the
request budget of page loads and API calls.
*/}}

{{/* Event-stream paths (SSE) the server serves under /v1: run events, workspace events and
changes, skill-eval events. Traefik PathRegexp (Go regexp); the path must start with "/" for the
Kubernetes API, so it is anchored only at the end. */}}
{{- define "kobe.ingress.streamPathRegexp" -}}
/v1/(runs/[^/]+/events|workspace/(events|changes)|skill-evals/[^/]+/events)$
{{- end }}

{{/* Annotations of an Ingress: the TLS/cert-manager ones, the user's, and the rate-limit
middleware (prepended to any `router.middlewares` the user set). Args: root, middleware ("" for
none), extra (dict of further annotations), secondary (true: no cert-manager annotations, since
the main Ingress already owns the Certificate for the shared TLS Secret). */}}
{{- define "kobe.ingress.annotations" -}}
{{- $root := .root -}}
{{- $tls := $root.Values.ingress.tls -}}
{{- $key := "traefik.ingress.kubernetes.io/router.middlewares" -}}
{{- $user := deepCopy (default dict $root.Values.ingress.annotations) -}}
{{- $mws := list -}}
{{- with .middleware }}
{{- $mws = append $mws (printf "%s-%s@kubernetescrd" $root.Release.Namespace .) -}}
{{- end }}
{{- with (get $user $key) }}
{{- $mws = append $mws . -}}
{{- end }}
{{- $_ := unset $user $key -}}
{{- if .secondary }}
{{- range $k, $_ := $user }}
{{- if hasPrefix "cert-manager.io/" $k }}{{- $_ := unset $user $k -}}{{- end }}
{{- end }}
{{- end }}
{{- if $tls.enabled }}
traefik.ingress.kubernetes.io/router.entrypoints: websecure
traefik.ingress.kubernetes.io/router.tls: "true"
{{- end }}
{{- if not .secondary }}{{- with $tls.clusterIssuer }}
cert-manager.io/cluster-issuer: {{ . }}
{{- end }}{{- end }}
{{- with .extra }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- with $user }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- if $mws }}
{{ $key }}: {{ join "," $mws | quote }}
{{- end }}
{{- end }}

{{/* A Traefik rateLimit spec. Args: root, limit (average, burst, period). The source is the
request's remote address unless ingress.rateLimit.ipStrategy sets depth or excluded IPs (with
excludeTrustedProxies, auth.trustedProxies join the excluded IPs, so Traefik skips the same
proxies the server trusts). */}}
{{- define "kobe.ingress.rateLimitSpec" -}}
{{- $s := default dict .root.Values.ingress.rateLimit.ipStrategy -}}
{{- $depth := int (default 0 $s.depth) -}}
{{- $excluded := concat (default list $s.excludedIPs) (ternary (default list .root.Values.auth.trustedProxies) list (eq $s.excludeTrustedProxies true)) | uniq -}}
rateLimit:
  average: {{ int .limit.average }}
  burst: {{ int .limit.burst }}
  period: {{ .limit.period | quote }}
  {{- if or (gt $depth 0) $excluded }}
  sourceCriterion:
    ipStrategy:
      {{- if gt $depth 0 }}
      depth: {{ $depth }}
      {{- else }}
      excludedIPs:
        {{- toYaml $excluded | nindent 8 }}
      {{- end }}
  {{- end }}
{{- end }}
