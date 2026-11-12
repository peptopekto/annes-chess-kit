import clsx from 'clsx'
import type { Key } from 'chessground/types'
import { motion } from 'motion/react'
import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, CheckCircle2, Dumbbell, GraduationCap, ListChecks, Repeat, ShieldAlert, Minus, Skull, Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Board } from '../components/Board'
import { drill } from '../components/insights/drill'
import { TrainingCard } from '../components/training/TrainingCard'
import { Button, Card, CardsSkeleton, ErrorNote, PageHeader, Skeleton } from '../components/ui'
import { api } from '../lib/api'
import { turnOf, uciSquares } from '../lib/chess'
import { go } from '../lib/router'
import type { CoachHabit, CoachNote, CoachPlanItem, CoachRef, CoachReport, CoachRepeat } from '../lib/types'

export function CoachPage() {
  const [report, setReport] = useState<CoachReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.coach().then(setReport).catch(e => setError(String(e.message ?? e))) }, [])

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 lg:px-8">
      <PageHeader icon={<GraduationCap className="text-accent" />} title="Coach"
        description="The habits behind your mistakes and the moves you keep repeating – ranked by what they cost you lately, with real examples from your games and a drill for each." />
      <TrainingCard />
      {error && <ErrorNote>{error}</ErrorNote>}
      {!report && !error && (
        <div className="space-y-4">
          <Skeleton className="h-28 rounded-2xl" />
          <CardsSkeleton count={3} className="grid gap-4" h="h-64" />
          <p className="text-center text-xs text-ink-500">Going through all your reviewed games – the first time takes a little while.</p>
        </div>
      )}
      {report && report.games === 0 && <Card className="p-8 text-center text-ink-300">Review some of your games first – the coach learns from them.</Card>}
      {report && report.games > 0 && <Report r={report} />}
    </div>
  )
}

function Report({ r }: { r: CoachReport }) {
  const [more, setMore] = useState(false)
  const top = r.habits.slice(0, 3)
  const rest = r.habits.slice(3)
  return (
    <>
      {/* Training plan */}
      {r.plan && r.plan.length > 0 && <Plan r={r} />}

      {/* Strengths & warning signs */}
      {((r.strengths?.length ?? 0) > 0 || (r.warnings?.length ?? 0) > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Notes title="Warning signs" icon={<TriangleAlert size={17} className="text-mistake" />} notes={r.warnings ?? []} tone="bad" />
          <Notes title="Your strengths" icon={<Sparkles size={17} className="text-best" />} notes={r.strengths ?? []} tone="good" />
        </div>
      )}

      {/* Checklist */}
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold">Your blunder check – before every move</h2>
            <p className="mt-1 text-sm text-ink-400">Built from your own most expensive habits. Run through it whenever there are captures or checks on the board.</p>
          </div>
          <Button onClick={() => go('/safety/play/mixed/20')}><ShieldAlert size={15} /> Practise it</Button>
        </div>
        <ol className="mt-4 grid gap-2 sm:grid-cols-2">
          {r.checklist.map((c, i) => (
            <li key={c.key} className="flex gap-3 rounded-xl bg-white/[0.03] p-3 text-sm ring-1 ring-inset ring-white/[0.06]">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-xs font-semibold text-accent">{i + 1}</span>
              <span className="text-ink-200">{c.question}</span>
            </li>
          ))}
        </ol>
      </Card>

      {/* Top habits */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-xl font-semibold">Your most expensive habits</h2>
          <span className="text-xs text-ink-500">“Lately” = your last {r.recentGames} games vs the {r.beforeGames} before</span>
        </div>
        <div className="space-y-4">
          {top.map((h, i) => <HabitCard key={h.key} h={h} rank={i + 1} />)}
        </div>
      </section>

      {/* Repeats */}
      {r.repeats.length > 0 && <Repeats r={r} />}

      {/* The rest */}
      {rest.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-xl font-semibold">Other habits</h2>
          <Card className="divide-y divide-white/[0.05]">
            {(more ? rest : rest.slice(0, 6)).map(h => <HabitRow key={h.key} h={h} />)}
          </Card>
          {rest.length > 6 && !more && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setMore(true)}>Show all {rest.length}</Button>}
        </section>
      )}
    </>
  )
}

function Trend({ h }: { h: CoachHabit }) {
  if (h.recentPct == null || h.beforePct == null) return <span className="text-ink-500">not enough games yet</span>
  const ratio = h.beforePct ? h.recentPct / h.beforePct : 1
  if (ratio <= 0.85) return <span className="inline-flex items-center gap-1 text-best"><ArrowDownRight size={14} /> improving · {h.beforePct}% → {h.recentPct}%</span>
  if (ratio >= 1.15) return <span className="inline-flex items-center gap-1 text-blunder"><ArrowUpRight size={14} /> getting worse · {h.beforePct}% → {h.recentPct}%</span>
  return <span className="inline-flex items-center gap-1 text-ink-300"><Minus size={14} /> steady · {h.recentPct}% of games</span>
}

const costText = (x: number | null) => (x == null ? '—' : `−${(x * 100).toFixed(1)}%`)

