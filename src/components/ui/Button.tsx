import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const base =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap select-none transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45'

const variants: Record<Variant, string> = {
  primary:
    'bg-cyan text-midnight hover:bg-cyan-soft shadow-[0_0_0_1px_rgba(34,211,238,0.4),0_8px_28px_-10px_rgba(34,211,238,0.55)]',
  secondary: 'bg-raised text-fg border border-line-strong hover:bg-overlay hover:border-electric/50',
  ghost: 'text-dim hover:text-fg hover:bg-raised',
  danger: 'bg-negative/10 text-negative border border-negative/30 hover:bg-negative/20',
}

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

interface CommonProps {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  className?: string
}

export function buttonClasses({ variant = 'primary', size = 'md', className }: CommonProps) {
  return cn(base, variants[variant], sizes[size], className)
}

export const Button = forwardRef<HTMLButtonElement, CommonProps & ButtonHTMLAttributes<HTMLButtonElement>>(
  function Button({ variant, size, loading, icon, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={buttonClasses({ variant, size, className })}
        disabled={disabled || loading}
        {...rest}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
        {children}
      </button>
    )
  },
)

export function LinkButton({
  variant,
  size,
  icon,
  className,
  children,
  ...rest
}: CommonProps & LinkProps) {
  return (
    <Link className={buttonClasses({ variant, size, className })} {...rest}>
      {icon}
      {children}
    </Link>
  )
}
