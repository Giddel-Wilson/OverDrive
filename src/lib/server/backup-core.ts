import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

/** Portable, ciphertext-only-at-rest snapshots of the vault's Postgres schema and rows. */
export interface SnapshotConnection {
	query(statement: string): Promise<Record<string, unknown>[]>;
	transaction(statements: string[]): Promise<Record<string, unknown>[][]>;
}

interface Column {
	name: string;
	type: string;
	notNull: boolean;
	default: string | null;
	generated: string;
	identity: string;
	identitySequence: string | null;
}
interface Table {
	schema: string;
	name: string;
	columns: Column[];
	constraints: { name: string; kind: string; definition: string }[];
	indexes: string[];
}
interface Sequence {
	schema: string;
	name: string;
	type: string;
	start: string;
	increment: string;
	min: string;
	max: string;
	cache: string;
	cycle: boolean;
	owner: string | null;
	ownerKind: string | null;
}
export interface DatabaseSnapshot {
	format: 'e2e-database';
	version: 1;
	createdAt: string;
	catalog: {
		schemas: string[];
		enums: { schema: string; name: string; labels: string[] }[];
		extensions: { name: string; schema: string }[];
		tables: Table[];
		sequences: Sequence[];
		unsupported: string[];
	};
	/** JSON stays a string: parsing it in JavaScript would round Postgres bigint values. */
	tables: { schema: string; name: string; rows: number; json: string }[];
	sequences: { schema: string; name: string; lastValue: string; isCalled: boolean }[];
}

const namespaceFilter = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
const userObject = "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e' AND d.classid = 'pg_catalog.pg_class'::regclass)";
export const DISCOVER_TABLES_SQL = `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
	FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	WHERE ${namespaceFilter} AND ${userObject} AND c.relkind IN ('r', 'S') ORDER BY n.nspname, c.relname`;

// pg_catalog search_path makes pg_get_expr / pg_get_constraintdef qualify user types,
// functions and referenced tables. Restoration doesn't depend on a deployment's search_path.
const CATALOG_SQL = `SELECT json_build_object(
	'createdAt', transaction_timestamp(),
	'schemas', COALESCE((SELECT json_agg(n.nspname ORDER BY n.nspname) FROM pg_catalog.pg_namespace n WHERE ${namespaceFilter}), '[]'::json),
	'extensions', COALESCE((SELECT json_agg(json_build_object('name', e.extname, 'schema', n.nspname)) FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql'), '[]'::json),
	'enums', COALESCE((SELECT json_agg(json_build_object('schema', n.nspname, 'name', t.typname, 'labels',
		(SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid)))
		FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE ${namespaceFilter} AND t.typtype = 'e'), '[]'::json),
	'tables', COALESCE((SELECT json_agg(json_build_object('schema', n.nspname, 'name', c.relname,
		'columns', (SELECT json_agg(json_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
			'notNull', a.attnotnull, 'default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity,
			'identitySequence', (SELECT quote_ident(sn.nspname) || '.' || quote_ident(sc.relname) FROM pg_catalog.pg_depend sd
				JOIN pg_catalog.pg_class sc ON sc.oid = sd.objid JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
				WHERE sd.refobjid = c.oid AND sd.refobjsubid = a.attnum AND sd.deptype = 'i' AND sc.relkind = 'S' LIMIT 1)) ORDER BY a.attnum)
			FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
			WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
		'constraints', COALESCE((SELECT json_agg(json_build_object('name', con.conname, 'kind', con.contype, 'definition', pg_catalog.pg_get_constraintdef(con.oid))) FROM pg_catalog.pg_constraint con WHERE con.conrelid = c.oid), '[]'::json),
		'indexes', COALESCE((SELECT json_agg(pg_catalog.pg_get_indexdef(i.indexrelid)) FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid)), '[]'::json)))
		FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${namespaceFilter} AND ${userObject} AND c.relkind = 'r'), '[]'::json),
	'sequences', COALESCE((SELECT json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'type', pg_catalog.format_type(s.seqtypid, NULL),
		'start', s.seqstart::text, 'increment', s.seqincrement::text, 'min', s.seqmin::text, 'max', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle,
		'ownerKind', (SELECT d.deptype FROM pg_catalog.pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a','i') LIMIT 1),
		'owner', (SELECT quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' || quote_ident(a.attname) FROM pg_catalog.pg_depend d
			JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
			JOIN pg_catalog.pg_attribute a ON a.attrelid = tc.oid AND a.attnum = d.refobjsubid WHERE d.objid = c.oid AND d.deptype IN ('a','i') LIMIT 1)))
		FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE ${namespaceFilter} AND ${userObject}), '[]'::json),
	'unsupported', COALESCE((SELECT json_agg(n.nspname || '.' || c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE ${namespaceFilter} AND ${userObject} AND (c.relkind IN ('v','m','p','f') OR c.relrowsecurity OR c.relispartition)), '[]'::json)
)::text AS catalog`;

