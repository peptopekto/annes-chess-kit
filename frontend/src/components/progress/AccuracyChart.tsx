import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, BarChart3, Clock, LineChart as LineIcon, ListOrdered } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { accuracyColor } from '../../lib/chess'
import { go } from '../../lib/router'
import { Segmented } from '../ui'

export interface AccPoint {
  t: number; acc: number; id: string; label: string; moves: number
  tc: string                        // bullet | blitz | rapid | daily | classical | unknown
  outcome: 'win' | 'loss' | 'draw' | null
}

type Range = 'all' | '365' | '90' | '30'
type View = 'trend' | 'recent' | 'tc' | 'dist'
const DAY = 86400_000
const AXIS = { fill: '#6c717f', fontSize: 11 }
const TC_COLOR: Record<string, string> = { bullet: '#ff6b81', blitz: '#f7c845', rapid: '#2ee6d1', classical: '#5b8cff', daily: '#a78bfa' }
const TC_ORDER = ['bullet', 'blitz', 'rapid', 'classical', 'daily']

/** Lichess's classification: estimated duration = base + 40 × increment. */
export function timeClass(tc: string | null | undefined): string {
  if (!tc || tc === '-' || tc === '?') return 'unknown'
  if (tc.includes('/')) return 'daily'
  const [base, inc] = tc.split('+').map(Number)
  if (!Number.isFinite(base)) return 'unknown'
  const est = base + 40 * (inc || 0)
  return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical'
}

/** Accuracy weighted by game length (a 60-move game says more than a 15-move one). */
function weighted(ps: AccPoint[]): number | null {
  const n = ps.reduce((s, p) => s + p.moves, 0)
  return n ? ps.reduce((s, p) => s + p.acc * p.moves, 0) / n : null
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/** Start of the week (Monday) or month containing t. */
function bucketStart(t: number, unit: 'week' | 'month'): number {
  const d = new Date(t)
  if (unit === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const day = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime()
}

const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10)

/**
 * Accuracy overview with switchable views. Thousands of games are summarised per week/month
 * (average + the middle half of your games as a band) instead of one dot per game; individual
 * games are only drawn in the "Recent games" view, where there are few enough to read.
 */
/** `shortGames`: games left out because they're too short to say much about accuracy. */
export function AccuracyChart({ points, shortGames = 0 }: { points: AccPoint[]; shortGames?: number }) {
  const [range, setRange] = useState<Range>('all')
  const [view, setView] = useState<View>('trend')

  const sorted = useMemo(() => [...points].sort((a, b) => a.t - b.t), [points])
  const { inRange, before } = useMemo(() => {
    const last = sorted.length ? sorted[sorted.length - 1].t : 0 // no games: nothing is in range anyway
    const span = range === 'all' ? Infinity : Number(range) * DAY
    const cut = range === 'all' ? -Infinity : last - span
    const prevCut = range === 'all' ? -Infinity : last - 2 * span
    return {
      inRange: sorted.filter(p => p.t > cut),
      before: range === 'all' ? [] : sorted.filter(p => p.t > prevCut && p.t <= cut),
    }
  }, [sorted, range])

  // ---- summary strip -------------------------------------------------------------
  const avg = weighted(inRange)
  const prevAvg = weighted(before)
  const delta = avg != null && prevAvg != null && before.length >= 5 ? avg - prevAvg : null
  const best = inRange.reduce<AccPoint | null>((b, p) => (p.moves >= 15 && (!b || p.acc > b.acc) ? p : b), null)
  const good = inRange.length ? inRange.filter(p => p.acc >= 80).length / inRange.length : null

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">Accuracy</h2>
        <Segmented value={range} onChange={setRange} options={[
          { value: 'all', label: 'All' }, { value: '365', label: '1y' }, { value: '90', label: '90d' }, { value: '30', label: '30d' },
        ]} />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label={range === 'all' ? 'Average (all time)' : 'Average in period'}
          value={avg != null ? avg.toFixed(1) : '—'} color={accuracyColor(avg)}
          sub={delta != null ? <Delta value={delta} /> : range === 'all' ? 'weighted by game length' : 'too few games before'} />
        <Stat label="Games" value={String(inRange.length)}
          sub={range !== 'all' ? `${before.length} in the period before` : shortGames ? `${shortGames} very short games left out` : 'reviewed'} />
        <Stat label="80%+ games" value={good != null ? `${Math.round(good * 100)}%` : '—'} sub="of your games in this period" />
        <Stat label="Best game" value={best ? best.acc.toFixed(1) : '—'} color={best ? accuracyColor(best.acc) : undefined}
          sub={best ? <button className="truncate text-left hover:text-ink-200 cursor-pointer" onClick={() => go(`/review/${best.id}`)}>{best.label} →</button> : '15+ moves'} />
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {([
          ['trend', 'Trend', LineIcon], ['recent', 'Recent games', ListOrdered], ['tc', 'Time controls', Clock], ['dist', 'Distribution', BarChart3],
        ] as const).map(([v, label, Icon]) => (
          <button key={v} onClick={() => setView(v)}
            className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors cursor-pointer',
              view === v ? 'bg-white/[0.08] text-white ring-1 ring-inset ring-white/[0.1]' : 'text-ink-400 hover:bg-white/[0.04] hover:text-ink-100')}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {inRange.length < 2 ? (
        <div className="flex h-64 items-center justify-center text-sm text-ink-400">Not enough games in this period yet.</div>
      ) : view === 'trend' ? <TrendView points={inRange} />
        : view === 'recent' ? <RecentView points={inRange} avg={avg} />
          : view === 'tc' ? <TimeControlView points={inRange} />
            : <DistributionView before={range === 'all' ? sorted.filter(p => p.t <= (sorted.at(-1)!.t - 90 * DAY)) : before}
              current={range === 'all' ? sorted.filter(p => p.t > sorted.at(-1)!.t - 90 * DAY) : inRange}
              labels={range === 'all' ? ['Last 90 days', 'Before'] : ['This period', 'Period before']} />}
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: ReactNode; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-500">{label}</div>
      <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      {sub && <div className="truncate text-xs text-ink-400">{sub}</div>}
    </div>
  )
}

function Delta({ value }: { value: number }) {
  const up = value >= 0
  return (
    <span className={clsx('inline-flex items-center gap-0.5 font-medium', up ? 'text-best' : 'text-blunder')}>
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(value).toFixed(1)} vs period before
    </span>
  )
}

