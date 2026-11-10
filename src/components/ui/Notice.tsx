import { FlaskConical } from 'lucide-react'

/** Shown on every dashboard page that renders sample data. */
export function DemoNotice() {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-caution/25 bg-caution/[0.06] px-4 py-3 text-sm">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-caution" />
      <p className="text-dim">
        <span className="font-medium text-caution">Demo data.</span> Figures on this page are fictional samples that preview the
        interface. They are not read from Arc and are not verified onchain transactions.
      </p>
    </div>
  )
}
