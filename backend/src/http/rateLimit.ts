import { tooManyRequests } from './errors'

interface Bucket {
  hits: number[]
}

/**
 * Sliding-window limiter held in process memory.
 * Good for a single API instance; a multi-instance deployment needs a shared store.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Throws a 429 HttpError once `limit` hits occurred inside `windowMs`. */
  consume(key: string, limit: number, windowMs: number): void {
    const t = this.now()
    const bucket = this.buckets.get(key) ?? { hits: [] }
    bucket.hits = bucket.hits.filter((h) => t - h < windowMs)
    if (bucket.hits.length >= limit) {
      this.buckets.set(key, bucket)
      throw tooManyRequests((bucket.hits[0] + windowMs - t) / 1000)
    }
    bucket.hits.push(t)
    this.buckets.set(key, bucket)
    if (this.buckets.size > 10_000) this.prune(windowMs)
  }

  private prune(windowMs: number) {
    const t = this.now()
    for (const [k, b] of this.buckets) {
      if (b.hits.every((h) => t - h >= windowMs)) this.buckets.delete(k)
    }
  }
}
