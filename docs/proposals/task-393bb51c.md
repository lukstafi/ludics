# Proposal: t3code SQLite crash resilience

## Summary

Add three defensive measures to `src/t3code/server.ts` to prevent and recover from SQLite WAL corruption on t3code server crashes: (1) WAL checkpoint on clean stop, (2) backup before start, (3) integrity check with auto-recovery on start.

All changes are ludics-side only — no upstream t3code modifications needed.

## Current state

- `state.sqlite` lives at `<harnessDir>/t3code/userdata/state.sqlite` with WAL mode enabled (set by upstream t3code in `persistence/Layers/Sqlite.ts`: `PRAGMA journal_mode = WAL`)
- `ensureServer()` handles crash log preservation (`server-crashes.log`) and lock-based startup coordination
- `stopServer()` sends SIGTERM, waits up to 5s, then SIGKILL — but does **not** checkpoint the WAL before killing
- On 2026-03-26, an unclean shutdown left the WAL inconsistent, corrupting the DB. Manual `sqlite3 .recover` fixed it but lost session IDs.

## Proposed changes

### 1. WAL checkpoint on clean stop (`stopServer()`)

Before sending SIGTERM in `stopServer()`, open the SQLite DB directly and run:

```ts
import { Database } from "bun:sqlite";

function checkpointWal(dbPath: string): void {
  try {
    const db = new Database(dbPath, { readonly: false });
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (err) {
    // Log but don't fail — the stop must proceed
    console.error(`t3code: WAL checkpoint failed: ${err}`);
  }
}
```

Called at the top of `stopServer()`, before `terminateProcess()`. Uses `bun:sqlite` directly since the t3code server process owns the DB connection — we open a second connection briefly just for the checkpoint. `TRUNCATE` mode resets the WAL file to zero length after checkpointing, ensuring the main DB file is fully up to date.

