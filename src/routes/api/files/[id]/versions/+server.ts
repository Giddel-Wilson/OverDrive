import { json } from '@sveltejs/kit';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, fileVersions } from '$server/db';
import { requireUser } from '$server/auth';
import { ownedCurrentFile, versionRecord } from '$server/versions';
import { MAX_FILE_VERSIONS } from '$lib/shared/limits';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals);
	const file = await ownedCurrentFile(params.id, user.id);
	const versions = await db.select().from(fileVersions).where(and(eq(fileVersions.fileId, file.id), isNull(fileVersions.purgingAt))).orderBy(desc(fileVersions.versionNumber));
	return json({ versions: versions.map(versionRecord), currentVersion: file.versionNumber, retainedVersions: MAX_FILE_VERSIONS }, { headers: { 'Cache-Control': 'no-store' } });
};
