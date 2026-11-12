import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle2, Info, Sparkles, X } from 'lucide-react'
import { go } from '../lib/router'
import { dismissToast, useToasts } from '../lib/store'

export function Toaster() {
  const toasts = useToasts()
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map(t => {
          const Icon = t.tone === 'good' ? Sparkles : t.tone === 'bad' ? Info : CheckCircle2
          return (
            <motion.div key={t.id} layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }}
              className={clsx('popover pointer-events-auto flex items-start gap-3 rounded-xl p-3.5 ring-1 ring-inset',
                t.tone === 'good' ? 'ring-brilliant/40' : t.tone === 'bad' ? 'ring-blunder/40' : 'ring-white/10',
                t.href && 'cursor-pointer')}
              onClick={() => { if (t.href) { go(t.href); dismissToast(t.id) } }}>
              <Icon size={18} className={clsx('mt-0.5 shrink-0', t.tone === 'good' ? 'text-brilliant' : t.tone === 'bad' ? 'text-blunder' : 'text-best')} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{t.title}</div>
                {t.body && <div className="text-xs text-ink-300">{t.body}</div>}
              </div>
              <button className="text-ink-400 hover:text-white cursor-pointer" onClick={e => { e.stopPropagation(); dismissToast(t.id) }}><X size={14} /></button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
