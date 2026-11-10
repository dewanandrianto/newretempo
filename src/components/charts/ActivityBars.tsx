import { cn } from '@/lib/cn'

export interface ActivityDatum {
  label: string
  gained: number
  lost: number
}

/** Paired bars: new subscriptions above the baseline, cancellations below. */
export function ActivityBars({ data, height = 200, className }: { data: ActivityDatum[]; height?: number; className?: string }) {
  const max = Math.max(...data.flatMap((d) => [d.gained, d.lost]), 1)
  const half = height / 2 - 12
  return (
    <div className={cn('w-full', className)}>
      <div className="relative flex items-center gap-2" style={{ height }}>
        <div className="absolute right-0 left-0 top-1/2 border-t border-line" />
        {data.map((d) => (
          <div key={d.label} className="group relative flex h-full flex-1 flex-col items-center justify-center" title={`${d.label}: +${d.gained} / -${d.lost}`}>
            <div className="flex w-full max-w-[22px] flex-col justify-end" style={{ height: half }}>
              <div className="w-full rounded-t-md bg-gradient-to-t from-electric to-cyan transition-opacity group-hover:opacity-100 opacity-90" style={{ height: (d.gained / max) * half }} />
            </div>
            <div className="flex w-full max-w-[22px] flex-col" style={{ height: half }}>
              <div className="w-full rounded-b-md bg-negative/60" style={{ height: (d.lost / max) * half }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2 text-[11px] text-faint">
        {data.map((d) => (
          <span key={d.label} className="flex-1 text-center">
            {d.label}
          </span>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-4 text-xs text-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-cyan" /> New subscriptions
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-negative/70" /> Cancellations
        </span>
      </div>
    </div>
  )
}
