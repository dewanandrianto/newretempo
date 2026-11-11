import { useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import { LinkButton } from '@/components/ui/Button'

const links = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#developers', label: 'Developers' },
]

function Header() {
  const [open, setOpen] = useState(false)
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line bg-midnight/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="rounded-lg px-3 py-2 text-sm text-dim transition-colors hover:text-fg">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <LinkButton to="/login" variant="ghost" size="sm">
            Log in
          </LinkButton>
          <LinkButton to="/signup" size="sm">
            Get Started
          </LinkButton>
        </div>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-xl text-dim hover:bg-raised hover:text-fg md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-line bg-panel px-5 py-4 md:hidden">
          <nav className="flex flex-col" aria-label="Mobile">
            {links.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="flex h-11 items-center text-dim hover:text-fg">
                {l.label}
              </a>
            ))}
          </nav>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <LinkButton to="/login" variant="secondary">
              Log in
            </LinkButton>
            <LinkButton to="/signup">Get Started</LinkButton>
          </div>
        </div>
      )}
    </header>
  )
}

const footerColumns = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'How it works', href: '#how-it-works' },
      { label: 'Security & escrow', href: '#security' },
      { label: 'Developers', href: '#developers' },
    ],
  },
  {
    title: 'Get started',
    links: [
      { label: 'Create account', to: '/signup' },
      { label: 'Log in', to: '/login' },
      { label: 'Customer portal', to: '/portal' },
    ],
  },
]

type FooterLink = { label: string; href?: string; to?: string; external?: boolean }

function Footer() {
  return (
    <footer className="border-t border-line bg-panel/60">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(2,1fr)]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm text-dim">Subscription billing infrastructure for SaaS, with clear pricing and customer payment flows.</p>
            <p className="mono mt-4 text-xs text-faint">retempo.xyz</p>
          </div>
          {footerColumns.map((col) => (
            <div key={col.title}>
              <p className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">{col.title}</p>
              <ul className="mt-4 space-y-3 text-sm">
                {(col.links as FooterLink[]).map((l) => (
                  <li key={l.label}>
                    {l.to ? (
                      <Link to={l.to} className="text-dim transition-colors hover:text-fg">
                        {l.label}
                      </Link>
                    ) : (
                      <a
                        href={l.href}
                        className="text-dim transition-colors hover:text-fg"
                        {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      >
                        {l.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-col gap-2 border-t border-line pt-6 text-xs text-faint sm:flex-row sm:justify-between">
          <p>&copy; 2026 RETEMPO. Preview environment. Payment and settlement features are currently unavailable.</p>
        </div>
      </div>
    </footer>
  )
}

export function PublicLayout() {
  return (
    <div className="min-h-dvh bg-midnight">
      <Header />
      <main className="pt-16">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
