export interface ShareLinkRow {
	id: string;
	fileId?: string;
	token: string;
	maxDownloads: number | null;
	downloadCount: number;
	expiresAt: string | null;
	revokedAt: string | null;
	revocationReason?: string | null;
	downloadGrantUntil?: string | null;
	createdAt: string;
	versionNumber?: number | null;
	fileInTrash?: boolean;
}

export function shareLinkStatus(link: ShareLinkRow, now = Date.now()): { label: string; active: boolean } {
	if (link.revokedAt) return { label: link.revocationReason === 'download_limit' ? 'Revoked · limit reached' : 'Revoked', active: false };
	if (link.expiresAt && new Date(link.expiresAt).getTime() <= now) return { label: 'Expired', active: false };
	if (link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) return { label: 'Limit reached', active: false };
	if (link.fileInTrash) return { label: 'In trash', active: false };
	return { label: 'Active', active: true };
}
