/**
 * Identity-namespace validation (Task 4.4). Alias/slug/id collisions are caught
 * PRE-COMMIT here so two notes can never come to share a normalized identity
 * key (which would make `<id-or-slug>` resolution ambiguous). The canonical fold
 * is `@atlas/contracts` `normalizeIdentityKey` (the versioned SSOT both the CLI
 * and the store use), re-exported via `vault/identity`.
 */
import type { ChangePlan } from "@atlas/contracts";
import { normalizeIdentityKey } from "../vault/identity.js";
import type { ValidationContext, ValidationFinding } from "./index.js";

/** Collision checks for the identity-minting ops (`CreateNote`, `AddAlias`). */
export function checkIdentity(plan: ChangePlan, ctx: ValidationContext): ValidationFinding[] {
  const op = plan.operation;
  const out: ValidationFinding[] = [];

  if (op.op === "CreateNote") {
    const key = normalizeIdentityKey(plan.target);
    const owners = ctx.vault.identityOwners(key);
    if (ctx.vault.hasNoteId(plan.target) || owners.length > 0) {
      out.push({
        code: "identity-collision",
        severity: "error",
        detail: `new note id «${plan.target}» collides with existing ${ctx.vault.hasNoteId(plan.target) ? `note '${plan.target}'` : `identity of '${owners[0]}'`}`,
      });
    }
  }

  if (op.op === "AddAlias") {
    const key = normalizeIdentityKey(op.alias);
    // An alias may collide with another note's id/slug/alias — but not with the
    // target note itself (re-declaring the note's own key is a no-op, not a clash).
    const owners = ctx.vault.identityOwners(key).filter((id) => id !== plan.target);
    if (owners.length > 0) {
      out.push({ code: "identity-collision", severity: "error", detail: `alias «${op.alias}» collides with the identity of note '${owners[0]}'` });
    }
    // The op's advisory normalizedKey (if present) must match the canonical fold.
    if (op.normalizedKey !== undefined && op.normalizedKey !== key) {
      out.push({ code: "normalized-key-mismatch", severity: "error", detail: `advisory normalizedKey «${op.normalizedKey}» ≠ canonical «${key}»` });
    }
  }

  return out;
}
