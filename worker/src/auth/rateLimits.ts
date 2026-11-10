import { tooManyRequests } from '../errors'
/** One atomic upsert: no isolate-memory counters and no read/check/write race. */
export async function consumeRateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<void> {
  const now = new Date().toISOString(), reset = new Date(Date.now() + windowMs).toISOString()
  const row = await db.prepare(`INSERT INTO rate_limits (key,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count,reset_at`).bind(key,reset,now,now).first<{count:number;reset_at:string}>()
  if (!row || row.count > limit) throw tooManyRequests(row ? (Date.parse(row.reset_at)-Date.now()) / 1000 : windowMs / 1000)
}
