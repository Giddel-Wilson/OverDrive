<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
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
		FilePlus,
		SquareCheck,
		History,
		Image as ImageIcon
	} from 'lucide-svelte';
	import EncryptUploader from '$lib/components/EncryptUploader.svelte';
	import PendingUploads from '$lib/components/PendingUploads.svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import ShareModal from '$lib/components/ShareModal.svelte';
	import PromptModal from '$lib/components/PromptModal.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RowMenu, { type MenuAction } from '$lib/components/RowMenu.svelte';
	import StorageMeter, { type Usage } from '$lib/components/StorageMeter.svelte';
	import SelectionBar from '$lib/components/SelectionBar.svelte';
	import MoveModal from '$lib/components/MoveModal.svelte';
	import PreviewModal from '$lib/components/PreviewModal.svelte';
	import PhotoThumbnail from '$lib/components/PhotoThumbnail.svelte';
	import VersionHistoryModal from '$lib/components/VersionHistoryModal.svelte';
	import { backfillPhotoThumbnail } from '$crypto/thumbnails';
	import { keyStore } from '$lib/stores/key-store.svelte';
	import { ui } from '$lib/ui';
	import { formatBytes, MAX_FILE_SIZE_BYTES } from '$lib/shared/limits';
	import { isExternalFileDrag, readDroppedTree, type DroppedTree, type UploadFileEntry, type UploadBatchResult } from '$lib/file-drop';
	import { chooseAutoEncryption } from '$crypto/auto-encryption';
	import type { FileAlgo } from '$crypto/types';
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
		isValidFolderMoveTarget,
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
	let listingError = $state<string | null>(null);
	$effect(() => {
		files = data.files ?? [];
		folderRecords = data.folders ?? [];
		pending = data.pending ?? [];
		listingError = data.listingError ?? null;
	});

	// ---- decrypted names (never leave the browser) ---------------------------
	const fileMeta = new SvelteMap<string, DecryptedMetadata | 'error'>();
	const folderMeta = new SvelteMap<string, FolderMeta | 'error'>();
	const inflight = new Set<string>();
	const decryptJobs = new Set<Promise<void>>();

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
		if (key) untrack(() => {
			const job = decryptMissing(key, fl, dl);
			decryptJobs.add(job);
			void job.finally(() => decryptJobs.delete(job));
		});
	});

	async function waitForMetadata() {
		const key = keyStore.privateKey;
		if (!key) throw new Error('Unlock your key before working with folders.');
		await Promise.all([...decryptJobs]);
		await decryptMissing(key, [...files, ...trashFiles], [...folderRecords, ...trashFolderRecords]);
		if (keyStore.privateKey !== key) throw new Error('Your key was locked. Unlock it before working with folders.');
	}

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
	let view = $state<'files' | 'photos' | 'trash'>('files');
	const photoEntries = $derived(sortEntries(allEntries.filter((entry) => entry.kind === 'file' && metaOf(entry.id)?.mimeType.startsWith('image/') && (!searching || entry.name.toLowerCase().includes(query.trim().toLowerCase()))), sortBy));
	let generatingThumbnails = $state(false);
	let thumbnailProgress = $state('');
	async function generateMissingThumbnails() {
		const key = keyStore.privateKey;
		if (!key || generatingThumbnails) return;
		const missing = photoEntries.map((entry) => filesById.get(entry.id)!).filter((record) => !record.thumbnail);
		generatingThumbnails = true;
		let done = 0;
		let made = 0;
		let failed = 0;
		try {
			await pool(missing, 2, async (record) => {
				if (keyStore.privateKey !== key) return;
				try { if (await backfillPhotoThumbnail(record, key)) made++; } catch { failed++; }
				thumbnailProgress = `${++done} of ${missing.length}`;
			});
			await refreshActive();
			showNotice(`Created ${made} thumbnail${made === 1 ? '' : 's'}.${failed ? ` ${failed} could not be created.` : ''}${done - made - failed > 0 ? ' Unsupported formats and images over 50 MB were skipped.' : ''}`);
		} finally { generatingThumbnails = false; thumbnailProgress = ''; }
	}
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

	// Storage used vs. the account's limit (files + trash + unfinished uploads).
	let usage = $state<Usage | null>(null);
	async function loadUsage() {
		try {
			const res = await fetch('/api/storage');
			if (res.ok) usage = await res.json();
		} catch { /* Keep the last meter value when the network is unavailable. */ }
	}
	onMount(loadUsage);
	const storageFull = $derived(usage !== null && usage.quotaBytes > 0 && usage.usedBytes >= usage.quotaBytes);

	async function refreshTrash() {
		const [f, d] = await Promise.all([fetch('/api/files?view=trash'), fetch('/api/folders?view=trash')]);
		if (f.ok) trashFiles = (await f.json()).files;
		if (d.ok) trashFolderRecords = (await d.json()).folders;
		void loadUsage();
	}

	async function refreshActive() {
		const [f, d, p] = await Promise.all([fetch('/api/files', { cache: 'no-store' }), fetch('/api/folders', { cache: 'no-store' }), fetch('/api/files?view=pending', { cache: 'no-store' })]);
		if (f.ok) {
			listingError = null;
			const next = (await f.json()).files as EncryptedFileRecord[];
			for (const record of next) {
				const old = files.find((value) => value.id === record.id);
				if (old && (old.versionNumber !== record.versionNumber || old.metadata?.iv !== record.metadata?.iv)) fileMeta.delete(record.id);
			}
			files = next;
		} else listingError = (await f.json().catch(() => ({}))).message ?? 'Could not load your files. Please retry.';
		if (d.ok) folderRecords = (await d.json()).folders;
		else if (!listingError) listingError = (await d.json().catch(() => ({}))).message ?? 'Could not load your folders. Please retry.';
		if (p.ok) pending = (await p.json()).files;
		void loadUsage();
	}

	async function findExistingUpload(file: File, destinationFolderId: string | null) {
		await refreshActive();
		if (listingError) throw new Error('Could not check existing files. Reload your vault and try again.');
		await waitForMetadata();
		// Full filenames include the extension; browser MIME hints can differ for the same file.
		return files.find((record) => {
			const metadata = metaOf(record.id);
			return !record.deletedAt && record.uploadStatus !== 'uploading' && metadata
				&& metadata.name === file.name && placeOf(metadata) === destinationFolderId;
		}) ?? null;
	}

	async function showView(next: 'files' | 'photos' | 'trash') {
		view = next;
		query = '';
		if (next === 'trash') await refreshTrash();
		if (next === 'photos') sortBy = 'newest';
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
		if (res.status === 401) {
			// Signed out elsewhere (or the session expired) — go back to sign-in.
			keyStore.lock();
			await goto('/login');
			throw new Error('You were signed out.');
		}
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

	// ---- selection -----------------------------------------------------------
	const selected = new SvelteSet<string>();
	let selectToggle = $state(false); // the "Select" button / long-press turned selection mode on
	let lastPicked: string | null = null;
	const keyOf = (e: NamedEntry) => `${e.kind}:${e.id}`;
	const listed = $derived<NamedEntry[]>(view === 'trash' ? trashEntries : view === 'photos' ? photoEntries : visible);
	const selectedEntries = $derived(listed.filter((e) => selected.has(keyOf(e))));
	const selectMode = $derived(selectToggle || selected.size > 0);

	function clearSelection() {
		selected.clear();
		selectToggle = false;
		lastPicked = null;
	}

	/** Click toggles; shift-click selects the whole range since the last pick. */
	function toggle(entry: NamedEntry, range = false) {
		const k = keyOf(entry);
		if (range && lastPicked) {
			const a = listed.findIndex((e) => keyOf(e) === lastPicked);
			const b = listed.findIndex((e) => keyOf(e) === k);
			if (a !== -1 && b !== -1) {
				for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(keyOf(listed[i]));
				lastPicked = k;
				return;
			}
		}
		if (selected.has(k)) selected.delete(k);
		else selected.add(k);
		lastPicked = k;
	}

	function selectAll() {
		for (const e of listed) selected.add(keyOf(e));
	}

	// A different view, folder or search is a different list: start fresh.
	$effect(() => {
		void view;
		void query;
		void currentFolderId;
		untrack(clearSelection);
	});

	/** In selection mode a click picks the row; otherwise it does its normal thing (open / preview). */
	function activate(entry: NamedEntry, e: MouseEvent, open: () => void) {
		if (selectMode) toggle(entry, e.shiftKey);
		else open();
	}

	// Touch: press and hold a row to start selecting.
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	function pressStart(e: PointerEvent, entry: NamedEntry) {
		if (e.pointerType === 'mouse') return;
		clearTimeout(pressTimer);
		pressTimer = setTimeout(() => {
			selectToggle = true;
			toggle(entry);
			navigator.vibrate?.(10);
		}, 450);
	}
	const pressCancel = () => clearTimeout(pressTimer);

	// ---- drag a file/folder (or the whole selection) onto a folder -----------
	let dragItems = $state<NamedEntry[] | null>(null);
	let dropTarget = $state<string | null | undefined>(undefined); // undefined = none, null = vault root
	const dragEnabled = $derived(view !== 'trash' && !busy);

	function dragStart(e: DragEvent, entry: NamedEntry) {
		dragItems = selected.has(keyOf(entry)) ? selectedEntries : [entry];
		e.dataTransfer?.setData('text/plain', dragItems.map((i) => i.name).join('\n')); // Firefox needs data to start a drag
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}
	function dragEnd() {
		dragItems = null;
		dropTarget = undefined;
	}
	function canDropOn(targetId: string | null): boolean {
		if (!dragItems || dragItems.every((i) => i.parentId === targetId)) return false; // already there
		return dragItems.every((i) => i.kind !== 'folder' || isValidFolderMoveTarget(i.id, targetId, activeFolders));
	}
	function dragOver(e: DragEvent, targetId: string | null) {
		if (!canDropOn(targetId)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTarget = targetId;
	}
	function dragLeave(targetId: string | null) {
		if (dropTarget === targetId) dropTarget = undefined;
	}
	function drop(e: DragEvent, targetId: string | null) {
		e.preventDefault();
		const items = dragItems;
		const ok = canDropOn(targetId);
		dragEnd();
		if (items && ok) void moveEntries(items, targetId);
	}
	const isDragged = (e: NamedEntry) => dragItems?.some((d) => keyOf(d) === keyOf(e)) ?? false;

	// ---- keyboard ------------------------------------------------------------
	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
		const dialogOpen = newFolderOpen || uploadOpen || renaming !== null || moving !== null || purging !== null || previewing !== null || sharingRecord !== null || historyFileId !== null;
		if (typing || dialogOpen) return;
		if (e.key === 'Escape' && selectMode) clearSelection();
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			selectAll();
		}
	}

	// ---- create / rename / move ---------------------------------------------
	let newFolderOpen = $state(false);
	let uploadOpen = $state(false);
	let externalDragActive = $state(false);
	let externalDragDepth = 0;
	let dragDismissTimer: ReturnType<typeof setTimeout> | undefined;
	let dragIdleTimer: ReturnType<typeof setTimeout> | undefined;
	let uploaderBusy = $state(false);
	let receivingDrop = $state(false);
	let dropStage = $state<'reading' | 'folders' | null>(null);
	let dropError = $state<string | null>(null);
	let dropStatus = $state<string | null>(null);
	let dropCipher = $state<FileAlgo | null>(null);
	let uploadDestinationId = $state<string | null | undefined>(undefined);
	let uploadCloseTimer: ReturnType<typeof setTimeout> | undefined;
	let uploadReceiver = $state<{ uploadFiles: (entries: UploadFileEntry[], options?: { automatic?: boolean }) => Promise<UploadBatchResult>; resetEncryptionChoice: () => void } | undefined>();
	type DropResult = { tree: DroppedTree } | { error: string };
	let droppedBatches = $state<{ folderId: string | null; result: Promise<DropResult> }[]>([]);
	const uploadBusy = $derived(uploaderBusy || receivingDrop || droppedBatches.length > 0);
	const uploadFolderId = $derived(uploadDestinationId !== undefined ? uploadDestinationId : view === 'photos' ? null : currentFolderId);
	const uploadFolderLabel = $derived(uploadFolderId ? activeFolders.get(uploadFolderId)?.name ?? 'Folder' : 'Vault');
	let dropsDisposed = false;
	let renaming = $state<NamedEntry | null>(null);
	let moving = $state<NamedEntry[] | null>(null);

	function openPickerUpload() {
		externalDragActive = false;
		externalDragDepth = 0;
		clearTimeout(dragDismissTimer); clearTimeout(dragIdleTimer);
		uploadDestinationId = undefined;
		dropError = null; dropStatus = null; dropCipher = null;
		uploadOpen = true;
	}
	function closeUploadAfterSuccess() {
		clearTimeout(uploadCloseTimer);
		uploadCloseTimer = setTimeout(() => { if (!uploadBusy) uploadOpen = false; }, 1200);
	}
	async function refreshAfterUpload() {
		await refreshActive();
		if (listingError) throw new Error('The file was uploaded, but your vault could not refresh. Reload it before adding more files.');
		await waitForMetadata();
	}
	function openExternalUpload(destination: string | null) {
		view = 'files';
		query = '';
		if (!uploadOpen) { dropError = null; dropStatus = null; }
		if (!uploadBusy) uploadDestinationId = destination;
		uploadOpen = true;
	}
	function externalFolderAt(target: EventTarget | null): string | null | undefined {
		const element = target instanceof Element ? target : null;
		const folder = element?.closest('[data-upload-folder]');
		return folder ? folder.getAttribute('data-upload-folder') || null : undefined;
	}
	function cancelExternalDrag() {
		externalDragDepth = 0;
		externalDragActive = false;
		dropTarget = undefined;
		clearTimeout(dragDismissTimer); clearTimeout(dragIdleTimer);
		if (!uploadBusy) uploadOpen = false;
	}
	function previewExternalDrag(event: DragEvent) {
		if (!externalDragActive && !uploadBusy) uploadReceiver?.resetEncryptionChoice();
		externalDragActive = true;
		clearTimeout(dragDismissTimer); clearTimeout(dragIdleTimer);
		// Some external sources omit dragend; dragover continues while a drag is alive.
		dragIdleTimer = setTimeout(() => { if (externalDragActive) cancelExternalDrag(); }, 2000);
		clearTimeout(uploadCloseTimer);
		dropTarget = externalFolderAt(event.target);
		if (!uploadOpen) {
			const requested = page.url.searchParams.get('f');
			const current = requested && folderRecords.some((folder) => folder.id === requested) ? requested : null;
			openExternalUpload(dropTarget !== undefined ? dropTarget : current);
		}
	}
	function externalDragEnter(event: DragEvent) {
		if (dragItems || !isExternalFileDrag(event.dataTransfer)) return;
		externalDragDepth++;
		previewExternalDrag(event);
	}
	function externalDragOver(event: DragEvent) {
		if (dragItems || !isExternalFileDrag(event.dataTransfer)) return;
		event.preventDefault();
		if (!externalDragDepth) externalDragDepth = 1;
		previewExternalDrag(event);
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}
	function externalDragLeave(event: DragEvent) {
		if (dragItems || !externalDragActive) return;
		externalDragDepth = Math.max(0, externalDragDepth - 1);
		dropTarget = externalFolderAt(event.relatedTarget);
		const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
		if (outside) externalDragDepth = 0;
		if (!externalDragDepth) {
			clearTimeout(dragDismissTimer);
			dragDismissTimer = setTimeout(() => { if (!externalDragDepth && externalDragActive) cancelExternalDrag(); }, 100);
		}
	}
	function externalDragEnd() { if (!dragItems && externalDragActive) cancelExternalDrag(); }
	function externalDragKey(event: KeyboardEvent) { if (event.key === 'Escape' && externalDragActive) cancelExternalDrag(); }
	function externalDragBlur() { if (externalDragActive) cancelExternalDrag(); }
	function externalDrop(event: DragEvent) {
		if (dragItems || !isExternalFileDrag(event.dataTransfer) || !event.dataTransfer) return;
		event.preventDefault();
		event.stopPropagation();
		externalDragActive = false;
		externalDragDepth = 0;
		clearTimeout(dragDismissTimer); clearTimeout(dragIdleTimer);
		clearTimeout(uploadCloseTimer);
		const requested = page.url.searchParams.get('f');
		const current = requested && folderRecords.some((folder) => folder.id === requested) ? requested : null;
		const explicit = externalFolderAt(event.target);
		const withinUpload = event.target instanceof Element && event.target.closest('[role="dialog"][aria-label="Encrypt & upload"]');
		const destination = explicit !== undefined ? explicit : withinUpload && uploadDestinationId !== undefined ? uploadDestinationId : current;
		dropTarget = undefined;
		openExternalUpload(destination);
		if (!keyStore.isUnlocked || !keyStore.keyAlgo) {
			dropError = 'Unlock your key before encrypting dropped files and folders, then drop them again.';
			return;
		}
		// Start reading while the drop event still grants access to directory entries.
		const result: Promise<DropResult> = readDroppedTree(event.dataTransfer).then(
			(tree) => ({ tree }),
			(error) => ({ error: error instanceof Error ? error.message : 'Could not read the dropped files and folders.' })
		);
		droppedBatches = [...droppedBatches, { folderId: destination, result }];
	}
	onMount(() => {
		window.addEventListener('dragenter', externalDragEnter, true);
		window.addEventListener('dragover', externalDragOver, true);
		window.addEventListener('dragleave', externalDragLeave, true);
		window.addEventListener('dragend', externalDragEnd, true);
		window.addEventListener('keydown', externalDragKey, true);
		window.addEventListener('blur', externalDragBlur);
		window.addEventListener('drop', externalDrop, true);
		return () => {
			dropsDisposed = true;
			clearTimeout(uploadCloseTimer);
			clearTimeout(dragDismissTimer); clearTimeout(dragIdleTimer);
			window.removeEventListener('dragenter', externalDragEnter, true);
			window.removeEventListener('dragover', externalDragOver, true);
			window.removeEventListener('dragleave', externalDragLeave, true);
			window.removeEventListener('dragend', externalDragEnd, true);
			window.removeEventListener('keydown', externalDragKey, true);
			window.removeEventListener('blur', externalDragBlur);
			window.removeEventListener('drop', externalDrop, true);
		};
	});

	$effect(() => {
		const batch = droppedBatches[0];
		const receiver = uploadReceiver;
		if (!batch || dropsDisposed) return;
		if (!keyStore.isUnlocked) {
			untrack(() => { droppedBatches = []; dropError = 'Your key was locked. Unlock it and drop the files again.'; });
			return;
		}
		if (!receiver || uploaderBusy || receivingDrop || !uploadOpen) return;
		untrack(() => { void receiveDroppedBatch(batch, receiver); });
	});

	async function receiveDroppedBatch(batch: (typeof droppedBatches)[number], receiver: NonNullable<typeof uploadReceiver>) {
		clearTimeout(uploadCloseTimer);
		receivingDrop = true;
		uploadDestinationId = batch.folderId;
		droppedBatches = droppedBatches.slice(1);
		dropStage = 'reading'; dropError = null; dropStatus = null; dropCipher = null;
		try {
			const result = await batch.result;
			if (dropsDisposed) return;
			if ('error' in result) throw new Error(result.error);
			const { privateKey, publicKey, keyAlgo } = keyStore;
			if (!privateKey || !publicKey || !keyAlgo) throw new Error('Unlock your key before importing files and folders.');
			const oversized = result.tree.files.find((entry) => entry.file.size > MAX_FILE_SIZE_BYTES)?.file;
			if (oversized) throw new Error(`“${oversized.name}” is over the ${formatBytes(MAX_FILE_SIZE_BYTES)} upload limit.`);
			await refreshActive();
			if (listingError) throw new Error('Could not load the destination folder. Reload your vault and drop the files again.');
			await waitForMetadata();
			if (batch.folderId && !activeFolders.has(batch.folderId)) throw new Error('The destination folder is no longer available. Open another folder and drop the files again.');
			const knownFolders = new Map(activeFolders);
			const paths = new Map<string, string | null>([['[]', batch.folderId]]);
			let created = 0;
			dropStage = result.tree.directories.length ? 'folders' : null;
			for (const path of result.tree.directories) {
				if (dropsDisposed) return;
				if (keyStore.privateKey !== privateKey) throw new Error('Your key was locked. Unlock it and drop the files again.');
				const parentId = paths.get(JSON.stringify(path.slice(0, -1)));
				if (parentId === undefined) throw new Error('Could not prepare the dropped folder structure.');
				const name = path.at(-1)!;
				const existing = [...knownFolders].find(([, metadata]) => metadata.name === name
					&& (metadata.parentId && knownFolders.has(metadata.parentId) ? metadata.parentId : null) === parentId);
				if (existing) { paths.set(JSON.stringify(path), existing[0]); continue; }
				dropCipher = await chooseAutoEncryption(new TextEncoder().encode(JSON.stringify({ name, parentId })).byteLength);
				if (dropsDisposed || keyStore.privateKey !== privateKey) throw new Error('Your key was locked. Unlock it and drop the files again.');
				const payload = await createFolderPayload(name, parentId, keyAlgo, publicKey, dropCipher);
				const response = await api('/api/folders', { method: 'POST', body: JSON.stringify(payload) }, 'Could not create the dropped folder');
				if (typeof response.id !== 'string') throw new Error('The server did not return the new folder.');
				knownFolders.set(response.id, { name, parentId });
				paths.set(JSON.stringify(path), response.id);
				created++;
			}
			if (result.tree.directories.length) await refreshActive();
			if (listingError) throw new Error('Could not load the destination folder. Reload your vault and drop the files again.');
			await waitForMetadata();
			if (dropsDisposed) return;
			if (keyStore.privateKey !== privateKey) throw new Error('Your key was locked. Unlock it and drop the files again.');
			const entries = result.tree.files.map(({ file, directoryPath }) => {
				const folderId = paths.get(JSON.stringify(directoryPath));
				if (folderId === undefined) throw new Error('Could not find the destination for a dropped file.');
				return { file, folderId, relativePath: [...directoryPath, file.name].join('/') };
			});
			dropStage = null;
			const outcome = await receiver.uploadFiles(entries, { automatic: true });
			if (dropsDisposed || outcome.failed) return;
			if (!entries.length || (created && !outcome.uploaded)) dropStatus = created ? `Created ${created} folder${created === 1 ? '' : 's'}, including empty folders${dropCipher ? ` · ${dropCipher}` : ''}.` : 'The folders are already present in your vault.';
			if (!entries.length || created > 0 || outcome.uploaded > 0) closeUploadAfterSuccess();
		} catch (error) {
			if (!dropsDisposed) dropError = error instanceof Error ? error.message : 'Could not import the dropped files and folders.';
		} finally { receivingDrop = false; dropStage = null; }
	}

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

	/** Re-encrypts one item's metadata with its new parent and saves it. Throws on failure. */
	async function moveOne(entry: NamedEntry, parentId: string | null, key: CryptoKey) {
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
	}

	/** Moves several items (a selection, or a drag-and-drop) to one destination, with Undo. */
	async function moveEntries(items: NamedEntry[], parentId: string | null) {
		const key = keyStore.privateKey;
		if (!key || items.length === 0) return;
		const previous = items.map((entry) => ({ entry, parentId: entry.parentId }));
		const failures: string[] = [];
		let moved = 0;

		await run(async () => {
			await pool(items, 4, async (entry) => {
				try {
					await moveOne(entry, parentId, key);
					moved++;
				} catch (e) {
					failures.push(`${entry.name}: ${e instanceof Error ? e.message : 'failed'}`);
				}
			});
			moving = null;
			if (failures.length > 0) throw new Error(`Moved ${moved} of ${items.length}. ${failures[0]}`);
		});

		if (moved > 0) {
			clearSelection();
			const dest = parentId ? (activeFolders.get(parentId)?.name ?? 'the folder') : 'the top level';
			showNotice(`Moved ${moved === 1 ? `"${items[0].name}"` : `${moved} items`} to ${dest}.`, async () => {
				await pool(previous, 4, (p) => moveOne(p.entry, p.parentId, key));
				notice = null;
			});
		}
	}

	// ---- trash / restore / purge --------------------------------------------
	const fileFolderPairs = (records: EncryptedFileRecord[]) =>
		records.map((r) => ({ id: r.id, folderId: metaOf(r.id)?.folderId ?? null }));

	/** Everything that must move together with `entry`, drawn from the given tree and file list. */
	function subtreeOf(entry: NamedEntry, folders: FolderMap, records: EncryptedFileRecord[]) {
		if (entry.kind === 'file') return { fileIds: [entry.id], folderIds: [] as string[] };
		return collectSubtree(entry.id, folders, fileFolderPairs(records));
	}

	const describe = (entries: NamedEntry[]) => (entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`);

	async function trashItems(entries: NamedEntry[]) {
		await run(async () => {
			if (entries.some((entry) => entry.kind === 'folder')) await waitForMetadata();
			const fileIds = new Set<string>();
			const folderIds = new Set<string>();
			for (const e of entries) {
				const sub = subtreeOf(e, activeFolders, files);
				sub.fileIds.forEach((id) => fileIds.add(id));
				sub.folderIds.forEach((id) => folderIds.add(id));
			}
			const body = { fileIds: [...fileIds], folderIds: [...folderIds] };
			await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'trash', ...body }) }, 'Could not move to trash');
			clearSelection();
			await refreshActive();
			showNotice(`${describe(entries)} moved to trash.`, async () => {
				await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'restore', ...body }) }, 'Could not undo');
				await refreshActive();
				notice = null;
			});
		});
	}
	const trashEntry = (entry: NamedEntry) => trashItems([entry]);

	async function restoreEntries(entries: NamedEntry[]) {
		await run(async () => {
			if (entries.some((entry) => entry.kind === 'folder')) await waitForMetadata();
			const fileIds = new Set<string>();
			const folderIds = new Set<string>();
			for (const e of entries) {
				const sub = subtreeOf(e, unionFolders, trashFiles);
				sub.fileIds.forEach((id) => fileIds.add(id));
				sub.folderIds.filter((id) => trashedFolders.has(id)).forEach((id) => folderIds.add(id));
			}
			await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'restore', fileIds: [...fileIds], folderIds: [...folderIds] }) }, 'Could not restore');
			clearSelection();
			await Promise.all([refreshTrash(), refreshActive()]);
			showNotice(`${describe(entries)} restored.`);
		});
	}
	const restoreEntry = (entry: NamedEntry) => restoreEntries([entry]);

	let purging = $state<{ label: string; fileIds: string[]; folderIds: string[] } | null>(null);

	async function askPurge(entries: NamedEntry[], label: string) {
		await run(async () => {
			if (entries.some((entry) => entry.kind === 'folder')) await waitForMetadata();
			const fileIds = new Set<string>();
			const folderIds = new Set<string>();
			for (const e of entries) {
				const s = subtreeOf(e, unionFolders, trashFiles);
				s.fileIds.forEach((id) => fileIds.add(id));
				s.folderIds.filter((id) => trashedFolders.has(id)).forEach((id) => folderIds.add(id));
			}
			purging = { label, fileIds: [...fileIds], folderIds: [...folderIds] };
		});
	}

	async function confirmPurge() {
		if (!purging) return;
		const { fileIds, folderIds } = purging;
		await run(async () => {
			const res = await api('/api/trash', { method: 'POST', body: JSON.stringify({ action: 'purge', fileIds, folderIds }) }, 'Could not delete');
			purging = null;
			clearSelection();
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
	 * Decrypts a set of files (plus their folder structure) in this browser into
	 * one .zip. The save dialog needs the click's user gesture, so it opens
	 * before any other await: Chromium streams to disk, other browsers build the
	 * zip in memory.
	 */
	async function zipExport(filename: string, subFiles: EncryptedFileRecord[], subFolders: FolderRecord[], label: string) {
		const key = keyStore.privateKey;
		if (!key) return;
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
				actionError = `${result.failed.length} file(s) in ${label} could not be verified — see EXPORT-REPORT.txt inside the zip.`;
			} else {
				showNotice(`Downloaded ${label} (${result.exported} file${result.exported === 1 ? '' : 's'}).`);
			}
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Download failed';
		} finally {
			folderProgress = null;
		}
	}

	/** A folder and everything inside it, as FolderName.zip. */
	async function handleDownloadFolder(entry: NamedEntry) {
		if (downloadingFolderId || downloadingSelection) return;
		actionError = null;
		downloadingFolderId = entry.id;
		try {
			await waitForMetadata();
			const { fileIds, folderIds } = collectSubtree(entry.id, activeFolders, fileFolderPairs(files));
			const fileSet = new Set(fileIds);
			const folderSet = new Set(folderIds);
			await zipExport(
				`${sanitizeSegment(entry.name)}.zip`,
				files.filter((f) => fileSet.has(f.id)),
				folderRecords.filter((f) => folderSet.has(f.id)),
				`"${entry.name}"`
			);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not prepare the folder download';
		} finally {
			downloadingFolderId = null;
		}
	}

	let downloadingSelection = $state(false);

	/** The selected files and folders: one item downloads directly, several become a zip. */
	async function handleDownloadSelection() {
		const items = selectedEntries;
		if (items.length === 0 || downloadingSelection || downloadingFolderId) return;
		if (items.length === 1) {
			const only = items[0];
			if (only.kind === 'folder') return handleDownloadFolder(only);
			const rec = filesById.get(only.id);
			const meta = metaOf(only.id);
			if (rec && meta) return handleDownload(rec, meta);
		}

		actionError = null;
		downloadingSelection = true;
		try {
			if (items.some((entry) => entry.kind === 'folder')) await waitForMetadata();
			const fileIds = new Set<string>();
			const folderIds = new Set<string>();
			for (const e of items) {
				const sub = subtreeOf(e, activeFolders, files);
				sub.fileIds.forEach((id) => fileIds.add(id));
				sub.folderIds.forEach((id) => folderIds.add(id));
			}
			await zipExport(
				`endtoend-selection-${new Date().toISOString().slice(0, 10)}.zip`,
				files.filter((f) => fileIds.has(f.id)),
				folderRecords.filter((f) => folderIds.has(f.id)),
				`${items.length} items`
			);
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Could not prepare the selected download';
		} finally {
			downloadingSelection = false;
		}
	}

	/** What the floating bar offers for the current selection. */
	const barActions = $derived.by<MenuAction[]>(() => {
		const label = describe(selectedEntries.length ? selectedEntries : [{ kind: 'file', id: '', name: '', parentId: null }]);
		if (view === 'trash') {
			return [
				{ label: 'Restore', icon: RotateCcw, onclick: () => restoreEntries(selectedEntries), disabled: busy },
				{ label: 'Delete forever', icon: Trash2, danger: true, onclick: () => askPurge(selectedEntries, label), disabled: busy }
			];
		}
		return [
			{ label: 'Download', icon: Download, onclick: handleDownloadSelection, disabled: busy || downloadingSelection || downloadingFolderId !== null },
			{ label: 'Move', icon: FolderInput, onclick: () => (moving = selectedEntries), disabled: busy },
			{ label: 'Trash', icon: Trash2, danger: true, onclick: () => trashItems(selectedEntries), disabled: busy }
		];
	});

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
		const items: MenuAction[] = [{ label: 'Select', icon: SquareCheck, onclick: () => ((selectToggle = true), toggle(entry)) }];
		if (entry.kind === 'folder') {
			items.push({ label: 'Download folder (.zip)', icon: Download, onclick: () => handleDownloadFolder(entry), disabled: downloadingFolderId !== null });
		} else if (rec && meta) {
			if (canPreview) items.push({ label: 'Preview', icon: Eye, onclick: () => (previewing = rec) });
			items.push({ label: 'Download & decrypt', icon: Download, onclick: () => handleDownload(rec, meta), disabled: downloadingId === rec.id });
			items.push({ label: 'Download encrypted (.zip)', icon: PackageOpen, onclick: () => handleDownloadRaw(rec, entry.name), disabled: downloadingRawId === rec.id });
			items.push({ label: 'Share link', icon: Share2, onclick: () => (sharingRecord = rec) });
			items.push({ label: 'Version history', icon: History, onclick: () => (historyFileId = rec.id) });
		}
		items.push({ label: 'Rename', icon: Pencil, onclick: () => (renaming = entry), disabled: busy });
		items.push({ label: 'Move', icon: FolderInput, onclick: () => (moving = [entry]), disabled: busy });
		items.push({ label: 'Move to trash', icon: Trash2, danger: true, onclick: () => trashEntry(entry), disabled: busy });
		return items;
	}

	let previewing = $state<EncryptedFileRecord | null>(null);
	let sharingRecord = $state<EncryptedFileRecord | null>(null);
	let historyFileId = $state<string | null>(null);
	const historyRecord = $derived(historyFileId ? filesById.get(historyFileId) ?? null : null);

	const dateOf = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
</script>

<svelte:head>
	<title>EndToEnd Encrypt — Vault</title>
</svelte:head>

<svelte:window onkeydown={onKey} />

<div class="min-h-dvh bg-[var(--color-bg)] text-[var(--color-text-primary)]">
	<AppHeader />

	<main class="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6 sm:py-10 {selected.size > 0 ? 'pb-28' : ''}">
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
					<div class="flex w-fit gap-1 self-end rounded-[var(--radius-md)] border border-[var(--color-border)] p-1 lg:self-auto" role="tablist" aria-label="Vault view">
						{#each [['files', 'Files'], ['photos', 'Photos'], ['trash', 'Trash']] as [id, label] (id)}
							<button
								type="button"
								role="tab"
								aria-selected={view === id}
								onclick={() => showView(id as 'files' | 'photos' | 'trash')}
								class="h-8 cursor-pointer rounded-[var(--radius-sm)] px-3 text-sm {view === id
									? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
									: 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'}"
							>
								{label}
							</button>
						{/each}
					</div>

					{#if view !== 'trash'}
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
							{#if view === 'files'}<button type="button" class="{ui.btnGhost} w-full lg:w-36" onclick={() => (newFolderOpen = true)}>
								<FolderPlus class="h-4 w-4" aria-hidden="true" /> New folder
							</button>{/if}
						<button type="button" class="{ui.btnPrimary} w-full lg:w-36" onclick={openPickerUpload}>
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

				<!-- Breadcrumb (left) · storage meter (right) -->
				<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<div class="min-w-0">
					{#if view === 'files' && !searching}
						<nav aria-label="Folder path" class="flex flex-wrap items-center gap-1 text-sm">
							<button
								type="button"
								data-upload-folder=""
								class="flex cursor-pointer items-center gap-1 rounded px-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] {dropTarget === null ? 'bg-[var(--color-accent-bg)] ring-1 ring-[var(--color-accent)]' : ''}"
								onclick={() => openFolder(null)}
								ondragover={(e) => dragOver(e, null)}
								ondragleave={() => dragLeave(null)}
								ondrop={(e) => drop(e, null)}
							>
								<Home class="h-3.5 w-3.5" aria-hidden="true" /> Vault
							</button>
							{#each crumbs as crumb (crumb.id)}
								<ChevronRight class="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" aria-hidden="true" />
								<button
									type="button"
									data-upload-folder={crumb.id}
									class="max-w-48 cursor-pointer truncate rounded px-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] {dropTarget === crumb.id ? 'bg-[var(--color-accent-bg)] ring-1 ring-[var(--color-accent)]' : ''}"
									onclick={() => openFolder(crumb.id)}
									ondragover={(e) => dragOver(e, crumb.id)}
									ondragleave={() => dragLeave(crumb.id)}
									ondrop={(e) => drop(e, crumb.id)}
								>
									{crumb.name}
								</button>
							{/each}
						</nav>
					{:else if view === 'files' && searching}
						<p class="text-sm text-[var(--color-text-tertiary)]">
							{visible.length} result{visible.length === 1 ? '' : 's'} for “{query.trim()}” — searched locally, names never leave your browser.
							<button type="button" class="ml-1 cursor-pointer underline" style="color: var(--color-accent)" onclick={() => (query = '')}>Clear</button>
						</p>
					{:else if view === 'photos'}
						<p class="flex flex-wrap items-center gap-3 text-sm text-[var(--color-text-tertiary)]"><ImageIcon class="h-4 w-4" aria-hidden="true" /> {photoEntries.length} photo{photoEntries.length === 1 ? '' : 's'} in your vault
							{#if photoEntries.some((entry) => !filesById.get(entry.id)?.thumbnail)}<button type="button" class="cursor-pointer underline disabled:opacity-50" disabled={generatingThumbnails} onclick={generateMissingThumbnails}>{generatingThumbnails ? `Creating thumbnails… ${thumbnailProgress}` : 'Create missing thumbnails'}</button>{/if}
						</p>
					{:else}
						<p class="text-sm text-[var(--color-text-tertiary)]">Trashed items stay here until you delete them for good.</p>
					{/if}
					</div>
					<div class="flex items-center gap-3">
						{#if listed.length > 0}
							{#if selectMode && selected.size < listed.length}
								<button
									type="button"
									class="cursor-pointer rounded-[var(--radius-md)] px-2 py-1 text-xs font-medium hover:bg-[var(--color-surface-3)]"
									style="color: var(--color-accent)"
									onclick={selectAll}
								>Select all</button>
							{/if}
							<button
								type="button"
								class="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-xs font-medium hover:bg-[var(--color-surface-3)] {selectMode ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}"
								aria-pressed={selectMode}
								onclick={() => (selectMode ? clearSelection() : (selectToggle = true))}
							>
								<SquareCheck class="h-3.5 w-3.5" aria-hidden="true" /> {selectMode ? 'Done' : 'Select'}
							</button>
						{/if}
						<StorageMeter {usage} compact />
					</div>
				</div>

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
				{#if listingError && view !== 'trash'}
					<div class="flex flex-wrap items-center justify-between gap-3 {ui.alertDanger}" role="alert"><span>{listingError}</span><button type="button" class="cursor-pointer underline" onclick={() => void refreshActive()}>Retry loading files</button></div>
				{:else if view === 'photos'}
					<ul class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-label="Photo gallery">
						{#each listed as entry (entry.id)}
							{@const rec = filesById.get(entry.id)!}
							{@const meta = metaOf(entry.id)}
							{@const picked = selected.has(keyOf(entry))}
							<li class="relative overflow-hidden {ui.card} {picked ? 'ring-2 ring-[var(--color-accent)]' : ''}" draggable={dragEnabled} ondragstart={(event) => dragStart(event, entry)} ondragend={dragEnd}>
								<button type="button" class="block w-full cursor-pointer" aria-label="Open {entry.name}" onpointerdown={(event) => pressStart(event, entry)} onpointerup={pressCancel} onpointermove={pressCancel} onpointercancel={pressCancel} onclick={(event) => activate(entry, event, () => (previewing = rec))}>
									<PhotoThumbnail record={rec} privateKey={keyStore.privateKey} name={entry.name} />
								</button>
								<input type="checkbox" checked={picked} aria-label="Select {entry.name}" onclick={(event) => toggle(entry, event.shiftKey)} class="absolute left-3 top-3 h-4 w-4 cursor-pointer accent-[var(--color-accent)]" />
								<div class="flex items-center justify-between gap-2 p-3">
									<div class="min-w-0"><p class="truncate text-sm font-medium">{entry.name}</p><p class="truncate text-xs text-[var(--color-text-tertiary)]">{formatBytes(entry.size ?? 0)} · {pathLabel(entry)}</p></div>
									<RowMenu title={entry.name} actions={menuActions(entry, rec, meta, meta !== null && previewInfo(meta) !== null)} />
								</div>
							</li>
						{:else}<li class="col-span-full py-12 text-center text-sm text-[var(--color-text-tertiary)]">{searching ? 'No photos match your search.' : 'Upload photos to start your gallery.'}</li>{/each}
					</ul>
				{:else}
				<ul class="divide-y divide-[var(--color-border)] {ui.card}">
					{#each listed as entry, index (entry.kind + entry.id)}
						{@const rec = entry.kind === 'file' ? (view === 'files' ? filesById.get(entry.id) : trashFiles.find((t) => t.id === entry.id)) : undefined}
						{@const meta = entry.kind === 'file' ? metaOf(entry.id) : null}
						{@const canPreview = view === 'files' && meta !== null && previewInfo(meta) !== null}
						{@const picked = selected.has(keyOf(entry))}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
						<li
							data-upload-folder={view !== 'trash' && entry.kind === 'folder' ? entry.id : undefined}
			class="group/row flex items-center justify-between gap-3 px-4 py-3.5 transition-colors [-webkit-touch-callout:none] sm:gap-4 sm:px-5 {picked
								? index === 0 && index === listed.length - 1
									? 'rounded-[var(--radius-lg)] bg-[var(--color-accent-bg)]'
									: index === 0
										? 'rounded-t-[var(--radius-lg)] bg-[var(--color-accent-bg)]'
										: index === listed.length - 1
											? 'rounded-b-[var(--radius-lg)] bg-[var(--color-accent-bg)]'
											: 'bg-[var(--color-accent-bg)]'
								: ''} {entry.kind === 'folder' && dropTarget === entry.id
								? 'bg-[var(--color-accent-bg)] ring-1 ring-inset ring-[var(--color-accent)]'
								: ''} {isDragged(entry) ? 'opacity-50' : ''}"
							draggable={dragEnabled}
							ondragstart={(e) => dragStart(e, entry)}
							ondragend={dragEnd}
							ondragover={(e) => entry.kind === 'folder' && dragOver(e, entry.id)}
							ondragleave={() => entry.kind === 'folder' && dragLeave(entry.id)}
							ondrop={(e) => entry.kind === 'folder' && drop(e, entry.id)}
							onpointerdown={(e) => pressStart(e, entry)}
							onpointerup={pressCancel}
							onpointermove={pressCancel}
							onpointercancel={pressCancel}
							onclick={(e) => {
								if (selectMode && !(e.target as HTMLElement).closest('button, a, input')) toggle(entry, e.shiftKey);
							}}
						>
							<div class="flex min-w-0 flex-1 items-center gap-3">
								<!-- The icon turns into a checkbox on hover, and always in selection mode. -->
								<span class="flex h-5 w-5 shrink-0 items-center justify-center">
									<span class={selectMode ? 'hidden' : 'group-hover/row:hidden'}>
										{#if entry.kind === 'folder'}
											<FolderIcon class="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
										{:else}
											<FileIcon class="h-4 w-4 text-[var(--color-text-tertiary)]" aria-hidden="true" />
										{/if}
									</span>
									<input
										type="checkbox"
										checked={picked}
										aria-label="Select {entry.name}"
										onclick={(e) => {
											e.stopPropagation();
											toggle(entry, e.shiftKey);
										}}
										class="h-4 w-4 cursor-pointer accent-[var(--color-accent)] {selectMode ? 'block' : 'hidden group-hover/row:block'}"
									/>
								</span>
								<div class="min-w-0">
									{#if entry.kind === 'folder' && view === 'files'}
										<button type="button" class="block max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline" onclick={(e) => activate(entry, e, () => openFolder(entry.id))}>
											{entry.name}
										</button>
									{:else if canPreview && rec}
										<button type="button" class="block max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline" onclick={(e) => activate(entry, e, () => (previewing = rec))}>
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

							{#if !selectMode}
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
										<button type="button" class={ui.iconBtn} onclick={() => (historyFileId = rec.id)} aria-label="Version history for {entry.name}" title="Version history"><History class="h-4 w-4" aria-hidden="true" /></button>
									{/if}
									{#if entry.kind === 'folder'}
										<button type="button" class={ui.iconBtn} onclick={() => handleDownloadFolder(entry)} disabled={downloadingFolderId !== null} aria-label="Download folder {entry.name} as a decrypted zip" title="Download folder (decrypted .zip)">
											{#if downloadingFolderId === entry.id}<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />{:else}<Download class="h-4 w-4" aria-hidden="true" />{/if}
										</button>
									{/if}
									<button type="button" class={ui.iconBtn} onclick={() => (renaming = entry)} disabled={busy} aria-label="Rename {entry.name}" title="Rename"><Pencil class="h-4 w-4" aria-hidden="true" /></button>
									<button type="button" class={ui.iconBtn} onclick={() => (moving = [entry])} disabled={busy} aria-label="Move {entry.name}" title="Move"><FolderInput class="h-4 w-4" aria-hidden="true" /></button>
									<button type="button" class={ui.iconBtnDanger} onclick={() => trashEntry(entry)} disabled={busy} aria-label="Move {entry.name} to trash" title="Move to trash"><Trash2 class="h-4 w-4" aria-hidden="true" /></button>
								{/if}
							</div>
						<div class="shrink-0 sm:hidden">
								<RowMenu title={entry.name} actions={menuActions(entry, rec, meta, canPreview)} />
							</div>
							{/if}
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
				{/if}
			</section>
		{/if}
	</main>
</div>

<Modal
	open={uploadOpen}
	title="Encrypt &amp; upload"
	size="lg"
	zIndex={60}
	passThrough={externalDragActive}
	dismissable={!uploadBusy}
	contentClass="share-scrollbar"
	onClose={() => { uploadOpen = false; externalDragActive = false; externalDragDepth = 0; clearTimeout(dragDismissTimer); clearTimeout(dragIdleTimer); }}
>
	{#if dropStage}<p class="mb-4 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]" role="status"><Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" /> {dropStage === 'reading' ? 'Reading dropped files and folders…' : dropCipher ? `Encrypting folders · ${dropCipher}` : 'Choosing folder encryption…'}</p>{/if}
	{#if dropError}<div class="mb-4 {ui.alertDanger}" role="alert">{dropError}</div>{/if}
	{#if dropStatus}<div class="mb-4 {ui.alertOk}" role="status">{dropStatus}</div>{/if}
	{#if !keyStore.isUnlocked}<p class="mb-4 {ui.alertInfo}"><a href="/settings/keys?next=/dashboard" class="underline">Unlock your key</a> to encrypt and upload files.</p>{/if}
	{#if storageFull}
		<div class="mb-4 {ui.alertDanger}" role="alert">
			Your storage is full. Empty the trash or delete something to free space — uploads will be refused until then.
		</div>
	{/if}
	{#if keyStore.publicKey && keyStore.keyAlgo}
		<EncryptUploader
			bind:this={uploadReceiver}
			recipientPublicKey={keyStore.publicKey}
			recipientKeyAlgo={keyStore.keyAlgo}
			folderId={uploadFolderId}
			destinationLabel={uploadFolderLabel}
			findExistingFile={findExistingUpload}
			disabled={receivingDrop || droppedBatches.length > 0}
			onUploaded={refreshAfterUpload}
			onInterrupted={refreshActive}
			onBusyChange={(b) => { uploaderBusy = b; if (b) clearTimeout(uploadCloseTimer); }}
			onFinished={closeUploadAfterSuccess}
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
	title={moving ? (moving.length === 1 ? `Move “${moving[0].name}”` : `Move ${moving.length} items`) : 'Move'}
	folders={activeFolders}
	movingFolderIds={(moving ?? []).filter((m) => m.kind === 'folder').map((m) => m.id)}
	currentParentId={moving && moving.length > 0 && moving.every((m) => m.parentId === moving![0].parentId) ? moving[0].parentId : undefined}
	{busy}
	onPick={(parentId) => moving && moveEntries(moving, parentId)}
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
	<VersionHistoryModal record={historyRecord} name={historyFileId ? metaOf(historyFileId)?.name ?? 'File' : 'File'} privateKey={keyStore.privateKey} publicKey={keyStore.publicKey} keyAlgo={keyStore.keyAlgo} onClose={() => (historyFileId = null)} onChanged={refreshActive} />
{/if}

{#if selected.size > 0}
	<SelectionBar
		count={selected.size}
		actions={barActions}
		progress={downloadingSelection || downloadingFolderId
			? folderProgress?.phase === 'exporting'
				? `Decrypting ${folderProgress.fileIndex}/${folderProgress.fileCount}`
				: 'Preparing…'
			: null}
	/>
{/if}
