import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { titleCase } from '@/lib/format'

type Tone = 'neutral' | 'positive' | 'negative' | 'caution' | 'info' | 'cyan'

const tones: Record<Tone, string> = {
  neutral: 'bg-white/5 text-dim border-line',
  positive: 'bg-positive/10 text-positive border-positive/25',
  negative: 'bg-negative/10 text-negative border-negative/25',
  caution: 'bg-caution/10 text-caution border-caution/25',
  info: 'bg-electric/10 text-electric-soft border-electric/30',
  cyan: 'bg-cyan/10 text-cyan border-cyan/25',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

const statusTone: Record<string, Tone> = {
  active: 'positive',
  paid: 'positive',
  succeeded: 'positive',
  resolved: 'positive',
  released: 'positive',
  trialing: 'info',
  open: 'info',
  pending: 'caution',
  past_due: 'caution',
  held: 'cyan',
  funded: 'cyan',
  settled: 'positive',
  pending_funding: 'caution',
  incomplete: 'caution',
  processing: 'info',
  uncollectible: 'negative',
  under_review: 'caution',
  needs_response: 'negative',
  failed: 'negative',
  canceled: 'neutral',
  draft: 'neutral',
  void: 'neutral',
  refunded: 'neutral',
  paused: 'neutral',
  archived: 'neutral',
}

export function StatusBadge({ status }: { status: string }) {
  const tone = statusTone[status] ?? 'neutral'
  return (
    <Badge tone={tone}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {titleCase(status)}
    </Badge>
  )
}
