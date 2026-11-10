import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useAuth } from '@/features/auth/AuthProvider'
import { Skeleton } from '@/components/ui/States'
import { VerifyEmailBanner } from '@/features/auth/VerifyEmailBanner'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

export function DashboardLayout() {
  const { session, status } = useAuth()
  const location = useLocation()
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    if (!drawer) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false)
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [drawer])

  if (status === 'loading') {
    return (
      <div className="min-h-dvh bg-midnight p-6" role="status" aria-label="Loading">
        <Skeleton className="mx-auto mt-16 h-96 max-w-5xl" />
      </div>
    )
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (!session.organization) return <Navigate to="/onboarding" replace />

  return (
    <div className="min-h-dvh bg-midnight">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-line bg-panel/70 lg:block">
        <Sidebar />
      </aside>

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setDrawer(false)}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 w-72 border-r border-line bg-panel lg:hidden"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            >
              <button
                type="button"
                onClick={() => setDrawer(false)}
                className="absolute top-3 right-3 flex size-10 items-center justify-center rounded-xl text-dim hover:bg-raised hover:text-fg"
                aria-label="Close navigation"
              >
                <X className="size-5" />
              </button>
              <Sidebar onNavigate={() => setDrawer(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="lg:pl-64">
        <Topbar onMenu={() => setDrawer(true)} />
        <main className="mx-auto w-full max-w-[1280px] px-4 py-6 pb-20 sm:px-6 sm:py-8">
          <VerifyEmailBanner />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
