import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { HelpCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Card } from '../ui'

/** Insights card with an optional "?" that explains the section in plain words. */
export function Section({ title, icon, children, action, className, help }:
  { title: string; icon: ReactNode; children: ReactNode; action?: ReactNode; className?: string; help?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Card className={clsx('p-5', className)}>
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {help && (
          <button onClick={() => setOpen(o => !o)} title="What is this?"
            className={clsx('rounded-full transition cursor-pointer', open ? 'text-accent' : 'text-ink-500 hover:text-ink-200')}>
            <HelpCircle size={16} />
          </button>
        )}
        <div className="flex-1" />
        {action}
      </div>
      <AnimatePresence initial={false}>
        {open && help && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden">
            <div className="-mt-1 mb-4 rounded-xl bg-accent/8 px-3.5 py-2.5 text-sm leading-relaxed text-ink-200 ring-1 ring-accent/20">{help}</div>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </Card>
  )
}
