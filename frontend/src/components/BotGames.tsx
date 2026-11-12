import clsx from 'clsx'
import { Skull, Sparkles, Trophy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import { startAnalysis, useReviewsTick } from '../lib/store'
import type { BotGame } from '../lib/types'
import { SiteMark } from './LibraryImport'
import { Button, ErrorNote, Spinner } from './ui'

const OUT = {
  win: ['W', 'bg-best/12 text-best ring-best/25'],
  loss: ['L', 'bg-blunder/12 text-[#ff7b8d] ring-blunder/25'],
  draw: ['D', 'bg-white/[0.06] text-ink-300 ring-white/10'],
} as const

/** Your games against the Nightmare bot: reviewed ones open the review, the others can be analysed from here. */
export function BotGames() {
  const [games, setGames] = useState<BotGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tick = useReviewsTick()
  useEffect(() => {
    api.botGames().then(g => { setGames(g); setError(null) }).catch(e => setError((e as Error).message))
  }, [tick])

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!games) return <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-400"><Spinner size={16} /> Loading…</div>
  if (!games.length) {
    return (
      <div className="flex flex-col items-center py-10 text-center text-sm text-ink-400">
        <Skull size={22} className="mb-2 text-ink-500" />
        No bot games yet. Games you play against the Instructive bot show up here.
        <Button size="sm" variant="soft" className="mt-3" onClick={() => go('/nightmare')}>Play the Instructive bot</Button>
      </div>
    )
  }
  const won = games.filter(g => g.result === 'win').length
  const lost = games.filter(g => g.result === 'loss').length
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-400">
        <span><b className="text-ink-200">{games.length}</b> games · {won} won · {lost} lost · {games.length - won - lost} drawn</span>
        <div className="flex-1" />
        <span>Games played before this version only show up once reviewed.</span>
      </div>
      <div className="max-h-[480px] space-y-1.5 overflow-y-auto pr-1">
        {games.map(g => <BotRow key={`${g.at}-${g.review?.id ?? ''}`} g={g} />)}
      </div>
    </div>
  )
}

function BotRow({ g }: { g: BotGame }) {
  const [busy, setBusy] = useState(false)
  const out = g.result ? OUT[g.result] : ['?', 'bg-white/[0.04] text-ink-400 ring-white/10']
  const date = g.at ? new Date(g.at * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : ''
  const analyse = async () => {
    if (!g.pgn) return
    setBusy(true)
    try { await startAnalysis({ pgn: g.pgn, title: `You vs Nightmare (Maia ${g.level ?? '?'})`, source: 'nightmare' }) } finally { setBusy(false) }
  }
  return (
    <div className="group flex h-[52px] items-center gap-3 rounded-xl bg-white/[0.02] px-3 ring-1 ring-inset ring-white/[0.05] transition-colors hover:bg-white/[0.045]">
      <SiteMark source="bot" />
      <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold ring-1 ring-inset', out[1])}>{out[0]}</span>
      <span className={clsx('size-3 shrink-0 rounded-full ring-1 ring-white/30', g.color === 'w' ? 'bg-white' : 'bg-ink-950')} title={`You played ${g.color === 'w' ? 'White' : 'Black'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">vs Bot <span className="font-normal text-ink-400">(Maia {g.level ?? '?'})</span></div>
        <div className="text-xs text-ink-400">
          {date} · {g.moves} moves
          {g.traps != null && g.traps > 0 && <> · {g.traps} trap{g.traps === 1 ? '' : 's'} set, {g.fell ?? 0} fallen for</>}
        </div>
      </div>
      {g.review ? (
        <Button size="sm" variant="soft" onClick={() => go(`/review/${g.review!.id}`)}>
          <Trophy size={14} /> Review
          {g.review.accuracy != null && <span className="font-mono text-xs font-semibold" style={{ color: accuracyColor(g.review.accuracy) }}>{g.review.accuracy.toFixed(0)}</span>}
        </Button>
      ) : g.pgn ? (
        <Button size="sm" variant="soft" onClick={analyse} disabled={busy} className="group-hover:bg-accent group-hover:text-ink-950 group-hover:ring-accent">
          {busy ? <Spinner size={14} /> : <Sparkles size={14} className="text-accent group-hover:text-ink-950" />} Analyze
        </Button>
      ) : null}
    </div>
  )
}