function HabitCard({ h, rank }: { h: CoachHabit; rank: number }) {
  const [page, setPage] = useState(0)
  const per = 3
  const shown = h.examples.slice(page * per, page * per + per)
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: rank * 0.05 }}>
      <Card className="p-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className={clsx('flex size-8 shrink-0 items-center justify-center rounded-[10px] font-mono text-sm font-semibold ring-1 ring-inset',
                rank === 1 ? 'bg-blunder/15 text-[#ff8796] ring-blunder/30' : 'bg-white/[0.05] text-ink-200 ring-white/[0.08]')}>{rank}</span>
              <h3 className="font-display text-lg font-semibold">{h.title}</h3>
            </div>
            <p className="mt-2 text-sm text-ink-300">{h.why}</p>
            <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-xs text-ink-500">Shows up in</div><div className="font-display text-xl font-semibold tabular-nums">{h.pct}%</div><div className="text-xs text-ink-500">of your games · {h.count}×</div></div>
              <div><div className="text-xs text-ink-500">Each time it costs</div><div className="font-display text-xl font-semibold tabular-nums text-[#ff8796]">{costText(h.cost)}</div><div className="text-xs text-ink-500">win chance · {costText(h.recentImpact ?? h.impact)} per game on average</div></div>
              <div><div className="text-xs text-ink-500">Lately</div><div className="mt-1 text-xs font-medium"><Trend h={h} /></div>
                {h.history && h.history.length >= 3 && <Spark values={h.history} className="mt-2" />}</div>
            </div>
            <div className="mt-4 flex gap-3 rounded-xl bg-accent/[0.06] p-3 text-sm ring-1 ring-inset ring-accent/20">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
              <span className="text-ink-100">{h.fix}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => drill(h.examples, h.title)}><Dumbbell size={14} /> Drill these positions</Button>
              {h.examples.length > per && (
                <Button size="sm" variant="ghost" onClick={() => setPage(p => ((p + 1) * per >= Math.min(h.examples.length, 30) ? 0 : p + 1))}>
                  More examples <ArrowRight size={13} />
                </Button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 lg:w-[480px]">
            {shown.map(x => <Example key={`${x.gameId}-${x.ply}`} x={x} />)}
          </div>
        </div>
      </Card>
    </motion.div>
  )
}

function HabitRow({ h }: { h: CoachHabit }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{h.title}</div>
        <div className="truncate text-xs text-ink-500" title={h.fix}>{h.fix}</div>
      </div>
      <div className="w-24 text-right text-sm tabular-nums"><span className="font-semibold">{h.pct}%</span> <span className="text-xs text-ink-500">games</span></div>
      <div className="w-28 text-right font-mono text-xs text-[#ff8796]" title="Win chance lost each time">{costText(h.cost)} each</div>
      <div className="w-52 text-xs"><Trend h={h} /></div>
      {h.history && h.history.length >= 3 && <Spark values={h.history} className="hidden w-24 sm:block" />}
      <Button size="sm" variant="soft" onClick={() => drill(h.examples, h.title)}><Dumbbell size={13} /> Drill</Button>
    </div>
  )
}

function Example({ x }: { x: CoachRef }) {
  const shapes = [
    ...(x.bestUci ? [{ orig: uciSquares(x.bestUci)[0] as Key, dest: uciSquares(x.bestUci)[1] as Key, brush: 'best' }] : []),
    ...(x.uci ? [{ orig: uciSquares(x.uci)[0] as Key, dest: uciSquares(x.uci)[1] as Key, brush: 'blunder' }] : []),
  ]
  return (
    <button onClick={() => go(`/review/${x.gameId}/${x.ply}`)} title="Open this moment in the review"
      className="group min-w-0 text-left cursor-pointer">
      <div className="pointer-events-none aspect-square overflow-hidden rounded-lg ring-1 ring-white/[0.08] transition group-hover:ring-accent/50">
        <Board fen={x.fenBefore} orientation={turnOf(x.fenBefore)} shapes={shapes} />
      </div>
      <div className="mt-1.5 truncate font-mono text-[11px]">
        <span className="text-[#ff8796]">{x.san}</span> <span className="text-ink-500">→</span> <span className="text-best">{x.bestSan}</span>
      </div>
      <div className="truncate text-[11px] text-ink-500">{x.white} – {x.black}</div>
    </button>
  )
}

function Repeats({ r }: { r: CoachReport }) {
  const all = r.repeats.flatMap(x => x.refs)
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold"><Repeat size={18} className="text-mistake" /> Mistakes you repeat move for move</h2>
          <p className="mt-1 text-sm text-ink-400">The same position, the same bad move – in different games. {r.repeatTotal} of these in total; the costliest first.</p>
        </div>
        <Button onClick={() => drill(all, 'Mistakes I repeat')}><Dumbbell size={15} /> Drill them all</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {r.repeats.slice(0, 12).map(x => <RepeatCard key={`${x.fenBefore}-${x.san}`} x={x} />)}
      </div>
    </section>
  )
}

