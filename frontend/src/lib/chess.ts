import { Chess, type Square } from 'chess.js'
import type { Key } from 'chessground/types'
import type { Color, Eval } from './types'

// Legal moves per position, remembered: the board asks on every re-render (an engine line arriving, a rating
// popping up), and generating them again each time costs more than everything else the board does.
const destsCache = new Map<string, Map<Key, Key[]>>()

export function dests(fen: string): Map<Key, Key[]> {
  const hit = destsCache.get(fen)
  if (hit) return hit
  const d = computeDests(fen)
  if (destsCache.size > 500) destsCache.clear()
  destsCache.set(fen, d)
  return d
}

function computeDests(fen: string): Map<Key, Key[]> {
  const d = new Map<Key, Key[]>()
  let chess: Chess
  try { chess = new Chess(fen) } catch { return d }
  for (const m of chess.moves({ verbose: true })) {
    const list = d.get(m.from as Key) ?? []
    list.push(m.to as Key)
    d.set(m.from as Key, list)
  }
  return d
}

export function turnOf(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w'
}

export const cgColor = (c: Color) => (c === 'w' ? 'white' : 'black') as 'white' | 'black'

export function uciSquares(uci: string): [Key, Key] {
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key]
}

export function needsPromotion(fen: string, from: string, to: string): boolean {
  const chess = new Chess(fen)
  const piece = chess.get(from as Square)
  return !!piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1')
}

export function playUci(fen: string, uci: string) {
  const chess = new Chess(fen)
  let from = uci.slice(0, 2), to = uci.slice(2, 4)
  // Some engines write castling as king-takes-own-rook (e1h1): turn it into the king's real target (e1g1).
  const k = chess.get(from as Square), r = chess.get(to as Square)
  if (k?.type === 'k' && r?.type === 'r' && r.color === k.color) to = `${to > from ? 'g' : 'c'}${from[1]}`
  const m = chess.move({ from, to, promotion: uci[4] || undefined })
  return { fen: chess.fen(), san: m.san, uci: m.from + m.to + (m.promotion ?? ''), capture: m.isCapture() || m.isEnPassant(), check: chess.inCheck() }
}

/** How deep a review searched: "depth 16" or "1 s per move · avg depth 23". */
export function analysisLabel(g: { depth: number; moveTime?: number | null; depthReached?: number | null }): string {
  if (!g.moveTime) return `depth ${g.depth}`
  return `${g.moveTime} s per move${g.depthReached ? ` · avg depth ${Math.round(g.depthReached)}` : ''}`
}

/** "Re-analyze deeper": twice the time per move, or 4 plies deeper (at least 20). */
export function deeperAnalysis(g: { depth: number; moveTime?: number | null }): { depth?: number; moveTime?: number; label: string } {
  if (g.moveTime) {
    const t = Math.min(10, g.moveTime * 2)
    return { moveTime: t, label: `${t} s per move` }
  }
  const d = Math.min(30, Math.max(20, g.depth + 4))
  return { depth: d, label: `depth ${d}` }
}

/** Lichess win% model, matching the backend. */
export function winPct(e: Eval): number {
  if (e.mate !== undefined && e.mate !== null) {
    if (e.mate === 0) return e.winner ? (e.winner === 'w' ? 100 : 0) : 50 // checkmate on the board
    return e.mate > 0 ? 100 : 0
  }
  const cp = Math.max(-1000, Math.min(1000, e.cp ?? 0))
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

export function evalLabel(e: Eval): string {
  if (e.mate !== undefined && e.mate !== null) return e.mate === 0 ? '#' : `M${Math.abs(e.mate)}`
  const v = (e.cp ?? 0) / 100
  return (v > 0 ? '+' : '') + v.toFixed(1)
}

export function accuracyColor(a: number | null | undefined): string {
  if (a == null) return '#8f99b8'
  if (a >= 90) return '#1ee3cf'
  if (a >= 80) return '#7fd858'
  if (a >= 70) return '#f7c845'
  if (a >= 55) return '#ff9a3d'
  return '#ff3d55'
}

export function squareXY(sq: string, orientation: Color): { x: number; y: number } {
  const file = sq.charCodeAt(0) - 97
  const rank = Number(sq[1]) - 1
  return orientation === 'w' ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank }
}

/** Play a list of SAN moves from `fen`, stopping at the first illegal one. */
export function buildLine(fen: string, sans: string[]) {
  const chess = new Chess(fen)
  const out = { ucis: [] as string[], sans: [] as string[], fens: [] as string[], captures: [] as boolean[] }
  for (const san of sans) {
    let m
    try { m = chess.move(san) } catch { break }
    out.ucis.push(m.from + m.to + (m.promotion ?? ''))
    out.sans.push(m.san)
    out.fens.push(chess.fen())
    out.captures.push(m.isCapture() || m.isEnPassant())
  }
  return out
}

