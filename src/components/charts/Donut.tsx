export interface DonutSlice {
  label: string
  value: number
  color: string
}

export function Donut({ slices, centerLabel, centerValue }: { slices: DonutSlice[]; centerLabel: string; centerValue: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  const r = 52
  const c = 2 * Math.PI * r
  const offsets = slices.map((_, i) => slices.slice(0, i).reduce((sum, x) => sum + (x.value / total) * c, 0))
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div className="relative size-36 shrink-0">
        <svg viewBox="0 0 140 140" className="size-full -rotate-90" role="img" aria-label={centerLabel}>
          <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(138,166,232,0.08)" strokeWidth="14" />
          {slices.map((s, i) => (
            <circle
              key={s.label}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max((s.value / total) * c - 3, 0)} ${c}`}
              strokeDashoffset={-offsets[i]}
              strokeLinecap="round"
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="display num text-xl font-semibold text-fg">{centerValue}</span>
          <span className="text-[11px] text-faint">{centerLabel}</span>
        </div>
      </div>
      <ul className="w-full space-y-2.5 text-sm">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-dim">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="num font-medium text-fg">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
