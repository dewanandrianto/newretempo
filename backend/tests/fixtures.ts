import { randomUUID } from 'node:crypto'
import { registerClient, type TestClient, type TestEnv } from './helpers'

export interface Merchant {
  client: TestClient
  userId: string
  email: string
  orgId: string
}

type Id = { id: string }

let slugCounter = 0

export async function createMerchant(env: TestEnv, label = 'Merchant'): Promise<Merchant> {
  const { client, userId, email } = await registerClient(env, label)
  slugCounter += 1
  const res = await client.post<Id>('/api/orgs', {
    name: `${label} Inc`,
    slug: `${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${slugCounter}-${Date.now().toString(36)}`,
    industry: 'Software / SaaS',
    country: 'US',
  })
  if (res.status !== 201) throw new Error(`org create failed: ${res.status} ${JSON.stringify(res.body)}`)
  return { client, userId, email, orgId: res.body.id }
}

export interface Dataset {
  productId: string
  planId: string
  customerId: string
  subscriptionId: string
  invoiceId: string
}

const idem = () => ({ 'Idempotency-Key': `test-${randomUUID()}` })

/** One of everything, owned by `m`. The invoice is finalized (open). */
export async function seedDataset(m: Merchant, opts: { amount?: string; tag?: string } = {}): Promise<Dataset> {
  const base = `/api/orgs/${m.orgId}`
  const tag = opts.tag ?? randomUUID().slice(0, 6)
  const product = await m.client.post<Id>(`${base}/products`, { name: `Product ${tag}`, description: 'seed' })
  const plan = await m.client.post<Id>(`${base}/plans`, { productId: product.body.id, name: `Plan ${tag}`, amount: opts.amount ?? '99000000', interval: 'month', trialDays: 7, escrowDays: 7 })
  const customer = await m.client.post<Id>(`${base}/customers`, { name: `Customer ${tag}`, email: `cust-${tag}@example.test`, company: 'Acme' })
  const subscription = await m.client.post<Id>(`${base}/subscriptions`, { customerId: customer.body.id, planId: plan.body.id })
  const invoice = await m.client.post<Id>(
    `${base}/invoices`,
    { customerId: customer.body.id, lineItems: [{ description: 'Seed', quantity: 1, unitAmount: opts.amount ?? '99000000' }], dueAt: new Date(Date.now() + 14 * 86_400_000).toISOString() },
    idem(),
  )
  const finalized = await m.client.post(`${base}/invoices/${invoice.body.id}/finalize`)
  if (finalized.status !== 200) throw new Error(`finalize failed ${finalized.status}`)
  for (const [name, r] of Object.entries({ product, plan, customer, subscription, invoice })) {
    if (r.status !== 201) throw new Error(`seed ${name} failed: ${r.status} ${JSON.stringify(r.body)}`)
  }
  return { productId: product.body.id, planId: plan.body.id, customerId: customer.body.id, subscriptionId: subscription.body.id, invoiceId: invoice.body.id }
}

export const idempotencyHeader = idem
