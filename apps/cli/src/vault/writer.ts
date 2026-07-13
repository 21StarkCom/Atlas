/**
 * The vault WRITER primitive (Task 1.3). `writeNoteFile` is the single sanctioned
 * way workflow code mutates a note on disk: write to a sibling temp file, fsync
 * it, then atomically `rename` it over the target. A crash mid-write can leave a
 * stray `*.atlas-tmp-*` file but never a torn note — readers see either the old
 * bytes or the new ones, never a partial write.
 *
 * Scope: the primitive only. Patch GENERATION (what content to write) is Phase 4.
 */
import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Atomically write `content` to `path` via write-temp-fsync-rename. The temp file
 * lives in the target's own directory so `rename` stays on one filesystem (a
 * cross-device rename is not atomic).
 *
 * The failure contract covers the WHOLE operation: if `writeFile`, `sync`,
 * `close`, or `rename` fails, the handle is closed and the temp file is
 * best-effort removed before the ORIGINAL error is rethrown — no `*.atlas-tmp`
 * residue is left behind on any path. (If `open` itself fails, no temp file was
 * created, so there is nothing to clean up.)
 */
export async function writeNoteFile(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.atlas-tmp`);
  const handle = await open(tmp, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
  } catch (e) {
    // Best-effort cleanup that preserves the primary error `e`: closing an
    // already-closed handle or unlinking a gone temp both no-op via `.catch`.
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
