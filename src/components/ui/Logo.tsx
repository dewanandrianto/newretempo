import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#0F1A33" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" stroke="rgba(138,166,232,0.28)" />
      <path d="M22 11a8 8 0 1 0 1.6 7" stroke="#22D3EE" strokeWidth="3" strokeLinecap="round" />
      <circle cx="22.5" cy="10.5" r="2.4" fill="#3B82F6" />
    </svg>
  )
}

export function Logo({ to = '/', className, showWordmark = true }: { to?: string; className?: string; showWordmark?: boolean }) {
  return (
    <Link to={to} className={cn('inline-flex items-center gap-2.5', className)} aria-label="RETEMPO home">
      <LogoMark />
      {showWordmark && <span className="display text-lg font-bold tracking-[0.14em] text-fg">RETEMPO</span>}
    </Link>
  )
}
