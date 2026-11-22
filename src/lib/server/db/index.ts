import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { env } from '$env/dynamic/private';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as schema from './schema';

if (!env.DATABASE_URL) {
	throw new Error('DATABASE_URL is not set. Add it in Vercel project env vars or .env');
}

const sql = neon(env.DATABASE_URL);

export const db = drizzle(sql, { schema });

/** Neon HTTP supports atomic batches, rather than interactive transactions. */
export async function runTransaction(statements: SQL[]): Promise<Record<string, unknown>[][]> {
	const dialect = new PgDialect();
	return sql.transaction(statements.map((statement) => {
		const query = dialect.sqlToQuery(statement);
		return sql(query.sql, query.params);
	}));
}
export * from './schema';
