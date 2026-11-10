import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'

interface CodeBlockProps {
  code: string
  language?: string
  className?: string
  copyable?: boolean
}

export function CodeBlock({ code, language = 'ts', className, copyable = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className={cn('overflow-hidden rounded-xl border border-line bg-midnight/80', className)}>
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-white/10" />
          <span className="size-2.5 rounded-full bg-white/10" />
          <span className="size-2.5 rounded-full bg-white/10" />
        </div>
        <span className="mono text-[11px] text-faint">{language}</span>
        {copyable ? (
          <button
            type="button"
            onClick={copy}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-dim hover:bg-raised hover:text-fg"
            aria-label="Copy code"
          >
            {copied ? <Check className="size-3.5 text-positive" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : (
          <span className="w-12" />
        )}
      </div>
      <pre className="mono overflow-x-auto p-4 text-[12.5px] leading-6 text-dim">
        <code>{code}</code>
      </pre>
    </div>
  )
}
