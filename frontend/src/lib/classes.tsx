import { ArrowRight, BookOpen, Check, Star, ThumbsUp, X } from 'lucide-react'
import type { Cls } from './types'

interface ClsMeta {
  label: string
  color: string
  symbol?: string
  Icon?: typeof Star
  /** Lower = better; used for sorting and "key moment" detection. */
  rank: number
  /** One-line explanation for beginners. */
  desc: string
}

export const CLS: Record<Cls, ClsMeta> = {
  brilliant: { label: 'Brilliant', color: '#1ee3cf', symbol: '!!', rank: 0, desc: 'A strong sacrifice – you gave up material and it was the best move.' },
  great: { label: 'Great', color: '#5b8cff', symbol: '!', rank: 1, desc: 'The only good move in the position; everything else was clearly worse.' },
  best: { label: 'Best', color: '#7fd858', Icon: Star, rank: 2, desc: 'The engine’s top choice.' },
  excellent: { label: 'Excellent', color: '#5fc46e', Icon: ThumbsUp, rank: 3, desc: 'Practically as good as the best move.' },
  good: { label: 'Good', color: '#93b39a', Icon: Check, rank: 4, desc: 'A decent move, though something a bit better existed.' },
  book: { label: 'Book', color: '#d0a272', Icon: BookOpen, rank: 5, desc: 'Known opening theory.' },
  forced: { label: 'Forced', color: '#94a3b8', Icon: ArrowRight, rank: 6, desc: 'The only legal move.' },
  inaccuracy: { label: 'Inaccuracy', color: '#f7c845', symbol: '?!', rank: 7, desc: 'A small slip that gives away a little of your position.' },
  mistake: { label: 'Mistake', color: '#ff9a3d', symbol: '?', rank: 8, desc: 'A clear error that makes your position noticeably worse.' },
  miss: { label: 'Miss', color: '#ff6b81', Icon: X, rank: 9, desc: 'You let a forced mate slip, or didn’t punish your opponent’s mistake – without making your own position worse.' },
  blunder: { label: 'Blunder', color: '#ff3d55', symbol: '??', rank: 10, desc: 'A serious error: it throws away a lot, often by losing material – and always when it walks into a short forced mate.' },
}

export const SUMMARY_ORDER: Cls[] = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder',
]

export const KEY_CLASSES = new Set<Cls>(['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder'])
export const BAD_CLASSES = new Set<Cls>(['inaccuracy', 'mistake', 'miss', 'blunder'])
export const RETRY_CLASSES = new Set<Cls>(['mistake', 'miss', 'blunder', 'inaccuracy'])
export const SOLVED_CLASSES = new Set<Cls>(['brilliant', 'great', 'best', 'excellent'])

export function ClassIcon({ cls, size = 22, className = '', glow = false }:
  { cls: Cls; size?: number; className?: string; glow?: boolean }) {
  const m = CLS[cls]
  const Icon = m.Icon
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-display font-extrabold text-white select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 25%, color-mix(in srgb, ${m.color} 70%, white), ${m.color} 60%)`,
        boxShadow: glow
          ? `0 0 0 2px rgba(255,255,255,.9), 0 0 ${size * 0.8}px ${m.color}, 0 4px 10px rgba(0,0,0,.35)`
          : `0 0 0 ${Math.max(1, size / 14)}px rgba(255,255,255,.85), 0 2px 6px rgba(0,0,0,.35)`,
        fontSize: size * (m.symbol && m.symbol.length > 1 ? 0.5 : 0.62),
        letterSpacing: '-0.04em',
        textShadow: '0 1px 1px rgba(0,0,0,.25)',
      }}
      aria-label={m.label}
      title={m.label}
    >
      {Icon ? <Icon size={size * 0.58} strokeWidth={3} fill={cls === 'best' ? 'white' : 'none'} /> : m.symbol}
    </span>
  )
}