**Why before SIGTERM**: The t3code process holds an active connection. SQLite allows multiple readers but checkpointing with `TRUNCATE` requires exclusive access. However, `PASSIVE` mode (which doesn't require exclusive access) would also work — it checkpoints as many frames as possible without blocking. We'll use `TRUNCATE` first and fall back to `PASSIVE` if it fails:

```ts
function checkpointWal(dbPath: string): void {
  try {
    const db = new Database(dbPath, { readonly: false });
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // TRUNCATE needs exclusive lock; fall back to passive
      try { db.run("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* ignore */ }
    }
    db.close();
  } catch (err) {
    console.error(`t3code: WAL checkpoint failed: ${err}`);
  }
}
```

### 2. Backup before start (`ensureServer()`)

After acquiring the lock but before spawning the t3code process, copy the DB files as a restore point:

```ts
import { copyFileSync } from "fs";

function backupDb(dbPath: string): void {
  // Rotate: .bak.1 → .bak.2, .bak → .bak.1
  for (const ext of [".bak.1", ".bak"]) {
    const src = dbPath + ext;
    const dst = dbPath + ext.replace(/(\.\d)?$/, (m) => m ? `.${parseInt(m.slice(1)) + 1}` : ".1");
    if (existsSync(src)) {
      try { renameSync(src, dst); } catch { /* ignore */ }
    }
  }
  // Copy current DB to .bak
  if (existsSync(dbPath)) {
    try {
      copyFileSync(dbPath, dbPath + ".bak");
      // Also back up WAL/SHM if present (they're needed for consistent state)
      if (existsSync(dbPath + "-wal")) copyFileSync(dbPath + "-wal", dbPath + ".bak-wal");
      if (existsSync(dbPath + "-shm")) copyFileSync(dbPath + "-shm", dbPath + ".bak-shm");
    } catch (err) {
      console.error(`t3code: DB backup failed: ${err}`);
    }
  }
}
```

Rotation keeps the last 2 backups (~360 MB total for a 180 MB DB). The backup runs after the WAL checkpoint (if a clean stop preceded this start), so `.bak` should typically be a consistent snapshot.

### 3. Integrity check with auto-recovery (`ensureServer()`)

After backup, before spawning:

```ts
function checkAndRecoverDb(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true; // fresh start

  try {
    const db = new Database(dbPath, { readonly: true });
    const result = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    db.close();
    if (result.integrity_check === "ok") return true;
    console.error(`t3code: integrity check failed: ${result.integrity_check}`);
  } catch (err) {
    console.error(`t3code: integrity check error: ${err}`);
  }

  // Attempt .recover
  console.error("t3code: attempting automatic recovery...");
  const recoveredPath = dbPath + ".recovered";
  const recoverResult = Bun.spawnSync(
    ["sqlite3", dbPath, `.output ${recoveredPath}`, ".recover"],
    { stdout: "pipe", stderr: "pipe" }
  );

  if (recoverResult.exitCode === 0 && existsSync(recoveredPath)) {
    // Swap: move corrupt DB aside, put recovered in place
    renameSync(dbPath, dbPath + ".corrupt");
    renameSync(recoveredPath, dbPath);
    // Clean up WAL/SHM from corrupt version
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(dbPath + ".corrupt" + ext)) {
        try { unlinkSync(dbPath + ".corrupt" + ext); } catch { /* ignore */ }
      }
    }
    console.error("t3code: recovery succeeded — swapped to recovered DB");
    return true;
  }

  // .recover failed — try restoring from backup
  console.error("t3code: .recover failed, trying backup restore...");
  if (existsSync(dbPath + ".bak")) {
    renameSync(dbPath, dbPath + ".corrupt");
    copyFileSync(dbPath + ".bak", dbPath);
    if (existsSync(dbPath + ".bak-wal")) copyFileSync(dbPath + ".bak-wal", dbPath + "-wal");
    if (existsSync(dbPath + ".bak-shm")) copyFileSync(dbPath + ".bak-shm", dbPath + "-shm");
    console.error("t3code: restored from backup");
    return true;
  }

  console.error("t3code: no backup available — starting with corrupt DB (may fail)");
  return false;
}
```

### 4. PRAGMA verification on start

After the server starts successfully (after `waitForReady()`), we could verify WAL mode is active. However, since WAL mode is set by upstream t3code in `Sqlite.ts`, and we don't control that code, this is informational only. We'll skip this to keep the change minimal — the upstream already sets `PRAGMA journal_mode = WAL` on every startup.

## Integration into existing code

### `stopServer()` changes

```ts
export async function stopServer(options: EnsureServerOptions = {}): Promise<boolean> {
  const harnessDir = options.harnessDir ?? defaultHarnessDir();
  const record = readServerRecord(harnessDir);
  if (!record) return false;

  // Checkpoint WAL before stopping — reduces corruption risk on unclean shutdown
  const dbPath = join(record.stateDir, "userdata", "state.sqlite");
  checkpointWal(dbPath);

  const inspection = inspectManagedServerProcess(record);
  const stopped = inspection.matchesRecord
    ? await terminateProcess(record.pid)
    : false;
  const path = t3codeServerPath(harnessDir);
  if (existsSync(path)) unlinkSync(path);
  return stopped;
}
```

### `ensureServer()` changes

Insert after `migrateStateDirIfNeeded(t3Home)` and before `buildLaunchCommand()`:

```ts
const dbPath = join(t3Home, "userdata", "state.sqlite");
backupDb(dbPath);
checkAndRecoverDb(dbPath);
```

## Testing plan

1. **Manual: clean stop** — run `ludics t3code stop`, verify WAL file is truncated (0 bytes or absent)
2. **Manual: backup rotation** — start server 3 times, verify `state.sqlite.bak` and `state.sqlite.bak.1` exist
3. **Manual: integrity check** — corrupt a test DB copy, run `ensureServer()`, verify auto-recovery kicks in
4. **Regression**: ensure normal start/stop cycle still works with no visible changes to the user

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| WAL checkpoint blocks if t3code holds an exclusive lock | Fall back from TRUNCATE to PASSIVE; checkpoint failure is non-fatal |
| `bun:sqlite` version mismatch with t3code's SQLite | Both use the same Bun runtime; WAL is a standard SQLite feature |
| Backup adds ~1s to startup time | Acceptable for a 180 MB file; runs only on server start, not on every request |
| `.recover` produces an incomplete DB | We keep the `.corrupt` file and `.bak` as additional fallbacks |

## Scope

- **Files changed**: `src/t3code/server.ts` only
- **New imports**: `copyFileSync` from `fs`, `Database` from `bun:sqlite`
- **No upstream changes**: all logic is in the ludics server management layer
- **Effort**: small (estimated 1-2 hours)
