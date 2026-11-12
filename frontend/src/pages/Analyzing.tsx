import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Board } from '../components/Board'
import { QueuePanel } from '../components/QueuePanel'
import { Button, ErrorNote } from '../components/ui'
import { api } from '../lib/api'
import { analysisLabel } from '../lib/chess'
import { back, go, replace } from '../lib/router'
import { refreshQueue, useQueue, watchJob } from '../lib/store'
import type { QueueJob } from '../lib/types'

const QUIPS = [
  'Waking up Stockfish…',
  'Counting the pawns twice…',
  'Looking for hidden sacrifices…',
  'Checking if that knight was really hanging…',
  'Hunting for brilliancies…',
  'Calculating deep lines…',
  'Judging your opening prep (gently)…',
  'Finding the move you missed…',
  'Polishing the !! symbols…',
]
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export function Analyzing({ jobId }: { jobId?: number }) {
  const queue = useQueue()
  const [quip, setQuip] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setQuip(q => (q + 1) % QUIPS.length), 2200)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { refreshQueue() }, [])

  // Without an id, follow whatever is running.
  const [fetched, setFetched] = useState<QueueJob | null>(null)
  const listed = jobId != null ? queue.find(j => j.id === jobId) : queue.find(j => j.status === 'running') ?? queue.find(j => j.status === 'queued')
  const job = listed ?? (jobId != null && fetched?.id === jobId ? fetched : undefined)
  useEffect(() => {
    if (jobId == null || listed) return
    const t = setInterval(() => api.job(jobId).then(setFetched).catch(() => {}), 1000)
    void api.job(jobId).then(setFetched).catch(() => {})
    return () => clearInterval(t)
  }, [jobId, listed])

  useEffect(() => {
    watchJob(job?.id ?? null)
    return () => watchJob(null)
  }, [job?.id])

  useEffect(() => {
    if (job?.status === 'done' && job.gameId && jobId != null) replace(`/review/${job.gameId}`) // the review takes this page's place: Back skips the queue page
  }, [job?.status, job?.gameId, jobId])

  const others = queue.filter(j => j.id !== job?.id)

  if (!job) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-ink-300">
        Nothing is being analysed right now.
        <Button onClick={() => go('/')}><ArrowLeft size={16} /> Import a game</Button>
        {others.length > 0 && <div className="w-full max-w-xl"><QueuePanel /></div>}
      </div>
    )
  }

  if (job.status === 'error') {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10">
        <ErrorNote>Analysis failed: {job.error}</ErrorNote>
        <Button onClick={back}><ArrowLeft size={16} /> Back</Button>
      </div>
    )
  }

  const pct = job.total ? job.done / job.total : 0
  const R = 52, C = 2 * Math.PI * R
  const ahead = queue.filter(j => j.status === 'running' && j.id !== job.id).length

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <div className="relative w-[min(78vw,400px)]">
        <div className="pointer-events-none opacity-90"><Board fen={job.fen ?? START} orientation="w" /></div>
        <motion.div className="pointer-events-none absolute inset-0 rounded-[14px]"
          style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(30,227,207,.25) 50%, transparent 100%)', backgroundSize: '100% 30%', backgroundRepeat: 'no-repeat' }}
          animate={{ backgroundPositionY: ['-30%', '130%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }} />
      </div>

      <div className="flex items-center gap-5">
        <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
          <circle cx="64" cy="64" r={R} stroke="#1d2233" strokeWidth="10" fill="none" />
          <motion.circle cx="64" cy="64" r={R} stroke="url(#prog)" strokeWidth="10" fill="none" strokeLinecap="round"
            strokeDasharray={C} animate={{ strokeDashoffset: C * (1 - pct) }} transition={{ type: 'spring', stiffness: 60, damping: 20 }} />
          <defs>
            <linearGradient id="prog" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#1ee3cf" /><stop offset="1" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
          <text x="64" y="64" transform="rotate(90 64 64)" textAnchor="middle" dominantBaseline="central"
            className="fill-white font-display text-[30px] leading-tight font-semibold">{Math.round(pct * 100)}%</text>
        </svg>
        <div>
          <div className="font-display text-2xl font-semibold">Analysing {job.title}</div>
          <div className="mt-1 text-sm text-ink-400 tabular-nums">
            {job.status === 'queued' ? `Waiting in queue${ahead ? ' behind another game' : ''}…` : `Position ${job.done} / ${job.total || '…'}`}
            <span className="text-ink-500"> · Stockfish, {job.moveTime ? `${job.moveTime} s per move` : analysisLabel(job)}</span>
          </div>
          <div className="mt-2 h-6 overflow-hidden text-accent">
            <AnimatePresence mode="wait">
              <motion.div key={quip} initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -16, opacity: 0 }}>
                {QUIPS[quip]}
              </motion.div>
            </AnimatePresence>
          </div>
          <Button variant="ghost" size="sm" className="mt-2 -ml-3" onClick={async () => { await api.cancelJob(job.id); refreshQueue(); go('/') }}>
            <X size={14} /> Cancel
          </Button>
        </div>
      </div>

      {others.some(j => j.status === 'queued' || j.status === 'running') && (
        <div className="w-full max-w-xl"><QueuePanel /></div>
      )}
    </div>
  )
}
