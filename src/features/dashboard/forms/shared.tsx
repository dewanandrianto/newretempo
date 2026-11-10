import type { ReactNode } from 'react'
import { MoneyError, parseUsdc } from '@shared/money'
import { Button } from '@/components/ui/Button'

/** Converts a human USDC amount ("49.50") to a base-unit string using BigInt only. */
export function toBaseUnits(input: string): { value?: string; error?: string } {
  try {
    const n = parseUsdc(input)
    if (n <= 0n) return { error: 'Enter an amount greater than zero.' }
    return { value: n.toString() }
  } catch (err) {
    return { error: err instanceof MoneyError ? err.message : 'Enter a valid amount.' }
  }
}

interface FormFooterProps {
  label: string
  busy: boolean
  error?: string
  onCancel: () => void
  disabled?: boolean
  note?: ReactNode
}

export function FormFooter({ label, busy, error, onCancel, disabled, note }: FormFooterProps) {
  return (
    <div className="space-y-3 pt-2">
      {note && <p className="text-xs text-faint">{note}</p>}
      {error && (
        <p role="alert" className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={disabled}>
          {label}
        </Button>
      </div>
    </div>
  )
}
