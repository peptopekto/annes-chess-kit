import clsx from 'clsx'
import { motion } from 'motion/react'
import { AlertTriangle, History, Play, RotateCcw, ShieldAlert, ShieldCheck, Swords, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Section } from '../components/insights/Section'
import { Button, Card, CountUp, ErrorNote, PageSkeleton } from '../components/ui'
import { api } from '../lib/api'
import { CLS } from '../lib/classes'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import type { SafetyHub } from '../lib/types'

const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`)

export function SafetyHubPage() {
  const [hub, setHub] = useState<SafetyHub | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.safetyHub().then(setHub).catch(e => setError(String(e.message ?? e))) }, [])

  if (error) return <div className="mx-auto max-w-lg p-10"><ErrorNote>{error}</ErrorNote></div>
  if (!hub) return <PageSkeleton />

  const t = hub.totals
  const overall = t.answered ? (t.correct / t.answered) * 100 : null
  const md = hub.missedDangers, fa = hub.falseAlarms
  const missRate = md.n ? (md.missed / md.n) * 100 : null
  const alarmRate = fa.n ? (fa.wrong / fa.n) * 100 : null
  const chart = hub.sessions.map((s, i) => ({ i: i + 1, pct: Math.round((s.right / Math.max(1, s.total)) * 100), ...s }))

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[30px] leading-tight font-semibold"><span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-white/[0.08]"><ShieldAlert size={18} className="text-mistake" /></span> Blunder check</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            Train the 3-second safety check before every move, on positions from your own games: your real blunders mixed
            with sound moves that only <i>look</i> risky.
          </p>
        </div>
      </div>

      {/* start */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <div className="font-display text-lg font-semibold">Start a session</div>
            <div className="text-sm text-ink-400">Keys: S / ← safe · U / → unsafe · Enter next</div>
          </div>
          <Button onClick={() => go('/safety/play/mixed/10')}><Play size={15} /> Quick · 10</Button>
          <Button variant="primary" onClick={() => go('/safety/play/mixed/20')}><Play size={15} /> Standard · 20</Button>
          <Button onClick={() => go('/safety/play/mixed/30')}><Play size={15} /> Long · 30</Button>
          <Button onClick={() => go('/safety/play/review/30')} disabled={!hub.toReview}
            className={clsx(hub.toReview > 0 && 'ring-1 ring-inaccuracy/40 text-inaccuracy')}>
            <RotateCcw size={15} /> Review misses · {hub.toReview}
          </Button>
        </div>
      </Card>

      {t.answered === 0 && t.sessions === 0 ? (
        <Card className="p-8 text-center text-ink-300">No sessions yet – start one above. Your stats will show up here.</Card>
      ) : (
        <>
          {/* tiles */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Sessions" value={t.sessions} sub={`${fmtDur(t.seconds)} trained`} icon={<History size={16} />} />
            <Tile label="Cards answered" value={t.answered} sub={`${hub.seenCards} different positions`} icon={<ShieldCheck size={16} />} />
            <Tile label="Overall accuracy" value={overall} decimals={0} unit="%" color={accuracyColor(overall)} />
            <Tile label="Recent (~100 cards)" value={hub.recentAccuracy} unit="%" color={accuracyColor(hub.recentAccuracy)}
              sub={overall != null && hub.recentAccuracy != null
                ? (hub.recentAccuracy >= overall ? `▲ ${Math.round(hub.recentAccuracy - overall)} vs overall` : `▼ ${Math.round(overall - hub.recentAccuracy)} vs overall`)
                : undefined} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <Section title="Progress per session" icon={<Timer size={18} className="text-accent" />}
              help={<>Your score in each session (share of cards answered correctly). Aim for a rising line – and keep the
                review-misses mode in rotation so old mistakes don't come back in your games.</>}>
              {chart.length < 2 ? <p className="text-sm text-ink-400">Play a couple more sessions to see a trend.</p> : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                      <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
                      <XAxis dataKey="i" tick={{ fill: '#5d6888', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} unit="%" tick={{ fill: '#5d6888', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip cursor={{ stroke: '#fff', strokeOpacity: 0.15 }} content={({ active, payload }) => {
                        const p = active && payload?.[0]?.payload
                        if (!p) return null
                        return <div className="glass rounded-lg px-3 py-2 text-xs">
                          <div className="font-semibold">Session {p.i} · {fmtDate(p.at)}{p.mode === 'review' ? ' · review' : ''}</div>
                          <div style={{ color: accuracyColor(p.pct) }} className="font-bold">{p.right}/{p.total} ({p.pct}%)</div>
                          <div className="text-ink-400">{fmtDur(p.seconds)}</div>
                        </div>
                      }} />
                      <Line type="monotone" dataKey="pct" stroke="#1ee3cf" strokeWidth={2}
                        dot={{ r: 4, fill: '#1ee3cf', stroke: '#151926', strokeWidth: 2 }} activeDot={{ r: 6 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Section>

            <Section title="How you go wrong" icon={<AlertTriangle size={18} className="text-mistake" />}
              help={<><b>Missed dangers</b>: you said "safe" to a move that was actually a blunder – the check that would have
                saved you in a game. <b>False alarms</b>: you said "unsafe" to a sound move – too much caution costs time and
                good moves. Most improving players need to cut missed dangers first.</>}>
              <div className="space-y-4">
                <RateBar label="Missed dangers" sub={md.n ? `said "safe" to ${md.missed} of ${md.n} blunders` : 'tracked from your next session'} rate={missRate} color={CLS.blunder.color} />
                <RateBar label="False alarms" sub={fa.n ? `said "unsafe" to ${fa.wrong} of ${fa.n} sound moves` : 'tracked from your next session'} rate={alarmRate} color={CLS.inaccuracy.color} />
                {missRate != null && alarmRate != null && md.n >= 10 && fa.n >= 10 && (
                  <p className="rounded-lg bg-ink-850 px-3 py-2 text-xs text-ink-200">
                    {missRate > alarmRate + 10
                      ? 'You trust moves too quickly. Before every move, look at every capture and check your opponent gets.'
                      : alarmRate > missRate + 10
                        ? 'You spot the dangers, but you’re over-cautious – trust your check and play the active move.'
                        : 'Balanced – keep training to bring both numbers down.'}
                  </p>
                )}
              </div>
            </Section>
          </div>

          {hub.themes.length > 0 && (
            <Section title="Dangers by tactic" icon={<Swords size={18} className="text-blunder" />}
              help={<>For the blunder cards: how often you spotted the danger, by the tactic that punishes the move. The lowest
                bars are the patterns to look out for in your games.</>}>
              <div className="space-y-2">
                {hub.themes.map((th, i) => (
                  <div key={th.theme} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-sm font-medium">{th.label}</span>
                    <div className="h-5 flex-1 overflow-hidden rounded-md bg-ink-850">
                      <motion.div className="h-full rounded-md" style={{ background: accuracyColor(th.rate) }}
                        initial={{ width: 0 }} animate={{ width: `${Math.max(2, th.rate)}%` }} transition={{ delay: i * 0.04, duration: 0.5 }} />
                    </div>
                    <span className="w-24 text-right text-xs tabular-nums text-ink-300">{th.spotted}/{th.seen} · <b style={{ color: accuracyColor(th.rate) }}>{th.rate}%</b></span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Session history" icon={<History size={18} className="text-ink-200" />}>
            <div className="divide-y divide-white/5 text-sm">
              {[...hub.sessions].reverse().slice(0, 15).map((s, i) => {
                const pct = Math.round((s.right / Math.max(1, s.total)) * 100)
                return (
                  <div key={i} className="flex items-center gap-3 py-2">
                    <span className="w-20 text-ink-400">{fmtDate(s.at)}</span>
                    {s.mode === 'review' && <span className="rounded bg-inaccuracy/15 px-1.5 text-[11px] font-medium uppercase text-inaccuracy">review</span>}
                    <span className="flex-1" />
                    <span className="tabular-nums text-ink-300">{fmtDur(s.seconds)}</span>
                    <span className="w-16 text-right font-bold tabular-nums">{s.right}/{s.total}</span>
                    <span className="w-12 text-right font-display font-semibold tabular-nums" style={{ color: accuracyColor(pct) }}>{pct}%</span>
                  </div>
                )
              })}
            </div>
          </Section>
        </>
      )}
    </div>
  )
}

function Tile({ label, value, sub, color, unit = '', decimals = 0, icon }:
  { label: string; value: number | null; sub?: string; color?: string; unit?: string; decimals?: number; icon?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-ink-400">{label}{icon}</div>
      <div className="mt-2 font-display text-[30px] leading-tight font-semibold tabular-nums" style={{ color }}>
        {value == null ? '—' : <><CountUp to={value} decimals={decimals} />{unit}</>}
      </div>
      {sub && <div className="text-xs text-ink-400">{sub}</div>}
    </Card>
  )
}

function RateBar({ label, sub, rate, color }: { label: string; sub: string; rate: number | null; color: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className="font-display text-xl font-semibold tabular-nums" style={{ color: rate == null ? undefined : color }}>{rate == null ? '—' : `${Math.round(rate)}%`}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-850">
        <div className="h-full rounded-full" style={{ width: `${rate ?? 0}%`, background: color, opacity: 0.85 }} />
      </div>
      <div className="mt-0.5 text-xs text-ink-400">{sub}{rate != null && ' · lower is better'}</div>
    </div>
  )
}
