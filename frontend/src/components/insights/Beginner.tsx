import clsx from 'clsx'
import { motion } from 'motion/react'
import { ChevronDown, Crosshair, Dumbbell, Flag, Lightbulb, Scale, Shield, Swords, Target } from 'lucide-react'
import { useState } from 'react'
import { CLS, ClassIcon } from '../../lib/classes'
import { accuracyColor, moveNumber } from '../../lib/chess'
import { go } from '../../lib/router'
import type { Insights, MoveRef, TacticRow } from '../../lib/types'
import { Button } from '../ui'
import { drill } from './drill'
import { Section } from './Section'

const scoreColor = (s: number | null | undefined) =>
  s == null ? undefined : s >= 60 ? CLS.best.color : s <= 40 ? CLS.blunder.color : undefined

// --------------------------------------------------------------------------- //
//  #1 focus
// --------------------------------------------------------------------------- //

export function FocusCard({ data }: { data: Insights }) {
  const f = data.focus
  if (!f) return null
  const row = (() => {
    if (!f.drill || f.drill === 'thrown') return undefined
    const [list, theme] = f.drill.split(':')
    const rows = (list === 'tacticsAgainst' ? data.tacticsAgainst : data.tacticsMissed) ?? []
    return rows.find(r => r.theme === theme)
  })()
  const refs = f.drill === 'thrown' ? data.thrown ?? [] : row?.examples ?? []
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl p-5 ring-1 ring-accent/30"
      style={{ background: 'linear-gradient(120deg, rgba(30,227,207,.16), rgba(91,140,255,.10) 55%, rgba(16,19,29,.6))' }}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2ef0dc] to-[#5b8cff] text-ink-950 shadow-lg">
          <Target size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-widest text-accent">Your #1 focus right now</div>
          <h2 className="mt-0.5 font-display text-2xl font-semibold">{f.title}</h2>
          <p className="mt-1 text-sm text-ink-200">{f.text}</p>
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-black/25 px-3 py-2 text-sm text-ink-100">
            <Lightbulb size={16} className="mt-0.5 shrink-0 text-inaccuracy" />
            <span><b>Habit to build:</b> {f.tip}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {f.theme === 'free_piece' && (
            <Button variant="primary" onClick={() => go('/safety')}><Shield size={16} /> Blunder-check drill</Button>
          )}
          {refs.length > 0 && (
            <Button variant={f.theme === 'free_piece' ? 'soft' : 'primary'} onClick={() => drill(refs, f.title, row?.drill)}>
              <Dumbbell size={16} /> Practise these positions
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  )
}

// --------------------------------------------------------------------------- //
//  Tactics
// --------------------------------------------------------------------------- //

export function TacticsSection({ data }: { data: Insights }) {
  const against = data.tacticsAgainst ?? []
  const missed = data.tacticsMissed ?? []
  if (!against.length && !missed.length) return null
  return (
    <Section title="Tactics" icon={<Swords size={18} className="text-blunder" />}
      help={<>
        <b>You fall for</b>: after one of your mistakes, what was the opponent's best punishing idea – a fork, a pin, simply
        taking a loose piece…? <b>You miss</b>: the tactic <i>you</i> could have played instead. Click a row for examples
        and a tip, or drill them.
      </>}>
      <div className="grid gap-6 md:grid-cols-2">
        <TacticList title="You fall for" rows={against} color={CLS.blunder.color} prefix="Allowed" />
        <TacticList title="You miss" rows={missed} color={CLS.great.color} prefix="Missed" />
      </div>
    </Section>
  )
}

function TacticList({ title, rows, color, prefix }: { title: string; rows: TacticRow[]; color: string; prefix: string }) {
  const [open, setOpen] = useState<string | null>(null)
  const max = Math.max(1, ...rows.map(r => r.count))
  return (
    <div>
      <div className="mb-2 text-sm font-semibold" style={{ color }}>{title}</div>
      {rows.length === 0 ? <p className="text-sm text-ink-400">Nothing yet.</p> : (
        <div className="space-y-1">
          {rows.map(r => (
            <div key={r.theme}>
              <button onClick={() => setOpen(o => (o === r.theme ? null : r.theme))}
                className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left hover:bg-white/[0.03] cursor-pointer">
                <span className="w-32 shrink-0 truncate text-sm font-medium">{r.label}</span>
                <div className="h-5 flex-1 overflow-hidden rounded-md bg-ink-850">
                  <motion.div className="h-full rounded-md" style={{ background: color, opacity: 0.8 }}
                    initial={{ width: 0 }} animate={{ width: `${(r.count / max) * 100}%` }} transition={{ duration: 0.6 }} />
                </div>
                <span className="w-9 text-right font-display font-semibold tabular-nums">{r.count}</span>
                <ChevronDown size={14} className={clsx('text-ink-400 transition', open === r.theme && 'rotate-180')} />
              </button>
              {open === r.theme && (
                <div className="mb-2 ml-1 space-y-1.5 border-l border-white/10 pl-3">
                  <div className="flex items-start gap-2 rounded-lg bg-inaccuracy/8 px-2.5 py-1.5 text-xs text-ink-100">
                    <Lightbulb size={13} className="mt-0.5 shrink-0 text-inaccuracy" /> {r.tip}
                  </div>
                  <div className="text-xs text-ink-400">{prefix} in {r.games} game{r.games === 1 ? '' : 's'}. Newest first:</div>
                  <RefList refs={r.examples} />
                  <Button size="sm" variant="ghost" className="-ml-3 text-accent" onClick={() => drill(r.examples, `${title}: ${r.label}`, r.drill)}>
                    <Dumbbell size={14} /> Drill them
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RefList({ refs, limit = 5 }: { refs: MoveRef[]; limit?: number }) {
  const [n, setN] = useState(limit)
  return (
    <>
      {refs.slice(0, n).map(r => (
        <button key={`${r.gameId}-${r.ply}`} onClick={() => go(`/review/${r.gameId}/${r.ply}`)}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-white/5 cursor-pointer">
          <ClassIcon cls={r.cls} size={15} />
          <span className="font-semibold">{moveNumber(r.fenBefore)} {r.san}</span>
          <span className="text-ink-400">best {r.bestSan}</span>
          <span className="ml-auto truncate text-ink-500">{r.date}</span>
        </button>
      ))}
      {refs.length > n && (
        <button className="px-1.5 text-xs text-ink-400 hover:text-white cursor-pointer" onClick={() => setN(x => x + 10)}>+{refs.length - n} more</button>
      )}
    </>
  )
}

// --------------------------------------------------------------------------- //
//  How games end
// --------------------------------------------------------------------------- //

export function EndingsSection({ data }: { data: Insights }) {
  const e = data.endings
  if (!e) return null
  const cols: { key: 'win' | 'loss' | 'draw'; title: string; color: string }[] = [
    { key: 'win', title: 'Wins', color: CLS.best.color },
    { key: 'loss', title: 'Losses', color: CLS.blunder.color },
    { key: 'draw', title: 'Draws', color: '#8f99b8' },
  ]
  return (
    <Section title="How your games end" icon={<Flag size={18} className="text-ink-200" />}
      help={<>Lots of losses <b>on time</b> means the clock is costing you games. Many losses by <b>checkmate</b> often means
        you're missing your opponent's threats against your king. Lots of wins by <b>resignation</b> is a good sign –
        you're building positions others give up in.</>}>
      <div className="grid gap-5 sm:grid-cols-3">
        {cols.map(c => {
          const rows = e[c.key] ?? []
          const total = rows.reduce((s, r) => s + r.count, 0)
          return (
            <div key={c.key}>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="font-semibold" style={{ color: c.color }}>{c.title}</span>
                <span className="text-xs text-ink-400">{total} games</span>
              </div>
              {total === 0 ? <p className="text-sm text-ink-400">None.</p> : (
                <div className="space-y-1.5">
                  {rows.map(r => (
                    <div key={r.reason} className="text-sm">
                      <div className="flex justify-between"><span>{r.label}</span>
                        <span className="tabular-nums text-ink-300">{r.count} · {Math.round((r.count / total) * 100)}%</span></div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-ink-850">
                        <div className="h-full rounded-full" style={{ width: `${(r.count / total) * 100}%`, background: c.color, opacity: 0.75 }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

// --------------------------------------------------------------------------- //
//  Opening habits
// --------------------------------------------------------------------------- //

export function HabitsSection({ data }: { data: Insights }) {
  const h = data.habits
  if (!h) return null
  const stat = (label: string, value: string, sub?: string, good?: boolean | null) => (
    <div className="rounded-xl bg-ink-850 p-3 ring-1 ring-white/5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
      <div className={clsx('mt-1 font-display text-2xl font-semibold tabular-nums',
        good === true && 'text-best', good === false && 'text-mistake')}>{value}</div>
      {sub && <div className="text-xs text-ink-400">{sub}</div>}
    </div>
  )
  return (
    <Section title="Opening habits" icon={<Shield size={18} className="text-book" />}
      help={<>The classic beginner principles: <b>develop</b> your knights and bishops, <b>castle</b> early to get your king
        safe, and <b>don't bring the queen out</b> too soon (it gets chased around and you lose time). "Undeveloped" means 2+
        of your knights/bishops were still at home after move 10.</>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat('Castled', `${h.castleRate}%`, h.avgCastleMove ? `on move ${h.avgCastleMove} on average` : undefined, h.castleRate >= 80 ? true : h.castleRate < 60 ? false : null)}
        {stat('Undeveloped at move 10', `${h.underdevelopedRate}%`, 'of games', h.underdevelopedRate <= 15 ? true : h.underdevelopedRate >= 35 ? false : null)}
        {stat('Early queen', `${h.earlyQueenRate}%`, 'queen moved by move 5', h.earlyQueenRate <= 10 ? true : h.earlyQueenRate >= 30 ? false : null)}
        {stat('Leaves theory', h.avgBookExit ? `move ${h.avgBookExit}` : '—', 'last book move on average')}
      </div>
      {h.scoreCastledBy10 != null && h.scoreNotCastledBy10 != null && (
        <p className="mt-3 text-sm text-ink-300">
          Castled by move 10: you score <b style={{ color: scoreColor(h.scoreCastledBy10) }}>{h.scoreCastledBy10}%</b> ({h.gamesCastledBy10} games)
          · later or never: <b style={{ color: scoreColor(h.scoreNotCastledBy10) }}>{h.scoreNotCastledBy10}%</b> ({h.gamesNotCastledBy10} games).
        </p>
      )}
    </Section>
  )
}

// --------------------------------------------------------------------------- //
//  Opponent strength, conversion, tilt, colours
// --------------------------------------------------------------------------- //

export function OpponentsSection({ data }: { data: Insights }) {
  const rows = (data.vsRating ?? []).filter(r => r.games > 0)
  const c = data.colors
  if (!rows.length && !c) return null
  return (
    <Section title="Opponents & colours" icon={<Scale size={18} className="text-accent-2" />}
      help={<>Your score (wins count 1, draws ½) against opponents rated lower, similar and higher than you were in that
        game – and with White vs Black. Around 50% against equal opponents is expected; noticeably less with one
        colour usually points at an opening to work on.</>}>
      <div className="grid gap-6 md:grid-cols-[1fr_260px]">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
            <tr><th className="pb-2">Opponent rated</th><th className="pb-2 text-right">Games</th><th className="pb-2 text-right">Score</th><th className="pb-2 text-right">Accuracy</th></tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map(r => (
              <tr key={r.label}>
                <td className="py-2">{r.label}</td>
                <td className="text-right tabular-nums text-ink-300">{r.games}</td>
                <td className="text-right font-bold tabular-nums" style={{ color: scoreColor(r.score) }}>{r.score ?? '—'}%</td>
                <td className="text-right tabular-nums" style={{ color: accuracyColor(r.accuracy) }}>{r.accuracy ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {c && (
          <div className="grid grid-cols-2 gap-3">
            {(['w', 'b'] as const).map(k => (
              <div key={k} className="rounded-xl bg-ink-850 p-3 text-center ring-1 ring-white/5">
                <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-ink-300">
                  <span className={clsx('size-2.5 rounded-full ring-1 ring-white/40', k === 'w' ? 'bg-white' : 'bg-ink-950')} />
                  {k === 'w' ? 'White' : 'Black'}
                </div>
                <div className="mt-1 font-display text-2xl font-semibold" style={{ color: scoreColor(c[k].score) }}>{c[k].score ?? '—'}%</div>
                <div className="text-xs text-ink-400">score · {c[k].games} games</div>
                <div className="mt-1 text-xs font-semibold" style={{ color: accuracyColor(c[k].accuracy) }}>{c[k].accuracy ?? '—'} accuracy</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}

export function MindsetSection({ data }: { data: Insights }) {
  const conv = data.conversion
  const tilt = data.tilt
  if (!conv && !tilt) return null
  const big = (v: number | null | undefined, good: boolean | null) => (
    <span className={clsx('font-display text-[30px] leading-tight font-semibold tabular-nums', good === true && 'text-best', good === false && 'text-mistake')}>
      {v == null ? '—' : `${v}%`}
    </span>
  )
  return (
    <Section title="Winning & resilience" icon={<Crosshair size={18} className="text-best" />}
      help={<><b>Converted</b>: of the games where you were clearly winning (85%+ win chance) at some point, how many you
        actually won. <b>Saved</b>: of the games where you were clearly lost (15% or less), how many you still drew or won.
        <b> Blunder streaks</b>: how often a blunder is followed by another one within your next 3 moves – compared with how
        often that would happen by chance. High numbers mean frustration is costing you.</>}>
      <div className="grid gap-3 md:grid-cols-3">
        {conv && (
          <div className="rounded-xl bg-ink-850 p-4 ring-1 ring-white/5">
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Won from winning positions</div>
            <div className="mt-1">{big(conv.converted, conv.converted == null ? null : conv.converted >= 80 ? true : conv.converted < 65 ? false : null)}</div>
            <div className="text-xs text-ink-400">{conv.winningGames} games were clearly winning</div>
          </div>
        )}
        {conv && (
          <div className="rounded-xl bg-ink-850 p-4 ring-1 ring-white/5">
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Saved from lost positions</div>
            <div className="mt-1">{big(conv.saved, conv.saved == null ? null : conv.saved >= 25 ? true : null)}</div>
            <div className="text-xs text-ink-400">{conv.losingGames} games were clearly lost</div>
          </div>
        )}
        {tilt && tilt.rate != null && (
          <div className="rounded-xl bg-ink-850 p-4 ring-1 ring-white/5">
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Blunder after a blunder</div>
            <div className="mt-1 flex items-baseline gap-2">
              {big(tilt.rate, tilt.baseline != null ? tilt.rate <= tilt.baseline * 1.3 : null)}
              {tilt.baseline != null && <span className="text-sm text-ink-400">vs {tilt.baseline}% by chance</span>}
            </div>
            <div className="text-xs text-ink-400">within your next 3 moves · {tilt.samples} blunders</div>
          </div>
        )}
      </div>
    </Section>
  )
}
