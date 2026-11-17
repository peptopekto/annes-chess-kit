import { Chess } from 'chess.js'
import clsx from 'clsx'
import type { Key } from 'chessground/types'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeftRight, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Cpu, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { playUci, uciSquares } from '../lib/chess'
import { sound } from '../lib/sound'
import type { Color, EngineLine, Eval, GameEnd } from '../lib/types'
import { Board } from './Board'
import { MaterialDiff } from './MaterialDiff'
import { EvalBar } from './EvalBar'
import { Button, Kbd, Spinner } from './ui'

interface Step { uci: string; san: string; fen: string; capture: boolean }
type Engine = { eval: Eval; evalText: string; lines: EngineLine[]; over?: GameEnd | null }

/**
 * A free analysis board (like Lichess's): move any piece for either side, see Stockfish's evaluation
 * and best lines for every position, step back and forth with ← →. Opens over the current page.
 */
export function AnalysisBoard({ open, onClose, fen, orientation, moves = [], at, title = 'Analysis board' }: {
  open: boolean; onClose: () => void
  fen: string                 // starting position
  orientation: Color
  moves?: string[]            // moves already played from `fen` (UCI), e.g. a puzzle's solution
  at?: number                 // how many of them to show first (default: all)
  title?: string
}) {
  return (
    <AnimatePresence>
      {open && <Inner key={fen + moves.join()} onClose={onClose} fen={fen} orientation={orientation} moves={moves} at={at} title={title} />}
    </AnimatePresence>
  )
}

function build(fen: string, ucis: string[]): Step[] {
  const out: Step[] = []
  let cur = fen
  for (const u of ucis) {
    try {
      const r = playUci(cur, u)
      out.push({ uci: r.uci, san: r.san, fen: r.fen, capture: r.capture })
      cur = r.fen
    } catch { break }
  }
  return out
}

