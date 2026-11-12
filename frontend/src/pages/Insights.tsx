import clsx from 'clsx'
import { motion } from 'motion/react'
import {
  AlertTriangle, Brain, ChevronDown, Clock, Crown, Dumbbell, Hourglass, Sparkles, ThumbsUp, TrendingDown, Trophy,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { WhenBest } from '../components/insights/WhenBest'
import { Button, Card, CardsSkeleton, CountUp, ErrorNote, Segmented, Skeleton } from '../components/ui'
import { api } from '../lib/api'
import { CLS, ClassIcon } from '../lib/classes'
import { accuracyColor, moveNumber } from '../lib/chess'
import { go } from '../lib/router'
import { Delta, TrendSection } from '../components/insights/Trend'
import { EndingsSection, FocusCard, HabitsSection, MindsetSection, OpponentsSection, TacticsSection } from '../components/insights/Beginner'
import { drill } from '../components/insights/drill'
import { Section } from '../components/insights/Section'
import type { Insights, MoveRef, RateRow } from '../lib/types'

const MIN_BUCKET = 5
const PHASE_LABEL: Record<string, string> = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' }
const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)

type Period = 'all' | 'd30' | 'd90' | 'd365' | 'g50' | 'g20'
const PERIODS: { value: Period; label: string }[] = [
  { value: 'all', label: 'All time' }, { value: 'd365', label: '1 year' }, { value: 'd90', label: '90 days' },
  { value: 'd30', label: '30 days' }, { value: 'g50', label: 'Last 50' }, { value: 'g20', label: 'Last 20' },
]

function periodQuery(p: Period): { since?: string; last: number } {
  if (p.startsWith('g')) return { last: Number(p.slice(1)) }
  if (p.startsWith('d')) {
    const d = new Date(Date.now() - Number(p.slice(1)) * 86400_000)
    return { since: d.toISOString().slice(0, 10), last: 0 }
  }
  return { last: 0 }
}

const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function Comparing({ data, period }: { data: Insights; period: Period }) {
  const span = data.span
  if (!span) return null
  const b = data.baseline
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
      <span>
        <b className="text-ink-200">{data.games}</b> games · {fmtDay(span[0])} – {fmtDay(span[1])}
      </span>
      {period !== 'all' && (b
        ? <span className="rounded-full bg-accent/10 px-2 py-0.5 font-semibold text-accent">compared with {b.games} earlier games – ▲▼ chips show the change</span>
        : <span>(no earlier games to compare with)</span>)}
    </div>
  )
}

