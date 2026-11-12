import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, Dumbbell, Flame, Minus, Target } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { go } from '../../lib/router'
import { setTrainingGoal, useTraining } from '../../lib/training'
import type { Training, TrainingMastery } from '../../lib/types'
import { Button, Card, Segmented, Skeleton, Spinner } from '../ui'

/**
 * Daily training: goal, streak and the last 12 weeks – and, for each of your recurring mistake patterns,
 * how you do in its puzzles next to how often it still happens in your games. Practice only pays off if
 * the second number goes down; the card puts the two side by side.
 */
export function TrainingCard() {
  const t = useTraining()
  if (!t) return <Skeleton className="h-64 rounded-2xl" />
  return (
    <Card className="p-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <Today t={t} />
        <Mastery items={t.mastery} />
      </div>
    </Card>
  )
}

function Today({ t }: { t: Training }) {
  const pct = Math.min(1, t.today.points / Math.max(1, t.goal))
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-5">
        <GoalRing pct={pct} points={t.today.points} goal={t.goal} met={t.goalMet} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Flame size={22} className={clsx(t.streak > 0 ? 'fill-mistake text-mistake' : 'text-ink-500')} />
            <span className="font-display text-3xl font-semibold tabular-nums">{t.streak}</span>
            <span className="text-sm text-ink-400">day{t.streak === 1 ? '' : 's'} in a row</span>
          </div>
          <div className="mt-1 text-xs text-ink-400">
            {t.goalMet ? 'Today’s goal is done.' : t.streak > 0 ? `Reach today’s goal to keep the streak.` : 'Reach the daily goal to start a streak.'}
            {t.nextMilestone && t.streak > 0 && <> Next milestone: {t.nextMilestone} days.</>}
          </div>
          <div className="mt-1 text-xs text-ink-500">Best streak {t.bestStreak} · {t.week} points this week · {t.daysTrained} days trained</div>
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs text-ink-400">
          <span className="flex items-center gap-1.5"><Target size={13} /> Daily goal (points)</span>
          <Segmented value={t.goal} onChange={g => { void setTrainingGoal(g) }}
            options={t.goals.map(g => ({ value: g, label: String(g) }))} />
        </div>
        <p className="text-[11px] leading-relaxed text-ink-500">
          Puzzle 1 (+1 on the first try) · blunder-check card 1 · opening position 1 · endgame 3 (+2 won) · Nightmare game 5
        </p>
      </div>

      <Calendar days={t.calendar} goal={t.goal} />
    </div>
  )
}

function GoalRing({ pct, points, goal, met }: { pct: number; points: number; goal: number; met: boolean }) {
  const r = 34, c = 2 * Math.PI * r
  return (
    <div className="relative size-[88px] shrink-0">
      <svg viewBox="0 0 88 88" className="size-full -rotate-90">
        <circle cx="44" cy="44" r={r} fill="none" stroke="currentColor" strokeWidth="8" className="text-ink-700" />
        <circle cx="44" cy="44" r={r} fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          className={clsx('transition-[stroke-dashoffset] duration-700', met ? 'text-best' : 'text-accent')} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-display text-xl font-semibold tabular-nums">{points}</span>
        <span className="mt-0.5 text-[10px] text-ink-400">of {goal}</span>
      </div>
    </div>
  )
}

