import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, LogOut, Menu, Settings } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthProvider'
import { blockchain } from '@/services/blockchain'
import { initials } from '@/lib/format'
import { WalletButton } from '@/components/wallet/WalletButton'
import { Badge } from '@/components/ui/Badge'

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const name = session?.user.name ?? 'Merchant'
  const org = session?.organization?.name ?? 'No organization'

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-midnight/80 px-4 backdrop-blur-xl sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        className="flex size-10 items-center justify-center rounded-xl text-dim hover:bg-raised hover:text-fg lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </button>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg">{org}</p>
        <p className="hidden text-xs text-faint sm:block">Merchant workspace</p>
      </div>
      <Badge tone="cyan" className="ml-1 hidden md:inline-flex">
        <span className="size-1.5 rounded-full bg-cyan" />
        {blockchain.network.name}
      </Badge>
      <div className="ml-auto flex items-center gap-2">
        <WalletButton compact />
        <div className="relative" ref={ref}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex h-9 items-center gap-2 rounded-xl border border-line-strong bg-raised pr-2 pl-1 hover:border-electric/50"
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span className="flex size-7 items-center justify-center rounded-lg bg-electric/20 text-xs font-semibold text-electric-soft">
              {initials(name)}
            </span>
            <ChevronDown className="size-4 text-faint" />
          </button>
          {open && (
            <div role="menu" className="absolute right-0 mt-2 w-56 rounded-xl border border-line-strong bg-overlay p-1.5 shadow-card">
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium text-fg">{name}</p>
                <p className="truncate text-xs text-faint">{session?.user.email ?? 'Wallet account'}</p>
              </div>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false)
                  void navigate('/app/settings')
                }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-dim hover:bg-raised hover:text-fg"
              >
                <Settings className="size-4" /> Settings
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  void signOut().then(() => navigate('/'))
                }}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-dim hover:bg-raised hover:text-negative"
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
