import { randomUUID } from 'crypto';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getBlobStore } from '../blob/blob-store.js';
import { auditLog } from '../db/audit.js';
import { config } from '../config.js';

interface ExportSchedule {
  id: string;
  community_did: string;
  interval: string;
  retention_count: number;
  enabled: boolean;
  last_export_at: string | null;
}

function intervalToMs(interval: string): number {
  switch (interval) {
    case 'daily': return 24 * 60 * 60 * 1000;
    case 'weekly': return 7 * 24 * 60 * 60 * 1000;
    case 'monthly': return 30 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

function isDue(schedule: ExportSchedule): boolean {
  if (!schedule.last_export_at) return true;
  const lastExport = new Date(schedule.last_export_at).getTime();
  const intervalMs = intervalToMs(schedule.interval);
  return Date.now() - lastExport >= intervalMs;
}

async function exportCommunity(schedule: ExportSchedule): Promise<void> {
  const { community_did, retention_count } = schedule;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const storageKey = `exports/${community_did}/${timestamp}.car`;

  try {
    const engine = new RepoEngine(community_did);
    const hasRepo = await engine.hasRepo();
    if (!hasRepo) {
      console.log(`[Export] No repo for ${community_did}, skipping`);
      return;
    }

    const carStream = await engine.exportAsCAR();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of carStream) {
      chunks.push(chunk);
      totalSize += chunk.length;
    }
    const carData = Buffer.concat(chunks.map(c => Buffer.from(c)));

    const store = await getBlobStore();
    await store.put(storageKey, carData, 'application/vnd.ipld.car');

    const verified = await store.exists(storageKey);
    if (!verified) {
      throw new Error('Verification failed: stored CAR not readable');
    }

    const snapshotId = randomUUID();
    await query(
      `INSERT INTO export_snapshots (id, community_did, storage_key, size_bytes, root_cid)
       VALUES ($1, $2, $3, $4, $5)`,
      [snapshotId, community_did, storageKey, totalSize, null]
    );

    const oldSnapshots = await query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM export_snapshots
       WHERE community_did = $1
       ORDER BY created_at DESC
       OFFSET $2`,
      [community_did, retention_count]
    );

    for (const old of oldSnapshots.rows) {
      await store.delete(old.storage_key);
      await query('DELETE FROM export_snapshots WHERE id = $1', [old.id]);
    }

    await query(
      `UPDATE export_schedules SET last_export_at = NOW(), last_status = 'success', last_error = NULL WHERE id = $1`,
      [schedule.id]
    );

    await auditLog('admin.export.snapshot.success', null, community_did, {
      storageKey, sizeBytes: totalSize,
    });

    console.log(`[Export] ${community_did}: ${totalSize} bytes -> ${storageKey}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await query(
      `UPDATE export_schedules SET last_status = 'failed', last_error = $1 WHERE id = $2`,
      [errMsg, schedule.id]
    );
    await auditLog('admin.export.snapshot.failed', null, community_did, { error: errMsg });
    console.error(`[Export] ${community_did} FAILED:`, errMsg);
  }
}

async function runExportCycle(): Promise<void> {
  const result = await query<ExportSchedule>(
    'SELECT * FROM export_schedules WHERE enabled = true'
  );

  for (const schedule of result.rows) {
    if (isDue(schedule)) {
      await exportCommunity(schedule);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startExportScheduler(): void {
  if (!config.exportScheduler.enabled) {
    console.log('[Export] Scheduler disabled');
    return;
  }

  console.log(`[Export] Scheduler started (check interval: ${config.exportScheduler.checkIntervalMs}ms)`);

  runExportCycle().catch(err => console.error('[Export] Cycle error:', err));

  intervalHandle = setInterval(() => {
    runExportCycle().catch(err => console.error('[Export] Cycle error:', err));
  }, config.exportScheduler.checkIntervalMs);
}

export function stopExportScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
