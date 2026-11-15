---
name: otel-helper
description: Use when a task asks for OpenTelemetry span, trace or metric instrumentation in a Node service.
---

# OpenTelemetry helper

Use this skill when the task names OpenTelemetry and asks for instrumentation
of spans, traces or metrics. Prefer official `@opentelemetry/*` packages, name
spans after the operation and never invent an exporter endpoint.
