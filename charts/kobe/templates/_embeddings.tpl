{{/*
In-cluster embedding service values (KOBE-659) with defaults filled in, so a release that predates
these keys still renders. Keep in sync with values.yaml.
*/}}
{{- define "kobe.embeddingsValues" -}}
{{- $defaults := dict
  "enabled" true
  "image" (dict "repository" "ghcr.io/ggml-org/llama.cpp" "tag" "server-b12004" "digest" "sha256:b32890309c1a33a534a01b0b461e953dc2c5a6bac20213abcf48e22847a19c85")
  "model" (dict
    "name" "nomic-embed-text"
    "file" "nomic-embed-text-v1.5.f16.gguf"
    "download" true
    "url" "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/0188c9bf409793f810680a5a431e7b899c46104c/nomic-embed-text-v1.5.f16.gguf"
    "sha256" "f7af6f66802f4df86eda10fe9bbcfc75c39562bed48ef6ace719a251cf1c2fdb")
  "contextSize" 2048
  "threads" 2
  "persistence" (dict "enabled" true "size" "1Gi" "storageClass" "" "existingClaim" "")
  "networkPolicy" (dict "extraEgress" (list))
  "resources" (dict "requests" (dict "cpu" "1" "memory" "1Gi") "limits" (dict "cpu" "2" "memory" "1Gi")) -}}
{{- mustMergeOverwrite $defaults (deepCopy (dig "local" dict (.Values.embeddings | default dict))) | toJson -}}
{{- end -}}

{{- define "kobe.embeddingsImage" -}}
{{- $e := include "kobe.embeddingsValues" . | fromJson -}}
{{- if $e.image.digest -}}
{{- printf "%s:%s@%s" $e.image.repository $e.image.tag $e.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $e.image.repository $e.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "kobe.embeddingsUrl" -}}
{{- printf "http://%s-embeddings:8080" (include "kobe.fullname" .) -}}
{{- end -}}

{{/*
Server env: the local service's URL and model, for the gateway sync to register it in Bifrost as
the keyless provider `kobe-local` (services/server/src/models/local-embedding.ts). Nothing when off.
*/}}
{{- define "kobe.embeddingsServerEnv" -}}
{{- $e := include "kobe.embeddingsValues" . | fromJson -}}
{{- if $e.enabled }}
- name: KOBE_EMBEDDINGS_LOCAL_URL
  value: {{ include "kobe.embeddingsUrl" . | quote }}
- name: KOBE_EMBEDDINGS_LOCAL_MODEL
  value: {{ $e.model.name | quote }}
{{- end }}
{{- end -}}
