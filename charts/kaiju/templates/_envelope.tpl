{{/* Site key-encryption key for envelope encryption (KOBE-107): the API server only. */}}
{{- define "kaiju.envelopeSecretName" -}}
{{- default (printf "%s-envelope-key" (include "kaiju.fullname" .)) (.Values.envelope).keySecret -}}
{{- end -}}

{{- define "kaiju.envelopeEnv" -}}
- name: KAIJU_ENVELOPE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.envelopeSecretName" . }}
      key: key
- name: KAIJU_ENVELOPE_KEY_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ include "kaiju.envelopeSecretName" . }}
      key: key-previous
      optional: true
{{- end -}}
