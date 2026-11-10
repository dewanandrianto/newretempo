import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtPercent } from '@/lib/format'
import { Card } from './Card'
import { Skeleton } from './States'

interface StatCardProps {
  label: string
  value: string
  unit?: string
  delta?: number
  caption?: string
  icon?: ReactNode
  visual?: ReactNode
}

export function StatCard({ label, value, unit, delta, caption, icon, visual }: StatCardProps) {
  const up = (delta ?? 0) >= 0
  return (
    <Card className="relative overflow-hidden p-5">
      <div className="flex items-center justify-between text-dim">
        <span className="text-sm">{label}</span>
        {icon && <span className="text-faint">{icon}</span>}
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="display num text-3xl font-semibold text-fg">{value}</span>
        {unit && <span className="text-sm font-medium text-faint">{unit}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {delta !== undefined && (
          <span className={cn('inline-flex items-center gap-0.5 font-medium num', up ? 'text-positive' : 'text-negative')}>
            {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
            {fmtPercent(delta)}
          </span>
        )}
        {caption && <span className="text-faint">{caption}</span>}
      </div>
      {visual && <div className="pointer-events-none absolute right-4 bottom-4 opacity-80">{visual}</div>}
    </Card>
  )
}

export function StatCardSkeleton() {
  return <Skeleton className="h-32" />
}
