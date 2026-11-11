import { useEffect } from 'react'
import { BrowserRouter, useLocation } from 'react-router-dom'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { PrivyRuntime } from '@/features/auth/PrivyRuntime'
import { AppRoutes } from '@/app/router'

/** Reset scroll on route changes, except for in-page anchors on the landing page. */
function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0)
  }, [pathname, hash])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <PrivyRuntime>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </PrivyRuntime>
    </BrowserRouter>
  )
}
