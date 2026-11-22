import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { and, eq, lt } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, maintenanceState } from './db';
import { filesStore } from './blob-store';
import { backupEncryptionKey, captureDatabase, storeVerifiedBackup, type BackupResult } from './backup-core';

const LOCK = 'database_backup_lock';
const SUCCESS = 'database_backup_success';
const FAILURE = 'database_backup_failure';

export function backupRetentionDays() {
	const days = Number(env.BACKUP_RETENTION_DAYS);
	return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 30;
}

export async function backupStatus() {
	let configured = true;
	try { backupEncryptionKey(env.BACKUP_ENCRYPTION_KEY); } catch { configured = false; }
	const rows = await db.select().from(maintenanceState);
	const saved = rows.find((r) => r.key === SUCCESS);
	const failure = rows.find((r) => r.key === FAILURE);
	const lastSuccess = saved ? JSON.parse(saved.value) as BackupResult : null;
	return {
		configured, cronConfigured: Boolean(env.CRON_SECRET && env.CRON_SECRET.length >= 16), retentionDays: backupRetentionDays(), schedule: 'Vercel: daily at 02:00 UTC', lastSuccess,
		lastFailureAt: failure?.updatedAt.toISOString() ?? null,
		stale: !lastSuccess || Date.now() - new Date(lastSuccess.createdAt).getTime() > 48 * 60 * 60 * 1000
	};
}

/** Database-backed lease prevents overlapping cron/manual invocations across instances. */
export async function runDatabaseBackup(): Promise<BackupResult> {
	try { backupEncryptionKey(env.BACKUP_ENCRYPTION_KEY); } catch { error(503, 'Configure BACKUP_ENCRYPTION_KEY before running database backups'); }
	if (!env.DATABASE_URL) error(503, 'Database is not configured');
	const lease = randomUUID();
	const [locked] = await db.insert(maintenanceState).values({ key: LOCK, value: lease })
		.onConflictDoUpdate({ target: maintenanceState.key, set: { value: lease, updatedAt: new Date() }, where: lt(maintenanceState.updatedAt, new Date(Date.now() - 10 * 60 * 1000)) })
		.returning({ key: maintenanceState.key });
	if (!locked) error(409, 'A database backup is already running');
	try {
		const sql = neon(env.DATABASE_URL);
		const snapshot = await captureDatabase({
			query: (statement) => sql(statement),
			transaction: (statements) => sql.transaction(statements.map((statement) => sql(statement)), { isolationLevel: 'RepeatableRead', readOnly: true })
		});
		const result = await storeVerifiedBackup(snapshot, env.BACKUP_ENCRYPTION_KEY!, filesStore(env.B2_BACKUP_BUCKET_NAME), backupRetentionDays());
		await db.insert(maintenanceState).values({ key: SUCCESS, value: JSON.stringify(result) })
			.onConflictDoUpdate({ target: maintenanceState.key, set: { value: JSON.stringify(result), updatedAt: new Date() } });
		await db.delete(maintenanceState).where(eq(maintenanceState.key, FAILURE));
		return result;
	} catch {
		await db.insert(maintenanceState).values({ key: FAILURE, value: 'Backup failed' })
			.onConflictDoUpdate({ target: maintenanceState.key, set: { value: 'Backup failed', updatedAt: new Date() } });
		error(502, 'Database backup failed. Previous backups have been retained. Check database and B2 connectivity.');
	} finally {
		await db.delete(maintenanceState).where(and(eq(maintenanceState.key, LOCK), eq(maintenanceState.value, lease)));
	}
}
