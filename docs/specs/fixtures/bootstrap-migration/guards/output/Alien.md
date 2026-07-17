---
id: alien-alien-typed-note
type: alien
schema_version: 1
title: Alien Typed Note
created: 2026-07-12T00:00:00Z
updated: 2026-07-12T00:00:00Z
declaredSensitivity: internal
---

# Alien Typed Note

Declares an explicit type Atlas does not manage. Migration owns the `type` key, so it can
neither overwrite this value nor guess — the note is refused (unknown-type), never mutated.
