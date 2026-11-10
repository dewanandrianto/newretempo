import { useId, useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { formatBaseUnits } from '@shared/money'

export interface SeriesPoint {
  label: string
  value: number
  baseUnits?: string
}

interface AreaChartProps {
  data: SeriesPoint[]
  height?: number
  formatValue?: (v: number) => string
  className?: string
}

const W = 1000
const H = 100

/** Responsive SVG area chart with HTML overlays so dots and labels never distort. */
export function AreaChart({ data, height = 260, formatValue = (v) => String(v), className }: AreaChartProps) {
  const gid = useId()
  const [hover, setHover] = useState<number | null>(null)

  const { line, area, max, points } = useMemo(() => {
    const maxV = Math.max(...data.map((d) => d.value), 1)
    const niceMax = data.some(d => d.baseUnits !== undefined) ? 900 : Math.ceil((maxV * 1.1) / 1000) * 1000 || maxV
    const pts = data.map((d, i) => ({
      x: data.length === 1 ? W / 2 : (i / (data.length - 1)) * W,
      y: H - (d.value / niceMax) * H,
    }))
    const linePath = pts.reduce((acc, p, i) => {
      if (i === 0) return `M${p.x},${p.y}`
      const prev = pts[i - 1]
      const cx = (prev.x + p.x) / 2
      return `${acc} C${cx},${prev.y} ${cx},${p.y} ${p.x},${p.y}`
    }, '')
    return { line: linePath, area: `${linePath} L${W},${H} L0,${H} Z`, max: niceMax, points: pts }
  }, [data])

  const ticks = [1, 0.75, 0.5, 0.25, 0]
  const active = hover !== null ? points[hover] : null
  const activeDatum = hover !== null ? data[hover] : null

  return (
    <div className={cn('flex gap-3', className)} style={{ height }}>
      <div className="flex w-12 shrink-0 flex-col justify-between pb-6 text-right text-[11px] text-faint num">
        {ticks.map((t) => (
          <span key={t}>{data.some(d => d.baseUnits !== undefined) ? `${Math.round(t * 100)}%` : t === 0 ? '0' : formatValue(max * t)}</span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="relative min-h-0 flex-1"
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
            setHover(Math.round(frac * (data.length - 1)))
          }}
        >
          {ticks.map((t) => (
            <div key={t} className="absolute right-0 left-0 border-t border-dashed border-line" style={{ top: `${(1 - t) * 100}%` }} />
          ))}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" role="img" aria-label="Revenue over time, relative scale; exact USDC amounts on hover">
            <defs>
              <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`${gid}-stroke`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#3B82F6" />
                <stop offset="100%" stopColor="#22D3EE" />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${gid}-fill)`} />
            <path d={line} fill="none" stroke={`url(#${gid}-stroke)`} strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          </svg>
          {active && activeDatum && (
            <>
              <div className="absolute top-0 bottom-0 w-px bg-cyan/40" style={{ left: `${(active.x / W) * 100}%` }} />
              <div
                className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan bg-midnight"
                style={{ left: `${(active.x / W) * 100}%`, top: `${(active.y / H) * 100}%` }}
              />
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-overlay px-3 py-2 text-xs shadow-card"
                style={{
                  left: `${Math.min(88, Math.max(12, (active.x / W) * 100))}%`,
                  top: `${Math.max(0, (active.y / H) * 100 - 26)}%`,
                }}
              >
                <div className="text-faint">{activeDatum.label}</div>
                <div className="display num mt-0.5 text-sm font-semibold text-fg">{activeDatum.baseUnits === undefined ? formatValue(activeDatum.value) : formatBaseUnits(activeDatum.baseUnits)} USDC</div>
              </div>
            </>
          )}
        </div>
        <div className="relative mt-2 h-4 text-[11px] text-faint">
          {data.map((d, i) => {
            const step = Math.max(1, Math.ceil(data.length / 6))
            const middle = Math.round((data.length - 1) / 2 / step) * step
            const primary = i === 0 || i === middle || i === data.length - 1
            if (!primary && (i % step !== 0 || i > data.length - 1 - step)) return null
            return <span key={d.label} className={cn('absolute whitespace-nowrap', !primary && 'hidden sm:block')} style={{ left: `${data.length <= 1 ? 0 : i / (data.length - 1) * 100}%`, transform: i === 0 ? undefined : i === data.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{d.label}</span>
          })}
        </div>
      </div>
    </div>
  )
}
