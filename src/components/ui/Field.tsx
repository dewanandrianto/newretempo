import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

interface FieldShellProps {
  label: string
  hint?: string
  error?: string
  htmlFor: string
  children: ReactNode
}

function FieldShell({ label, hint, error, htmlFor, children }: FieldShellProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-negative">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-faint">{hint}</p>
      )}
    </div>
  )
}

const control =
  'h-11 w-full rounded-xl border bg-midnight/60 px-3.5 text-sm text-fg placeholder:text-faint transition-colors focus:outline-none focus:border-cyan/60 focus:ring-2 focus:ring-cyan/20 disabled:opacity-50'

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
  error?: string
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const auto = useId()
  const inputId = id ?? auto
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        className={cn(control, error ? 'border-negative/60' : 'border-line-strong', className)}
        {...rest}
      />
    </FieldShell>
  )
})

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  hint?: string
  error?: string
  options: { value: string; label: string }[]
}

export function SelectField({ label, hint, error, options, className, id, ...rest }: SelectFieldProps) {
  const auto = useId()
  const selectId = id ?? auto
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={selectId}>
      <select
        id={selectId}
        className={cn(control, 'appearance-none', error ? 'border-negative/60' : 'border-line-strong', className)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-panel">
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}
