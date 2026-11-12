import clsx from 'clsx'
import type { Key } from 'chessground/types'
import { motion } from 'motion/react'
import { Award, Flame, Lock, RotateCcw, Sparkles, Trophy } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { accuracyColor, uciSquares } from '../../lib/chess'
import { CLS, ClassIcon, SUMMARY_ORDER } from '../../lib/classes'
import type { BotCollected, BotGameResult, BotLevelInfo, BotProgress, Cls } from '../../lib/types'
import { Board } from '../Board'
import { Button, Card, Modal } from '../ui'

const fmtDate = (at: number) => new Date(at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** Level badge + XP bar. */
export function XpBar({ info, className }: { info: BotLevelInfo; className?: string }) {
  const pct = Math.min(100, (100 * info.into) / Math.max(1, info.needed))
  return (
    <div className={clsx('flex items-center gap-4', className)}>
      <div className="relative flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-2 text-ink-950 shadow-[0_8px_24px_-10px_rgba(46,230,209,.8)]">
        <span className="font-display text-2xl font-bold">{info.level}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-display text-lg font-semibold">{info.title}</span>
          <span className="shrink-0 text-xs text-ink-400 tabular-nums">{info.into} / {info.needed} XP</span>
        </div>
        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-ink-700">
          <motion.div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2"
            initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }} />
        </div>
        <div className="mt-1 text-[11px] text-ink-500">Level {info.level} · {info.xp} XP in total · next level at {info.next} XP</div>
      </div>
    </div>
  )
}

/** After a game: XP gained, a level-up, new moves for the collection. */
export function GameXp({ result, pending }: { result?: BotGameResult; pending: boolean }) {
  if (pending && !result) {
    return <div className="mt-3 rounded-xl bg-white/[0.03] p-3 text-sm text-ink-400 ring-1 ring-inset ring-white/[0.06]">Scoring your game…</div>
  }
  if (!result) return null
  const c = result.game.counts
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="mt-3 rounded-xl bg-accent/[0.06] p-3 ring-1 ring-inset ring-accent/25">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-accent" />
        <span className="font-display text-xl font-semibold text-accent">+{result.gained} XP</span>
        {result.difficulty !== 1 && <span className="text-xs text-ink-400">(bot strength ×{result.difficulty})</span>}
        {result.game.accuracy != null && (
          <span className="ml-auto text-xs text-ink-400">Accuracy <b style={{ color: accuracyColor(result.game.accuracy) }}>{result.game.accuracy}</b></span>
        )}
      </div>
      {result.repeat && (
        <p className="mt-1.5 text-xs text-ink-300">
          You played this position before and it paid {result.previous} XP. Playing it again only pays what you earn above
          that: this game was worth {result.earned} XP{result.gained === 0 ? ', so nothing new' : ''}.
        </p>
      )}
      {result.levelUp && (
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.3 }}
          className="mt-2 rounded-lg bg-best/15 px-3 py-2 text-sm font-semibold text-best">
          Level up! You're now level {result.after.level} – {result.after.title}.
        </motion.div>
      )}
      <XpBar info={result.after} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-300">
        {(['brilliant', 'great', 'best', 'inaccuracy', 'mistake', 'miss', 'blunder'] as Cls[]).filter(k => c[k]).map(k => (
          <span key={k} className="flex items-center gap-1"><ClassIcon cls={k} size={14} /> {c[k]} {CLS[k].label.toLowerCase()}</span>
        ))}
      </div>
      {result.collected.length > 0 && (
        <div className="mt-2 text-xs text-ink-300">
          <Trophy size={12} className="mr-1 inline text-inaccuracy" />
          {result.collected.length} move{result.collected.length === 1 ? '' : 's'} added to your collection: {result.collected.map(m => m.san).join(', ')}
        </div>
      )}
    </motion.div>
  )
}