/** The last 12 weeks, one square per day (columns are weeks). */
function Calendar({ days, goal }: { days: Training['calendar']; goal: number }) {
  const weeks: Training['calendar'][] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  const tone = (p: number) => p === 0 ? 'bg-ink-700/70' : p >= goal ? 'bg-best' : p >= goal / 2 ? 'bg-best/55' : 'bg-best/25'
  return (
    <div>
      <div className="mb-1.5 text-xs text-ink-400">Last 12 weeks</div>
      <div className="flex gap-1">
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-1 flex-col gap-1">
            {w.map(d => <div key={d.day} title={`${d.day}: ${d.points} points`} className={clsx('aspect-square w-full rounded-[3px]', tone(d.points))} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

function Mastery({ items }: { items: TrainingMastery[] }) {
  if (!items.length) {
    return <div className="text-sm text-ink-400">Review more of your games – your recurring mistake patterns show up here, with a drill for each.</div>
  }
  return (
    <div>
      <h3 className="font-display text-base font-semibold">Your patterns</h3>
      <p className="mt-0.5 text-xs text-ink-400">
        Puzzles train the pattern; your games show whether it sticks. The goal is the right-hand number going down.
      </p>
      <div className="mt-3 divide-y divide-white/[0.05]">
        {items.slice(0, 7).map(m => <MasteryRow key={m.key} m={m} />)}
      </div>
    </div>
  )
}

function MasteryRow({ m }: { m: TrainingMastery }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const train = async () => {
    setBusy(true); setError(null)
    try {
      const set = await api.createSet({ kind: 'pattern', pattern: m.key, amount: 30 })
      go(`/woodpecker/${set.id}`)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const before = m.perGameBefore
  const change = before != null && before > 0 ? (m.perGame - before) / before : null
  const better = change != null && change <= -0.1, worse = change != null && change >= 0.1
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{m.label}</div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-accent" style={{ width: `${m.firstTry ?? 0}%` }} />
          </div>
          <span className="text-[11px] text-ink-400">
            {m.solved ? `${m.solved} solved · ${m.firstTry}% first try` : 'not practised yet'}
          </span>
        </div>
        {error && <div className="mt-1 text-[11px] text-blunder">{error}</div>}
      </div>
      <div className="text-right" title="Mistakes of this kind per game: your last 50 games (and the 200 before)">
        <div className={clsx('flex items-center justify-end gap-1 text-sm font-semibold tabular-nums',
          better ? 'text-best' : worse ? 'text-mistake' : 'text-ink-200')}>
          {better ? <ArrowDownRight size={14} /> : worse ? <ArrowUpRight size={14} /> : <Minus size={14} className="text-ink-500" />}
          {m.perGame.toFixed(2)}
        </div>
        <div className="text-[11px] text-ink-500">{before != null ? `was ${before.toFixed(2)}` : 'per game'}</div>
      </div>
      <Button size="sm" onClick={train} disabled={busy} title="Build a puzzle set from your mistakes of this kind">
        {busy ? <Spinner /> : <Dumbbell size={14} />} Train
      </Button>
    </div>
  )
}

/** Sidebar: streak and today's progress, always in sight. */
export function StreakChip({ refreshKey }: { refreshKey?: unknown }) {
  const t = useTraining(refreshKey)
  if (!t) return null
  const pct = Math.min(1, t.today.points / Math.max(1, t.goal))
  return (
    <button onClick={() => go('/coach')} title={`Daily goal: ${t.today.points} of ${t.goal} points today · ${t.streak}-day streak`}
      className="flex shrink-0 items-center gap-2 rounded-[10px] px-2 py-1.5 text-left transition hover:bg-white/[0.04] cursor-pointer lg:mb-2">
      <Flame size={16} className={clsx(t.streak > 0 ? 'fill-mistake text-mistake' : 'text-ink-500')} />
      <span className="text-[13px] font-semibold tabular-nums">{t.streak}</span>
      <span className="hidden min-w-0 flex-1 lg:block">
        <span className="block h-1.5 overflow-hidden rounded-full bg-ink-700">
          <span className={clsx('block h-full rounded-full transition-[width] duration-500', t.goalMet ? 'bg-best' : 'bg-accent')} style={{ width: `${pct * 100}%` }} />
        </span>
        <span className="mt-0.5 block text-[10px] text-ink-500">{t.goalMet ? 'Goal done today' : `${t.today.points}/${t.goal} points today`}</span>
      </span>
    </button>
  )
}