/** "12." / "12…" prefix for the move played from `fen`. */
export function moveNumber(fen: string): string {
  const [, turn, , , , full] = fen.split(' ')
  return turn === 'w' ? `${full}.` : `${full}…`
}

export function lichessAnalysisUrl(fen: string) {
  return `https://lichess.org/analysis/standard/${fen.replace(/ /g, '_')}`
}

// ------------------------------------------------------------------ square control (endgame "show control")

const FILES = 'abcdefgh'
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
const AROUND = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const STRAIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** Piece placement of a FEN as square -> piece letter (uppercase = White). */
function pieceMap(fen: string): Map<string, string> {
  const out = new Map<string, string>()
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let f = 0
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch)
      else { out.set(`${FILES[f]}${8 - i}`, ch); f++ }
    }
  })
  return out
}

const at = (f: number, r: number) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? `${FILES[f]}${r + 1}` : null)
const ownerOf = (p: string): Color => (p === p.toUpperCase() ? 'w' : 'b')

/**
 * Squares `color`'s pieces attack (cover): a line piece up to and including the first piece in its way, so a
 * protected piece counts as covered. `through` is treated as empty – pass the enemy king's square, so the
 * squares behind it on a line count as covered too (the king can't step back along a check).
 */
export function controlledSquares(fen: string, color: Color, through?: string): Set<string> {
  const board = pieceMap(fen)
  const out = new Set<string>()
  for (const [sq, p] of board) {
    if (ownerOf(p) !== color) continue
    const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1
    const kind = p.toLowerCase()
    const steps = (dirs: number[][]) => dirs.forEach(([df, dr]) => { const s = at(f + df, r + dr); if (s) out.add(s) })
    const rays = (dirs: number[][]) => dirs.forEach(([df, dr]) => {
      for (let i = 1; i < 8; i++) {
        const s = at(f + df * i, r + dr * i)
        if (!s) break
        out.add(s)
        if (board.has(s) && s !== through) break
      }
    })
    if (kind === 'p') steps(color === 'w' ? [[1, 1], [-1, 1]] : [[1, -1], [-1, -1]])
    else if (kind === 'n') steps(KNIGHT)
    else if (kind === 'k') steps(AROUND)
    else if (kind === 'b') rays(DIAG)
    else if (kind === 'r') rays(STRAIGHT)
    else if (kind === 'q') rays([...DIAG, ...STRAIGHT])
  }
  return out
}

/** Squares `color`'s king can step to: not taken by its own pieces and not covered by the other side. */
export function kingSquares(fen: string, color: Color): Set<string> {
  const board = pieceMap(fen)
  const king = [...board].find(([, p]) => p === (color === 'w' ? 'K' : 'k'))?.[0]
  const out = new Set<string>()
  if (!king) return out
  const covered = controlledSquares(fen, color === 'w' ? 'b' : 'w', king)
  const f = king.charCodeAt(0) - 97, r = Number(king[1]) - 1
  for (const [df, dr] of AROUND) {
    const s = at(f + df, r + dr)
    if (!s || covered.has(s)) continue
    const p = board.get(s)
    if (p && ownerOf(p) === color) continue
    out.add(s)
  }
  return out
}

// ------------------------------------------------------------------ material difference

export type PieceType = 'q' | 'r' | 'b' | 'n' | 'p'
const VALUE: Record<PieceType, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 }
const ORDER: PieceType[] = ['q', 'r', 'b', 'n', 'p']

/**
 * Who is up material, like Lichess shows it next to the players: for each side the pieces it has more of than
 * the opponent (e.g. a knight for two pawns shows the knight on one side, the pawns on the other) and the points
 * it is ahead (pawn 1, knight/bishop 3, rook 5, queen 9; only the side that is ahead gets a number).
 */
export function materialDiff(fen: string): Record<Color, { extra: PieceType[]; score: number }> {
  const count = { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } }
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase() as PieceType
    if (t in VALUE) count[ch === t ? 'b' : 'w'][t]++
  }
  const out = { w: { extra: [] as PieceType[], score: 0 }, b: { extra: [] as PieceType[], score: 0 } }
  let diff = 0
  for (const t of ORDER) {
    const d = count.w[t] - count.b[t]
    diff += d * VALUE[t]
    for (let i = 0; i < Math.abs(d); i++) out[d > 0 ? 'w' : 'b'].extra.push(t)
  }
  if (diff > 0) out.w.score = diff
  if (diff < 0) out.b.score = -diff
  return out
}
