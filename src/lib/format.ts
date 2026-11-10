const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usdWhole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Exact decimal-string USDC display; numeric inputs are retained for legacy visualizations only. */
export function fmtUsdc(value: string | number, opts: { whole?: boolean; compact?: boolean } = {}): string {
  if (typeof value === 'string') {
    const match = /^(-?)(\d{1,78})(?:\.(\d{1,6}))?$/.exec(value)
    if (match) {
      const raw = BigInt(match[2]) * 1_000_000n + BigInt((match[3] ?? '').padEnd(6, '0') || '0')
      if (opts.compact) {
        const suffixes = ['', 'K', 'M', 'B', 'T']
        let index = 0
        let divisor = 1_000_000n
        while (raw >= divisor * 1_000n && index < suffixes.length - 1) {
          divisor *= 1_000n
          index++
        }
        let tenths = (raw * 10n + divisor / 2n) / divisor
        if (tenths >= 10_000n && index < suffixes.length - 1) {
          divisor *= 1_000n
          index++
          tenths = (raw * 10n + divisor / 2n) / divisor
        }
        const whole = (tenths / 10n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        const fraction = tenths % 10n === 0n ? '' : `.${tenths % 10n}`
        return `${tenths === 0n ? '' : match[1]}${whole}${fraction}${suffixes[index]}`
      }
      if (opts.whole) {
        const rounded = (raw + 500_000n) / 1_000_000n
        return `${rounded === 0n ? '' : match[1]}${rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
      }
      const whole = BigInt(match[2]).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      const fraction = (match[3] ?? '').replace(/0+$/, '').padEnd(2, '0')
      return `${match[1]}${whole}.${fraction}`
    }
    return '—'
  }
  const n = value
  if (!Number.isFinite(n)) return '—'
  if (opts.compact) return compact.format(n)
  return opts.whole ? usdWhole.format(n) : usd.format(n)
}

export function fmtNumber(n: number): string {
  return usdWhole.format(n)
}

export function fmtPercent(n: number, digits = 1): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
