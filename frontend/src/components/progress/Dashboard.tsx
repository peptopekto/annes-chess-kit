import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, Award, CalendarDays, Flame, Medal, Minus, TrendingUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { accuracyColor } from '../../lib/chess'
import { go } from '../../lib/router'
import type { StatBlock, StatsReport } from '../../lib/types'
import { Card } from '../ui'

const AXIS = { fill: '#6c717f', fontSize: 11 }
const SERIES = ['#2ee6d1', '#5b8cff', '#f7c845', '#a78bfa']

function H({ icon, children, right }: { icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">{icon}{children}</h2>
      {right && <span className="text-xs text-ink-500">{right}</span>}
    </div>
  )
}

function WDL({ b }: { b: StatBlock }) {
  const n = b.wins + b.draws + b.losses || 1
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
        <div className="bg-best" style={{ width: `${(b.wins / n) * 100}%` }} />
        <div className="bg-ink-500" style={{ width: `${(b.draws / n) * 100}%` }} />
        <div className="bg-blunder" style={{ width: `${(b.losses / n) * 100}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-xs">
        <span className="text-best">{b.wins} W</span><span className="text-ink-400">{b.draws} D</span><span className="text-[#ff7b8d]">{b.losses} L</span>
      </div>
    </div>
  )
}

/** Wins/draws/losses, score, streaks, colours. */
export function RecordCard({ s }: { s: StatsReport }) {
  const r = s.record
  const streak = r.streak.kind === 'win' ? `${r.streak.n} win${r.streak.n === 1 ? '' : 's'} in a row`
    : r.streak.kind === 'loss' ? `${r.streak.n} loss${r.streak.n === 1 ? '' : 'es'} in a row` : r.streak.kind === 'draw' ? 'last game drawn' : '—'
  return (
    <Card className="p-5">
      <H icon={<Award size={18} className="text-best" />}>Your record</H>
      <div className="grid grid-cols-2 gap-5">
        <div>
          <div className="text-xs text-ink-500">All {r.all.games} games</div>
          <div className="mb-2 font-display text-2xl font-semibold tabular-nums">{r.all.score ?? '—'}%<span className="ml-1 text-xs font-normal text-ink-500">score</span></div>
          <WDL b={r.all} />
        </div>
        <div>
          <div className="text-xs text-ink-500">Last {r.recent.games} games</div>
          <div className="mb-2 font-display text-2xl font-semibold tabular-nums">{r.recent.score ?? '—'}%<span className="ml-1 text-xs font-normal text-ink-500">score</span></div>
          <WDL b={r.recent} />
        </div>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3 text-sm">
        <div><div className="text-xs text-ink-500">Current</div><div className={clsx('font-medium', r.streak.kind === 'win' ? 'text-best' : r.streak.kind === 'loss' ? 'text-[#ff8796]' : '')}>{streak}</div></div>
        <div><div className="text-xs text-ink-500">Best win streak</div><div className="flex items-center gap-1 font-medium"><Flame size={14} className="text-mistake" />{r.bestWinStreak}</div></div>
        <div><div className="text-xs text-ink-500">Best unbeaten run</div><div className="font-medium">{r.bestUnbeaten}</div></div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-4 text-sm">
        {(['white', 'black'] as const).map(c => (
          <div key={c} className="flex items-center gap-2">
            <span className={clsx('size-3 rounded-full ring-1 ring-white/30', c === 'white' ? 'bg-white' : 'bg-ink-950')} />
            <span className="text-ink-300 capitalize">{c}</span>
            <span className="ml-auto font-mono font-semibold">{r[c].score ?? '—'}%</span>
            <span className="font-mono text-xs" style={{ color: accuracyColor(r[c].accuracy) }}>{r[c].accuracy ?? '—'}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Rating per platform & time control over time. */
export function RatingCard({ s }: { s: StatsReport }) {
  const series = s.ratings
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const data = useMemo(() => {
    const months = [...new Set(series.flatMap(x => x.points.map(p => p.month)))].sort()
    return months.map(m => {
      const row: Record<string, string | number | null> = { month: m }
      series.forEach((x, i) => { row[`s${i}`] = x.points.find(p => p.month === m)?.elo ?? null })
      return row
    })
  }, [series])
  if (!series.length) return null
  const label = (x: StatsReport['ratings'][number]) => `${x.source === 'chess.com' ? 'Chess.com' : x.source === 'lichess' ? 'Lichess' : x.source} ${x.tc}`
  return (
    <Card className="p-5">
      <H icon={<TrendingUp size={18} className="text-great" />} right="last game of each month">Rating</H>
      <div className="mb-3 flex flex-wrap gap-2">
        {series.map((x, i) => (
          <button key={i} onClick={() => setHidden(h => { const n = new Set(h); if (n.has(i)) n.delete(i); else n.add(i); return n })}
            className={clsx('flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-inset transition cursor-pointer',
              hidden.has(i) ? 'opacity-40 ring-white/[0.06]' : 'bg-white/[0.03] ring-white/[0.08]')}>
            <span className="size-2 rounded-full" style={{ background: SERIES[i] }} />
            <span className="text-ink-200">{label(x)}</span>
            <span className="font-mono font-semibold">{x.current}</span>
            {x.change90 != null && <span className={clsx('font-mono', x.change90 >= 0 ? 'text-best' : 'text-[#ff8796]')}>{x.change90 >= 0 ? '+' : ''}{x.change90} 90d</span>}
            <span className="text-ink-500">peak {x.peak}</span>
          </button>
        ))}
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
            <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} minTickGap={28}
              tickFormatter={m => new Date(`${m}-01`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })} />
            <YAxis domain={['auto', 'auto']} tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} width={44} />
            <Tooltip isAnimationActive={false} cursor={{ stroke: '#fff', strokeOpacity: 0.12 }} content={({ active, payload, label: m }) => {
              if (!active || !payload?.length) return null
              return (
                <div className="popover rounded-lg px-3 py-2 text-xs">
                  <div className="mb-1 font-medium text-ink-100">{new Date(`${m}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
                  {payload.map(p => p.value != null && (
                    <div key={String(p.dataKey)} className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ background: p.color }} />
                      <span className="text-ink-300">{label(series[Number(String(p.dataKey).slice(1))])}</span>
                      <span className="ml-auto font-mono font-semibold">{p.value}</span>
                    </div>
                  ))}
                </div>
              )
            }} />
            {series.map((_, i) => !hidden.has(i) && (
              <Line key={i} dataKey={`s${i}`} stroke={SERIES[i]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false}
                activeDot={{ r: 4, fill: SERIES[i], stroke: '#0b0c0f', strokeWidth: 2 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

/** Recent games vs the ones before, metric by metric. */
export function TrendTable({ s }: { s: StatsReport }) {
  const fmt = (v: number | null, unit: string) => (v == null ? '—' : `${unit === '%' ? v.toFixed(1) : v.toFixed(2)}${unit}`)
  return (
    <Card className="p-5">
      <H icon={<TrendingUp size={18} className="text-accent" />} right={`last ${s.recentGames} games vs the ${s.beforeGames} before`}>Getting better or worse?</H>
      <div className="divide-y divide-white/[0.05]">
        {s.trend.map(m => (
          <div key={m.key} className="grid grid-cols-[1fr_72px_72px_110px] items-center gap-2 py-2 text-sm">
            <span className="text-ink-200">{m.label}</span>
            <span className="text-right font-mono text-xs text-ink-500" title="the 200 games before">{fmt(m.before, m.unit)}</span>
            <span className="text-right font-mono font-semibold">{fmt(m.recent, m.unit)}</span>
            <span className={clsx('flex items-center justify-end gap-1 text-xs font-medium',
              m.better == null || !m.notable ? 'text-ink-500' : m.better ? 'text-best' : 'text-[#ff8796]')}>
              {m.delta == null ? 'new' : !m.notable ? <><Minus size={13} /> steady</> : m.better
                ? <><ArrowUpRight size={13} /> better</> : <><ArrowDownRight size={13} /> worse</>}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Personal bests – each opens its game. */
export function RecordsCard({ s }: { s: StatsReport }) {
  return (
    <Card className="p-5">
      <H icon={<Medal size={18} className="text-inaccuracy" />}>Personal records</H>
      <div className="grid gap-2 sm:grid-cols-2">
        {s.records.map(r => (
          <button key={r.key} disabled={!r.gameId} onClick={() => r.gameId && go(`/review/${r.gameId}`)}
            className="rounded-xl bg-white/[0.03] p-3 text-left ring-1 ring-inset ring-white/[0.06] transition enabled:hover:bg-white/[0.06] enabled:cursor-pointer">
            <div className="text-xs text-ink-500">{r.title}</div>
            <div className="font-display text-xl font-semibold tabular-nums">{r.value}</div>
            {(r.opponent || r.detail) && <div className="truncate text-xs text-ink-400">{r.opponent ? `vs ${r.opponent}` : ''}{r.opponent && r.detail ? ' · ' : ''}{r.detail ?? ''}</div>}
          </button>
        ))}
      </div>
    </Card>
  )
}

/** A year of games, GitHub-style. */
export function ActivityCard({ s }: { s: StatsReport }) {
  const { weeks, max, total, days } = useMemo(() => {
    const by = new Map(s.activity.map(a => [a.date, a]))
    const today = new Date()
    const start = new Date(today)
    start.setDate(start.getDate() - 364 - ((start.getDay() + 6) % 7)) // a Monday ~a year ago
    const weeks: { date: string; games: number; score: number }[][] = []
    let max = 1, total = 0, days = 0
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const a = by.get(key)
      if ((d.getDay() + 6) % 7 === 0) weeks.push([])
      weeks[weeks.length - 1]?.push({ date: key, games: a?.games ?? 0, score: a?.score ?? 0 })
      if (a) { max = Math.max(max, a.games); total += a.games; days += 1 }
    }
    return { weeks, max, total, days }
  }, [s.activity])
  return (
    <Card className="p-5">
      <H icon={<CalendarDays size={18} className="text-great" />} right={`${total} games on ${days} days in the last year`}>Activity</H>
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-[3px]">
          {weeks.map((w, i) => (
            <div key={i} className="flex flex-col gap-[3px]">
              {w.map(d => (
                <div key={d.date} title={`${d.date}: ${d.games} game${d.games === 1 ? '' : 's'}${d.games ? ` · ${d.score}% score` : ''}`}
                  className="size-[11px] rounded-[3px]"
                  style={{ background: d.games ? `rgba(46,230,209,${0.18 + 0.82 * (d.games / max)})` : 'rgba(255,255,255,0.04)' }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
