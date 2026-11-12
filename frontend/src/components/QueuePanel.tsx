import clsx from 'clsx'
import { Check, ListChecks, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { ClassIcon } from '../lib/classes'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import { refreshQueue, useQueue, useQueueCounts } from '../lib/store'
import { Button, Card, Spinner } from './ui'

export function QueuePanel() {
  const jobs = useQueue()
  const counts = useQueueCounts()
  if (!jobs.length) return null
  const total = counts.queued + counts.running + counts.done + counts.error + counts.cancelled
  const activeCount = counts.queued + counts.running
  const finished = counts.done
  // Keep the list short for big batches: recent finished, the running one, a few up next.
  const shownFinished = jobs.filter(j => !['queued', 'running'].includes(j.status)).slice(-6)
  const shownActive = jobs.filter(j => j.status === 'running').concat(jobs.filter(j => j.status === 'queued').slice(0, 6))
  const hiddenQueued = counts.queued - shownActive.filter(j => j.status === 'queued').length

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <ListChecks size={18} className="text-accent" />
        <h3 className="font-display font-semibold">Analysis queue</h3>
        <span className="text-xs text-ink-400">{finished}/{total} done</span>
        <div className="flex-1" />
        {activeCount > 0 && (
          <Button size="sm" variant="ghost" onClick={async () => { await api.cancelAll(); refreshQueue() }}><X size={14} /> Stop all</Button>
        )}
        {total > activeCount && (
          <Button size="sm" variant="ghost" onClick={async () => { await api.clearQueue(); refreshQueue() }}><Trash2 size={14} /> Clear finished</Button>
        )}
      </div>
      {total > 1 && (
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-ink-700">
          <div className="h-full rounded-full bg-gradient-to-r from-accent to-great transition-[width] duration-500"
            style={{ width: `${((total - activeCount) / total) * 100}%` }} />
        </div>
      )}
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {[...shownFinished, ...shownActive].map(j => {
          const pct = j.total ? (j.done / j.total) * 100 : 0
          const c = j.summary?.counts ?? {}
          return (
            <div key={j.id}
              className={clsx('relative flex items-center gap-3 overflow-hidden rounded-xl px-3 py-2 text-sm ring-1 ring-white/5',
                j.status === 'done' ? 'bg-ink-850 hover:bg-ink-800 cursor-pointer' : 'bg-ink-850/60')}
              onClick={() => j.status === 'done' && j.gameId && go(`/review/${j.gameId}`)}>
              {j.status === 'running' && (
                <div className="absolute inset-y-0 left-0 bg-accent/10 transition-[width] duration-500" style={{ width: `${pct}%` }} />
              )}
              <span className="relative flex w-5 justify-center">
                {j.status === 'running' && <Spinner size={14} />}
                {j.status === 'queued' && <span className="size-2 rounded-full bg-ink-500" />}
                {j.status === 'done' && <Check size={16} className="text-best" />}
                {(j.status === 'error' || j.status === 'cancelled') && <X size={16} className="text-ink-400" />}
              </span>
              <span className="relative min-w-0 flex-1 truncate font-medium">{j.title}</span>
              <span className="relative flex items-center gap-2 text-xs">
                {j.status === 'running' && <span className="tabular-nums text-accent">{Math.round(pct)}%</span>}
                {j.status === 'error' && <span className="text-blunder" title={j.error ?? ''}>failed</span>}
                {j.status === 'cancelled' && <span className="text-ink-400">cancelled</span>}
                {j.status === 'done' && (
                  <>
                    {(['brilliant', 'great', 'blunder'] as const).map(k => (c[k] ?? 0) > 0 && (
                      <span key={k} className="flex items-center gap-0.5 font-bold"><ClassIcon cls={k} size={14} />{c[k]}</span>
                    ))}
                    {j.summary?.accuracy != null && (
                      <span className="w-10 text-right font-display font-semibold tabular-nums" style={{ color: accuracyColor(j.summary.accuracy) }}>
                        {j.summary.accuracy.toFixed(1)}
                      </span>
                    )}
                  </>
                )}
                {j.status === 'queued' && (
                  <button className="text-ink-400 hover:text-white cursor-pointer" title="Remove"
                    onClick={async e => { e.stopPropagation(); await api.cancelJob(j.id); refreshQueue() }}><X size={14} /></button>
                )}
              </span>
            </div>
          )
        })}
        {hiddenQueued > 0 && (
          <div className="px-3 py-1.5 text-xs text-ink-400">+ {hiddenQueued} more queued</div>
        )}
      </div>
    </Card>
  )
}
