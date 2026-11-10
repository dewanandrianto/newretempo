import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { ApiError, errorMessage } from '@/services/api/client'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

/**
 * Runs a merchant API call, toasts the outcome, and refreshes every billing query.
 * Field-level errors from the server are returned so forms can show them inline.
 */
export function useMerchantMutation<V, R>(fn: (v: V) => Promise<R>, successMessage: string, onSuccess?: (r: R) => void, inline = false) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      toast.success(successMessage)
      void queryClient.invalidateQueries({ queryKey: ['billing'] })
      onSuccess?.(result)
    },
    onError: (err) => {
      // Forms render validation problems inline; every other failure is a toast.
      if (!(inline && err instanceof ApiError && (err.status === 422 || err.status === 409))) toast.error(errorMessage(err))
    },
  })
  const fields = mutation.error instanceof ApiError ? (mutation.error.fields ?? {}) : {}
  const formError = mutation.error ? (mutation.error instanceof ApiError && mutation.error.fields ? undefined : errorMessage(mutation.error)) : undefined
  return { ...mutation, fields, formError }
}

interface CreateDialogProps {
  label: string
  title: string
  description?: string
  disabled?: boolean
  disabledReason?: string
  children: (close: () => void) => ReactNode
}

/** A primary "New ..." button that opens a form in a dialog. Remounting the form resets it. */
export function CreateDialog({ label, title, description, disabled, disabledReason, children }: CreateDialogProps) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <>
      <Button size="sm" icon={<Plus className="size-4" />} disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal open={open} onClose={close} title={title} description={description}>
        {open && children(close)}
      </Modal>
    </>
  )
}

interface ConfirmActionProps {
  label: string
  title: string
  description: string
  confirmLabel: string
  tone?: 'danger' | 'secondary'
  onConfirm: () => Promise<unknown>
  icon?: ReactNode
  disabled?: boolean
}

/** Small row button that asks before doing something destructive. */
export function ConfirmAction({ label, title, description, confirmLabel, tone = 'danger', onConfirm, icon, disabled }: ConfirmActionProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = () => {
    setBusy(true)
    onConfirm()
      .then(() => setOpen(false))
      .catch(() => undefined) // the mutation already toasted the failure
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        icon={icon}
        className="h-8 px-2"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        {label}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} description={description}>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Keep it
          </Button>
          <Button variant={tone} loading={busy} onClick={run}>
            {confirmLabel}
          </Button>
        </div>
      </Modal>
    </>
  )
}
