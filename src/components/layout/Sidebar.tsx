import { NavLink } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Logo } from '@/components/ui/Logo'
import { dashboardNav } from './nav'

const customerPreviews = [
  { to: '/portal', label: 'Subscription portal' },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Logo to="/app" />
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="Dashboard">
        {dashboardNav.map((group) => (
          <div key={group.label}>
            <p className="px-3 pb-2 text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">{group.label}</p>
            <ul className="space-y-0.5">
              {group.items.map(({ to, label, icon: Icon, end }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    end={end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors',
                        isActive ? 'bg-raised text-fg' : 'text-dim hover:bg-raised/60 hover:text-fg',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-cyan" />}
                        <Icon className={cn('size-[18px]', isActive ? 'text-cyan' : 'text-faint group-hover:text-dim')} />
                        {label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="m-3 rounded-xl border border-line bg-midnight/50 p-3">
        <p className="px-1 pb-2 text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">Customer pages</p>
        {customerPreviews.map((l) => (
          <a
            key={l.to}
            href={l.to}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 items-center justify-between rounded-lg px-1 text-sm text-dim transition-colors hover:text-fg"
          >
            {l.label}
            <ExternalLink className="size-3.5 text-faint" />
          </a>
        ))}
      </div>
    </div>
  )
}
