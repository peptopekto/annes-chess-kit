import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, Minus, TrendingUp, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { LoadingNotice } from '../components/LoadingNotice'
import { Card, EmptyState, ErrorNote, PageHeader, Segmented } from '../components/ui'
import { api } from '../lib/api'
import type { PeerFinding, PeerGroupInfo, PeerMetric, Peers } from '../lib/types'

const AXIS = { fill: '#6c717f', fontSize: 11 }
const PLATFORM: Record<string, string> = { 'chess.com': 'Chess.com', lichess: 'Lichess' }
const GROUPS = [
  { key: 'you', label: 'You' },
  { key: 'level', label: 'Your level' },
  { key: 'stronger', label: 'Stronger' },
  { key: 'weaker', label: 'Weaker' },
] as const

const fmt = (v: number | null | undefined, unit: string) =>
  v == null ? '–' : `${Number.isInteger(v) ? v : v.toFixed(unit === '%' || unit === 's' ? 1 : 2)}${unit === '%' ? '%' : unit === 's' ? ' s' : ''}`

/**
 * You against the players at your rating: every review holds the engine's verdict on your opponents' moves too,
 * so the people you play are a reference group. Same measurements for both sides; a difference counts as real
 * only when it's clearly larger than the noise.
 */
export function PeersPage() {
  const [platform, setPlatform] = useState('all')
  const [tc, setTc] = useState('all')
  const [last, setLast] = useState(0)
  const [band, setBand] = useState(100)
  const [data, setData] = useState<Peers | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.peers({ tc, last, band, platform })
      .then(d => { if (alive) { setData(d); setError(null) } })
      .catch(e => { if (alive) setError(String(e.message ?? e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tc, last, band, platform])

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <PageHeader icon={<Users className="text-accent-2" />} title="Compared to others"
        description={<>Your moves and your opponents' moves, measured the same way. <b className="font-semibold text-ink-200">Your level</b> means
          opponents within ±{band} of your rating in that game; stronger and weaker go up to {data?.far ?? 400} points away.</>} />

      <div className="flex flex-wrap items-center gap-2">
        {(data?.platforms.length ?? 0) > 1 && (
          <Segmented value={platform} onChange={setPlatform}
            options={[{ value: 'all', label: 'All sites' }, ...(data?.platforms ?? []).map(p => ({ value: p, label: PLATFORM[p] ?? p }))]} />
        )}
        <Segmented value={tc} onChange={setTc}
          options={[{ value: 'all', label: 'All' }, ...(data?.timeClasses ?? []).map(t => ({ value: t, label: <span className="capitalize">{t}</span> }))]} />
        <Segmented value={last} onChange={setLast}
          options={[{ value: 0, label: 'All games' }, { value: 500, label: 'Last 500' }, { value: 100, label: 'Last 100' }]} />
        <Segmented value={band} onChange={setBand}
          options={[50, 100, 150].map(b => ({ value: b, label: `±${b}` }))} />
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && !error && (
        <LoadingNotice title="Comparing you with your opponents" tasks={['peers', 'insights', 'summaries']} note="The first time after new reviews this reads every game; after that the page opens straight away." />
      )}
      {data && data.games === 0 && (
        <EmptyState icon={<Users />} title="No rated games to compare yet">
          This needs reviewed games with both players' ratings. Bot games don't count.
        </EmptyState>
      )}
      {data && data.games > 0 && (
        <div className={clsx('space-y-6 transition-opacity', loading && 'opacity-60')}>
          <Results data={data} />
          <Findings data={data} />
          <MetricsTable data={data} />
          {data.concepts.length > 0 && <Concepts data={data} />}
          <Curves data={data} />
        </div>
      )}
    </div>
  )
}

function Results({ data }: { data: Peers }) {
  const tiles: { key: 'level' | 'stronger' | 'weaker'; title: string }[] = [
    { key: 'level', title: `Your level (±${data.band})` },
    { key: 'stronger', title: 'Stronger opponents' },
    { key: 'weaker', title: 'Weaker opponents' },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {tiles.map(t => <ResultTile key={t.key} title={t.title} g={data.groups[t.key]} min={data.minGames} />)}
    </div>
  )
}

