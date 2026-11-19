<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		File as FileIcon,
		Folder as FolderIcon,
		FolderPlus,
		FolderInput,
		Search,
		ChevronRight,
		Home,
		Trash2,
		Eye,
		Download,
		PackageOpen,
		Share2,
		Pencil,
		RotateCcw,
		X,
		Loader2,
		AlertCircle,
		KeyRound,
		ChevronDown,
		FilePlus
	} from 'lucide-svelte';
	import EncryptUploader from '$lib/components/EncryptUploader.svelte';
	import PendingUploads from '$lib/components/PendingUploads.svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import ShareModal from '$lib/components/ShareModal.svelte';
	import PromptModal from '$lib/components/PromptModal.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RowMenu, { type MenuAction } from '$lib/components/RowMenu.svelte';
	import MoveModal from '$lib/components/MoveModal.svelte';
	import PreviewModal from '$lib/components/PreviewModal.svelte';
	import { keyStore } from '$lib/stores/key-store.svelte';
	import { ui } from '$lib/ui';
	import { formatBytes } from '$lib/shared/limits';
	import { previewInfo } from '$lib/preview';
	import {
		unwrapRecordFileKey,
		decryptRecordMetadata,
		decryptFileToSink,
		downloadAndDecryptFile,
		downloadRawCiphertext,
		createBlobSink,
		triggerBrowserDownload,
		canStreamToDisk,
		createDiskSink,
		type EncryptedFileRecord,
		type DecryptedMetadata,
		type PlaintextSink
	} from '$crypto/download-pipeline';
	import { exportVault, sanitizeSegment, type ExportProgress } from '$crypto/export-vault';
	import {
		collectSubtree,
		createFolderPayload,
		decryptFolderMeta,
		folderPath,
		reencryptFileMeta,
		reencryptFolderMeta,
		searchEntries,
		sortEntries,
		type FolderMap,
		type FolderMeta,
		type FolderRecord,
		type NamedEntry
	} from '$crypto/vault';

	let { data } = $props();

	// ---- server state --------------------------------------------------------
	let files = $state<EncryptedFileRecord[]>([]);
	let folderRecords = $state<FolderRecord[]>([]);
	let pending = $state<EncryptedFileRecord[]>([]);
	let trashFiles = $state<EncryptedFileRecord[]>([]);
	let trashFolderRecords = $state<FolderRecord[]>([]);
	$effect(() => {
		files = data.files ?? [];
		folderRecords = data.folders ?? [];
		pending = data.pending ?? [];
	});

	// ---- decrypted names (never leave the browser) ---------------------------
	const fileMeta = new SvelteMap<string, DecryptedMetadata | 'error'>();
	const folderMeta = new SvelteMap<string, FolderMeta | 'error'>();
	const inflight = new Set<string>();

	async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
		let i = 0;
		await Promise.all(
			Array.from({ length: Math.min(size, items.length) }, async () => {
				while (i < items.length) await fn(items[i++]);
			})
		);
	}

	async function decryptMissing(key: CryptoKey, fileList: EncryptedFileRecord[], folderList: FolderRecord[]) {
		// Folders first, so by the time a file's name appears the tree it belongs to is ready.
		await pool(
			folderList.filter((f) => !folderMeta.has(f.id) && !inflight.has(f.id)),
			6,
			async (f) => {
				inflight.add(f.id);
				try {
					folderMeta.set(f.id, await decryptFolderMeta(f, key));
				} catch {
					folderMeta.set(f.id, 'error');
				} finally {
					inflight.delete(f.id);
				}
			}
		);
		await pool(
			fileList.filter((f) => !fileMeta.has(f.id) && !inflight.has(f.id)),
			6,
			async (f) => {
				inflight.add(f.id);
				try {
					const fileKey = await unwrapRecordFileKey(f, key);
					fileMeta.set(f.id, (await decryptRecordMetadata(f, fileKey)) ?? 'error');
				} catch {
					fileMeta.set(f.id, 'error');
				} finally {
					inflight.delete(f.id);
				}
			}
		);
	}

	// Re-run when the lists change or the key unlocks. `untrack` keeps the
	// effect from also depending on the maps it fills in.
	$effect(() => {
		const key = keyStore.privateKey;
		const fl = [...files, ...pending, ...trashFiles];
		const dl = [...folderRecords, ...trashFolderRecords];
		if (key) untrack(() => void decryptMissing(key, fl, dl));
	});

	const metaOf = (id: string) => {
		const m = fileMeta.get(id);
		return m && m !== 'error' ? m : null;
	};

	// ---- derived tree --------------------------------------------------------
	const toFolderMap = (records: FolderRecord[]) => {
		const m: FolderMap = new Map();
		for (const r of records) {
			const fm = folderMeta.get(r.id);
			if (fm && fm !== 'error') m.set(r.id, fm);
		}
		return m;
	};
	const activeFolders = $derived(toFolderMap(folderRecords));
	const trashedFolders = $derived(toFolderMap(trashFolderRecords));
	const unionFolders = $derived<FolderMap>(new Map([...activeFolders, ...trashedFolders]));

	const currentFolderId = $derived.by(() => {
		const f = page.url.searchParams.get('f');
		return f && activeFolders.has(f) ? f : null;
	});
	const crumbs = $derived(folderPath(currentFolderId, activeFolders));
	const folderLabel = $derived(crumbs.length ? crumbs[crumbs.length - 1].name : 'Vault');

	const placeOf = (m: DecryptedMetadata) => (m.folderId && activeFolders.has(m.folderId) ? m.folderId : null);

	const allEntries = $derived.by<NamedEntry[]>(() => {
		const out: NamedEntry[] = [];
		const created = new Map(folderRecords.map((r) => [r.id, r.createdAt]));
		for (const [id, f] of activeFolders) {
			out.push({
				kind: 'folder',
				id,
				name: f.name,
				parentId: f.parentId && activeFolders.has(f.parentId) ? f.parentId : null,
				createdAt: created.get(id)
			});
		}
		for (const f of files) {
			const m = metaOf(f.id);
			if (m) out.push({ kind: 'file', id: f.id, name: m.name, parentId: placeOf(m), size: m.size, createdAt: f.createdAt });
		}
		return out;
	});

	let query = $state('');
	let sortBy = $state<'name' | 'newest' | 'size'>('name');
	const searching = $derived(query.trim().length > 0);
	const visible = $derived(
		searching
			? sortEntries(searchEntries(query, allEntries), sortBy)
			: sortEntries(allEntries.filter((e) => e.parentId === currentFolderId), sortBy)
	);
	const undecryptable = $derived(files.filter((f) => fileMeta.get(f.id) === 'error'));
	const filesById = $derived(new Map(files.map((f) => [f.id, f])));

	function pathLabel(entry: NamedEntry) {
		const p = folderPath(entry.parentId, activeFolders).map((f) => f.name);
		return ['Vault', ...p].join(' / ');
	}

	function openFolder(id: string | null) {
		query = '';
		goto(id ? `?f=${id}` : page.url.pathname, { keepFocus: true, noScroll: true });
	}

	// ---- trash view ----------------------------------------------------------
	let view = $state<'files' | 'trash'>('files');
	const trashEntries = $derived.by<NamedEntry[]>(() => {
		const out: NamedEntry[] = [];
		const trashedIds = new Set(trashFolderRecords.map((r) => r.id));
		for (const r of trashFolderRecords) {
			const f = trashedFolders.get(r.id);
			if (f && !(f.parentId && trashedIds.has(f.parentId)))
				out.push({ kind: 'folder', id: r.id, name: f.name, parentId: f.parentId, createdAt: r.deletedAt ?? undefined });
		}
		for (const rec of trashFiles) {
			const m = metaOf(rec.id);
			// Only top-level trash items: anything inside a trashed folder travels with that folder.
			if (m && !(m.folderId && trashedIds.has(m.folderId)))
				out.push({ kind: 'file', id: rec.id, name: m.name, parentId: m.folderId ?? null, size: m.size, createdAt: rec.deletedAt ?? undefined });
		}
		return sortEntries(out, 'newest');
	});

	async function refreshTrash() {
		const [f, d] = await Promise.all([fetch('/api/files?view=trash'), fetch('/api/folders?view=trash')]);
		if (f.ok) trashFiles = (await f.json()).files;
		if (d.ok) trashFolderRecords = (await d.json()).folders;
	}

	async function refreshActive() {
		const [f, d, p] = await Promise.all([fetch('/api/files'), fetch('/api/folders'), fetch('/api/files?view=pending')]);
		if (f.ok) files = (await f.json()).files;
		if (d.ok) folderRecords = (await d.json()).folders;
		if (p.ok) pending = (await p.json()).files;
	}

	async function showView(next: 'files' | 'trash') {
		view = next;
		query = '';
		if (next === 'trash') await refreshTrash();
	}

	// ---- helpers shared by actions ------------------------------------------
	let busy = $state(false);
	let actionError = $state<string | null>(null);
	let notice = $state<{ text: string; undo?: () => Promise<void> } | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;

	function showNotice(text: string, undo?: () => Promise<void>) {
		notice = { text, undo };
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = null), 8000);
	}

	async function api(url: string, init: RequestInit, fallback: string) {
		const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.message ?? fallback);
		}
		return res.json();
	}

	async function run(fn: () => Promise<void>) {
		actionError = null;
		busy = true;
		try {
			await fn();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Something went wrong';
		} finally {
			busy = false;
		}
	}

	// ---- create / rename / move ---------------------------------------------
	let newFolderOpen = $state(false);
	let uploadOpen = $state(false);
	let uploadBusy = $state(false);
	let renaming = $state<NamedEntry | null>(null);
	let moving = $state<NamedEntry | null>(null);

	async function createFolder(name: string) {
		const { privateKey, publicKey, keyAlgo } = keyStore;
		if (!privateKey || !publicKey || !keyAlgo) return;
		await run(async () => {
			const payload = await createFolderPayload(name, currentFolderId, keyAlgo, publicKey);
			await api('/api/folders', { method: 'POST', body: JSON.stringify(payload) }, 'Could not create the folder');
			newFolderOpen = false;
			await refreshActive();
		});
	}

	// Keep the in-memory ciphertext in step with what the server now holds:
	// every rename/move re-encrypts from the CURRENT blob, so a stale copy
	// here would silently undo the previous change.
	function patchFileRecord(id: string, patch: { encryptedBlob: string; iv: string }) {
		files = files.map((r) => (r.id === id && r.metadata ? { ...r, metadata: { ...r.metadata, ...patch } } : r));
	}
	function patchFolderRecord(id: string, patch: { encryptedBlob: string; iv: string }) {
		folderRecords = folderRecords.map((r) => (r.id === id ? { ...r, ...patch } : r));
	}

	async function renameEntry(entry: NamedEntry, name: string) {
		const key = keyStore.privateKey;
		if (!key) return;
		await run(async () => {
			if (entry.kind === 'file') {
				const rec = filesById.get(entry.id)!;
				const patch = await reencryptFileMeta(rec, key, { name });
				await api(`/api/files/${entry.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Could not rename');
				patchFileRecord(entry.id, patch);
				const m = metaOf(entry.id);
				if (m) fileMeta.set(entry.id, { ...m, name });
			} else {
				const rec = folderRecords.find((r) => r.id === entry.id)!;
				const patch = await reencryptFolderMeta(rec, key, { name });
				await api(`/api/folders/${entry.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Could not rename');
				patchFolderRecord(entry.id, patch);
				const fm = folderMeta.get(entry.id);
				if (fm && fm !== 'error') folderMeta.set(entry.id, { ...fm, name });
			}
			renaming = null;
		});
	}

	async function moveEntry(entry: NamedEntry, parentId: string | null) {
		const key = keyStore.privateKey;
		if (!key) return;
		await run(async () => {
			if (entry.kind === 'file') {
				const rec = filesById.get(entry.id)!;
				const patch = await reencryptFileMeta(rec, key, { folderId: parentId });
				await api(`/api/files/${entry.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Could not move');
				patchFileRecord(entry.id, patch);
				const m = metaOf(entry.id);
				if (m) fileMeta.set(entry.id, { ...m, folderId: parentId });
			} else {
				const rec = folderRecords.find((r) => r.id === entry.id)!;
				const patch = await reencryptFolderMeta(rec, key, { parentId });
				await api(`/api/folders/${entry.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Could not move');
				patchFolderRecord(entry.id, patch);
				const fm = folderMeta.get(entry.id);
				if (fm && fm !== 'error') folderMeta.set(entry.id, { ...fm, parentId });
			}
			moving = null;
		});
	}

	// ---- trash / restore / purge --------------------------------------------
	const fileFolderPairs = (records: EncryptedFileRecord[]) =>
		records.map((r) => ({ id: r.id, folderId: metaOf(r.id)?.folderId ?? null }));

	/** Everything that must move together with `entry`, drawn from the given tree and file list. */
	function subtreeOf(entry: NamedEntry, folders: FolderMap, records: EncryptedFileRecord[]) {
		if (entry.kind === 'file') return { fileIds: [entry.id], folderIds: [] as string[] };
		return collectSubtree(entry.id, folders, fileFolderPairs(records));
	}

	async function trashEntry(entry: NamedEntry) {
		const { fileIds, folderIds } = subtreeOf(entry, activeFolders, files);
		await run(async () => {
			await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'trash', fileIds, folderIds }) }, 'Could not move to trash');
			await refreshActive();
			showNotice(`"${entry.name}" moved to trash.`, async () => {
				await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'restore', fileIds, folderIds }) }, 'Could not undo');
				await refreshActive();
				notice = null;
			});
		});
	}

	async function restoreEntry(entry: NamedEntry) {
		const { fileIds, folderIds } = subtreeOf(entry, unionFolders, trashFiles);
		await run(async () => {
			await api(
				'/api/trash',
				{ method: 'POST', body: JSON.stringify({ action: 'restore', fileIds, folderIds: folderIds.filter((id) => trashedFolders.has(id)) }) },
				'Could not restore'
			);
			await Promise.all([refreshTrash(), refreshActive()]);
			showNotice(`"${entry.name}" restored.`);
		});
	}

	let purging = $state<{ label: string; fileIds: string[]; folderIds: string[] } | null>(null);

	function askPurge(entries: NamedEntry[], label: string) {
		const fileIds = new Set<string>();
		const folderIds = new Set<string>();
		for (const e of entries) {
			const s = subtreeOf(e, unionFolders, trashFiles);
			s.fileIds.forEach((id) => fileIds.add(id));
			s.folderIds.filter((id) => trashedFolders.has(id)).forEach((id) => folderIds.add(id));
		}
		purging = { label, fileIds: [...fileIds], folderIds: [...folderIds] };
	}

	async function confirmPurge() {
		if (!purging) return;
		const { fileIds, folderIds } = purging;
		await run(async () => {
			const res = await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'purge', fileIds, folderIds }) }, 'Could not delete');
			purging = null;
			await refreshTrash();
			if (res.failed?.length) throw new Error(`${res.failed.length} file(s) could not be removed from storage — try again.`);
		});
	}

	// ---- download / preview / share -----------------------------------------
	const STREAM_TO_DISK_ABOVE = 100 * 1024 * 1024;
	let downloadingId = $state<string | null>(null);
	let downloadingRawId = $state<string | null>(null);
	let downloadPercent = $state(0);

	async function handleDownload(record: EncryptedFileRecord, meta: DecryptedMetadata) {
		const key = keyStore.privateKey;
		if (!key) return;
		actionError = null;

		// Big files on Chromium stream straight to disk. The save dialog needs this
		// click's user gesture, so it must open before any other await.
		let disk: PlaintextSink | null = null;
		if (canStreamToDisk() && meta.size > STREAM_TO_DISK_ABOVE) {
			disk = await createDiskSink(meta.name, meta.mimeType);
			if (!disk) return; // cancelled
		}

		downloadingId = record.id;
		downloadPercent = 0;
		try {
			const fileKey = await unwrapRecordFileKey(record, key);
			const onProgress = (p: { percent: number }) => (downloadPercent = p.percent);
			if (disk) {
				await decryptFileToSink(record, fileKey, disk, { onProgress });
			} else {
				const { blob, metadata } = await downloadAndDecryptFile(record, fileKey, undefined, onProgress);
				triggerBrowserDownload(blob, metadata?.name ?? meta.name);
			}
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Download failed';
		} finally {
			downloadingId = null;
		}
	}

	/** Verified ciphertext + a decryption manifest, without ever decrypting locally. */
	async function handleDownloadRaw(record: EncryptedFileRecord, name: string) {
		actionError = null;
		downloadingRawId = record.id;
		try {
			const { archive } = await downloadRawCiphertext(record);
			triggerBrowserDownload(archive, `${name}.enc.zip`);
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Download failed';
		} finally {
			downloadingRawId = null;
		}
	}

	// ---- download a whole folder ---------------------------------------------
	let downloadingFolderId = $state<string | null>(null);
	let folderProgress = $state<ExportProgress | null>(null);

	/**
	 * Decrypts a folder and everything inside it (in this browser) into one
	 * .zip named after the folder, keeping the subfolder structure. Reuses the
	 * vault exporter, fed only this folder's subtree.
	 */
	async function handleDownloadFolder(entry: NamedEntry) {
		const key = keyStore.privateKey;
		if (!key || downloadingFolderId) return;
		actionError = null;

		const { fileIds, folderIds } = collectSubtree(entry.id, activeFolders, fileFolderPairs(files));
		const fileSet = new Set(fileIds);
		const folderSet = new Set(folderIds);
		const subFiles = files.filter((f) => fileSet.has(f.id));
		const subFolders = folderRecords.filter((f) => folderSet.has(f.id));
		const filename = `${sanitizeSegment(entry.name)}.zip`;

		// The save dialog needs this click's user gesture, so it opens before any
		// other await. Chromium streams to disk; other browsers build it in memory.
		let sink: PlaintextSink;
		let toBlob: (() => Blob) | null = null;
		if (canStreamToDisk()) {
			const disk = await createDiskSink(filename, 'application/zip');
			if (!disk) return; // cancelled
			sink = disk;
		} else {
			const mem = createBlobSink('application/zip');
			sink = mem.sink;
			toBlob = mem.toBlob;
		}

		downloadingFolderId = entry.id;
		folderProgress = null;
		try {
			const result = await exportVault({
				files: subFiles,
				folders: subFolders,
				privateKey: key,
				sink,
				onProgress: (p) => (folderProgress = p)
			});
			if (toBlob) triggerBrowserDownload(toBlob(), filename);
			if (result.failed.length > 0) {
				actionError = `${result.failed.length} file(s) in "${entry.name}" could not be verified — see EXPORT-REPORT.txt inside the zip.`;
			} else {
				showNotice(`Downloaded "${entry.name}" (${result.exported} file${result.exported === 1 ? '' : 's'}).`);
			}
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Folder download failed';
		} finally {
			downloadingFolderId = null;
			folderProgress = null;
		}
	}

	/** The same actions as the desktop icon row, for the mobile bottom sheet. */
	function menuActions(
		entry: NamedEntry,
		rec: EncryptedFileRecord | undefined,
		meta: DecryptedMetadata | null,
		canPreview: boolean
	): MenuAction[] {
		if (view === 'trash') {
			return [
				{ label: 'Restore', icon: RotateCcw, onclick: () => restoreEntry(entry), disabled: busy },
				{ label: 'Delete permanently', icon: Trash2, danger: true, onclick: () => askPurge([entry], `"${entry.name}"`), disabled: busy }
			];
		}
		const items: MenuAction[] = [];
		if (entry.kind === 'folder') {
			items.push({ label: 'Download folder (.zip)', icon: Download, onclick: () => handleDownloadFolder(entry), disabled: downloadingFolderId !== null });
		} else if (rec && meta) {
			if (canPreview) items.push({ label: 'Preview', icon: Eye, onclick: () => (previewing = rec) });
			items.push({ label: 'Download & decrypt', icon: Download, onclick: () => handleDownload(rec, meta), disabled: downloadingId === rec.id });
			items.push({ label: 'Download encrypted (.zip)', icon: PackageOpen, onclick: () => handleDownloadRaw(rec, entry.name), disabled: downloadingRawId === rec.id });
			items.push({ label: 'Share link', icon: Share2, onclick: () => (sharingRecord = rec) });
		}
		items.push({ label: 'Rename', icon: Pencil, onclick: () => (renaming = entry), disabled: busy });
		items.push({ label: 'Move', icon: FolderInput, onclick: () => (moving = entry), disabled: busy });
		items.push({ label: 'Move to trash', icon: Trash2, danger: true, onclick: () => trashEntry(entry), disabled: busy });
		return items;
	}

	let previewing = $state<EncryptedFileRecord | null>(null);
	let sharingRecord = $state<EncryptedFileRecord | null>(null);

	const dateOf = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
