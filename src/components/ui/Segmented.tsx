import { cn } from '@/lib/cn'

interface SegmentedProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
}

export function Segmented<T extends string>({ value, onChange, options, label }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl border border-line bg-midnight/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 rounded-[10px] px-3 text-xs font-medium transition-colors',
            o.value === value ? 'bg-raised text-fg shadow-sm' : 'text-faint hover:text-dim',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