export function InsightsPage() {
  const [tc, setTc] = useState('all')
  const [color, setColor] = useState('all')
  const [period, setPeriod] = useState<Period>('all')
  const [data, setData] = useState<Insights | null>(null)
  const { since, last } = periodQuery(period)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true // a slower, older response must not overwrite the current filter's data
    setLoading(true)
    api.insights({ tc, color, last, since }).then(d => { if (alive) { setData(d); setError(null) } })
      .catch(e => { if (alive) setError(String(e.message ?? e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tc, color, last, since])

  const tcs = data?.timeClasses ?? []

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[30px] leading-tight font-semibold"><span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-white/[0.08]"><Brain size={18} className="text-accent-2" /></span> My mistakes</h1>
          <p className="mt-1 text-sm text-ink-400">What goes wrong most often in your analyzed games, and where you lose the most – with a practice button for each.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tcs.length > 1 && (
            <Segmented value={tc} onChange={setTc} options={[{ value: 'all', label: 'All' }, ...tcs.map(t => ({ value: t, label: <span className="capitalize">{t}</span> }))]} />
          )}
          <Segmented value={color} onChange={setColor} options={[
            { value: 'all', label: 'Both' },
            { value: 'w', label: <><span className="size-2.5 rounded-full bg-white" /> White</> },
            { value: 'b', label: <><span className="size-2.5 rounded-full bg-ink-950 ring-1 ring-white/40" /> Black</> },
          ]} />
          <Segmented value={period} onChange={setPeriod} options={PERIODS} />
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        <div className="space-y-4">
          <Skeleton className="h-36 rounded-2xl" />
          <CardsSkeleton count={6} h="h-20" />
          <CardsSkeleton count={4} className="grid grid-cols-2 gap-3 lg:grid-cols-4" />
        </div>
      ) : data.games === 0 ? (
        <Card className="p-10 text-center text-ink-300">
          No reviewed games of yours match these filters. Set your username in Settings and analyse a few games first.
        </Card>
      ) : (
        <div className={clsx('space-y-6 transition-opacity', loading && 'opacity-60')}>
          <Comparing data={data} period={period} />
          <FocusCard data={data} />
          <Summary data={data} />
          <Tiles data={data} />
          <TrendSection tc={tc} color={color} since={since} />
          <WhenBest />
          <Phases data={data} />
          <TacticsSection data={data} />
          <div className="grid gap-6 lg:grid-cols-2">
            <MistakeTypes data={data} />
            <Pieces data={data} />
          </div>
          <MindsetSection data={data} />
          <EndingsSection data={data} />
          <HabitsSection data={data} />
          <ClockSection data={data} />
          <Openings data={data} />
          <OpponentsSection data={data} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Thrown data={data} />
            <Comebacks data={data} />
          </div>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //

function Summary({ data }: { data: Insights }) {
  if (!data.summary.length) return null
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.summary.map((t, i) => {
        const tag = t.tag ? data.tags?.find(x => x.tag === t.tag) : null
        const refs = tag?.examples ?? (t.kind === 'thrown' ? data.thrown ?? [] : t.kind === 'phase'
          ? [...(data.phases ?? [])].sort((a, b) => (a.accuracy ?? 100) - (b.accuracy ?? 100))[0]?.examples ?? [] : [])
        const good = t.tone === 'good'
        return (
          <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
            className={clsx('flex items-start gap-3 rounded-2xl p-4 ring-1',
              good ? 'bg-best/8 ring-best/25' : 'bg-mistake/8 ring-mistake/25')}>
            <span className={clsx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl',
              good ? 'bg-best/15 text-best' : 'bg-mistake/15 text-mistake')}>
              {good ? <ThumbsUp size={16} /> : <AlertTriangle size={16} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-relaxed text-ink-100">{t.text}</p>
              {!good && refs.length > 0 && (
                <Button size="sm" variant="ghost" className="mt-1 -ml-3 text-accent" onClick={() => drill(refs, tag?.label ?? (t.kind === 'thrown' ? 'Thrown wins' : 'Weak phase'))}>
                  <Dumbbell size={14} /> Drill {Math.min(60, refs.length)} of these positions
                </Button>
              )}
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

function Tiles({ data }: { data: Insights }) {
  const r = data.record!
  const b = data.baseline, c = data.core
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Games · {data.moves} moves</div>
        <div className="mt-2 flex items-baseline gap-2 font-display">
          <span className="text-4xl font-extrabold"><CountUp to={data.games} /></span>
          <span className="text-sm font-bold"><span className="text-best">{r.win}W</span> <span className="text-ink-300">{r.draw}D</span> <span className="text-blunder">{r.loss}L</span></span>
        </div>
        {b && <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-400">score {c?.winRate}% <Delta now={c?.winRate} before={b.winRate} unit="%" digits={0} /></div>}
      </Card>
      <Card className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-ink-400" title="Weighted by moves played; games under 10 moves left out">Accuracy (weighted)</div>
        <div className="mt-2 font-display text-4xl font-semibold tabular-nums" style={{ color: accuracyColor(data.accuracy) }}>
          {data.accuracy == null ? '—' : <CountUp to={data.accuracy} decimals={1} />}
        </div>
        {b && <Delta now={c?.accuracy} before={b.accuracy} unit="%" className="mt-1" />}
      </Card>
      <Card className="p-4">
        <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-400">Blunders / game <ClassIcon cls="blunder" size={18} /></div>
        <div className="mt-2 font-display text-4xl font-semibold tabular-nums text-blunder"><CountUp to={data.blundersPerGame ?? 0} decimals={2} /></div>
        {b && <Delta now={c?.blundersPerGame} before={b.blundersPerGame} better="down" digits={2} className="mt-1" />}
      </Card>
      <Card className="p-4">
        <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-400">Errors / 40 moves <ClassIcon cls="mistake" size={18} /></div>
        <div className="mt-2 font-display text-4xl font-semibold tabular-nums text-mistake"><CountUp to={data.errorsPer40 ?? 0} decimals={1} /></div>
        {b && <Delta now={c?.errorsPer40} before={b.errorsPer40} better="down" className="mt-1" />}
      </Card>
    </div>
  )
}

function Phases({ data }: { data: Insights }) {
  const phases = data.phases ?? []
  const worst = [...phases].filter(p => p.moves >= 20 && p.accuracy != null).sort((a, b) => a.accuracy! - b.accuracy!)[0]
  return (
    <Section title="By game phase" icon={<TrendingDown size={18} className="text-mistake" />}
      help={<><b>Move accuracy</b> (0–100) is the average of your moves' accuracy in each phase – how close they were to the engine's best. It runs higher than game accuracy, which weighs your worst moves more. The game is split into opening (first 10 moves / book), middlegame and endgame (few pieces left). Your weakest phase is the best place to study next.</>}>
      <div className="grid gap-3 sm:grid-cols-3">
        {phases.map(p => (
          <div key={p.phase} className={clsx('rounded-2xl p-4 ring-1', p === worst ? 'bg-mistake/8 ring-mistake/30' : 'bg-ink-850 ring-white/5')}>
            <div className="flex items-center justify-between">
              <span className="font-semibold">{PHASE_LABEL[p.phase]}</span>
              {p === worst && <span className="rounded-full bg-mistake/20 px-2 py-0.5 text-[11px] font-medium uppercase text-mistake">Weakest</span>}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="font-display text-4xl font-semibold tabular-nums" style={{ color: accuracyColor(p.accuracy) }}>
                {p.accuracy ?? '—'}<span className="text-lg">{p.accuracy != null && '%'}</span>
              </span>
              {data.baseline && <Delta now={p.accuracy} before={data.baseline[p.phase as 'opening']} unit="%" />}
            </div>
            <div className="mt-1 space-y-0.5 text-xs text-ink-300">
              <div>{p.moves} moves · mistakes on <b className="text-ink-100">{pct(p.errorRate)}</b></div>
              <div>{p.blunders} blunder{p.blunders === 1 ? '' : 's'} · loses {p.lossPerMove ?? '—'}% win chance / move</div>
            </div>
            {p.examples.length > 0 && (
              <Button size="sm" variant="ghost" className="mt-2 -ml-3 text-accent" onClick={() => drill(p.examples, `${PHASE_LABEL[p.phase]} mistakes`)}>
                <Dumbbell size={14} /> Drill {Math.min(60, p.count)} of them
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-400">Opening = book moves and moves 1–10 · Endgame = 6 or fewer pieces (excl. pawns & kings) left.</p>
    </Section>
  )
}

function MistakeTypes({ data }: { data: Insights }) {
  const tags = (data.tags ?? []).filter(t => t.count > 0)
  const max = Math.max(1, ...tags.map(t => t.count))
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Section title="What goes wrong" icon={<AlertTriangle size={18} className="text-blunder" />}
      help={<>Your costly moves (mistakes, misses and blunders) sorted by what happened: you <b>hung a piece</b>, <b>allowed a mate</b>, <b>missed a mate</b> or a <b>winning shot</b>, or <b>didn't punish</b> your opponent's mistake. "Lost the thread" means no single tactic – the position just got worse.</>}>
      <p className="-mt-2 mb-3 text-xs text-ink-400">Your mistakes, misses and blunders, by type{data.baseline ? ' – chips compare the rate per game with earlier games' : ''}.</p>
      <div className="space-y-1.5">
        {tags.map(t => (
          <div key={t.tag}>
            <button onClick={() => setOpen(o => (o === t.tag ? null : t.tag))}
              className="group flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left hover:bg-white/[0.03] cursor-pointer">
              <span className="w-40 shrink-0 truncate text-sm font-medium">{t.label}</span>
              <div className="h-6 flex-1 overflow-hidden rounded-md bg-ink-850">
                <motion.div className="h-full rounded-md bg-gradient-to-r from-mistake/80 to-blunder/80"
                  initial={{ width: 0 }} animate={{ width: `${(t.count / max) * 100}%` }} transition={{ duration: 0.6 }} />
              </div>
              <span className="w-8 text-right font-display font-semibold tabular-nums">{t.count}</span>
              {data.baseline && t.tag !== 'positional' && (
                <Delta now={data.core?.[t.tag as 'hung_piece']} before={data.baseline[t.tag as 'hung_piece']} better="down" digits={2} />
              )}
              <ChevronDown size={14} className={clsx('text-ink-400 transition', open === t.tag && 'rotate-180')} />
            </button>
            {open === t.tag && (
              <div className="mb-2 ml-1 space-y-1 border-l border-white/10 pl-3">
                <MoveRefList refs={t.examples} total={t.count} />
                <Button size="sm" variant="ghost" className="-ml-3 text-accent" onClick={() => drill(t.examples, t.label)}>
                  <Dumbbell size={14} /> Drill {Math.min(60, t.count)} of them
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

function MoveRefList({ refs, limit = 6, total }: { refs: MoveRef[]; limit?: number; total?: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? refs : refs.slice(0, limit)
  return (
    <>
      {shown.map(r => (
        <button key={`${r.gameId}-${r.ply}`} onClick={() => go(`/review/${r.gameId}/${r.ply}`)}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-white/5 cursor-pointer">
          <ClassIcon cls={r.cls} size={16} />
          <span className="font-semibold">{moveNumber(r.fenBefore)} {r.san}</span>
          <span className="text-ink-400">best {r.bestSan}</span>
          <span className="ml-auto truncate text-ink-500">{r.white} – {r.black} · {r.date}</span>
        </button>
      ))}
      {all && total != null && total > refs.length && (
        <div className="px-1.5 text-xs text-ink-500">Showing the newest {refs.length} of {total}.</div>
      )}
      {refs.length > limit && !all && (
        <button className="px-1.5 text-xs text-ink-400 hover:text-white cursor-pointer" onClick={() => setAll(true)}>+{refs.length - limit} more</button>
      )}
    </>
  )
}

function RateChart({ rows, color, label }: { rows: { name: string; rate: number | null; moves: number }[]; color: string; label: string }) {
  // Buckets with only a handful of moves are noise (1 move = 0% or 100%): don't plot them.
  const data = rows.map(r => ({ ...r, value: r.rate == null || r.moves < MIN_BUCKET ? 0 : r.rate * 100 }))
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
          <XAxis dataKey="name" tick={{ fill: '#8f99b8', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#5d6888', fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
          <Tooltip cursor={{ fill: '#ffffff', fillOpacity: 0.04 }} content={({ active, payload }) => {
            const p = active && payload?.[0]?.payload
            if (!p) return null
            return <div className="glass rounded-lg px-3 py-2 text-xs"><div className="font-semibold capitalize">{p.name}</div>
              <div>{label}: <b>{p.rate == null || p.moves < MIN_BUCKET ? 'too few moves' : `${p.value.toFixed(1)}%`}</b></div><div className="text-ink-400">{p.moves} moves</div></div>
          }} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={44}>
            {data.map((d, i) => <Cell key={i} fill={color} fillOpacity={d.moves < 10 ? 0.35 : 0.9} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function Pieces({ data }: { data: Insights }) {
  const order = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']
  const rows = order.map(p => data.pieces?.find(x => x.piece === p)).filter(Boolean).map(p => ({ name: p!.piece, rate: p!.errorRate, moves: p!.moves }))
  return (
    <Section title="Mistakes by piece" icon={<Crown size={18} className="text-inaccuracy" />}
      help={<>Which piece you were moving when things went wrong. A high bar for the <b>king</b> often means endgame king walks or unsafe king moves; for the <b>queen</b>, often queen raids that lose time or get trapped.</>}>
      <p className="-mt-2 mb-3 text-xs text-ink-400">Share of moves with each piece that were a mistake or worse.</p>
      <RateChart rows={rows} color={CLS.mistake.color} label="Mistake rate" />
    </Section>
  )
}

function ClockSection({ data }: { data: Insights }) {
  const c = data.clock
  const enough = c && c.moves >= 20
  const rows = (rs: RateRow[]) => rs.map(r => ({ name: r.bucket, rate: r.errorRate, moves: r.moves }))
  return (
    <Section title="Clock & tempo" icon={<Clock size={18} className="text-great" />}
      help={<>How often your moves are mistakes depending on <b>how much time you had left</b> and <b>how long you thought</b>. Very fast moves going wrong a lot means you're moving on autopilot; mistakes piling up under 30 seconds means time trouble.</>}>
      {!enough ? (
        <p className="text-sm text-ink-400">
          Not enough clock data yet ({c?.moves ?? 0} timed moves). Chess.com games include clocks; Lichess games imported
          from now on do too.
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Hourglass size={14} /> Mistake rate by time left</div>
            <RateChart rows={rows(c!.remaining)} color={CLS.great.color} label="Mistake rate" />
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Clock size={14} /> Mistake rate by time spent on the move</div>
            <RateChart rows={rows(c!.spent)} color={CLS.great.color} label="Mistake rate" />
          </div>
          <p className="text-xs text-ink-400 md:col-span-2">Based on {c!.moves} timed moves. Faded bars have fewer than 10 moves; buckets under 5 aren't plotted.</p>
        </div>
      )}
    </Section>
  )
}

function Openings({ data }: { data: Insights }) {
  const ops = (data.openings ?? []).slice(0, 14)
  return (
    <Section title="Openings" icon={<Sparkles size={18} className="text-book" />}
      help={<><b>Score</b> = wins + ½ draws per game. <b>Opening acc.</b> is your accuracy in the first moves only. A low score with high opening accuracy means the trouble starts later; low opening accuracy means it's worth learning that opening's main ideas.</>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
            <tr><th className="pb-2">Opening</th><th className="pb-2 text-right">Games</th><th className="pb-2 text-right">Score</th>
              <th className="pb-2 text-right">Accuracy</th><th className="pb-2 text-right" title="Accuracy in the opening phase only">Opening acc.</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {ops.map(o => (
              <tr key={o.name + o.color}>
                <td className="py-2 pr-3">
                  <span className={clsx('mr-2 inline-block size-2.5 rounded-full ring-1 ring-white/30', o.color === 'w' ? 'bg-white' : 'bg-ink-950')} />
                  {o.name}
                </td>
                <td className="text-right tabular-nums text-ink-300">{o.games}</td>
                <td className="text-right font-bold tabular-nums" style={{ color: o.score >= 60 ? CLS.best.color : o.score <= 40 ? CLS.blunder.color : undefined }}>{o.score}%</td>
                <td className="text-right font-semibold tabular-nums" style={{ color: accuracyColor(o.accuracy) }}>{o.accuracy ?? '—'}</td>
                <td className="text-right tabular-nums text-ink-300">{o.openingAccuracy ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

function Thrown({ data }: { data: Insights }) {
  const all = data.thrown ?? []
  const [n, setN] = useState(8)
  const t = all.slice(0, n)
  return (
    <Section title={`Wins that slipped away${data.thrownCount ? ` (${data.thrownCount})` : ''}`} icon={<TrendingDown size={18} className="text-blunder" />}
      action={t.length > 0 && <Button size="sm" variant="ghost" className="text-accent" onClick={() => drill(all, 'Thrown wins')}><Dumbbell size={14} /> Drill</Button>}>
      {t.length === 0 ? <p className="text-sm text-ink-400">None – you convert your winning positions. 👏</p> : (
        <div className="space-y-1.5">
          {t.map(x => (
            <button key={x.gameId} onClick={() => go(`/review/${x.gameId}/${x.ply}`)}
              className="flex w-full items-center gap-3 rounded-xl bg-ink-850 px-3 py-2 text-left text-sm ring-1 ring-white/5 hover:bg-ink-800 cursor-pointer">
              <span className="w-12 shrink-0 font-display font-semibold text-best">{x.peak}%</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{x.white} – {x.black}</div>
                <div className="flex items-center gap-1 text-xs text-ink-400">
                  slipped with <ClassIcon cls={x.cls} size={13} /> <b className="text-ink-200">{moveNumber(x.fenBefore)} {x.san}</b> · ended in a {x.outcome}
                </div>
              </div>
            </button>
          ))}
          <More shown={t.length} available={all.length} total={data.thrownCount ?? all.length} onMore={() => setN(x => x + 20)} />
        </div>
      )}
    </Section>
  )
}

function Comebacks({ data }: { data: Insights }) {
  const all = data.comebacks ?? []
  const [n, setN] = useState(8)
  const c = all.slice(0, n)
  return (
    <Section title={`Comebacks${data.comebackCount ? ` (${data.comebackCount})` : ''}`} icon={<Trophy size={18} className="text-best" />}>
      {c.length === 0 ? <p className="text-sm text-ink-400">No great escapes yet – keep fighting in bad positions!</p> : (
        <div className="space-y-1.5">
          {c.map(x => (
            <button key={x.gameId} onClick={() => go(`/review/${x.gameId}`)}
              className="flex w-full items-center gap-3 rounded-xl bg-ink-850 px-3 py-2 text-left text-sm ring-1 ring-white/5 hover:bg-ink-800 cursor-pointer">
              <span className="w-12 shrink-0 font-display font-semibold text-blunder">{x.low}%</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{x.white} – {x.black}</div>
                <div className="text-xs text-ink-400">down to {x.low}% win chance – still {x.outcome === 'win' ? 'won' : 'drew'} · {x.date}</div>
              </div>
            </button>
          ))}
          <More shown={c.length} available={all.length} total={data.comebackCount ?? all.length} onMore={() => setN(x => x + 20)} />
        </div>
      )}
    </Section>
  )
}

function More({ shown, available, total, onMore }: { shown: number; available: number; total: number; onMore: () => void }) {
  if (shown >= available) {
    return total > available
      ? <div className="px-1 pt-1 text-xs text-ink-500">Showing the newest {available} of {total}.</div>
      : null
  }
  return (
    <button onClick={onMore} className="w-full rounded-lg py-1.5 text-xs font-semibold text-ink-400 hover:bg-white/5 hover:text-white cursor-pointer">
      Show more · {total - shown} left
    </button>
  )
}
