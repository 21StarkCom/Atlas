/**
 * `config/canonical-ref` — the CLI-boundary bridge from the configured canonical
 * ref to the broker's protected-ref set (60-A task 1.2a).
 *
 * Live-vault adoption (60-A) lets an operator point Atlas's canonical protected
 * ref at a non-default branch (e.g. `refs/atlas/main` for the adopted main-vault).
 * The audit + trust refs are NEVER overridable — they are the ledger/trust anchors,
 * fixed by the security model. {@link protectedRefsFor} therefore derives the broker
 * {@link ProtectedRefs} from {@link DEFAULT_PROTECTED_REFS} with ONLY `canonical`
 * replaced by the configured value, so a config typo can never redirect the audit or
 * trust ref.
 *
 * `DEFAULT_CANONICAL_REF` is re-exported from `@atlas/broker` — the SINGLE definition
 * of the fallback, shared with `DEFAULT_PROTECTED_REFS`; the config schema default and
 * this module both consume that one constant (never an inlined literal).
 */
import { DEFAULT_CANONICAL_REF, DEFAULT_PROTECTED_REFS, type ProtectedRefs } from "@atlas/broker";

export { DEFAULT_CANONICAL_REF };

/**
 * The broker protected-ref set for a configured canonical ref: {@link
 * DEFAULT_PROTECTED_REFS} with ONLY `canonical` overridden. `audit`/`trust` are
 * preserved verbatim — they are never config-supplied.
 */
export function protectedRefsFor(canonicalRef: string): ProtectedRefs {
  return { ...DEFAULT_PROTECTED_REFS, canonical: canonicalRef };
}