function ResultTile({ title, g, min }: { title: string; g: PeerGroupInfo; min: number }) {
  const r = g.results
  const over = r ? r.score - r.expected : null
  return (
    <Card className="p-4">
      <div className="text-xs font-medium tracking-wide text-ink-400 uppercase">{title}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-2xl font-semibold tabular-nums">{g.games}</span>
        <span className="text-sm text-ink-400">games</span>
      </div>
      {r ? (
        <div className="mt-1 text-xs text-ink-400">
          You scored <b className="text-ink-100">{r.score}%</b>; ratings predicted {r.expected}%
          {over != null && Math.abs(over) >= 0.5 && (
            <span className={clsx('ml-1 font-semibold', over > 0 ? 'text-best' : 'text-mistake')}>({over > 0 ? '+' : ''}{over.toFixed(1)})</span>
          )}
          {r.diff !== 0 && <> · opponents {r.diff > 0 ? '+' : ''}{r.diff} on average</>}
        </div>
      ) : <div className="mt-1 text-xs text-ink-500">No games in this range.</div>}
      {g.games > 0 && g.games < min && <div className="mt-1 text-[11px] text-ink-500">Too few games for verdicts (needs {min}).</div>}
    </Card>
  )
}

function Findings({ data }: { data: Peers }) {
  const f = data.findings
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <FindingList title="Where you're behind your level" tone="bad" items={f.weaknesses}
        empty={data.groups.level.games < data.minGames ? 'Not enough games at your level yet.' : 'Nothing where you’re clearly behind players at your level.'} />
      <FindingList title="Where you're ahead" tone="good" items={f.strengths}
        empty={data.groups.level.games < data.minGames ? 'Not enough games at your level yet.' : 'No clear strengths yet – differences are within the noise.'} />
      <FindingList title="What stronger players do better" tone="climb" items={f.climb}
        empty={data.groups.stronger.games < data.minGames
          ? `Needs at least ${data.minGames} games against stronger opponents (${data.groups.stronger.games} so far).`
          : 'Stronger opponents don’t clearly differ from your level in anything you don’t already do.'} />
    </div>
  )
}

