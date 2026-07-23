<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: node tools/gen-cli-contract.ts --write
     Source of truth: docs/specs/cli-contract/commands.json -->

# Atlas — CLI command surface (generated overview)

Registry version: **2** · Commands: **24**

| Phase | Command | Idempotency | Privilege | Implemented | Schema |
|---|---|---|---|---|---|
| 1 | `db migrate` | intrinsic | shared | yes | `docs/specs/cli-contract/db-migrate.schema.json` |
| 1 | `db rebuild` | intrinsic | shared | yes | `docs/specs/cli-contract/db-rebuild.schema.json` |
| 1 | `status` | none | shared | yes | `docs/specs/cli-contract/status.schema.json` |
| 2 | `ingest` | key-accepting | shared | yes | `docs/specs/cli-contract/ingest.schema.json` |
| 2 | `jobs list` | none | shared | yes | `docs/specs/cli-contract/jobs-list.schema.json` |
| 2 | `jobs run` | key-accepting | shared | yes | `docs/specs/cli-contract/jobs-run.schema.json` |
| 2 | `note add` | key-accepting | shared | yes | `docs/specs/cli-contract/note-add.schema.json` |
| 2 | `note history` | none | shared | yes | `docs/specs/cli-contract/note-history.schema.json` |
| 2 | `note related` | none | shared | yes | `docs/specs/cli-contract/note-related.schema.json` |
| 2 | `note show` | none | shared | yes | `docs/specs/cli-contract/note-show.schema.json` |
| 2 | `source add` | intrinsic | shared | yes | `docs/specs/cli-contract/source-add.schema.json` |
| 2 | `source list` | none | shared | yes | `docs/specs/cli-contract/source-list.schema.json` |
| 2 | `source show` | none | shared | yes | `docs/specs/cli-contract/source-show.schema.json` |
| 3 | `index rebuild` | intrinsic | shared | yes | `docs/specs/cli-contract/index-rebuild.schema.json` |
| 3 | `query` | none | shared | yes | `docs/specs/cli-contract/query.schema.json` |
| 4 | `enrich` | key-accepting | shared | yes | `docs/specs/cli-contract/enrich.schema.json` |
| 4 | `evidence resolve` | none | shared | yes | `docs/specs/cli-contract/evidence-resolve.schema.json` |
| 4 | `evidence retry` | none | shared | yes | `docs/specs/cli-contract/evidence-retry.schema.json` |
| 4 | `evidence review` | none | shared | yes | `docs/specs/cli-contract/evidence-review.schema.json` |
| 4 | `link` | intrinsic | shared | yes | `docs/specs/cli-contract/link.schema.json` |
| 4 | `maintain` | key-accepting | shared | yes | `docs/specs/cli-contract/maintain.schema.json` |
| 4 | `validate` | none | shared | yes | `docs/specs/cli-contract/validate.schema.json` |
| 5 | `index eval` | none | shared | yes | `docs/specs/cli-contract/index-eval.schema.json` |
| 5 | `sync` | intrinsic | shared | yes | `docs/specs/cli-contract/sync.schema.json` |
