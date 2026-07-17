---
id: 42-malformed-type-note
type: 42
schema_version: 1
title: Malformed Type Note
created: 2026-07-12T00:00:00Z
updated: 2026-07-12T00:00:00Z
declaredSensitivity: internal
---

# Malformed Type Note

The explicit `type` is not a string. It cannot be a known managed type, so the note is
refused (unknown-type) rather than silently overwritten.
