---
title: Secret-Bearing Input (adversarial)
---

# Secret-Bearing Input

This fixture embeds high-signal secret *shapes* so the fail-closed secret scanner
(exit code 3) has something to catch. Every value below is synthetic and — crucially —
**structurally broken with a `⟪BREAK⟫` marker** so GitHub push protection does not
match it (this is a public repo). The scanner ruleset (Task #28) is designed to catch
these broken fixture forms; the **live-format** secrets used to prove the fail-closed
guarantee are **materialized at runtime** by `@atlas/testing` (never committed).

AWS access key: `AKIA⟪BREAK⟫IOSFODNN7EXAMPLE`
AWS secret access key: `wJalrXUtnF⟪BREAK⟫EMI/K7MDENG/bPxRfiCYEXAMPLEKEY`
GitHub token: `ghp⟪BREAK⟫_0123456789abcdefghijklmnopqrstuvwxyzAB`
Slack token: `xoxb⟪BREAK⟫-000000000000-000000000000-000000000000000000000000`
Generic API key: `api_key = "sk-live⟪BREAK⟫-000000000000000000000000000000000000"`
Password assignment: `password = "hunter2-do-not-use"`

-----BEGIN OPENSSH⟪BREAK⟫PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZQ
THIS-IS-A-FAKE-KEY-BODY-FOR-SCANNER-FIXTURES-ONLY-0000000000000000000
-----END OPENSSH PRIVATE KEY-----
