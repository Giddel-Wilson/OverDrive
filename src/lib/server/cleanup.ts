import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db, encryptedFiles, fileVersions, folders, maintenanceState, sessions } from './db';
import { filesStore } from './blob-store';
import { purgeFiles } from './files';
import { pruneFileVersions } from './versions';
import { MAX_FILE_VERSIONS } from '$lib/shared/limits';
import { autoRevokeLimitedLinks } from './shared-files';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const num = (raw: string | undefined, fallback: number) => {
	const n = Number(raw);
	return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export interface CleanupStats {
	sessionsRemoved: number;
	abandonedUploadsPurged: number;
	trashFilesPurged: number;
	trashFoldersPurged: number;
	orphanObjectsDeleted: number;
	orphanObjectsScanned: number;
	orphanSweepComplete: boolean;
	failed: string[];
	timedOut: boolean;
	versionsPruned: number;
	shareLinksRevoked: number;
}

/** A page of at most this many files is purged per step, so one slow batch can't eat the whole time budget. */
const BATCH = 100;

// Chunk object keys look like  <ownerUuid>/<fileUuid>/chunk-<n>
const CHUNK_KEY = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\/(chunk-\d+|thumbnail-[0-9a-f]{64})$/;
const CURSOR_KEY = 'orphan_sweep_cursor';

/**
 * Daily housekeeping, run by Vercel Cron (see vercel.json):
 *
 *  1. expired / long-revoked sessions are deleted
 *  2. uploads abandoned for ABANDONED_UPLOAD_HOURS (default 48) are discarded,
 *     chunks and all
 *  3. trash older than TRASH_RETENTION_DAYS (default 30) is purged for good
 *  4. an orphan sweep deletes stored chunks that no database row refers to
 *     (older than ORPHAN_MIN_AGE_HOURS, default 24, so an upload in flight is
 *     never touched). It resumes where it left off, so a large bucket is
 *     covered over several runs.
 *
 * Everything stops cleanly when `budgetMs` is used up; whatever is left is
 * picked up by the next run.
 */
export async function runCleanup(
	opts: { budgetMs?: number; now?: Date; maxOrphanPages?: number } = {}
): Promise<CleanupStats> {
	const now = opts.now ?? new Date();
	const deadline = Date.now() + (opts.budgetMs ?? 50_000);
	const outOfTime = () => Date.now() >= deadline;

	const stats: CleanupStats = {
		sessionsRemoved: 0,
		abandonedUploadsPurged: 0,
		trashFilesPurged: 0,
		trashFoldersPurged: 0,
		orphanObjectsDeleted: 0,
		orphanObjectsScanned: 0,
		orphanSweepComplete: false,
		failed: [],
		timedOut: false,
		versionsPruned: 0,
		shareLinksRevoked: 0
	};

	// 1. sessions ----------------------------------------------------------
	const sessionCutoff = new Date(now.getTime() - 7 * DAY);
	const removed = await db
		.delete(sessions)
		.where(or(lt(sessions.expiresAt, sessionCutoff), and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, sessionCutoff))))
		.returning({ id: sessions.id });
	stats.sessionsRemoved = removed.length;
	stats.shareLinksRevoked = await autoRevokeLimitedLinks();

	// 2. abandoned uploads -------------------------------------------------
	const abandonedCutoff = new Date(now.getTime() - num(env.ABANDONED_UPLOAD_HOURS, 48) * HOUR);
	while (!outOfTime()) {
		const rows = await db
			.select({ id: encryptedFiles.id, ownerId: encryptedFiles.ownerId })
			.from(encryptedFiles)
			.where(and(eq(encryptedFiles.uploadStatus, 'uploading'), lt(encryptedFiles.createdAt, abandonedCutoff)))
			.limit(BATCH);
		if (rows.length === 0) break;
		const progressed = await purgeByOwner(rows, false, stats);
		stats.abandonedUploadsPurged += progressed;
		if (progressed === 0) break; // nothing removable this run (storage errors) — don't spin
	}

	// 3. trash retention ---------------------------------------------------
	const trashCutoff = new Date(now.getTime() - num(env.TRASH_RETENTION_DAYS, 30) * DAY);
	while (!outOfTime()) {
		const rows = await db
			.select({ id: encryptedFiles.id, ownerId: encryptedFiles.ownerId })
			.from(encryptedFiles)
			.where(and(isNotNull(encryptedFiles.deletedAt), lt(encryptedFiles.deletedAt, trashCutoff)))
			.limit(BATCH);
		if (rows.length === 0) break;
		const progressed = await purgeByOwner(rows, true, stats);
		stats.trashFilesPurged += progressed;
		if (progressed === 0) break;
	}
	const oldFolders = await db
		.delete(folders)
		.where(and(isNotNull(folders.deletedAt), lt(folders.deletedAt, trashCutoff)))
		.returning({ id: folders.id });
	stats.trashFoldersPurged = oldFolders.length;

	// Pruning is retried here if storage was unavailable after a replacement.
	const candidates = await db.execute(sql`WITH ranked AS (
		SELECT v.id, v.file_id, v.purging_at, f.owner_id,
			row_number() OVER (PARTITION BY v.file_id ORDER BY v.version_number DESC) AS position
		FROM file_versions v JOIN encrypted_files f ON f.id = v.file_id
	) SELECT DISTINCT file_id, owner_id FROM ranked r
	WHERE (position > ${MAX_FILE_VERSIONS - 1} OR purging_at IS NOT NULL)
		AND NOT EXISTS (SELECT 1 FROM share_links l WHERE l.version_id = r.id
			AND (l.expires_at IS NULL OR l.expires_at > now())
			AND ((l.revoked_at IS NULL AND (l.max_downloads IS NULL OR l.download_count < l.max_downloads OR l.download_grant_until > now()))
				OR (l.revocation_reason = 'download_limit' AND l.download_grant_until > now())))
	LIMIT ${BATCH}`);
	for (const row of candidates.rows as { file_id: string; owner_id: string }[]) {
		if (outOfTime()) break;
		const result = await pruneFileVersions(row.owner_id, row.file_id);
		stats.versionsPruned += result.pruned;
		if (result.failed) stats.failed.push(row.file_id);
	}

	// 4. orphan sweep ------------------------------------------------------
	const minAge = num(env.ORPHAN_MIN_AGE_HOURS, 24) * HOUR;
	const store = filesStore();
	const [saved] = await db.select().from(maintenanceState).where(eq(maintenanceState.key, CURSOR_KEY));
	let token: string | undefined = saved?.value || undefined;
	let pagesDone = 0;
	const maxPages = opts.maxOrphanPages ?? 50;

	while (!outOfTime() && pagesDone < maxPages) {
		pagesDone++;
		const page = await store.listPage('', token, 1000);
		stats.orphanObjectsScanned += page.objects.length;

		const ids = new Set<string>();
		const pointers = new Set<string>();
		for (const o of page.objects) {
			const m = CHUNK_KEY.exec(o.key);
			if (m) { ids.add(m[2]); pointers.add(`${m[1]}/${m[2]}`); }
		}
		const known = new Set<string>();
		const knownThumbnails = new Set<string>();
		const idList = [...ids];
		const pointerList = [...pointers];
		for (let i = 0; i < Math.max(idList.length, pointerList.length); i += 500) {
			const found = await db
				.select({ id: encryptedFiles.id, ownerId: encryptedFiles.ownerId, storageKey: encryptedFiles.storageKey, hash: encryptedFiles.thumbnailSha256 })
				.from(encryptedFiles)
				.where(or(inArray(encryptedFiles.id, idList.slice(i, i + 500)), inArray(encryptedFiles.storageKey, pointerList.slice(i, i + 500))));
			for (const f of found) {
				const pointer = f.storageKey || `${f.ownerId}/${f.id}`;
				known.add(pointer);
				if (f.hash) knownThumbnails.add(`${pointer}/thumbnail-${f.hash}`);
			}
			const retained = await db.select({ storageKey: fileVersions.storageKey, hash: fileVersions.thumbnailSha256 }).from(fileVersions)
				.where(inArray(fileVersions.storageKey, pointerList.slice(i, i + 500)));
			for (const v of retained) {
				known.add(v.storageKey);
				if (v.hash) knownThumbnails.add(`${v.storageKey}/thumbnail-${v.hash}`);
			}
		}

		const orphans = page.objects.filter((o) => {
			const m = CHUNK_KEY.exec(o.key);
			if (!m) return false;
			if (m[3].startsWith('thumbnail-') ? knownThumbnails.has(o.key) : known.has(`${m[1]}/${m[2]}`)) return false;
			// No timestamp = can't prove it's old enough, so leave it.
			return o.lastModified !== undefined && now.getTime() - o.lastModified.getTime() > minAge;
		});
		if (orphans.length > 0) {
			const { failed } = await store.deleteMany(orphans.map((o) => o.key));
			stats.orphanObjectsDeleted += orphans.length - failed.length;
			stats.failed.push(...failed.slice(0, 20));
		}

		token = page.next;
		if (!token) {
			stats.orphanSweepComplete = true;
			await db.delete(maintenanceState).where(eq(maintenanceState.key, CURSOR_KEY));
			break;
		}
		await db
			.insert(maintenanceState)
			.values({ key: CURSOR_KEY, value: token })
			.onConflictDoUpdate({ target: maintenanceState.key, set: { value: token, updatedAt: new Date() } });
	}

	stats.timedOut = outOfTime() && !stats.orphanSweepComplete;
	return stats;
}

/** Purges a batch grouped by owner; returns how many were actually removed. */
async function purgeByOwner(
	rows: { id: string; ownerId: string }[],
	onlyTrashed: boolean,
	stats: CleanupStats
): Promise<number> {
	const byOwner = new Map<string, string[]>();
	for (const r of rows) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r.id]);
	let purged = 0;
	for (const [ownerId, ids] of byOwner) {
		const res = await purgeFiles(ownerId, ids, { onlyTrashed });
		purged += res.purged.length;
		stats.failed.push(...res.failed);
	}
	return purged;
}