/** The benchmark: level, record, move statistics, by bot strength, recent games, achievements – and reset. */
export function ProgressView({ p, onReset }: { p: BotProgress; onReset: (p: BotProgress) => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const r = p.record
  const reset = async () => {
    setBusy(true)
    try { onReset(await api.resetBotProgress()) } finally { setBusy(false); setConfirm(false) }
  }
  if (!r.played) {
    return (
      <Card className="p-6">
        <XpBar info={p} />
        <p className="mt-4 text-sm text-ink-400">
          Play a game against the bot to start. Wins earn the most XP (more against a stronger bot), and every game is
          scored: your accuracy, your good and bad moves, and your best moves go into your collection.
        </p>
      </Card>
    )
  }
  const max = Math.max(1, ...SUMMARY_ORDER.map(c => p.counts[c] ?? 0))
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <XpBar info={p} />
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Record" value={`${r.won}–${r.drawn}–${r.lost}`} sub={`${r.played} games · W–D–L`} />
          <Stat label="Win streak" value={String(p.streak)} sub={`best ${p.bestStreak}`} icon={<Flame size={14} className={p.streak ? 'fill-mistake text-mistake' : 'text-ink-500'} />} />
          <Stat label="Accuracy" value={p.accuracy != null ? String(p.accuracy) : '–'}
            sub={p.recentAccuracy != null ? `last 10 games: ${p.recentAccuracy}` : undefined} color={p.accuracy != null ? accuracyColor(p.accuracy) : undefined} />
          <Stat label="Best win" value={p.bestWin ? `Maia ${p.bestWin}` : '–'} sub="strongest bot you beat" />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="font-display text-base font-semibold">Your moves</h3>
          <p className="text-xs text-ink-400">
            {p.moves} moves rated · {p.goodShare ?? '–'}% good or better · {p.badShare ?? '–'}% inaccuracies or worse
          </p>
          <div className="mt-3 space-y-1.5">
            {SUMMARY_ORDER.filter(c => c !== 'forced').map(c => {
              const n = p.counts[c] ?? 0
              return (
                <div key={c} className="grid grid-cols-[110px_minmax(0,1fr)_64px] items-center gap-2 text-sm">
                  <span className="flex items-center gap-1.5"><ClassIcon cls={c} size={15} /> {CLS[c].label}</span>
                  <div className="h-2 overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full rounded-full" style={{ width: `${(100 * n) / max}%`, background: CLS[c].color }} />
                  </div>
                  <span className="text-right font-mono text-xs text-ink-300 tabular-nums">
                    {n}{p.perGame[c] != null && <span className="text-ink-500"> · {p.perGame[c]}/g</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-display text-base font-semibold">By bot strength</h3>
          <p className="text-xs text-ink-400">Your score and accuracy against each Maia level – your benchmark.</p>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-500"><th className="py-1 font-medium">Bot</th><th className="font-medium">Games</th><th className="font-medium">Score</th><th className="text-right font-medium">Accuracy</th></tr></thead>
            <tbody>
              {p.levels.map(l => (
                <tr key={l.maia} className="border-t border-white/[0.04]">
                  <td className="py-1.5 font-medium">Maia {l.maia}</td>
                  <td className="text-ink-300 tabular-nums">{l.games}</td>
                  <td className={clsx('tabular-nums', l.score >= 50 ? 'text-best' : 'text-ink-300')}>{l.score}%</td>
                  <td className="text-right tabular-nums" style={{ color: l.accuracy != null ? accuracyColor(l.accuracy) : undefined }}>{l.accuracy ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-5 font-display text-base font-semibold">Recent games</h3>
          <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
            {p.recent.map(g => (
              <div key={g.at} className="flex items-center gap-2 text-sm">
                <span className={clsx('w-5 text-center font-mono text-xs font-bold', g.result === 'win' ? 'text-best' : g.result === 'loss' ? 'text-blunder' : 'text-ink-400')}>
                  {g.result === 'win' ? 'W' : g.result === 'loss' ? 'L' : 'D'}
                </span>
                <span className="text-ink-300">Maia {g.maia}</span>
                {g.takebacks > 0 && <span className="text-[11px] text-ink-500">({g.takebacks} takeback{g.takebacks === 1 ? '' : 's'})</span>}
                <span className="ml-auto text-xs tabular-nums" style={{ color: g.accuracy != null ? accuracyColor(g.accuracy) : undefined }}>{g.accuracy ?? '–'}</span>
                <span className="w-14 text-right text-xs font-semibold text-accent tabular-nums">+{g.xp} XP</span>
                <span className="w-14 text-right text-[11px] text-ink-500">{fmtDate(g.at)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h3 className="font-display text-base font-semibold">Achievements</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {p.achievements.map(a => (
            <div key={a.id} className={clsx('flex items-center gap-3 rounded-xl p-3 ring-1 ring-inset',
              a.earned ? 'bg-inaccuracy/[0.08] ring-inaccuracy/30' : 'bg-white/[0.02] ring-white/[0.05] opacity-60')}>
              {a.earned ? <Award size={20} className="shrink-0 text-inaccuracy" /> : <Lock size={18} className="shrink-0 text-ink-500" />}
              <div className="min-w-0">
                <div className="text-sm font-semibold">{a.name}</div>
                <div className="text-xs text-ink-400">{a.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3 text-xs text-ink-500">
        <span>
          XP: win 100, draw 40, loss 10 – times the bot's strength (×0.5 at −200 up to ×2 at +400); +25 per Brilliant, +10 per Great,
          +20 for a game without mistakes; half with takebacks.
        </span>
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}><RotateCcw size={13} /> Reset</Button>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Reset your bot progress?">
        <p className="text-sm text-ink-300">
          This sets your level and XP back to zero and deletes your statistics, achievements and move collection – a fresh start
          for the benchmark. Your games stay in the Bot games list and their reviews aren't touched.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" onClick={reset} disabled={busy}><RotateCcw size={14} /> Reset</Button>
        </div>
      </Modal>
    </div>
  )
}

function Stat({ label, value, sub, icon, color }: { label: string; value: string; sub?: string; icon?: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.05]">
      <div className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 font-display text-xl font-semibold tabular-nums" style={{ color }}>{icon}{value}</div>
      {sub && <div className="text-[11px] text-ink-500">{sub}</div>}
    </div>
  )
}

const PAGE = 24

/** Your Brilliant and Great moves against the bot. */
export function CollectionView({ p }: { p: BotProgress }) {
  const [shown, setShown] = useState(PAGE)
  const [kind, setKind] = useState<'all' | Cls>('all')
  const items = p.collection.filter(m => kind === 'all' || m.cls === kind)
  if (!p.collection.length) {
    return (
      <Card className="p-6 text-sm text-ink-400">
        <Trophy size={20} className="mb-2 text-inaccuracy" />
        Your Brilliant and Great moves against the bot are collected here – with the position, so you can look at them again.
        None yet: keep playing!
      </Card>
    )
  }
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm">
        {(['all', 'brilliant', 'great'] as const).map(k => (
          <button key={k} onClick={() => setKind(k)}
            className={clsx('flex items-center gap-1.5 rounded-lg px-2.5 py-1 ring-1 ring-inset transition cursor-pointer',
              kind === k ? 'bg-white/[0.08] text-white ring-white/15' : 'text-ink-400 ring-white/[0.06] hover:text-ink-200')}>
            {k === 'all' ? `All ${p.collectionSize}` : <><ClassIcon cls={k} size={14} /> {p.collection.filter(m => m.cls === k).length}</>}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.slice(0, shown).map(m => <CollectedCard key={`${m.at}-${m.ply}`} m={m} />)}
      </div>
      {items.length > shown && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" onClick={() => setShown(s => s + PAGE)}>Show more · {items.length - shown} left</Button>
        </div>
      )}
    </div>
  )
}

function CollectedCard({ m }: { m: BotCollected }) {
  const [from, to] = uciSquares(m.uci)
  return (
    <div className="glass rounded-2xl p-2.5" style={{ boxShadow: `0 0 30px -14px ${CLS[m.cls].color}` }}>
      <div className="pointer-events-none">
        <Board fen={m.fen} orientation={m.color} shapes={[{ orig: from as Key, dest: to as Key, brush: m.cls }]} />
      </div>
      <div className="mt-2 flex items-center gap-2 px-1">
        <ClassIcon cls={m.cls} size={20} />
        <span className="font-display font-semibold" style={{ color: CLS[m.cls].color }}>{m.san}</span>
        <span className="ml-auto truncate text-[11px] text-ink-400">vs Maia {m.maia} · {fmtDate(m.at)}</span>
      </div>
    </div>
  )
}
