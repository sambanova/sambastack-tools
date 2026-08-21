{{/* Base name, overridable. */}}
{{- define "sambaeval.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully-qualified release name. */}}
{{- define "sambaeval.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "sambaeval.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "sambaeval.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Per-component selector labels. Call with (dict "root" . "component" "api"). */}}
{{- define "sambaeval.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sambaeval.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* ServiceAccount name. */}}
{{- define "sambaeval.serviceAccountName" -}}
{{- default (include "sambaeval.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}

{{/* Fully-qualified image refs (Makefile overrides repository/tag with --set). */}}
{{- define "sambaeval.backendImage" -}}
{{- printf "%s:%s" .Values.image.backend.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "sambaeval.frontendImage" -}}
{{- printf "%s:%s" .Values.image.frontend.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* Name of the env ConfigMap. */}}
{{- define "sambaeval.configMapName" -}}
{{- printf "%s-env" (include "sambaeval.fullname" .) -}}
{{- end -}}
