import type { ReactNode } from 'react'
import { motion } from 'framer-motion'

export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, delay, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </motion.div>
  )
}

export function SectionHeading({ eyebrow, title, body, align = 'center' }: { eyebrow: string; title: string; body?: string; align?: 'center' | 'left' }) {
  return (
    <div className={align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-xl'}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="display mt-3 text-3xl font-semibold text-fg sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base text-dim">{body}</p>}
    </div>
  )
}