export const quoteIdentifier = (s: string) => `"${s.replaceAll('"', '""')}"`;
const qualified = (s: { schema: string; name: string }) => `${quoteIdentifier(s.schema)}.${quoteIdentifier(s.name)}`;
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAGIC = Buffer.from('E2E-DB-BACKUP-1\n');
export const BACKUP_PREFIX = '_database-backups/v1/';

/** All table data and DDL are read in one READ ONLY, REPEATABLE READ transaction. */
export async function captureDatabase(connection: SnapshotConnection): Promise<DatabaseSnapshot> {
	const discovered = await connection.query(DISCOVER_TABLES_SQL);
	const tables = discovered.filter((t) => t.kind === 'r') as unknown as Table[];
	const sequences = discovered.filter((t) => t.kind === 'S') as unknown as Sequence[];
	const results = await connection.transaction([
		'SET LOCAL search_path = pg_catalog',
		CATALOG_SQL,
		...tables.map((t) => `SELECT count(*)::text AS count, COALESCE(json_agg(row_to_json(backup_row)), '[]'::json)::text AS data FROM ONLY ${qualified(t)} AS backup_row`),
		...sequences.map((s) => `SELECT last_value::text AS value, is_called AS called FROM ${qualified(s)}`)
	]);
	const { createdAt, ...catalog } = JSON.parse(String(results[1][0].catalog)) as DatabaseSnapshot['catalog'] & { createdAt: string };
	if (catalog.unsupported.length) throw new Error('This schema uses views, partitions or row policies. Use pg_dump for this database.');
	const keys = (items: { schema: string; name: string }[]) => items.map(qualified).sort().join('\n');
	if (keys(tables) !== keys(catalog.tables) || keys(sequences) !== keys(catalog.sequences)) {
		throw new Error('The database schema changed while the backup started. Retry the backup.');
	}
	const snapshot: DatabaseSnapshot = {
		format: 'e2e-database', version: 1, createdAt, catalog,
		tables: tables.map((t, i) => ({ schema: t.schema, name: t.name, rows: Number(results[i + 2][0].count), json: String(results[i + 2][0].data) })),
		sequences: sequences.map((s, i) => ({ schema: s.schema, name: s.name, lastValue: String(results[i + 2 + tables.length][0].value), isCalled: Boolean(results[i + 2 + tables.length][0].called) }))
	};
	if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw new Error('Database backup exceeds 64 MiB. Use pg_dump for a larger database.');
	return snapshot;
}

/** Restore into an empty database. Foreign keys and indexes come after data (including cyclic FKs). */
export function restoreStatements(snapshot: DatabaseSnapshot): string[] {
	if (snapshot.format !== 'e2e-database' || snapshot.version !== 1) throw new Error('Unsupported database backup format');
	const statements = ["SET LOCAL standard_conforming_strings = on", 'SET LOCAL search_path = pg_catalog'];
	for (const schema of snapshot.catalog.schemas) statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
	for (const extension of snapshot.catalog.extensions) statements.push(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.name)} WITH SCHEMA ${quoteIdentifier(extension.schema)}`);
	for (const e of snapshot.catalog.enums) statements.push(`CREATE TYPE ${qualified(e)} AS ENUM (${e.labels.map(literal).join(', ')})`);
	for (const s of snapshot.catalog.sequences.filter((s) => s.ownerKind !== 'i')) {
		statements.push(`CREATE SEQUENCE ${qualified(s)} AS ${s.type} START WITH ${s.start} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} CACHE ${s.cache} ${s.cycle ? 'CYCLE' : 'NO CYCLE'}`);
	}
	for (const t of snapshot.catalog.tables) {
		const columns = t.columns.map((c) => {
			let definition = `${quoteIdentifier(c.name)} ${c.type}`;
			if (c.identity) definition += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${c.identitySequence ? ` (SEQUENCE NAME ${c.identitySequence})` : ''}`;
			else if (c.generated) definition += ` GENERATED ALWAYS AS (${c.default}) STORED`;
			else if (c.default !== null) definition += ` DEFAULT ${c.default}`;
			if (c.notNull) definition += ' NOT NULL';
			return definition;
		});
		statements.push(`CREATE TABLE ${qualified(t)} (${columns.join(', ')})`);
	}
	for (const t of snapshot.tables) {
		if (t.rows === 0) continue;
		const definition = snapshot.catalog.tables.find((d) => d.schema === t.schema && d.name === t.name);
		if (!definition) throw new Error('Backup table is missing its schema');
		const columns = definition.columns.filter((c) => !c.generated).map((c) => quoteIdentifier(c.name)).join(', ');
		statements.push(`INSERT INTO ${qualified(t)} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM json_populate_recordset(NULL::${qualified(t)}, ${literal(t.json)}::json)`);
	}
	for (const kind of ['primary', 'foreign']) {
		for (const t of snapshot.catalog.tables) for (const c of t.constraints) {
			if ((c.kind === 'f') !== (kind === 'foreign')) continue;
			statements.push(`ALTER TABLE ${qualified(t)} ADD CONSTRAINT ${quoteIdentifier(c.name)} ${c.definition}`);
		}
	}
	for (const t of snapshot.catalog.tables) statements.push(...t.indexes);
	for (const s of snapshot.catalog.sequences) if (s.owner && s.ownerKind !== 'i') statements.push(`ALTER SEQUENCE ${qualified(s)} OWNED BY ${s.owner}`);
	for (const s of snapshot.sequences) statements.push(`SELECT pg_catalog.setval(${literal(qualified(s))}::regclass, ${s.lastValue}, ${s.isCalled})`);
	return statements;
}

