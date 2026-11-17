import clsx from 'clsx'
import { Crosshair, Dumbbell, LineChart, RefreshCw, Target, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AccuracyChart, timeClass, type AccPoint } from '../components/progress/AccuracyChart'
import { TrophyRoom } from '../components/progress/TrophyRoom'
import { ActivityCard, RatingCard, RecordCard, RecordsCard, TrendTable } from '../components/progress/Dashboard'
import { Button, Card, CountUp, EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui'
import { LoadingNotice } from '../components/LoadingNotice'
import { api } from '../lib/api'
import { CLS, ClassIcon } from '../lib/classes'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import { refreshQueue, useQueueCounts, useReviewsTick } from '../lib/store'
import type { GameSummary, StatsReport } from '../lib/types'
import { ResultPill } from './Home'

const SHORT = 10
/** Number of moves you (or White, if unknown) played. */
const myMoves = (g: GameSummary) => (g.me === 'b' ? Math.floor(g.plies / 2) : Math.ceil(g.plies / 2))

export function Progress() {
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [mistakes, setMistakes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [drilling, setDrilling] = useState(false)

  const [dash, setDash] = useState<StatsReport | null>(null)
  const load = () => { api.games().then(setGames).catch(e => setError(String(e))); api.stats().then(setDash).catch(() => {}) }
  // Reload as queued games finish (throttled during big batches, see useReviewsTick).
  const refresh = useReviewsTick()
  useEffect(() => { load() }, [refresh])
  const [shown, setShown] = useState(50)

  const stats = useMemo(() => {
    if (!games) return null
    // Short games say little about accuracy: leave them out of averages and the trend.
    const mine = games.filter(g => g.me && myMoves(g) >= SHORT)
    const weighted = (gs: GameSummary[]) => {
      const rows = gs.map(g => [g.accuracy[g.me!], myMoves(g)] as const).filter((r): r is readonly [number, number] => r[0] != null)
      const n = rows.reduce((s, [, w]) => s + w, 0)
      return n ? rows.reduce((s, [a, w]) => s + a * w, 0) / n : null
    }
    const sum = (k: 'brilliant' | 'great' | 'blunder') => games.filter(g => g.me).reduce((s, g) => s + (g.counts[g.me!][k] ?? 0), 0)
    const byPlayed = [...mine].sort((a, b) => (b.playedAt ?? 0) - (a.playedAt ?? 0)) // newest game first
    const trend: AccPoint[] = mine.filter(g => g.accuracy[g.me!] != null).map(g => ({
      t: (g.playedAt || g.analysedAt) * 1000, acc: g.accuracy[g.me!]!, label: `${g.white} vs ${g.black}`, id: g.id,
      moves: Math.ceil(g.plies / 2), tc: timeClass(g.timeControl), outcome: outcomeOf(g),
    }))
    return {
      count: games.length,
      avg: weighted(mine),
      recentAvg: weighted(byPlayed.slice(0, 10)),
      brilliant: sum('brilliant'), great: sum('great'),
      blunders: mine.length ? sum('blunder') / games.filter(g => g.me).length : null,
      trend, hasMe: games.some(g => g.me), shortGames: games.filter(g => g.me).length - mine.length,
    }
  }, [games])


  const drill = async () => {
    setDrilling(true)
    try {
      const set = await api.createSet({ kind: 'mistakes', amount: 50 })
      go(`/woodpecker/${set.id}`)
    } catch (e) { setError((e as Error).message) } finally { setDrilling(false) }
  }

  if (!games) return error ? <div className="flex h-full items-center justify-center"><ErrorNote>{error}</ErrorNote></div>
    : <div className="mx-auto max-w-6xl px-4 py-8 lg:px-8"><LoadingNotice title="Loading your progress" tasks={['summaries', 'insights']} /></div>
  if (!games.length) {
    return (
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 lg:px-8">
        <PageHeader icon={<LineChart className="text-best" />} title="My progress" />
        <EmptyState icon={<LineChart />} title="No reviewed games yet"
          action={<Button variant="primary" onClick={() => go('/')}>Import and analyse games</Button>}>
          Your accuracy over time, rating, records and the mistakes worth drilling show up here once you've reviewed a few games.
        </EmptyState>
      </div>
    )
  }
  // The dashboard cards need at least one game of yours (with your username set).
  const board = dash && dash.games > 0 ? dash : null

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 lg:px-8">
      <PageHeader icon={<LineChart className="text-best" />} title="My progress"
        description={!stats?.hasMe && games.length > 0
          ? <>Tip: set your Chess.com / Lichess username in Settings so stats focus on <em>your</em> moves.</>
          : 'Accuracy over time, your best moves, and the mistakes worth drilling.'} />
      {error && <ErrorNote>{error}</ErrorNote>}
      <UpgradeBanner />

      {/* stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Games reviewed" value={stats!.count} color="#e7eaf4" />
        <Tile label="Avg accuracy (last 10 played)" value={stats!.recentAvg} decimals={1} color={accuracyColor(stats!.recentAvg)} />
        <Tile label="Brilliant moves" value={stats!.brilliant} color={CLS.brilliant.color} icon={<ClassIcon cls="brilliant" size={22} />} />
        <Tile label="Great moves" value={stats!.great} color={CLS.great.color} icon={<ClassIcon cls="great" size={22} />} />
      </div>

      {/* dashboard */}
      {board && (
        <div className="grid gap-4 lg:grid-cols-2">
          <RecordCard s={board} />
          <RatingCard s={board} />
        </div>
      )}

      {/* trend + drill */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="p-5">
          <AccuracyChart points={stats!.trend} shortGames={stats!.shortGames} />
        </Card>

        <Card className="flex flex-col justify-between gap-4 p-5">
          <div>
            <div className="flex size-11 items-center justify-center rounded-2xl bg-mistake/15 text-mistake"><Dumbbell size={22} /></div>
            <h2 className="mt-3 font-display text-lg font-semibold">Drill your mistakes</h2>
            <p className="mt-1 text-sm text-ink-300">
              Turn the <b className="text-white">{mistakes}</b> mistakes, misses &amp; blunders from your games into a Woodpecker set.
              {mistakes > 50 ? ' A random 50 of them per set –' : ''} Same positions, again and again, until the right move is automatic.
            </p>
          </div>
          <Button variant="primary" onClick={drill} disabled={!mistakes || drilling}>
            {drilling ? <Spinner /> : <Target size={16} />} Build drill set
          </Button>
        </Card>
      </div>

      {board && (
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <TrendTable s={board} />
          <RecordsCard s={board} />
        </div>
      )}
      {board && <ActivityCard s={board} />}

      {/* trophy room */}
      <TrophyRoom refresh={refresh} onCounts={c => setMistakes(c.mistakes)} />

      {/* all games */}
      <section>
        <h2 className="mb-3 font-display text-xl font-semibold">All reviewed games <span className="text-sm font-normal text-ink-400">({games.length})</span></h2>
        {games.length === 0 ? (
          <Card className="p-8 text-center text-ink-300">
            Nothing here yet. <button className="font-semibold text-accent hover:underline cursor-pointer" onClick={() => go('/')}>Import your first game →</button>
          </Card>
        ) : (
          <Card className="divide-y divide-white/5 overflow-hidden">
            {games.slice(0, shown).map(g => {
              const side = g.me ?? 'w'
              const c = g.counts[side]
              return (
                <div key={g.id} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-white/[0.03]">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer" onClick={() => go(`/review/${g.id}`)}>
                    <ResultPill result={g.result} me={g.me} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{g.white} <span className="text-ink-400">vs</span> {g.black}</div>
                      <div className="truncate text-xs text-ink-400">
                        {[g.date, `${Math.ceil(g.plies / 2)} moves`, g.opening?.name].filter(Boolean).join(' · ')}
                        {myMoves(g) < SHORT && <span className="ml-1.5 rounded bg-ink-600 px-1 text-[11px] font-medium uppercase text-ink-300" title="Too short to judge – excluded from averages">short</span>}
                      </div>
                    </div>
                    <div className="hidden gap-2 sm:flex">
                      {(['brilliant', 'great', 'mistake', 'blunder'] as const).map(k => (c[k] ?? 0) > 0 && (
                        <span key={k} className="flex items-center gap-1 text-xs font-bold"><ClassIcon cls={k} size={16} />{c[k]}</span>
                      ))}
                    </div>
                    <span className={clsx('w-14 text-right font-display text-lg font-semibold tabular-nums', myMoves(g) < SHORT && 'opacity-40')} style={{ color: accuracyColor(g.accuracy[side]) }}>
                      {g.accuracy[side]?.toFixed(1) ?? '—'}
                    </span>
                  </button>
                  <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100" title="Delete"
                    onClick={async () => { if (confirm('Delete this review?')) { await api.deleteGame(g.id); load() } }}>
                    <Trash2 size={15} />
                  </Button>
                </div>
              )
            })}
            {games.length > shown && (
              <button onClick={() => setShown(n => n + 100)}
                className="w-full py-3 text-sm font-semibold text-ink-300 hover:bg-white/[0.03] hover:text-white cursor-pointer">
                Show {Math.min(100, games.length - shown)} more of {games.length - shown} remaining
              </button>
            )}
          </Card>
        )}
      </section>

      {stats!.blunders != null && (
        <p className="flex items-center justify-center gap-2 pb-4 text-xs text-ink-400">
          <Crosshair size={13} /> {stats!.blunders.toFixed(2)} blunders per game on average. Get it to zero!
        </p>
      )}
    </div>
  )
}

function Tile({ label, value, color, decimals = 0, icon }:
  { label: string; value: number | null; color: string; decimals?: number; icon?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
        {icon}
      </div>
      <div className="mt-2 font-display text-4xl font-semibold tabular-nums" style={{ color }}>
        {value == null ? '—' : <CountUp to={value} decimals={decimals} />}
      </div>
    </Card>
  )
}

/** Reviews made with an older rating method can be re-analysed in the background. */
function UpgradeBanner() {
  const [info, setInfo] = useState<{ count: number; plies: number; active?: boolean } | null>(null)
  const [queued, setQueued] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const tick = useReviewsTick()
  const counts = useQueueCounts()
  useEffect(() => { api.reviewsOutdated().then(setInfo).catch(() => {}) }, [tick])
  if (!info || info.count === 0) return null
  const busy = counts.queued + counts.running
  const running = queued != null || !!info.active
  const minutes = Math.max(1, Math.round(info.plies / 35 / 60)) // ~35 positions/s on the batch pool
  const est = minutes >= 90 ? `~${Math.round(minutes / 60)} h` : `~${minutes} min`
  const start = async () => {
    setStarting(true)
    try { setQueued((await api.upgradeReviews()).queued); refreshQueue() } finally { setStarting(false) }
  }
  if (running) {
    const total = counts.done + busy
    const pct = busy && total ? Math.round((counts.done / total) * 100) : 0
    return (
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Spinner size={16} />
          <div className="mr-auto">
            <b>Re-analysing your reviews</b> <span className="text-ink-400">· {info.count.toLocaleString()} left, {est} to go.
              Keep using the app – if you close it, it carries on next time.</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => go('/analyzing')}>Queue</Button>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${pct}%` }} />
        </div>
      </Card>
    )
  }
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4 ring-1 ring-accent/30">
      <RefreshCw size={18} className="text-accent" />
      <div className="mr-auto text-sm">
        <b>{info.count.toLocaleString()} reviews</b> use the older rating method. <span className="text-ink-400">Re-analyse them for
          ratings tuned to your level and steadier results ({est}, runs in the background).</span>
      </div>
      <Button variant="primary" onClick={start} disabled={starting}>{starting ? <Spinner size={14} /> : <RefreshCw size={14} />} Re-analyse</Button>
    </Card>
  )
}

function outcomeOf(g: GameSummary): AccPoint['outcome'] {
  if (!g.me) return null
  if (g.result === '1/2-1/2') return 'draw'
  if (g.result !== '1-0' && g.result !== '0-1') return null
  return (g.result === '1-0') === (g.me === 'w') ? 'win' : 'loss'
}
