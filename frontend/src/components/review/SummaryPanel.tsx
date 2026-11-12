import { useState } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import { GraduationCap, Play, Sparkles } from 'lucide-react'
import { CLS, ClassIcon, SUMMARY_ORDER } from '../../lib/classes'
import { accuracyColor } from '../../lib/chess'
import { go } from '../../lib/router'
import type { Color, GameRecord } from '../../lib/types'
import { Button, CountUp } from '../ui'

export function coachLine(game: GameRecord): string {
  const side: Color = game.me ?? 'w'
  const c = game.counts[side]
  const acc = game.accuracy[side] ?? 0
  const you = game.me ? 'You' : (side === 'w' ? game.white : game.black)
  const b = c.brilliant ?? 0
  const g = c.great ?? 0
  if (b > 1) return `${you} found ${b} brilliant moves. Absolute magic! ✨`
  if (b === 1) return `${you} found a brilliant move! Let's go see it.`
  if (g > 0 && acc >= 80) return `${g} great move${g > 1 ? 's' : ''} and ${acc.toFixed(0)}% accuracy. Sharp game!`
  if (acc >= 90) return 'Super clean game. The engine barely had notes.'
  if ((c.blunder ?? 0) === 0 && acc >= 75) return 'No blunders! Solid, steady chess.'
  if ((c.blunder ?? 0) + (c.miss ?? 0) >= 3) return 'A wild one. Lots of chances to learn from – let\'s find them.'
  return 'Let\'s walk through the key moments together.'
}

export function SummaryPanel({ game, onStart, onJump }: { game: GameRecord; onStart: () => void; onJump?: (ply: number) => void }) {
  const sides: Color[] = ['w', 'b']
  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2ef0dc] to-[#5b8cff] text-ink-950 shadow-lg">
          <Sparkles size={22} />
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-widest text-ink-400">Game Review</div>
          <p className="mt-0.5 font-display text-lg font-semibold leading-snug">{coachLine(game)}</p>
          {game.end && <p className="mt-1 text-xs text-ink-400">Ended: {game.end.text.split(' – ')[0].toLowerCase()}</p>}
        </div>
      </div>

      {/* Players & accuracy */}
      <div className="grid grid-cols-2 gap-3">
        {sides.map((s, i) => {
          const name = s === 'w' ? game.white : game.black
          const elo = s === 'w' ? game.whiteElo : game.blackElo
          const acc = game.accuracy[s]
          return (
            <motion.div key={s}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.08 }}
              className={clsx('relative overflow-hidden rounded-2xl p-4 ring-1',
                game.me === s ? 'bg-accent/8 ring-accent/40' : 'bg-ink-850 ring-white/5')}>
              <div className="flex items-center gap-2">
                <span className={clsx('size-3 rounded-full ring-1 ring-white/30', s === 'w' ? 'bg-white' : 'bg-ink-950')} />
                <span className="truncate text-sm font-semibold">{name}</span>
                {game.me === s && <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-ink-950">YOU</span>}
              </div>
              <div className="mt-0.5 text-xs text-ink-400">{elo || '—'}</div>
              <div className="mt-3 font-display text-4xl font-semibold tabular-nums" style={{ color: accuracyColor(acc) }}>
                {acc == null ? '—' : <CountUp to={acc} decimals={1} delay={0.2 + i * 0.1} />}
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Accuracy</div>
            </motion.div>
          )
        })}
      </div>

      {/* Your recurring habits, as they showed up in this game */}
      {game.habits && game.habits.length > 0 && (
        <div className="rounded-2xl bg-ink-850/70 p-3 ring-1 ring-white/5">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-400 uppercase"><GraduationCap size={13} /> Habits in this game</span>
            <button onClick={() => go('/coach')} className="text-xs text-ink-500 hover:text-ink-200 cursor-pointer">Coach →</button>
          </div>
          <div className="space-y-2">
            {game.habits.slice(0, 4).map(h => (
              <div key={h.key} className="text-sm" title={h.fix}>
                <div className="font-medium text-ink-100">{h.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {h.plies.map(p => (
                    <button key={p} onClick={() => onJump?.(p)}
                      className="rounded-md bg-blunder/10 px-1.5 py-0.5 font-mono text-[11px] text-[#ff8796] ring-1 ring-inset ring-blunder/20 hover:bg-blunder/20 cursor-pointer">
                      {Math.ceil(p / 2)}{p % 2 ? '.' : '…'} {game.moves[p - 1]?.san}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Classification table */}
      <div className="rounded-2xl bg-ink-850/70 p-2 ring-1 ring-white/5">
        {SUMMARY_ORDER.map((cls, i) => {
          const w = game.counts.w[cls] ?? 0
          const b = game.counts.b[cls] ?? 0
          const hot = cls === 'brilliant' || cls === 'great'
          return (
            <motion.div key={cls}
              initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.035 }}
              title={CLS[cls].desc}
              className={clsx('grid grid-cols-[1fr_44px_28px_44px] items-center rounded-lg px-2 py-1.5',
                hot && (w + b) > 0 && 'bg-white/[0.03]')}>
              <span className="text-sm font-medium" style={{ color: (w + b) > 0 ? CLS[cls].color : '#5d6888' }}>
                {CLS[cls].label}
              </span>
              <Count n={w} cls={cls} me={game.me === 'w'} />
              <span className="flex justify-center"><ClassIcon cls={cls} size={20} /></span>
              <Count n={b} cls={cls} me={game.me === 'b'} />
            </motion.div>
          )
        })}
      </div>

      <Glossary />

      {game.opening && (
        <div className="text-center text-xs text-ink-400">
          <span className="font-semibold text-book">{game.opening.eco}</span> · {game.opening.name}
        </div>
      )}

      <Button variant="primary" size="lg" onClick={onStart} className="w-full">
        <Play size={18} fill="currentColor" /> Start Review
      </Button>
    </div>
  )
}

function Count({ n, cls, me }: { n: number; cls: string; me: boolean }) {
  return (
    <span className={clsx('text-center font-display text-base font-semibold tabular-nums',
      n === 0 ? 'text-ink-500' : me ? 'text-white' : 'text-ink-200')}
      style={n > 0 && (cls === 'brilliant' || cls === 'great') ? { color: CLS[cls as 'great'].color } : undefined}>
      {n}
    </span>
  )
}

function Glossary() {
  const [open, setOpen] = useState(false)
  return (
    <div className="-mt-3">
      <button onClick={() => setOpen(o => !o)} className="text-xs font-semibold text-ink-400 hover:text-accent cursor-pointer">
        {open ? 'Hide' : 'What do these ratings mean?'}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-xl bg-ink-850/70 p-3 ring-1 ring-white/5">
          {SUMMARY_ORDER.map(c => (
            <div key={c} className="flex items-start gap-2 text-xs">
              <ClassIcon cls={c} size={16} />
              <span><b style={{ color: CLS[c].color }}>{CLS[c].label}</b> <span className="text-ink-300">– {CLS[c].desc}</span></span>
            </div>
          ))}
          <p className="pt-1 text-[11px] text-ink-400">Accuracy (0–100) sums up how close all your moves were to the engine's choices.</p>
        </div>
      )}
    </div>
  )
}
