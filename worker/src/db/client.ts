import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/** Real D1-backed ORM. All money columns deliberately remain strings. */
export function createOrm(db: D1Database) {
  return drizzle(db, { schema });
}