</script>

<svelte:head>
	<title>EndToEnd Encrypt — Vault</title>
</svelte:head>

<div class="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text-primary)]">
	<AppHeader />

	<main class="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 sm:py-10">
		{#if !keyStore.isUnlocked}
			<section class="{ui.card} flex items-center gap-3 p-6 text-sm text-[var(--color-text-tertiary)]">
				<KeyRound class="h-5 w-5 shrink-0" aria-hidden="true" />
				<span>
					Your key is locked for this session, so file names can't be read yet.
					<a href="/settings/keys?next=/dashboard" class="underline" style="color: var(--color-accent)">Unlock it</a>
					to browse, upload and download.
				</span>
			</section>
		{:else}
			<h1 class="sr-only">Your vault</h1>

			{#if view === 'files'}
				{#if keyStore.privateKey}
					<PendingUploads records={pending} metaFor={(id) => fileMeta.get(id)} privateKey={keyStore.privateKey} onChanged={refreshActive} />
				{/if}
			{/if}

			<section class="space-y-4">
				<!-- Tabs (left) · search (centre) · sort, new folder, new file (right) -->
				<div class="flex flex-col gap-3 lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-4">
					<div class="flex w-full md:w-fit gap-1 self-end rounded-[var(--radius-md)] border border-[var(--color-border)] p-1 lg:self-auto" role="tablist" aria-label="Vault view">
						{#each [['files', 'Files'], ['trash', 'Trash']] as [id, label] (id)}
							<button
								type="button"
								role="tab"
								aria-selected={view === id}
								onclick={() => showView(id as 'files' | 'trash')}
								class="h-8 w-[50%] md:w-auto cursor-pointer rounded-[var(--radius-sm)] px-3 text-sm {view === id
									? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
									: 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
							>
								{label}
							</button>
						{/each}
					</div>

					{#if view === 'files'}
						<div class="relative w-full lg:max-w-sm lg:justify-self-center">
							<Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-tertiary)]" aria-hidden="true" />
							<input type="search" bind:value={query} placeholder="Search names…" aria-label="Search file and folder names" class="{ui.input} h-10 pl-9" />
						</div>

						<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:justify-end">
							<!-- All three share one box: h-10, w-36 on desktop, same border and radius. -->
							<div class="relative col-span-2 sm:col-span-1 lg:w-36">
								<select
									bind:value={sortBy}
									aria-label="Sort by"
									class="h-10 w-full cursor-pointer appearance-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-9 text-sm font-medium text-[var(--color-text-secondary)] outline-none hover:border-[var(--color-border-strong)] focus:border-[var(--color-accent)]"
								>
									<option value="name">Name</option>
									<option value="newest">Newest</option>
									<option value="size">Size</option>
								</select>
								<ChevronDown class="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-tertiary)]" aria-hidden="true" />
							</div>
							<button type="button" class="{ui.btnGhost} w-full lg:w-36" onclick={() => (newFolderOpen = true)}>
								<FolderPlus class="h-4 w-4" aria-hidden="true" /> New folder
							</button>
							<button type="button" class="{ui.btnPrimary} w-full lg:w-36" onclick={() => (uploadOpen = true)}>
								<FilePlus class="h-4 w-4" aria-hidden="true" /> New file
							</button>
						</div>
					{:else}
						<div class="hidden lg:block"></div>
						{#if trashEntries.length > 0}
							<button type="button" class="{ui.btnGhost} lg:justify-self-end" onclick={() => askPurge(trashEntries, 'Everything in the trash')}>
								<Trash2 class="h-4 w-4" aria-hidden="true" /> Empty trash
							</button>
						{:else}
							<div class="hidden lg:block"></div>
						{/if}
					{/if}
				</div>

				<!-- Breadcrumb -->
				{#if view === 'files' && !searching}
					<nav aria-label="Folder path" class="flex flex-wrap items-center gap-1 text-sm">
						<button type="button" class="flex cursor-pointer items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]" onclick={() => openFolder(null)}>
							<Home class="h-3.5 w-3.5" aria-hidden="true" /> Vault
						</button>
						{#each crumbs as crumb (crumb.id)}
							<ChevronRight class="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" aria-hidden="true" />
							<button type="button" class="max-w-48 cursor-pointer truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]" onclick={() => openFolder(crumb.id)}>
								{crumb.name}
							</button>
						{/each}
					</nav>
				{:else if view === 'files' && searching}
					<p class="text-sm text-[var(--color-text-tertiary)]">
						{visible.length} result{visible.length === 1 ? '' : 's'} for “{query.trim()}” — searched locally, names never leave your browser.
						<button type="button" class="ml-1 cursor-pointer underline" style="color: var(--color-accent)" onclick={() => (query = '')}>Clear</button>
					</p>
				{:else}
					<p class="text-sm text-[var(--color-text-tertiary)]">Trashed items stay here until you delete them for good.</p>
				{/if}

				{#if actionError}
					<div class="flex items-start gap-2 {ui.alertDanger}" role="alert">
						<AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
						<span class="min-w-0 flex-1">{actionError}</span>
						<button type="button" class="cursor-pointer" aria-label="Dismiss" onclick={() => (actionError = null)}><X class="h-4 w-4" aria-hidden="true" /></button>
					</div>
				{/if}

				{#if notice}
					<div class="flex items-center justify-between gap-3 {ui.alertInfo}" role="status">
						<span class="min-w-0 truncate">{notice.text}</span>
						<div class="flex shrink-0 items-center gap-3">
							{#if notice.undo}
								<button type="button" class="cursor-pointer underline" style="color: var(--color-accent)" onclick={() => run(notice!.undo!)}>Undo</button>
							{/if}
							<button type="button" class="cursor-pointer" aria-label="Dismiss" onclick={() => (notice = null)}><X class="h-4 w-4" aria-hidden="true" /></button>
						</div>
					</div>
				{/if}

				<!-- List -->
				<ul class="divide-y divide-[var(--color-border)] {ui.card}">
					{#each view === 'files' ? visible : trashEntries as entry (entry.kind + entry.id)}
						{@const rec = entry.kind === 'file' ? (view === 'files' ? filesById.get(entry.id) : trashFiles.find((t) => t.id === entry.id)) : undefined}
						{@const meta = entry.kind === 'file' ? metaOf(entry.id) : null}
						{@const canPreview = view === 'files' && meta !== null && previewInfo(meta) !== null}
						<li class="flex items-center justify-between gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
							<div class="flex min-w-0 flex-1 items-center gap-3">
								{#if entry.kind === 'folder'}
									<FolderIcon class="h-4 w-4 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
								{:else}
									<FileIcon class="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
								{/if}
								<div class="min-w-0">
									{#if entry.kind === 'folder' && view === 'files'}
										<button type="button" class="block max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline" onclick={() => openFolder(entry.id)}>
											{entry.name}
										</button>
									{:else if canPreview && rec}
										<button type="button" class="block max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline" onclick={() => (previewing = rec)}>
											{entry.name}
										</button>
									{:else}
										<p class="truncate text-sm font-medium">{entry.name}</p>
									{/if}
									<p class="{ui.mono} truncate text-xs text-[var(--color-text-tertiary)]">
										{#if downloadingId === entry.id}
											Decrypting… {Math.round(downloadPercent)}%
										{:else if downloadingFolderId === entry.id}
											{#if folderProgress?.phase === 'exporting'}
												Decrypting {folderProgress.fileIndex}/{folderProgress.fileCount} · {folderProgress.currentName.split('/').pop()}
											{:else}
												Preparing folder…
											{/if}
										{:else if entry.kind === 'folder'}
											Folder{view === 'trash' ? ' · with its contents' : ''}
										{:else}
											{rec?.fileAlgo} · {formatBytes(entry.size ?? 0)} · {dateOf(view === 'trash' ? undefined : entry.createdAt)}
										{/if}
										{#if view === 'files' && searching}· {pathLabel(entry)}{/if}
									</p>
								</div>
							</div>

							<div class="hidden flex-wrap items-center justify-end gap-1.5 sm:flex sm:shrink-0">
								{#if view === 'trash'}
									<button type="button" class={ui.btnGhost} disabled={busy} onclick={() => restoreEntry(entry)}>
										<RotateCcw class="h-4 w-4" aria-hidden="true" /> Restore
									</button>
									<button type="button" class={ui.iconBtnDanger} disabled={busy} onclick={() => askPurge([entry], `"${entry.name}"`)} aria-label="Delete {entry.name} permanently" title="Delete permanently">
										<Trash2 class="h-4 w-4" aria-hidden="true" />
									</button>
								{:else}
									{#if entry.kind === 'file' && rec && meta}
										{#if canPreview}
											<button type="button" class={ui.iconBtn} onclick={() => (previewing = rec)} aria-label="Preview {entry.name}" title="Preview"><Eye class="h-4 w-4" aria-hidden="true" /></button>
										{/if}
										<button type="button" class={ui.iconBtn} onclick={() => handleDownload(rec, meta)} disabled={downloadingId === rec.id} aria-label="Download and decrypt {entry.name}" title="Download & decrypt">
											{#if downloadingId === rec.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Download class="h-4 w-4" aria-hidden="true" />{/if}
										</button>
										<button type="button" class={ui.iconBtn} onclick={() => handleDownloadRaw(rec, entry.name)} disabled={downloadingRawId === rec.id} aria-label="Download encrypted copy of {entry.name}" title="Download encrypted (.zip: ciphertext + manifest)">
											{#if downloadingRawId === rec.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<PackageOpen class="h-4 w-4" aria-hidden="true" />{/if}
										</button>
										<button type="button" class={ui.iconBtn} onclick={() => (sharingRecord = rec)} aria-label="Share {entry.name}" title="Create share link"><Share2 class="h-4 w-4" aria-hidden="true" /></button>
									{/if}
									{#if entry.kind === 'folder'}
										<button type="button" class={ui.iconBtn} onclick={() => handleDownloadFolder(entry)} disabled={downloadingFolderId !== null} aria-label="Download folder {entry.name} as a decrypted zip" title="Download folder (decrypted .zip)">
											{#if downloadingFolderId === entry.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Download class="h-4 w-4" aria-hidden="true" />{/if}
										</button>
									{/if}
									<button type="button" class={ui.iconBtn} onclick={() => (renaming = entry)} disabled={busy} aria-label="Rename {entry.name}" title="Rename"><Pencil class="h-4 w-4" aria-hidden="true" /></button>
									<button type="button" class={ui.iconBtn} onclick={() => (moving = entry)} disabled={busy} aria-label="Move {entry.name}" title="Move"><FolderInput class="h-4 w-4" aria-hidden="true" /></button>
									<button type="button" class={ui.iconBtnDanger} onclick={() => trashEntry(entry)} disabled={busy} aria-label="Move {entry.name} to trash" title="Move to trash"><Trash2 class="h-4 w-4" aria-hidden="true" /></button>
								{/if}
							</div>
						<div class="shrink-0 sm:hidden">
								<RowMenu title={entry.name} actions={menuActions(entry, rec, meta, canPreview)} />
							</div>
						</li>
					{:else}
						<li class="px-5 py-10 text-center text-sm text-[var(--color-text-tertiary)]">
							{#if view === 'trash'}
								The trash is empty.
							{:else if searching}
								Nothing matches “{query.trim()}”.
							{:else if currentFolderId}
								This folder is empty — add a file or create a subfolder.
							{:else}
								No files yet — click <strong class="font-medium text-[var(--color-text-secondary)]">New file</strong> to add your first one.
							{/if}
						</li>
					{/each}

					{#if view === 'files' && !searching && currentFolderId === null}
						{#each undecryptable as f (f.id)}
							<li class="flex items-center justify-between gap-3 px-5 py-3.5">
								<p class="truncate text-sm font-medium text-[var(--color-danger)]">Could not decrypt name ({f.id.slice(0, 8)}…)</p>
								<button type="button" class={ui.iconBtnDanger} onclick={() => trashEntry({ kind: 'file', id: f.id, name: 'Unreadable file', parentId: null })} aria-label="Move unreadable file to trash"><Trash2 class="h-4 w-4" aria-hidden="true" /></button>
							</li>
						{/each}
					{/if}
				</ul>
			</section>
		{/if}
	</main>
</div>

<Modal
	open={uploadOpen}
	title="Encrypt &amp; upload"
	size="lg"
	dismissable={!uploadBusy}
	scrollable={false}
	onClose={() => (uploadOpen = false)}
>
	{#if keyStore.publicKey && keyStore.keyAlgo}
		<EncryptUploader
			recipientPublicKey={keyStore.publicKey}
			recipientKeyAlgo={keyStore.keyAlgo}
			folderId={currentFolderId}
			destinationLabel={folderLabel}
			onUploaded={refreshActive}
			onInterrupted={refreshActive}
			onBusyChange={(b) => (uploadBusy = b)}
			onFinished={() => setTimeout(() => (uploadOpen = false), 1200)}
		/>
	{/if}
</Modal>

<PromptModal
	open={newFolderOpen}
	title="New folder"
	label="Folder name"
	confirmLabel="Create"
	{busy}
	onSubmit={createFolder}
	onClose={() => (newFolderOpen = false)}
/>

<PromptModal
	open={renaming !== null}
	title={renaming?.kind === 'folder' ? 'Rename folder' : 'Rename file'}
	label="New name"
	initial={renaming?.name ?? ''}
	{busy}
	onSubmit={(name) => renaming && renameEntry(renaming, name)}
	onClose={() => (renaming = null)}
/>

<MoveModal
	open={moving !== null}
	title={moving ? `Move “${moving.name}”` : 'Move'}
	folders={activeFolders}
	movingFolderId={moving?.kind === 'folder' ? moving.id : null}
	currentParentId={moving?.parentId ?? null}
	{busy}
	onPick={(parentId) => moving && moveEntry(moving, parentId)}
	onClose={() => (moving = null)}
/>

<ConfirmModal
	open={purging !== null}
	title="Delete permanently?"
	description={purging ? `${purging.label} will be permanently deleted, including the stored ciphertext. This can't be undone.` : ''}
	confirmLabel={busy ? 'Deleting…' : 'Delete forever'}
	cancelLabel="Cancel"
	danger
	{busy}
	onConfirm={confirmPurge}
	onCancel={() => !busy && (purging = null)}
/>

<PreviewModal
	record={previewing}
	meta={previewing ? metaOf(previewing.id) : null}
	privateKey={keyStore.privateKey}
	onClose={() => (previewing = null)}
	onDownload={() => {
		const m = previewing ? metaOf(previewing.id) : null;
		if (previewing && m) handleDownload(previewing, m);
	}}
/>

{#if keyStore.privateKey}
	<ShareModal open={sharingRecord !== null} record={sharingRecord} ownerPrivateKey={keyStore.privateKey} onClose={() => (sharingRecord = null)} />
{/if}