function FindingList({ title, tone, items, empty }: { title: string; tone: 'good' | 'bad' | 'climb'; items: PeerFinding[]; empty: string }) {
  const Icon = tone === 'good' ? ArrowUpRight : tone === 'bad' ? ArrowDownRight : TrendingUp
  const color = tone === 'good' ? 'text-best' : tone === 'bad' ? 'text-mistake' : 'text-accent'
  return (
    <Card className="p-4">
      <h2 className="flex items-center gap-2 font-display text-base font-semibold"><Icon size={16} className={color} /> {title}</h2>
      {items.length === 0 ? <p className="mt-2 text-sm text-ink-400">{empty}</p> : (
        <ul className="mt-2 space-y-2">
          {items.map(i => (
            <li key={i.key} className="text-sm leading-snug">
              <span className="text-ink-100">{i.label}</span>
              <div className="text-xs text-ink-400">
                you <b className="text-ink-200">{i.you ?? '–'}</b> · your level <b className="text-ink-200">{i.level ?? '–'}</b>
                {i.stronger != null && <> · stronger <b className="text-ink-200">{i.stronger}</b></>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Verdict({ m, zReal }: { m: PeerMetric; zReal: number }) {
  const z = m.vsLevel
  if (z == null || m.better == null) return <span className="text-ink-500">–</span>
  if (Math.abs(z) < zReal) {
    return <span className="inline-flex items-center gap-1 text-xs text-ink-400" title={`${z.toFixed(1)} standard errors – within the noise`}><Minus size={12} /> same</span>
  }
  return z > 0
    ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-best" title={`${z.toFixed(1)} standard errors better`}><ArrowUpRight size={13} /> better</span>
    : <span className="inline-flex items-center gap-1 text-xs font-semibold text-mistake" title={`${(-z).toFixed(1)} standard errors worse`}><ArrowDownRight size={13} /> worse</span>
}

function MetricsTable({ data }: { data: Peers }) {
  const sections = useMemo(() => {
    const out: [string, PeerMetric[]][] = []
    for (const m of data.metrics) {
      const last = out[out.length - 1]
      if (last && last[0] === m.section) last[1].push(m)
      else out.push([m.section, [m]])
    }
    return out
  }, [data.metrics])
  const thin = (g: 'stronger' | 'weaker' | 'level') => data.groups[g].games < data.minGames
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-xs text-ink-400">
              <th className="px-4 py-3 font-medium">Measure</th>
              {GROUPS.map(g => (
                <th key={g.key} className={clsx('px-3 py-3 text-right font-medium', g.key !== 'you' && thin(g.key) && 'text-ink-600')}
                  title={g.key !== 'you' && thin(g.key) ? `Fewer than ${data.minGames} games – rough numbers` : undefined}>
                  {g.label}{g.key !== 'you' && <span className="ml-1 font-normal text-ink-500">({data.groups[g.key].games})</span>}
                </th>
              ))}
              <th className="px-4 py-3 text-right font-medium">You vs your level</th>
            </tr>
          </thead>
          {sections.map(([section, rows]) => (
            <tbody key={section}>
              <tr><td colSpan={6} className="px-4 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-ink-500 uppercase">{section}</td></tr>
              {rows.map(m => (
                <tr key={m.key} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-ink-200">{m.label}</td>
                  {GROUPS.map(g => (
                    <td key={g.key} className={clsx('px-3 py-2 text-right font-mono tabular-nums',
                      g.key === 'you' ? 'font-semibold text-ink-100' : thin(g.key) ? 'text-ink-600' : 'text-ink-300')}>
                      {fmt(m[g.key], m.unit)}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right"><Verdict m={m} zReal={data.zReal} /></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="border-t border-white/[0.05] px-4 py-3 text-[11px] leading-relaxed text-ink-500">
        Rates are pooled over games. "Better" or "worse" needs a difference of at least {data.zReal} standard errors (games as the
        unit), so a handful of games can't produce a verdict. Grey columns have fewer than {data.minGames} games.
      </p>
    </Card>
  )
}

function Concepts({ data }: { data: Peers }) {
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Positional lessons per 100 moves</h2>
      <p className="mt-0.5 text-xs text-ink-400">How often the coach's positional principles explain a mistake – yours and your level's.</p>
      <div className="mt-3 grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
        {data.concepts.slice(0, 12).map(c => {
          const max = Math.max(c.you, c.level, 0.01)
          return (
            <div key={c.concept} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-sm">
              <span className="truncate text-ink-200">{c.title}</span>
              <span className="font-mono text-xs text-ink-400 tabular-nums">{c.you.toFixed(2)} / {c.level.toFixed(2)}</span>
              <div className="col-span-2 flex h-1.5 gap-1">
                <div className={clsx('h-full rounded-full', c.z != null && c.z <= -data.zReal ? 'bg-mistake' : 'bg-accent')} style={{ width: `${(c.you / max) * 50}%` }} />
                <div className="h-full rounded-full bg-ink-500" style={{ width: `${(c.level / max) * 50}%` }} />
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[11px] text-ink-500">Bars: <span className="text-accent">you</span> and <span className="text-ink-300">your level</span>; red when you're clearly more often affected.</p>
    </Card>
  )
}

function Curves({ data }: { data: Peers }) {
  const sites = Object.entries(data.curve).filter(([, rows]) => rows.length >= 2)
  if (!sites.length) return null
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {sites.map(([site, rows]) => (
        <Card key={site} className="p-5">
          <h2 className="font-display text-lg font-semibold">Accuracy by rating · {PLATFORM[site] ?? site}</h2>
          <p className="mt-0.5 text-xs text-ink-400">Your opponents' accuracy at each rating, and yours when you were at that rating.</p>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
                <XAxis dataKey="from" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis domain={['auto', 'auto']} tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ stroke: '#fff', strokeOpacity: 0.12 }} isAnimationActive={false} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const r = payload[0].payload as (typeof rows)[number]
                  return (
                    <Tip>
                      <div className="mb-1 font-medium text-ink-100">Rating {r.from}–{r.to}</div>
                      <div>Opponents: <b>{r.oppAccuracy ?? '–'}</b>% · {r.oppBlunders ?? '–'} blunders/100 <span className="text-ink-500">({r.opponents} games)</span></div>
                      <div>You: <b>{r.accuracy ?? '–'}</b>% · {r.blunders ?? '–'} blunders/100 <span className="text-ink-500">({r.you} games)</span></div>
                    </Tip>
                  )
                }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line name="Opponents" dataKey="oppAccuracy" stroke="#6c717f" strokeWidth={2} connectNulls dot={false} isAnimationActive={false} />
                <Line name="You" dataKey="accuracy" stroke="#2ee6d1" strokeWidth={2.25} connectNulls dot={{ r: 3, fill: '#2ee6d1' }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ))}
    </div>
  )
}

function Tip({ children }: { children: ReactNode }) {
  return <div className="popover rounded-lg px-3 py-2 text-xs leading-relaxed">{children}</div>
}
