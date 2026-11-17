import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { api, type ProgressTask } from '../lib/api'
import { Card, Spinner } from './ui'

const n0 = (v: number) => v.toLocaleString('en-US')

/**
 * What a page is waiting for, with a real progress bar when the backend reports one (/api/progress) and a
 * moving bar otherwise. Appears after a short delay, so quick loads don't flash it.
 *
 * `tasks`: the backend jobs this page waits for, most specific first (any running job is shown otherwise).
 */
export function LoadingNotice({ title, tasks, note, className, compact }:
  { title: ReactNode; tasks?: string[]; note?: ReactNode; className?: string; compact?: boolean }) {
  const [visible, setVisible] = useState(false)
  const [task, setTask] = useState<ProgressTask | null>(null)
  const [seconds, setSeconds] = useState(0)
  const key = tasks?.join() ?? ''

  useEffect(() => {
    const started = Date.now()
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const show = setTimeout(() => { if (alive) setVisible(true) }, 250)
    const poll = async () => {
      try {
        const { tasks: running } = await api.progress()
        if (!alive) return
        const wanted = key ? key.split(',') : []
        const pick = wanted.length
          ? wanted.map(name => running.find(t => t.name === name)).find(Boolean) ?? null
          : running[0] ?? null
        setTask(pick)
      } catch { /* the page itself reports errors */ }
      if (alive) {
        setSeconds(Math.floor((Date.now() - started) / 1000))
        timer = setTimeout(poll, 500)
      }
    }
    timer = setTimeout(poll, 200)
    return () => { alive = false; clearTimeout(timer); clearTimeout(show) }
  }, [key])

  if (!visible) return null
  const share = task && task.total > 0 ? Math.min(1, task.done / task.total) : null
  return (
    <Card className={clsx(compact ? 'p-4' : 'p-6', className)}>
      <div role="status" aria-live="polite" className="flex items-center gap-3">
        <Spinner size={compact ? 15 : 18} />
        <div className="min-w-0 flex-1">
          <div className={clsx('font-medium text-ink-100', compact ? 'text-sm' : 'text-[15px]')}>{title}</div>
          <div className="mt-0.5 text-xs text-ink-400">
            {task ? task.label : 'Loading'}
            {task && task.total > 0 && <span className="tabular-nums">: {n0(task.done)} of {n0(task.total)}</span>}
            {seconds >= 3 && <span className="text-ink-500 tabular-nums">, {seconds} s</span>}
          </div>
        </div>
        {share != null && <span className="shrink-0 text-sm font-semibold text-ink-200 tabular-nums">{Math.round(share * 100)}%</span>}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={share != null ? Math.round(share * 100) : undefined}>
        {share != null
          ? <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, share * 100)}%` }} />
          : <div className="progress-indeterminate h-full w-1/3 rounded-full bg-accent/70" />}
      </div>
      {note && <p className="mt-3 text-xs leading-relaxed text-ink-500">{note}</p>}
    </Card>
  )
}
