import { Outlet, Link } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import { WalletButton } from '@/components/wallet/WalletButton'
export function CustomerLayout() {
 return <div className="relative min-h-dvh bg-midnight">
  <header className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6"><Logo /><div className="flex items-center gap-4"><Link to="/portal" className="text-sm text-dim hover:text-fg">Your portal</Link><WalletButton compact /></div></header>
  <main className="mx-auto max-w-5xl px-4 py-8 pb-20 sm:px-6"><Outlet /></main>
  <footer className="px-4 pb-10 text-center text-xs text-faint"><span className="inline-flex items-center gap-1.5"><Lock className="size-3" /> Payments by RETEMPO. We never ask for your private key.</span></footer>
 </div>
}
