/**
 * Subprocess helper for the restore process-crash test (round-3 finding 4). Runs a
 * real `restoreBackup` and HARD-EXITS (`process.exit`, no `finally`/`catch`) at the
 * requested filesystem seam, simulating a SIGKILL mid-restore. The parent test then
 * runs `recoverInterruptedRestore` and asserts the prior DB is intact.
 *
 * argv: <distIndex> <dbPath> <backupDir> <backupRef> <keyHex> <keyId> <seam>
 * Imports the BUILT package (dist) so it runs as plain ESM in a child `node`.
 */
const [, , distIndex, dbPath, backupDir, backupRef, keyHex, keyId, seam] = process.argv;
const { openStore, restoreBackup } = await import(distIndex);

const store = openStore({ path: dbPath });
const cfg = { dir: backupDir, key: Uint8Array.from(Buffer.from(keyHex, "hex")), keyId, keep: 10 };

await restoreBackup(store, backupRef, cfg, {
  failpoint: (s) => {
    if (s === seam) {
      // Hard kill: no unwind, no rollback, no journal cleanup — a true crash.
      process.exit(137);
    }
  },
});
// If we get here the seam never fired; signal an unexpected clean completion.
process.exit(0);
