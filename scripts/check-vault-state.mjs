import { neon } from '@neondatabase/serverless';

try {
	const sql = neon(process.env.DATABASE_URL);
	const [counts, columns] = await Promise.all([
		sql(`SELECT count(*)::int AS total, count(*) FILTER (WHERE upload_status = 'complete' AND deleted_at IS NULL)::int AS active,
			count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS trash, count(*) FILTER (WHERE upload_status = 'uploading')::int AS pending FROM encrypted_files`),
		sql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
			AND ((table_name = 'encrypted_files' AND column_name IN ('version_number', 'content_updated_at', 'replaces_file_id', 'base_version', 'thumbnail_iv', 'thumbnail_sha256', 'thumbnail_size_bytes'))
			OR (table_name = 'share_links' AND column_name IN ('version_id', 'download_grant_until')))
			ORDER BY table_name, column_name`)
	]);
	console.log(JSON.stringify({ files: counts[0], featureColumnsPresent: columns, fileVersionsTableExists: (await sql("SELECT to_regclass('public.file_versions') IS NOT NULL AS present"))[0].present }, null, 2));
} catch { console.error('Could not inspect the database connection.'); process.exitCode = 1; }