export function backupEncryptionKey(encoded: string | undefined): Buffer {
	if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded random 32-byte key');
	const key = Buffer.from(encoded, 'base64');
	if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to 32 bytes');
	return key;
}

export function encryptSnapshot(snapshot: DatabaseSnapshot, encodedKey: string): Buffer {
	const key = backupEncryptionKey(encodedKey);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(MAGIC);
	const compressed = gzipSync(JSON.stringify(snapshot));
	return Buffer.concat([MAGIC, iv, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
}

export function decryptSnapshot(archive: Uint8Array, encodedKey: string): DatabaseSnapshot {
	const bytes = Buffer.from(archive);
	if (bytes.length < MAGIC.length + 28 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid database backup');
	const decipher = createDecipheriv('aes-256-gcm', backupEncryptionKey(encodedKey), bytes.subarray(MAGIC.length, MAGIC.length + 12));
	decipher.setAAD(MAGIC);
	decipher.setAuthTag(bytes.subarray(-16));
	const compressed = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 12, -16)), decipher.final()]);
	const snapshot = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_SNAPSHOT_BYTES }).toString('utf8')) as DatabaseSnapshot;
	if (snapshot.format !== 'e2e-database' || snapshot.version !== 1) throw new Error('Unsupported database backup format');
	return snapshot;
}

export interface BackupStorage {
	set(key: string, bytes: ArrayBuffer): Promise<void>;
	get(key: string): Promise<ArrayBuffer | null>;
	listPage(prefix: string, token?: string, maxKeys?: number): Promise<{ objects: { key: string; lastModified?: Date; size: number }[]; next?: string }>;
	deleteMany(keys: string[]): Promise<{ failed: string[] }>;
}

export interface BackupResult {
	key: string;
	createdAt: string;
	bytes: number;
	tables: number;
	rows: number;
	sha256: string;
	pruned: number;
	pruneFailed: number;
}

export async function storeVerifiedBackup(snapshot: DatabaseSnapshot, encodedKey: string, store: BackupStorage, retentionDays = 30): Promise<BackupResult> {
	const archive = encryptSnapshot(snapshot, encodedKey);
	const key = `${BACKUP_PREFIX}${new Date(snapshot.createdAt).toISOString().replaceAll(':', '-')}-${randomBytes(6).toString('hex')}.json.gz.enc`;
	await store.set(key, Uint8Array.from(archive).buffer);
	const readBack = await store.get(key);
	const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
	if (!readBack || !timingSafeEqual(hash(archive), hash(new Uint8Array(readBack)))) throw new Error('Backup read-back verification failed; previous backups were retained');
	const verified = decryptSnapshot(new Uint8Array(readBack), encodedKey);
	if (verified.createdAt !== snapshot.createdAt) throw new Error('Backup verification failed');
	const result: BackupResult = {
		key, createdAt: snapshot.createdAt, bytes: archive.length, tables: snapshot.tables.length,
		rows: snapshot.tables.reduce((sum, t) => sum + t.rows, 0), sha256: hash(archive).toString('hex'), pruned: 0, pruneFailed: 0
	};
	const cutoff = new Date(snapshot.createdAt).getTime() - Math.max(1, retentionDays) * 86_400_000;
	let token: string | undefined;
	// Retention only runs AFTER a new backup has passed read-back and decryption.
	// Limit maintenance work so a large prefix can't consume a serverless invocation.
	for (let pages = 0; pages < 20; pages++) {
		try {
			const page = await store.listPage(BACKUP_PREFIX, token, 1000);
			const old = page.objects.filter((o) => o.key !== key && o.key.endsWith('.json.gz.enc') && o.lastModified && o.lastModified.getTime() < cutoff);
			if (old.length) {
				const { failed } = await store.deleteMany(old.map((o) => o.key));
				result.pruned += old.length - failed.length;
				result.pruneFailed += failed.length;
			}
			token = page.next;
			if (!token) break;
		} catch { result.pruneFailed++; break; }
	}
	return result;
}
