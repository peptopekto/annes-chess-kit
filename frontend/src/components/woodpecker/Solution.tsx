import { Chess, type Square } from 'chess.js'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import clsx from 'clsx'
import { Lightbulb } from 'lucide-react'
import type { Puzzle } from '../../lib/types'

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }

export const THEME_LABELS: Record<string, string> = {
  free_piece: 'Free piece', fork: 'Fork', pin: 'Pin', skewer: 'Skewer', discovered: 'Discovered attack', trapped: 'Trapped piece',
  mate: 'Checkmate', back_rank: 'Back-rank mate', promotion: 'Promotion',
  stop_mate: 'Stop the mate', save_piece: 'Save your piece', win_material: 'Win material',
}

export const themeLabel = (t: string) =>
  THEME_LABELS[t] ?? t.replace(/([A-Z])/g, ' $1').replace(/(\d)/, ' $1').replace(/^./, c => c.toUpperCase()).trim()

/**
 * What the last move threatens: arrows from the side that just moved to enemy pieces that
 * are really in danger (king, more valuable than the attacker, or undefended), and the
 * mated/checked king highlighted.
 */
export function threatShapes(fen: string): { shapes: DrawShape[]; king: string | null } {
  let chess: Chess
  try { chess = new Chess(fen) } catch { return { shapes: [], king: null } }
  const victim = chess.turn() // side to move = side under threat
  const attacker = victim === 'w' ? 'b' : 'w'
  const shapes: DrawShape[] = []
  let king: string | null = null
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== victim) continue
      const from = chess.attackers(sq.square as Square, attacker)
      if (!from.length) continue
      if (sq.type === 'k') { king = sq.square; continue }
      const defended = chess.attackers(sq.square as Square, victim).length > 0
      for (const a of from) {
        const ap = chess.get(a as Square)
        if (!ap) continue
        if (VALUE[sq.type] >= 3 && (VALUE[sq.type] > VALUE[ap.type] || !defended)) {
          shapes.push({ orig: a as Key, dest: sq.square as Key, brush: 'blunder' })
        }
      }
    }
  }
  if (king && chess.inCheck()) {
    const checks: DrawShape[] = chess.attackers(king as Square, attacker).map(a => ({ orig: a as Key, dest: king as Key, brush: 'blunder' }))
    // Checkmate: the mating pieces are the whole story – leave out other threats.
    if (chess.isCheckmate()) return { shapes: checks, king }
    shapes.push(...checks)
  } else {
    king = null
  }
  return { shapes: shapes.slice(0, 6), king }
}

/** Numbered SAN moves for the line that was played on the board. */
export function lineSans(fen: string, ucis: string[]): { san: string; no: string }[] {
  const chess = new Chess(fen)
  const out: { san: string; no: string }[] = []
  for (const u of ucis) {
    const n = chess.moveNumber()
    const white = chess.turn() === 'w'
    let m
    try { m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined }) } catch { break }
    out.push({ san: m.san, no: white ? `${n}.` : out.length === 0 ? `${n}…` : '' })
  }
  return out
}

export function SolutionPanel({ puzzle, ucis, shown, onSelect }:
  { puzzle: Puzzle; ucis: string[]; shown: number; onSelect: (i: number) => void }) {
  const moves = lineSans(puzzle.fen, ucis)
  const theme = puzzle.themes[0]
  return (
    <div className="rounded-2xl bg-ink-850/80 p-3.5 ring-1 ring-white/5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display font-semibold">{theme ? themeLabel(theme) : 'Solution'}</span>
        <span className="text-[11px] text-ink-400">click a move to replay</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-xs">
        {moves.map((m, i) => (
          <button key={i} onClick={() => onSelect(i + 1)}
            className={clsx('rounded px-1.5 py-0.5 font-semibold transition cursor-pointer',
              i === 0 && 'opacity-60',
              shown === i + 1 ? 'bg-accent text-ink-950' : i % 2 === 1 ? 'bg-best/15 text-best hover:bg-best/25' : 'bg-white/5 text-ink-300 hover:text-white')}>
            {m.no && <span className="mr-0.5 opacity-60">{m.no}</span>}{m.san}
          </button>
        ))}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-400">Grey: opponent · green: your moves · red arrows: what the position threatens</div>
      {puzzle.tip && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-inaccuracy/8 px-2.5 py-2 text-xs text-ink-100">
          <Lightbulb size={13} className="mt-0.5 shrink-0 text-inaccuracy" /> {puzzle.tip}
        </div>
      )}
      {puzzle.played && (
        <div className="mt-2 text-xs text-ink-400">In your game you played <b className="text-mistake">{puzzle.played}</b> here.</div>
      )}
    </div>
  )
}