function RepeatCard({ x }: { x: CoachRepeat }) {
  const shapes = [
    ...(x.bestUci ? [{ orig: uciSquares(x.bestUci)[0] as Key, dest: uciSquares(x.bestUci)[1] as Key, brush: 'best' }] : []),
    ...(x.uci ? [{ orig: uciSquares(x.uci)[0] as Key, dest: uciSquares(x.uci)[1] as Key, brush: 'blunder' }] : []),
  ]
  return (
    <Card className="p-3">
      <button onClick={() => go(`/review/${x.lastGame}/${x.lastPly}`)} className="block w-full cursor-pointer" title="Open the latest game">
        <div className="pointer-events-none aspect-square overflow-hidden rounded-lg ring-1 ring-white/[0.08]">
          <Board fen={x.fenBefore} orientation={turnOf(x.fenBefore)} shapes={shapes} />
        </div>
      </button>
      <div className="mt-2.5 flex items-baseline justify-between gap-2">
        <span className="text-sm"><span className="text-ink-500">Move {x.moveNo}:</span> <b className="text-[#ff8796]">{x.san}</b></span>
        <span className="font-mono text-xs text-[#ff8796]">×{x.times}</span>
      </div>
      <div className="mt-0.5 text-xs text-ink-400">
        You played it in {x.times} of the {x.reached} games that reached this position. Better: <b className="text-best">{x.bestSan}</b>
      </div>
      <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => drill(x.refs, `Repeat: ${x.san} on move ${x.moveNo}`)}><Dumbbell size={13} /> Drill</Button>
    </Card>
  )
}

/** Share of games per 100-game block, oldest → newest. */
function Spark({ values, className }: { values: number[]; className?: string }) {
  const w = 96, h = 24, max = Math.max(...values, 1), min = Math.min(...values, 0)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 4) - 2}`).join(' ')
  const last = values[values.length - 1], first = values[0]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={clsx('h-6 w-24 overflow-visible', className)} aria-label="trend over your games">
      <title>{`Share of games, per 100 games (oldest → newest): ${values.map(v => `${v.toFixed(0)}%`).join(', ')}`}</title>
      <polyline points={pts} fill="none" stroke={last <= first ? '#7fd858' : '#ff8796'} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

const PLAN_ICON: Record<string, React.ReactNode> = {
  habit: <Dumbbell size={16} />, repeats: <Repeat size={16} />, warning: <TriangleAlert size={16} />, nightmare: <Skull size={16} />,
}

function Plan({ r }: { r: CoachReport }) {
  const run = (p: CoachPlanItem) => {
    if (p.action === 'drill-habit') {
      const h = r.habits.find(x => x.key === p.habit) ?? r.habits[0]
      if (h) void drill(h.examples, h.title)
    } else if (p.action === 'drill-repeats') void drill(r.repeats.flatMap(x => x.refs), 'Mistakes I repeat')
    else if (p.action === 'blunder-check') go('/safety/play/mixed/20')
    else if (p.action === 'openings') go('/openings')
    else if (p.action === 'nightmare') go('/nightmare')
  }
  const label: Record<string, string> = {
    'drill-habit': 'Start drill', 'drill-repeats': 'Start drill', 'blunder-check': 'Blunder check', openings: 'Opening trainer', nightmare: 'Play',
  }
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 font-display text-xl font-semibold"><ListChecks size={19} className="text-accent" /> Your training plan</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {r.plan!.map((p, i) => (
          <Card key={p.key} className="flex flex-col p-4">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent/12 text-accent ring-1 ring-inset ring-accent/25">{PLAN_ICON[p.key] ?? <BookOpen size={16} />}</span>
              <span className="font-mono text-xs text-ink-500">step {i + 1}</span>
            </div>
            <div className="mt-2 text-sm font-semibold leading-snug">{p.title}</div>
            <p className="mt-1 flex-1 text-xs text-ink-400">{p.why}</p>
            {p.action !== 'none' && label[p.action] && (
              <Button size="sm" variant={i === 0 ? 'primary' : 'soft'} className="mt-3 self-start" onClick={() => run(p)}>{label[p.action]} <ArrowRight size={13} /></Button>
            )}
          </Card>
        ))}
      </div>
    </section>
  )
}

function Notes({ title, icon, notes, tone }: { title: string; icon: React.ReactNode; notes: CoachNote[]; tone: 'good' | 'bad' }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold">{icon}{title}</h3>
      {notes.length === 0 && <p className="text-sm text-ink-400">{tone === 'good' ? 'Keep playing – strengths show up with more games.' : 'Nothing stands out right now.'}</p>}
      <ul className="space-y-2.5">
        {notes.map(n => (
          <li key={n.key} className={clsx('rounded-xl p-3 text-sm ring-1 ring-inset', tone === 'good' ? 'bg-best/[0.05] ring-best/15' : 'bg-mistake/[0.06] ring-mistake/20')}>
            <div className="font-medium text-ink-100">{n.title}</div>
            <div className="mt-0.5 text-xs text-ink-300">{n.text}</div>
            {n.tip && <div className="mt-1.5 text-xs text-ink-400"><span className="text-accent">Try:</span> {n.tip}</div>}
          </li>
        ))}
      </ul>
    </Card>
  )
}