function Inner({ onClose, fen, orientation: initialOrientation, moves, at, title }:
  { onClose: () => void; fen: string; orientation: Color; moves: string[]; at?: number; title: string }) {
  const [steps, setSteps] = useState<Step[]>(() => build(fen, moves))
  const [cursor, setCursor] = useState(() => Math.min(at ?? moves.length, moves.length))
  const [orientation, setOrientation] = useState(initialOrientation)
  const [cache, setCache] = useState<Record<string, Engine>>({})
  const current = cursor === 0 ? fen : steps[cursor - 1].fen
  const engine = cache[current]
  const inflight = useRef(new Set<string>())

  // Engine for the shown position (cached; short debounce while stepping quickly).
  useEffect(() => {
    if (cache[current] || inflight.current.has(current)) return
    const t = setTimeout(() => {
      inflight.current.add(current)
      api.lines(current, 18, 3).then(r => setCache(c => ({ ...c, [current]: r }))).catch(() => {})
        .finally(() => inflight.current.delete(current))
    }, 180)
    return () => clearTimeout(t)
  }, [current, cache])

  const go = useCallback((c: number, withSound = true) => {
    setCursor(prev => {
      const next = Math.max(0, Math.min(steps.length, c))
      if (withSound && next !== prev && next > 0) sound.move(steps[next - 1].capture)
      return next
    })
  }, [steps])

  // Keys belong to this board while it's open (the page underneath must not react).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const map: Record<string, () => void> = {
        ArrowLeft: () => go(cursor - 1), ArrowRight: () => go(cursor + 1),
        ArrowUp: () => go(0, false), Home: () => go(0, false), ArrowDown: () => go(steps.length, false), End: () => go(steps.length, false),
        Escape: onClose, f: () => setOrientation(o => (o === 'w' ? 'b' : 'w')),
        Enter: () => {}, ' ': () => {}, // not "next puzzle" on the page underneath
      }
      const fn = map[e.key]
      if (!fn) return
      e.preventDefault()
      e.stopImmediatePropagation()
      fn()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [go, cursor, steps.length, onClose])

  const play = (ucis: string[]) => {
    // New moves replace whatever came after the shown position (a new variation).
    let cur = current
    const added: Step[] = []
    for (const u of ucis) {
      try { const r = playUci(cur, u); added.push({ uci: r.uci, san: r.san, fen: r.fen, capture: r.capture }); cur = r.fen } catch { break }
    }
    if (!added.length) return
    sound.move(added[0].capture)
    const same = steps[cursor]?.uci === added[0].uci && added.length === 1
    if (same) { setCursor(cursor + 1); return }
    setSteps([...steps.slice(0, cursor), ...added])
    setCursor(cursor + added.length)
  }

  const playLine = (l: EngineLine, all: boolean) => {
    const c = new Chess(current)
    const ucis: string[] = []
    for (const san of all ? l.line.slice(0, 10) : l.line.slice(0, 1)) {
      try { const m = c.move(san); ucis.push(m.from + m.to + (m.promotion ?? '')) } catch { break }
    }
    play(ucis)
  }

  const last = cursor > 0 ? steps[cursor - 1].uci : null
  const arrows = useMemo(() => (engine?.lines ?? []).slice(0, 2).map((l, i) => ({
    orig: uciSquares(l.uci)[0] as Key, dest: uciSquares(l.uci)[1] as Key, brush: i === 0 ? 'engine' : 'engine2',
  })), [engine])
  const startNo = Number(fen.split(' ')[5] ?? 1) || 1
  const startBlack = fen.split(' ')[1] === 'b'
  const label = (i: number) => { // move number label for steps[i]
    const ply = i + (startBlack ? 1 : 0)
    return `${startNo + Math.floor(ply / 2)}${ply % 2 === 0 ? '.' : '…'}`
  }
  const changed = steps.length !== moves.length || steps.some((s, i) => s.uci !== moves[i])

  return (
    <motion.div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/60 p-3 backdrop-blur-[4px] sm:p-6"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="popover flex max-h-full w-full max-w-[1180px] flex-col gap-4 overflow-auto rounded-2xl p-4 sm:p-5 lg:flex-row"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} // no scale/shift: the board measures itself on open
        role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        {/* board */}
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="flex flex-col gap-1" style={{ width: 'calc(min(100%, calc(100vh - 9rem)) * var(--board-zoom, 1))' }}>
            <div className="flex h-5 items-center pl-5 sm:pl-6"><MaterialDiff fen={current} color={orientation === 'w' ? 'b' : 'w'} /></div>
            <div className="flex gap-2">
              <div className="w-3 shrink-0 sm:w-4"><EvalBar ev={engine?.eval ?? { cp: 0 }} orientation={orientation} /></div>
              <div className="board-frame aspect-square min-w-0 flex-1">
                <Board wheelSteps resizable fen={current} orientation={orientation} movable onMove={u => play([u])}
                  lastMove={last ? uciSquares(last) : null} shapes={arrows} />
              </div>
            </div>
            <div className="flex h-5 items-center pl-5 sm:pl-6"><MaterialDiff fen={current} color={orientation} /></div>
          </div>
        </div>

        {/* side */}
        <div className="flex w-full shrink-0 flex-col gap-3 lg:w-[360px]">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Cpu size={17} className="text-great" /> {title}</h2>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-white/[0.06] hover:text-white cursor-pointer" aria-label="Close"><X size={18} /></button>
          </div>

          <div className="flex items-baseline justify-between">
            <span className="text-xs text-ink-500">Stockfish 17 · depth 18</span>
            <span className="font-mono text-2xl font-semibold tabular-nums">{engine ? engine.evalText : <Spinner size={16} />}</span>
          </div>
          <div className="space-y-1">
            {!engine && [0, 1, 2].map(i => <div key={i} className="skeleton h-9" />)}
            {engine && engine.lines.length === 0 && (
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5 text-sm text-ink-200 ring-1 ring-inset ring-white/[0.05]">
                {engine.over?.text ?? 'Game over – no legal moves.'}
              </div>
            )}
            {engine?.lines.map((l, i) => (
              <div key={l.uci} className="group flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 ring-1 ring-inset ring-white/[0.05] hover:bg-white/[0.06]">
                <span className={clsx('w-14 shrink-0 rounded-md px-1.5 py-0.5 text-center font-mono text-xs font-semibold',
                  i === 0 ? 'bg-great/15 text-great' : 'bg-white/[0.06] text-ink-200')}>{l.evalText}</span>
                <button onClick={() => playLine(l, false)} title="Play this move" className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-ink-200 cursor-pointer">
                  <b className="text-white">{l.san}</b> {l.line.slice(1, 8).join(' ')}
                </button>
                <button onClick={() => playLine(l, true)} title="Play the whole line"
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-ink-500 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08] hover:text-white cursor-pointer">line ▸</button>
              </div>
            ))}
          </div>

          <div className="min-h-[90px] flex-1 overflow-y-auto rounded-xl bg-black/20 p-2.5 ring-1 ring-inset ring-white/[0.05]">
            {steps.length === 0 ? (
              <p className="text-sm text-ink-400">Move any piece – for either side – and watch the evaluation change. Click a line to play it.</p>
            ) : (
              <div className="flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-[13px]">
                <button onClick={() => go(0, false)} className={clsx('rounded px-1 cursor-pointer', cursor === 0 ? 'bg-great/20 text-white' : 'text-ink-500 hover:bg-white/[0.06]')}>start</button>
                {steps.map((s, i) => (
                  <button key={i} onClick={() => go(i + 1)}
                    className={clsx('rounded px-1 cursor-pointer', i + 1 === cursor ? 'bg-great/20 text-white' : 'text-ink-200 hover:bg-white/[0.06]',
                      i >= moves.length || s.uci !== moves[i] ? '' : 'text-ink-400')}>
                    {(i === 0 || (i + (startBlack ? 1 : 0)) % 2 === 0) && <span className="text-ink-500">{label(i)}</span>}{s.san}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            <Button size="sm" onClick={() => go(0, false)} disabled={cursor === 0} title="Start (↑)"><ChevronsLeft size={16} /></Button>
            <Button size="sm" onClick={() => go(cursor - 1)} disabled={cursor === 0} title="Back (←)"><ChevronLeft size={16} /></Button>
            <Button size="sm" onClick={() => go(cursor + 1)} disabled={cursor >= steps.length} title="Forward (→)"><ChevronRight size={16} /></Button>
            <Button size="sm" onClick={() => go(steps.length, false)} disabled={cursor >= steps.length} title="End (↓)"><ChevronsRight size={16} /></Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOrientation(o => (o === 'w' ? 'b' : 'w'))}><ArrowLeftRight size={14} /> Flip</Button>
            {changed && <Button size="sm" variant="ghost" onClick={() => { setSteps(build(fen, moves)); setCursor(Math.min(at ?? moves.length, moves.length)) }}><RotateCcw size={14} /> Reset</Button>}
            <span className="ml-auto flex items-center gap-1 text-[11px] text-ink-500"><Kbd>←</Kbd><Kbd>→</Kbd> step · <Kbd>F</Kbd> flip · <Kbd>esc</Kbd></span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
