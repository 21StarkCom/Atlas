<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: node tools/gen-cli-contract.ts --write
     Source of truth: docs/specs/cli-contract/commands.json -->

# Atlas — CLI command surface (generated overview)

Registry version: **1** · Commands: **49**

| Phase | Command | Idempotency | Privilege | Implemented | Schema |
|---|---|---|---|---|---|
| 1 | `db backup` | key-accepting | shared | yes | `docs/specs/cli-contract/db-backup.schema.json` |
| 1 | `db migrate` | intrinsic | shared | no | `docs/specs/cli-contract/db-migrate.schema.json` |
| 1 | `db rebuild` | intrinsic | shared | yes | `docs/specs/cli-contract/db-rebuild.schema.json` |
| 1 | `db restore` | key-accepting | privileged | yes | `docs/specs/cli-contract/db-restore.schema.json` |
| 1 | `db status` | none | shared | no | `docs/specs/cli-contract/db-status.schema.json` |
| 1 | `db verify` | none | shared | yes | `docs/specs/cli-contract/db-verify.schema.json` |
| 1 | `doctor` | none | shared | yes | `docs/specs/cli-contract/doctor.schema.json` |
| 1 | `inspect` | none | shared | yes | `docs/specs/cli-contract/inspect.schema.json` |
| 1 | `status` | none | shared | yes | `docs/specs/cli-contract/status.schema.json` |
| 2 | `git cleanup` | intrinsic | shared | no | `docs/specs/cli-contract/git-cleanup.schema.json` |
| 2 | `git status` | none | shared | no | `docs/specs/cli-contract/git-status.schema.json` |
| 2 | `ingest` | key-accepting | shared | no | `docs/specs/cli-contract/ingest.schema.json` |
| 2 | `jobs cancel` | key-accepting | shared | no | `docs/specs/cli-contract/jobs-cancel.schema.json` |
| 2 | `jobs list` | none | shared | no | `docs/specs/cli-contract/jobs-list.schema.json` |
| 2 | `jobs retry` | key-accepting | shared | no | `docs/specs/cli-contract/jobs-retry.schema.json` |
| 2 | `jobs run` | key-accepting | shared | no | `docs/specs/cli-contract/jobs-run.schema.json` |
| 2 | `note history` | none | shared | no | `docs/specs/cli-contract/note-history.schema.json` |
| 2 | `note related` | none | shared | no | `docs/specs/cli-contract/note-related.schema.json` |
| 2 | `note show` | none | shared | no | `docs/specs/cli-contract/note-show.schema.json` |
| 2 | `source add` | key-accepting | shared | no | `docs/specs/cli-contract/source-add.schema.json` |
| 2 | `source list` | none | shared | no | `docs/specs/cli-contract/source-list.schema.json` |
| 2 | `source show` | none | shared | no | `docs/specs/cli-contract/source-show.schema.json` |
| 2 | `source trust show` | none | shared | no | `docs/specs/cli-contract/source-trust-show.schema.json` |
| 3 | `index rebuild` | intrinsic | shared | no | `docs/specs/cli-contract/index-rebuild.schema.json` |
| 3 | `index repair` | intrinsic | shared | no | `docs/specs/cli-contract/index-repair.schema.json` |
| 3 | `index status` | none | shared | no | `docs/specs/cli-contract/index-status.schema.json` |
| 3 | `index verify` | none | shared | no | `docs/specs/cli-contract/index-verify.schema.json` |
| 3 | `query` | none | shared | no | `docs/specs/cli-contract/query.schema.json` |
| 4 | `enrich` | key-accepting | shared | no | `docs/specs/cli-contract/enrich.schema.json` |
| 4 | `evidence resolve` | intrinsic | shared | no | `docs/specs/cli-contract/evidence-resolve.schema.json` |
| 4 | `evidence retry` | intrinsic | shared | no | `docs/specs/cli-contract/evidence-retry.schema.json` |
| 4 | `evidence review` | none | shared | no | `docs/specs/cli-contract/evidence-review.schema.json` |
| 4 | `git approve` | key-accepting | privileged | no | `docs/specs/cli-contract/git-approve.schema.json` |
| 4 | `git refresh` | key-accepting | privileged | no | `docs/specs/cli-contract/git-refresh.schema.json` |
| 4 | `git reject` | intrinsic | shared | no | `docs/specs/cli-contract/git-reject.schema.json` |
| 4 | `git review` | none | shared | no | `docs/specs/cli-contract/git-review.schema.json` |
| 4 | `git rollback` | key-accepting | privileged | no | `docs/specs/cli-contract/git-rollback.schema.json` |
| 4 | `git verify` | intrinsic | shared | no | `docs/specs/cli-contract/git-verify.schema.json` |
| 4 | `maintain` | key-accepting | shared | no | `docs/specs/cli-contract/maintain.schema.json` |
| 4 | `purge` | key-accepting | privileged | no | `docs/specs/cli-contract/purge.schema.json` |
| 4 | `reconcile` | key-accepting | shared | no | `docs/specs/cli-contract/reconcile.schema.json` |
| 4 | `source trust promote` | key-accepting | privileged | no | `docs/specs/cli-contract/source-trust-promote.schema.json` |
| 4 | `source trust revoke` | key-accepting | privileged | no | `docs/specs/cli-contract/source-trust-revoke.schema.json` |
| 4 | `validate` | none | shared | no | `docs/specs/cli-contract/validate.schema.json` |
| 5 | `graduation audit` | none | shared | yes | `docs/specs/cli-contract/graduation-audit.schema.json` |
| 5 | `graduation migrate` | key-accepting | privileged | yes | `docs/specs/cli-contract/graduation-migrate.schema.json` |
| 5 | `graduation scan` | none | shared | yes | `docs/specs/cli-contract/graduation-scan.schema.json` |
| 5 | `quarantine inspect` | none | privileged | yes | `docs/specs/cli-contract/quarantine-inspect.schema.json` |
| 5 | `quarantine resolve` | key-accepting | privileged | yes | `docs/specs/cli-contract/quarantine-resolve.schema.json` |
