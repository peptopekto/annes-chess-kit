import clsx from 'clsx'
import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../../lib/api'
import type { Core, Trend } from '../../lib/types'
import { Card, Segmented, Spinner } from '../ui'

type MetricKey = Exclude<keyof Core, 'games'>

/** Every metric we can chart over time; `better` says which direction is an improvement. */
export const METRICS: { key: MetricKey; label: string; better: 'up' | 'down'; unit?: string; digits?: number; color: string }[] = [
  { key: 'accuracy', label: 'Accuracy', better: 'up', unit: '%', digits: 1, color: '#1ee3cf' },
  { key: 'rating', label: 'Rating', better: 'up', digits: 0, color: '#a78bfa' },
  { key: 'winRate', label: 'Score', better: 'up', unit: '%', digits: 0, color: '#7fd858' },
  { key: 'blundersPerGame', label: 'Blunders / game', better: 'down', digits: 2, color: '#ff3d55' },
  { key: 'errorsPer40', label: 'Mistakes / 40 moves', better: 'down', digits: 1, color: '#ff9a3d' },
  { key: 'opening', label: 'Opening acc.', better: 'up', unit: '%', digits: 1, color: '#d0a272' },
  { key: 'middlegame', label: 'Middlegame acc.', better: 'up', unit: '%', digits: 1, color: '#5b8cff' },
  { key: 'endgame', label: 'Endgame acc.', better: 'up', unit: '%', digits: 1, color: '#5fc46e' },
  { key: 'hung_piece', label: 'Hung pieces / game', better: 'down', digits: 2, color: '#ff6b81' },
  { key: 'missed_punish', label: 'Unpunished mistakes / game', better: 'down', digits: 2, color: '#ff6b81' },
  { key: 'missed_tactic', label: 'Missed tactics / game', better: 'down', digits: 2, color: '#ff6b81' },
]

const MIN_GAMES = 5 // buckets with fewer games are drawn faded

/** "+2.3% vs before" chip, green when the change is an improvement. */
export function Delta({ now, before, better = 'up', unit = '', digits = 1, className }:
  { now: number | null | undefined; before: number | null | undefined; better?: 'up' | 'down'; unit?: string; digits?: number; className?: string }) {
  if (now == null || before == null) return null
  const d = now - before
  const tiny = Math.abs(d) < Math.pow(10, -digits) / 2
  const good = better === 'up' ? d > 0 : d < 0
  return (
    <span className={clsx('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums',
      tiny ? 'bg-ink-700 text-ink-300' : good ? 'bg-best/15 text-best' : 'bg-blunder/15 text-[#ff8a9a]', className)}
      title={`Earlier games: ${before.toFixed(digits)}${unit}`}>
      {tiny ? '±0' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(digits)}${unit}`}
    </span>
  )
}

export function TrendSection({ tc, color, since }: { tc: string; color: string; since?: string }) {
  const [bucket, setBucket] = useState('auto')
  const [metric, setMetric] = useState<MetricKey>('accuracy')
  const [trend, setTrend] = useState<Trend | null>(null)

  useEffect(() => {
    let alive = true
    api.trend({ tc, color, bucket }).then(t => { if (alive) setTrend(t) }).catch(() => { if (alive) setTrend(null) })
    return () => { alive = false }
  }, [tc, color, bucket])

  const m = METRICS.find(x => x.key === metric)!
  const points = (trend?.points ?? []).map(p => ({ ...p, value: p[metric] }))
  const valid = points.filter(p => p.value != null)

  // Shade the buckets that fall inside the selected period.
  const sinceTs = since ? Date.parse(`${since}T00:00:00Z`) / 1000 : null
  const inPeriod = sinceTs != null && trend?.bucket !== 'games' ? points.filter(p => p.end >= sinceTs) : []

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <History size={18} className="text-accent" />
        <h2 className="font-display text-lg font-semibold">Over time</h2>
        <div className="flex-1" />
        <Segmented value={bucket} onChange={setBucket} options={[
          { value: 'auto', label: 'Auto' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'games', label: '20 games' },
        ]} />
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {METRICS.map(x => (
          <button key={x.key} onClick={() => setMetric(x.key)}
            className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold transition cursor-pointer',
              metric === x.key ? 'text-ink-950' : 'bg-ink-700 text-ink-300 hover:text-white')}
            style={metric === x.key ? { background: x.color } : undefined}>
            {x.label}
          </button>
        ))}
      </div>

      {!trend ? <div className="flex h-60 items-center justify-center"><Spinner /></div>
        : valid.length < 2 ? (
          <div className="flex h-60 items-center justify-center text-sm text-ink-400">
            Not enough reviewed games spread over time yet – analyse older games to see a trend.
          </div>
        ) : (
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
                {inPeriod.length > 0 && (
                  <ReferenceArea x1={inPeriod[0].label} x2={inPeriod[inPeriod.length - 1].label} fill="#1ee3cf" fillOpacity={0.06}
                    label={{ value: 'selected period', position: 'insideTopRight', fill: '#5d6888', fontSize: 10 }} />
                )}
                <XAxis dataKey="label" tick={{ fill: '#8f99b8', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={16} />
                <YAxis tick={{ fill: '#5d6888', fontSize: 11 }} axisLine={false} tickLine={false} domain={['auto', 'auto']}
                  reversed={false} width={44} />
                <Tooltip cursor={{ stroke: '#fff', strokeOpacity: 0.15 }} content={({ active, payload }) => {
                  const p = active && payload?.[0]?.payload
                  if (!p) return null
                  return (
                    <div className="glass rounded-lg px-3 py-2 text-xs">
                      <div className="font-semibold">{p.label}</div>
                      <div style={{ color: m.color }} className="font-bold">
                        {m.label}: {p.value == null ? '—' : `${Number(p.value).toFixed(m.digits ?? 1)}${m.unit ?? ''}`}
                      </div>
                      <div className="text-ink-400">{p.games} game{p.games === 1 ? '' : 's'}{p.games < MIN_GAMES ? ' (few – take with salt)' : ''}</div>
                    </div>
                  )
                }} />
                <Line type="monotone" dataKey="value" stroke={m.color} strokeWidth={2} connectNulls isAnimationActive
                  dot={(props: { cx?: number; cy?: number; payload?: { games: number }; index?: number }) => {
                    const { cx, cy, payload, index } = props
                    if (cx == null || cy == null) return <g key={index} />
                    const few = (payload?.games ?? 0) < MIN_GAMES
                    return <circle key={index} cx={cx} cy={cy} r={few ? 3 : 4.5} fill={few ? '#151926' : m.color}
                      stroke={m.color} strokeWidth={2} opacity={few ? 0.6 : 1} />
                  }}
                  activeDot={{ r: 6, fill: m.color, stroke: '#fff', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      <p className="mt-2 text-xs text-ink-400">
        {m.better === 'down' ? 'Lower is better. ' : ''}Hollow dots: fewer than {MIN_GAMES} games in that {trend?.bucket === 'games' ? 'batch' : trend?.bucket ?? 'period'}.
        {metric === 'rating' && tc === 'all' ? ' Ratings from different time controls are mixed – pick one above for a clean rating line.' : ''}
      </p>
    </Card>
  )
}