function Tip({ children }: { children: ReactNode }) {
  return <div className="popover rounded-lg px-3 py-2 text-xs leading-relaxed">{children}</div>
}

// ---- views -----------------------------------------------------------------------

/** Average per week/month, a band for the middle half of your games, and game volume underneath. */
function TrendView({ points }: { points: AccPoint[] }) {
  const span = points[points.length - 1].t - points[0].t
  const unit: 'week' | 'month' = span <= 150 * DAY ? 'week' : 'month'
  const data = useMemo(() => {
    const groups = new Map<number, AccPoint[]>()
    for (const p of points) {
      const k = bucketStart(p.t, unit)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(p)
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([t, ps]) => {
      const accs = ps.map(p => p.acc).sort((a, b) => a - b)
      const lo = quantile(accs, 0.25), hi = quantile(accs, 0.75)
      return { t, n: ps.length, avg: round1(weighted(ps)), band: ps.length >= 3 ? [round1(lo), round1(hi)] : null,
        best: accs[accs.length - 1], worst: accs[0] }
    })
  }, [points, unit])
  const maxN = Math.max(...data.map(d => d.n))
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, unit === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' })

  return (
    <>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <defs>
              <linearGradient id="acc-band" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2ee6d1" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#2ee6d1" stopOpacity={0.06} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmt} tick={AXIS} axisLine={false} tickLine={false} minTickGap={32} />
            <YAxis yAxisId="acc" domain={[40, 100]} ticks={[40, 60, 80, 100]} tick={AXIS} axisLine={false} tickLine={false} allowDataOverflow />
            <YAxis yAxisId="n" hide domain={[0, maxN * 4]} />
            <Tooltip cursor={{ fill: '#fff', fillOpacity: 0.03 }} isAnimationActive={false} content={({ active, payload }) => {
              const d = active && payload?.[0]?.payload
              if (!d) return null
              return (
                <Tip>
                  <div className="font-medium text-ink-100">{unit === 'week' ? 'Week of ' : ''}{new Date(d.t).toLocaleDateString(undefined, unit === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                  <div className="font-mono text-sm font-semibold" style={{ color: accuracyColor(d.avg) }}>{d.avg?.toFixed(1)}% average</div>
                  <div className="text-ink-400">{d.n} game{d.n === 1 ? '' : 's'}{d.band && <> · middle half {d.band[0]}–{d.band[1]}%</>}</div>
                  <div className="text-ink-500">best {d.best.toFixed(0)} · worst {d.worst.toFixed(0)}</div>
                </Tip>
              )
            }} />
            <Bar yAxisId="n" dataKey="n" fill="#fff" fillOpacity={0.06} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Area yAxisId="acc" dataKey="band" type="monotone" stroke="none" fill="url(#acc-band)" connectNulls isAnimationActive={false} activeDot={false} />
            <Line yAxisId="acc" dataKey="avg" type="monotone" stroke="#2ee6d1" strokeWidth={2.25} isAnimationActive={false}
              dot={data.length <= 40 ? { r: 2.5, fill: '#2ee6d1', strokeWidth: 0 } : false}
              activeDot={{ r: 4.5, fill: '#2ee6d1', stroke: '#0b0c0f', strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legendish items={[
        { swatch: 'h-0.5 w-4 rounded bg-accent', label: `Average per ${unit}` },
        { swatch: 'h-2.5 w-4 rounded-sm bg-accent/20', label: 'Middle half of your games' },
        { swatch: 'h-2.5 w-2 rounded-sm bg-white/15', label: 'Games played' },
      ]} />
    </>
  )
}

/** The last 40 games as bars – here a single game is worth seeing; click one to open it. */
function RecentView({ points, avg }: { points: AccPoint[]; avg: number | null }) {
  const data = points.slice(-40).map((p, i) => ({ ...p, i }))
  return (
    <>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="18%">
            <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
            <XAxis dataKey="i" tick={false} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={AXIS} axisLine={false} tickLine={false} />
            {avg != null && <ReferenceLine y={avg} stroke="#fff" strokeOpacity={0.35} strokeDasharray="4 4" />}
            <Tooltip cursor={{ fill: '#fff', fillOpacity: 0.04 }} isAnimationActive={false} content={({ active, payload }) => {
              const p = active && (payload?.[0]?.payload as AccPoint | undefined)
              if (!p) return null
              return (
                <Tip>
                  <div className="font-medium text-ink-100">{p.label}</div>
                  <div className="text-ink-400">{new Date(p.t).toLocaleDateString()} · {p.moves} moves · <span className="capitalize">{p.tc}</span>
                    {p.outcome && <> · <span className={p.outcome === 'win' ? 'text-best' : p.outcome === 'loss' ? 'text-blunder' : ''}>{p.outcome}</span></>}</div>
                  <div className="font-mono text-sm font-semibold" style={{ color: accuracyColor(p.acc) }}>{p.acc.toFixed(1)}%</div>
                  <div className="text-[11px] text-ink-500">click to open the review</div>
                </Tip>
              )
            }} />
            <Bar dataKey="acc" radius={[4, 4, 1, 1]} cursor="pointer" isAnimationActive={false}
              onClick={(d: { payload?: AccPoint }) => d?.payload && go(`/review/${d.payload.id}`)}>
              {data.map(p => <Cell key={p.id} fill={accuracyColor(p.acc)} fillOpacity={p.outcome === 'loss' ? 0.55 : 0.9} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legendish items={[
        { swatch: 'h-2.5 w-2 rounded-sm bg-best', label: 'Win / draw' },
        { swatch: 'h-2.5 w-2 rounded-sm bg-best/50', label: 'Loss (faded)' },
        { swatch: 'w-4 border-t border-dashed border-white/40', label: 'Period average' },
      ]} note={`Your last ${data.length} games, oldest left`} />
    </>
  )
}

/** Monthly (or weekly) average per time control – are you better at rapid than blitz? */
function TimeControlView({ points }: { points: AccPoint[] }) {
  const span = points[points.length - 1].t - points[0].t
  const unit: 'week' | 'month' = span <= 150 * DAY ? 'week' : 'month'
  const { data, classes, totals } = useMemo(() => {
    const counts: Record<string, AccPoint[]> = {}
    for (const p of points) (counts[p.tc] ??= []).push(p)
    const classes = TC_ORDER.filter(c => (counts[c]?.length ?? 0) >= 5)
    const rows = new Map<number, Record<string, AccPoint[]>>()
    for (const p of points) {
      if (!classes.includes(p.tc)) continue
      const k = bucketStart(p.t, unit)
      const row = rows.get(k) ?? {}
      ;(row[p.tc] ??= []).push(p)
      rows.set(k, row)
    }
    const data = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([t, row]) => {
      const out: Record<string, number | null> = { t }
      for (const c of classes) { out[c] = row[c] && row[c].length >= 3 ? round1(weighted(row[c])) : null; out[`${c}_n`] = row[c]?.length ?? 0 }
      return out
    })
    const totals = classes.map(c => ({ c, n: counts[c].length, avg: weighted(counts[c]) }))
    return { data, classes, totals }
  }, [points, unit])
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, unit === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' })

  if (!classes.length) return <div className="flex h-64 items-center justify-center text-sm text-ink-400">Not enough games per time control yet.</div>
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        {totals.map(({ c, n, avg }) => (
          <div key={c} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-xs ring-1 ring-inset ring-white/[0.06]">
            <span className="size-2 rounded-full" style={{ background: TC_COLOR[c] }} />
            <span className="capitalize text-ink-200">{c}</span>
            <span className="font-mono font-semibold" style={{ color: accuracyColor(avg) }}>{avg?.toFixed(1)}</span>
            <span className="text-ink-500">{n} games</span>
          </div>
        ))}
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
            <XAxis dataKey="t" tickFormatter={fmt} tick={AXIS} axisLine={false} tickLine={false} minTickGap={32} />
            <YAxis domain={[40, 100]} ticks={[40, 60, 80, 100]} tick={AXIS} axisLine={false} tickLine={false} allowDataOverflow />
            <Tooltip cursor={{ stroke: '#fff', strokeOpacity: 0.12 }} isAnimationActive={false} content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0].payload as Record<string, number | null>
              return (
                <Tip>
                  <div className="mb-1 font-medium text-ink-100">{new Date(Number(label)).toLocaleDateString(undefined, unit === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short' })}</div>
                  {classes.filter(c => row[c] != null).map(c => (
                    <div key={c} className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ background: TC_COLOR[c] }} />
                      <span className="w-16 capitalize text-ink-300">{c}</span>
                      <span className="font-mono font-semibold text-ink-100">{row[c]?.toFixed(1)}</span>
                      <span className="text-ink-500">{row[`${c}_n`]} games</span>
                    </div>
                  ))}
                </Tip>
              )
            }} />
            {classes.map(c => (
              <Line key={c} dataKey={c} type="monotone" stroke={TC_COLOR[c]} strokeWidth={2} connectNulls isAnimationActive={false}
                dot={false} activeDot={{ r: 4, fill: TC_COLOR[c], stroke: '#0b0c0f', strokeWidth: 2 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Legendish items={[]} note={`Average per ${unit}; a point needs at least 3 games of that time control`} />
    </>
  )
}

/** How your games spread over accuracy bands, now vs before – is the whole curve moving right? */
function DistributionView({ current, before, labels }: { current: AccPoint[]; before: AccPoint[]; labels: [string, string] }) {
  const bins = [[0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]] as const
  const share = (ps: AccPoint[], lo: number, hi: number) => ps.length ? Math.round((ps.filter(p => p.acc >= lo && p.acc < hi).length / ps.length) * 1000) / 10 : 0
  const data = bins.map(([lo, hi]) => ({
    label: lo === 0 ? '<50' : hi > 100 ? '90+' : `${lo}–${hi}`, mid: (lo + Math.min(hi, 100)) / 2,
    now: share(current, lo, hi), before: share(before, lo, hi),
  }))
  const hasBefore = before.length >= 5
  return (
    <>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barGap={3} barCategoryGap="22%">
            <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
            <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis unit="%" tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: '#fff', fillOpacity: 0.04 }} isAnimationActive={false} content={({ active, payload }) => {
              const d = active && payload?.[0]?.payload
              if (!d) return null
              return (
                <Tip>
                  <div className="font-medium text-ink-100">{d.label}% accuracy</div>
                  <div className="text-ink-200">{labels[0]}: <b className="font-mono">{d.now}%</b> of games</div>
                  {hasBefore && <div className="text-ink-400">{labels[1]}: <span className="font-mono">{d.before}%</span></div>}
                </Tip>
              )
            }} />
            {hasBefore && <Bar dataKey="before" fill="#fff" fillOpacity={0.12} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
            <Bar dataKey="now" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map(d => <Cell key={d.label} fill={accuracyColor(d.mid)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legendish items={[
        { swatch: 'h-2.5 w-2 rounded-sm bg-best', label: `${labels[0]} (${current.length} games)` },
        ...(hasBefore ? [{ swatch: 'h-2.5 w-2 rounded-sm bg-white/20', label: `${labels[1]} (${before.length} games)` }] : []),
      ]} note="Share of games in each accuracy band" />
    </>
  )
}

/** Legend row: each item is a swatch (its classes) and a label. */
function Legendish({ items, note }: { items: { swatch: string; label: string }[]; note?: string }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400">
      {items.map(it => <span key={it.label} className="flex items-center gap-1.5"><span className={it.swatch} />{it.label}</span>)}
      {note && <span className="ml-auto text-ink-500">{note}</span>}
    </div>
  )
}
