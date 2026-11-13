import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const db = () => (env as unknown as { DB: D1Database }).DB;
const run = (sql: string, ...args: unknown[]) => db().prepare(sql).bind(...args).run();
async function fixture() {
  const user=crypto.randomUUID(), org=crypto.randomUUID(), customer=crypto.randomUUID(), product=crypto.randomUUID(), plan=crypto.randomUUID(), invoice=crypto.randomUUID();
  await run('INSERT INTO users(id) VALUES (?)',user);
  await run("INSERT INTO organizations(id,name,slug,industry,country,created_by) VALUES (?,'Test',?,'software','ID',?)",org,'org-'+org,user);
  await run("INSERT INTO memberships(id,org_id,user_id,role) VALUES (?,?,?,'owner')",crypto.randomUUID(),org,user);
  await run("INSERT INTO customers(id,org_id,name,email) VALUES (?,?,'Customer','customer@example.test')",customer,org);
  await run("INSERT INTO products(id,org_id,name) VALUES (?,?,'Product')",product,org);
  await run("INSERT INTO plans(id,org_id,product_id,name,amount,\"interval\") VALUES (?,?,?,'Plan','9223372036854775807','month')",plan,org,product);
  await run("INSERT INTO invoices(id,org_id,customer_id,number,total_amount,line_items,due_at,idempotency_key,request_hash) VALUES (?,?,?,'INV-1','9223372036854775807','[]','2026-11-09T00:00:00.000Z','invoice-key','hash')",invoice,org,customer);
  return {user,org,customer,product,plan,invoice};
}
describe('D1 schema', () => {
  it('contains the complete legacy schema plus database-backed rate limits', async () => {
    const { results } = await db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
    expect(results.map(r => r.name)).toEqual(expect.arrayContaining(['users','sessions','email_tokens','siwe_nonces','merchant_wallet_challenges','organizations','memberships','products','plans','customers','wallets','subscriptions','mandates','invoices','payments','escrows','transactions','disputes','api_keys','webhooks','webhook_deliveries','audit_logs','rate_limits']));
  });
  it('uses a real Drizzle D1 connection with exact text money', async()=>{
    const { createOrm } = await import('../src/db/client');
    const { plans } = await import('../src/db/schema');
    const f=await fixture();
    const rows=await createOrm(db()).select({ id: plans.id, amount: plans.amount }).from(plans);
    expect(rows.find(row=>row.id===f.plan)?.amount).toBe('9223372036854775807');
  });
  it('rejects noncanonical timestamp representations',async()=>{
    const f=await fixture();
    for(const date of ['2026-11-08','2026-11-08T00:00:00Z','2026-11-08T07:00:00.000+07:00','not-a-date']) {
      await expect(run('UPDATE users SET last_login_at=? WHERE id=?',date,f.user)).rejects.toThrow();
    }
  });
  it('preserves exact money beyond JS safe integers and rejects noncanonical money', async()=>{
    const f=await fixture();
    expect((await db().prepare('SELECT amount FROM plans WHERE id=?').bind(f.plan).first<{amount:string}>())?.amount).toBe('9223372036854775807');
    for(const amount of ['01','1.0','1e6','-1','0','9223372036854775808','9007199254740993.5',' 1','1 ']) {
      await expect(run('UPDATE plans SET amount=? WHERE id=?',amount,f.plan)).rejects.toThrow();
    }
  });
  it('blocks cross-tenant foreign keys and case-insensitive duplicate products',async()=>{
    const a=await fixture(),b=await fixture();
    await expect(run('UPDATE plans SET product_id=? WHERE id=?',b.product,a.plan)).rejects.toThrow();
    await expect(run("INSERT INTO products(id,org_id,name) VALUES (?,?,'PRODUCT')",crypto.randomUUID(),a.org)).rejects.toThrow();
  });
  it('keeps the final owner on deletion, demotion, and tenant movement',async()=>{
    const a=await fixture(),b=await fixture();
    await expect(run('DELETE FROM memberships WHERE org_id=?',a.org)).rejects.toThrow();
    await expect(run("UPDATE memberships SET role='admin' WHERE org_id=?",a.org)).rejects.toThrow();
    await expect(run('UPDATE memberships SET org_id=? WHERE org_id=?',b.org,a.org)).rejects.toThrow();
  });
  it('makes audit history append-only including REPLACE',async()=>{
    const id=crypto.randomUUID();
    await run("INSERT INTO audit_logs(id,actor_type,action,resource_type) VALUES (?,'system','test','test')",id);
    await expect(run("UPDATE audit_logs SET action='changed' WHERE id=?",id)).rejects.toThrow();
    await expect(run('DELETE FROM audit_logs WHERE id=?',id)).rejects.toThrow();
    await expect(run("INSERT OR REPLACE INTO audit_logs(id,actor_type,action,resource_type) VALUES (?,'system','changed','test')",id)).rejects.toThrow();
  });
  it('fails closed on all financial authoritative fields',async()=>{
    const f=await fixture(),payment=crypto.randomUUID(),escrow=crypto.randomUUID();
    await run("INSERT INTO payments(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) VALUES (?,?,?,?,'1',5042002,'payment-key','hash')",payment,f.org,f.invoice,f.customer);
    await run("INSERT INTO escrows(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) VALUES (?,?,?,?,'1',5042002,'escrow-key','hash')",escrow,f.org,f.invoice,f.customer);
    for(const sql of ["UPDATE payments SET status='succeeded'", "UPDATE payments SET tx_hash='0x"+'a'.repeat(64)+"'", "UPDATE payments SET chain_id=1", "UPDATE escrows SET status='funded'", "UPDATE escrows SET onchain_escrow_id='1'", "UPDATE escrows SET chain_id=1", "UPDATE invoices SET amount_paid='1'", "UPDATE invoices SET status='paid'", 'DELETE FROM payments']) {
      await expect(run(sql)).rejects.toThrow();
    }
    await expect(run("INSERT INTO transactions(id,org_id,kind,direction,amount,chain_id,tx_hash,log_index,block_number,occurred_at) VALUES (?,?,'payment','in','1',5042002,?,0,1,'2026-11-08T00:00:00.000Z')",crypto.randomUUID(),f.org,'0x'+'a'.repeat(64))).rejects.toThrow();
    await run("UPDATE payments SET status='canceled' WHERE id=?",payment);
    await run('UPDATE escrows SET release_after_days=3 WHERE id=?',escrow);
  });
  it('enforces one live payment and escrow per invoice and immutable idempotency',async()=>{
    const f=await fixture();
    for(const table of ['payments','escrows']) {
      const insert=`INSERT INTO ${table}(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) VALUES (?,?,?,?,'1',5042002,?,'hash')`;
      const id=crypto.randomUUID();
      await run(insert,id,f.org,f.invoice,f.customer,'unique-key');
      await expect(run(insert,crypto.randomUUID(),f.org,f.invoice,f.customer,'other-key')).rejects.toThrow();
      await expect(run(`UPDATE ${table} SET idempotency_key='changed-key' WHERE id=?`,id)).rejects.toThrow();
    }
    await expect(run("UPDATE invoices SET idempotency_key='changed-key' WHERE id=?",f.invoice)).rejects.toThrow();
  });
  it('protects financial insert, replace, and accounting paths without a capability switch',async()=>{
    const f=await fixture(),pay=crypto.randomUUID();
    const base=[pay,f.org,f.invoice,f.customer];
    const insert="INSERT INTO payments(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash) VALUES (?,?,?,?,'1',5042002,'payment-key','hash')";
    await run(insert,...base);
    await expect(run(insert.replace('INSERT INTO','INSERT OR REPLACE INTO'),crypto.randomUUID(),f.org,f.invoice,f.customer)).rejects.toThrow();
    await expect(run(insert.replace("'payment-key'","'second-key'").replace('INSERT INTO','INSERT OR REPLACE INTO'),crypto.randomUUID(),f.org,f.invoice,f.customer)).rejects.toThrow();
    await expect(run("UPDATE invoices SET status='open',total_amount='10' WHERE id=?",f.invoice)).resolves.toBeDefined();
    await expect(run("UPDATE invoices SET total_amount='11' WHERE id=?",f.invoice)).rejects.toThrow();
    await expect(run("UPDATE invoices SET amount_paid='11' WHERE id=?",f.invoice)).rejects.toThrow();
    await expect(run('DELETE FROM invoices WHERE id=?',f.invoice)).rejects.toThrow();
    await expect(run('UPDATE payments SET org_id=? WHERE id=?',crypto.randomUUID(),pay)).rejects.toThrow();
    const tables=await db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>();
    expect(tables.results.map(r=>r.name).filter(n=>/authorit|capabil|verified_event/.test(n))).toEqual([]);
  });
  it('rejects authoritative creation of subscriptions, mandates, invoices, payments, and escrows',async()=>{
    const f=await fixture(),sub=crypto.randomUUID();
    await expect(run("INSERT INTO subscriptions(id,org_id,customer_id,plan_id,amount,\"interval\",status) VALUES (?,?,?,?,'1','month','active')",sub,f.org,f.customer,f.plan)).rejects.toThrow();
    await run("INSERT INTO subscriptions(id,org_id,customer_id,plan_id,amount,\"interval\") VALUES (?,?,?,?,'1','month')",sub,f.org,f.customer,f.plan);
    const address='0x'+'a'.repeat(40);
    await expect(run("INSERT INTO mandates(id,org_id,subscription_id,customer_id,payer_address,chain_id,token_address,max_amount_per_period,period_seconds,status) VALUES (?,?,?,?,?,5042002,?,'1',86400,'active')",crypto.randomUUID(),f.org,sub,f.customer,address,address)).rejects.toThrow();
    await expect(run("INSERT INTO escrows(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash,status) VALUES (?,?,?,?,'1',5042002,'escrow-key','hash','funded')",crypto.randomUUID(),f.org,f.invoice,f.customer)).rejects.toThrow();
    await expect(run("INSERT INTO payments(id,org_id,invoice_id,customer_id,amount,chain_id,idempotency_key,request_hash,payer_address) VALUES (?,?,?,?,'1',5042002,'payment-key','hash',?)",crypto.randomUUID(),f.org,f.invoice,f.customer,address)).rejects.toThrow();
    await expect(run("INSERT INTO invoices(id,org_id,customer_id,number,total_amount,amount_paid,line_items,due_at,idempotency_key,request_hash,status) VALUES (?,?,?,'INV-2','1','1','[]','2026-11-09T00:00:00.000Z','invoice-two','hash','paid')",crypto.randomUUID(),f.org,f.customer)).rejects.toThrow();
  });
  it('requires a unique invoice for each subscription billing period',async()=>{
    const f=await fixture(), sub=crypto.randomUUID();
    await run("INSERT INTO subscriptions(id,org_id,customer_id,plan_id,amount,\"interval\") VALUES (?,?,?,?,'1','month')",sub,f.org,f.customer,f.plan);
    await run("UPDATE invoices SET subscription_id=?,period_start='2026-11-08T00:00:00.000Z' WHERE id=?",sub,f.invoice);
    await expect(run("INSERT INTO invoices(id,org_id,customer_id,subscription_id,number,total_amount,line_items,due_at,period_start,idempotency_key,request_hash) VALUES (?,?,?,?,'INV-2','1','[]','2026-11-09T00:00:00.000Z','2026-11-08T00:00:00.000Z','invoice-two','hash')",crypto.randomUUID(),f.org,f.customer,sub)).rejects.toThrow();
    await expect(run("UPDATE subscriptions SET status='active' WHERE id=?",sub)).rejects.toThrow();
  });
});
