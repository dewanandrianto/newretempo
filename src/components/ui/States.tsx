import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-raised', className)} aria-hidden>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />
    </div>
  )
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-80" />
    </div>
  )
}

interface EmptyStateProps {
  title: string
  description: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-line-strong bg-raised text-cyan">
        {icon ?? <Inbox className="size-5" />}
      </div>
      <h3 className="display text-lg font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-dim">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

interface ErrorStateProps {
  title?: string
  message?: string
  onRetry?: () => void
  className?: string
}

export function ErrorState({
  title = 'Something went wrong',
  message = 'We could not load this data. Check your connection and try again.',
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div role="alert" className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-negative/30 bg-negative/10 text-negative">
        <AlertTriangle className="size-5" />
      </div>
      <h3 className="display text-lg font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-dim">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry} icon={<RefreshCw className="size-4" />}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Inline notice used for phase boundaries and honest "not available yet" messaging. */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'caution'
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 text-sm',
        tone === 'info' ? 'border-electric/30 bg-electric/[0.07]' : 'border-caution/30 bg-caution/[0.07]',
        className,
      )}
    >
      <p className={cn('font-medium', tone === 'info' ? 'text-electric-soft' : 'text-caution')}>{title}</p>
      <div className="mt-0.5 text-dim">{children}</div>
    </div>
  )
}
