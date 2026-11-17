import clsx from 'clsx'
import { CalendarClock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { accuracyColor } from '../../lib/chess'
import type { StatBucket, StatsReport } from '../../lib/types'
import { LoadingNotice } from '../LoadingNotice'
import { Section } from './Section'

/** Score per bucket as horizontal bars, centred on your overall score – instantly shows the outliers. */
function Buckets({ title, rows, overall, note }: { title: string; rows: StatBucket[]; overall: number; note?: string }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map(r => r.games))
  return (
    <div className="rounded-xl bg-white/[0.02] p-4 ring-1 ring-inset ring-white/[0.05]">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {note && <span className="text-[11px] text-ink-500">{note}</span>}
      </div>
      <div className="space-y-1.5">
        {rows.map(r => {
          const d = (r.score ?? overall) - overall
          return (
            <div key={r.bucket} className="grid grid-cols-[110px_1fr_46px_40px] items-center gap-2 text-xs"
              title={`${r.games} games · ${r.wins}W ${r.draws}D ${r.losses}L · accuracy ${r.accuracy ?? '—'} · ${r.blunders ?? '—'} blunders/game`}>
              <span className="truncate text-ink-300">{r.bucket}</span>
              <div className="relative h-4 rounded bg-white/[0.04]">
                <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
                <div className={clsx('absolute inset-y-0.5 rounded-sm', d >= 0 ? 'left-1/2 bg-best/70' : 'right-1/2 bg-blunder/70')}
                  style={{ width: `${Math.min(50, Math.abs(d) * 2.2)}%` }} />
                <div className="absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-white/10" style={{ width: `${(r.games / max) * 100}%` }} />
              </div>
              <span className={clsx('text-right font-mono font-semibold', d >= 3 ? 'text-best' : d <= -3 ? 'text-[#ff8796]' : 'text-ink-200')}>{r.score?.toFixed(0) ?? '—'}%</span>
              <span className="text-right font-mono text-ink-500" style={{ color: accuracyColor(r.accuracy) }}>{r.accuracy?.toFixed(0) ?? '—'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function WhenBest() {
  const [s, setS] = useState<StatsReport | null>(null)
  useEffect(() => { let alive = true; api.stats().then(r => { if (alive) setS(r) }).catch(() => {}); return () => { alive = false } }, [])
  if (!s) return <LoadingNotice compact title="Working out when you play your best" tasks={['insights']} />
  if (!s.games) return null
  const overall = s.record.all.score ?? 50
  return (
    <Section title="When – and against whom – you play best" icon={<CalendarClock size={18} className="text-great" />}
      help={<>Your score (wins + half the draws) in each situation, compared with your overall {overall.toFixed(0)}% – green bars are better
        than usual, red worse. The small number on the right is your accuracy. All your reviewed games, regardless of the filters above.</>}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Buckets title="Game number in a session" rows={s.timing.session} overall={overall} note="a new session starts after a 45-min pause" />
        <Buckets title="After the previous game" rows={s.timing.after} overall={overall} />
        <Buckets title="Time of day" rows={s.timing.hours} overall={overall} />
        <Buckets title="Day of the week" rows={s.timing.weekdays} overall={overall} />
        <Buckets title="Game length (your moves)" rows={s.breakdown.length} overall={overall} />
        <Buckets title="Opponent's rating vs yours" rows={s.breakdown.opponent} overall={overall} />
        <Buckets title="Time control" rows={s.breakdown.timeControl} overall={overall} />
      </div>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-ink-500">
        <span>score %</span><span>·</span><span>accuracy</span><span>·</span><span>thin line under a bar = how many games</span>
      </div>
    </Section>
  )
}
