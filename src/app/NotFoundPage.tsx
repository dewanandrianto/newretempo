import { Compass } from 'lucide-react'
import { LinkButton } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/States'
import { Logo } from '@/components/ui/Logo'

export default function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-midnight px-5">
      <Logo className="mb-8" />
      <EmptyState
        icon={<Compass className="size-5" />}
        title="Page not found"
        description="The page you are looking for does not exist or has moved."
        action={<LinkButton to="/">Back to home</LinkButton>}
      />
    </div>
  )
}
