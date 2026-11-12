import clsx from 'clsx'
import { useMemo } from 'react'
import { materialDiff, type PieceType } from '../lib/chess'
import type { Color } from '../lib/types'

const ROLE: Record<PieceType, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }
const NAME: Record<PieceType, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }

/** Small piece images, same set as the board; pieces of one kind overlap a little (like Lichess). */
function Pieces({ types, color, size }: { types: PieceType[]; color: Color; size: number }) {
  return (
    <span className="inline-flex items-center">
      {types.map((t, i) => (
        // cg-wrap gives the piece images; its own (unlayered) display/size rules need inline overrides.
        <span key={i} className="cg-wrap shrink-0 opacity-85"
          style={{ display: 'inline-block', position: 'relative', width: size, height: size, marginLeft: i === 0 ? 0 : types[i - 1] === t ? -size * 0.45 : 2 }}>
          <piece className={`${color === 'w' ? 'white' : 'black'} ${ROLE[t]}`}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none', filter: 'none' }} />
        </span>
      ))}
    </span>
  )
}

function describe(extra: PieceType[], score: number): string {
  const parts = extra.length ? `Up ${extra.map(t => NAME[t]).join(', ')}` : ''
  return [parts, score ? `${score} point${score === 1 ? '' : 's'} ahead` : ''].filter(Boolean).join(' · ')
}

/**
 * The material `color` is up in this position: the opponent's pieces it has more of, and +points when ahead.
 * Renders nothing when that side isn't up anything – put it next to the player's name.
 */
export function MaterialDiff({ fen, color, size = 15, className }: { fen: string; color: Color; size?: number; className?: string }) {
  const d = useMemo(() => materialDiff(fen), [fen])[color]
  if (!d.extra.length && !d.score) return null
  const theirs: Color = color === 'w' ? 'b' : 'w'
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-ink-300', className)}
      title={describe(d.extra, d.score)}>
      <Pieces types={d.extra} color={theirs} size={size} />
      {d.score > 0 && <span>+{d.score}</span>}
    </span>
  )
}

/** One line for both sides (for boards without player bars): "Material: equal" or who is up what. */
export function MaterialBalance({ fen, className }: { fen: string; className?: string }) {
  const d = useMemo(() => materialDiff(fen), [fen])
  const side = (c: Color) => (d[c].extra.length || d[c].score ? (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('size-2.5 rounded-full ring-1 ring-white/30', c === 'w' ? 'bg-white' : 'bg-ink-950')} />
      <MaterialDiff fen={fen} color={c} />
    </span>
  ) : null)
  const w = side('w'), b = side('b')
  return (
    <span className={clsx('inline-flex min-h-5 items-center gap-3 text-xs text-ink-400', className)}>
      <span>Material</span>
      {w || b ? <>{w}{b}</> : <span className="text-ink-300">equal</span>}
    </span>
  )
}
