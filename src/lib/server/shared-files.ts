import { error } from '@sveltejs/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { db, shareLinks, encryptedFiles, fileVersions, fileMetadata } from './db';
import { LEGACY_SHARE_DOWNLOAD_AUDIENCE } from '../shared/legacy-protocol.js';

/** One SQL snapshot pairs the link's wrapped key with the correct immutable content. */
export async function sharedFile(token: string, checkLimit = true, allowAdmittedDownload = false) {
	if (checkLimit) await autoRevokeLimitedLinks({ token });
	const [row] = await db.select({ link: shareLinks, file: encryptedFiles, version: fileVersions, metadata: fileMetadata })
		.from(shareLinks).leftJoin(encryptedFiles, eq(encryptedFiles.id, shareLinks.fileId))
		.leftJoin(fileVersions, eq(fileVersions.id, shareLinks.versionId))
		.leftJoin(fileMetadata, eq(fileMetadata.fileId, encryptedFiles.id))
		.where(eq(shareLinks.token, token));
	if (!row) error(404, 'This link does not exist');
	const { link, file, version } = row;
	if (link.revokedAt && !(allowAdmittedDownload && link.revocationReason === 'download_limit')) error(410, link.revocationReason === 'download_limit' ? 'This link was automatically revoked after reaching its download limit' : 'This link has been revoked');
	if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) error(410, 'This link has expired');
	if (checkLimit && link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) error(410, 'This link has reached its download limit');
	if (!file || file.deletedAt || file.uploadStatus !== 'complete') error(404, 'This file is no longer available');
	if (link.versionId && (!version || version.purgingAt)) error(404, 'This file version is no longer available');
	return {
		link, root: file, content: version ?? file,
		metadata: version ? { encryptedBlob: version.metadataBlob, iv: version.metadataIv, algo: version.metadataAlgo }
			: row.metadata ? { encryptedBlob: row.metadata.encryptedBlob, iv: row.metadata.iv, algo: row.metadata.algo } : null
	};
}

/** Backfill exhausted links, scoped to the owner/file/token from UI routes. */
export async function autoRevokeLimitedLinks(scope: { ownerId?: string; fileId?: string; token?: string } = {}) {
	const conditions = [isNull(shareLinks.revokedAt), sql`${shareLinks.maxDownloads} IS NOT NULL AND ${shareLinks.downloadCount} >= ${shareLinks.maxDownloads}`];
	if (scope.token) conditions.push(eq(shareLinks.token, scope.token));
	if (scope.fileId) conditions.push(eq(shareLinks.fileId, scope.fileId));
	if (scope.ownerId) conditions.push(sql`EXISTS (SELECT 1 FROM encrypted_files f WHERE f.id = ${shareLinks.fileId} AND f.owner_id = ${scope.ownerId})`);
	const rows = await db.update(shareLinks).set({ revokedAt: new Date(), revocationReason: 'download_limit' }).where(and(...conditions)).returning({ id: shareLinks.id });
	return rows.length;
}

const audience = 'overdrive-share-download';
const signingKey = () => {
	if (!env.SESSION_SECRET) error(503, 'Sharing is not configured');
	return new TextEncoder().encode(env.SESSION_SECRET);
};

export async function downloadGrant(token: string, versionNumber: number, until: Date) {
	return new SignJWT({ token, versionNumber }).setProtectedHeader({ alg: 'HS256' }).setAudience(audience)
		.setIssuedAt().setExpirationTime(Math.floor(until.getTime() / 1000)).sign(signingKey());
}

export async function verifyDownloadGrant(grant: string | null, token: string): Promise<number> {
	if (!grant || grant.length > 2048) error(401, 'Start a download from the shared-file page first');
	try {
		const { payload } = await jwtVerify(grant, signingKey(), { audience: [audience, LEGACY_SHARE_DOWNLOAD_AUDIENCE], algorithms: ['HS256'] });
		if (payload.token !== token || !Number.isInteger(payload.versionNumber)) error(401, 'Invalid download grant');
		return payload.versionNumber as number;
	} catch { error(401, 'The download grant expired. Start the download again.'); }
}
