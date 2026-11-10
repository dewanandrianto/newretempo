import { Component, Suspense, type ReactNode } from 'react'

class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-midnight p-6 text-fg">
          <section role="alert" className="w-full max-w-md rounded-2xl border border-line bg-panel p-6">
            <h1 className="text-xl font-semibold">Unable to load page</h1>
            <p className="mt-3 text-sm text-dim">The page could not be loaded. Check your connection and reload to get the latest version. Reloading does not submit a transaction.</p>
            <div className="mt-6 flex flex-wrap gap-4">
              <button type="button" className="rounded-lg bg-cyan px-4 py-3 font-medium text-midnight" onClick={() => window.location.reload()}>Reload page</button>
              <a className="px-2 py-3 text-cyan underline" href="/">Return home</a>
            </div>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}

export function RouteBoundary({ children }: { children: ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<main className="flex min-h-dvh items-center justify-center bg-midnight p-8 text-fg" role="status" aria-live="polite">Loading page…</main>}>
        {children}
      </Suspense>
    </RouteErrorBoundary>
  )
}
