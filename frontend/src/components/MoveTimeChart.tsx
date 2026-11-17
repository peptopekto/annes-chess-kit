import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { CLS, KEY_CLASSES } from '../lib/classes'
import type { GameRecord } from '../lib/types'

// Same inner margin as the evaluation graph, so each bar sits under its move's point there.
const MARGIN = 6

const fmtSpent = (s: number) => (s < 10 ? `${s.toFixed(1)} s` : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min`)

/**
 * Time spent on each move, under the evaluation graph: White's moves rise from the centre line, Black's hang
 * below it. Bars of key moves (blunders, mistakes, brilliant moves …) take their rating's colour, so a mistake
 * made in a hurry – or after a long think – shows at a glance. Click a bar to go to that move.
 */
export function MoveTimeChart({ game, ply, onSelect, height = 64 }:
  { game: GameRecord; ply: number; onSelect: (ply: number) => void; height?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const times = game.moveTimes
  const last = Math.max(1, game.moves.length)
  const xOf = (p: number) => MARGIN + (width - 2 * MARGIN) * (p / last)
  const plyAt = (x: number) => Math.max(1, Math.min(last, Math.round(((x - MARGIN) / Math.max(1, width - 2 * MARGIN)) * last)))

  if (!times) return null
  const h = hover != null ? hoverInfo(game, hover) : null
  return (
    <div ref={box} className="relative cursor-pointer select-none overflow-hidden rounded-xl bg-[#262a36] ring-1 ring-white/5" style={{ height }}
      onPointerMove={e => setHover(plyAt(e.clientX - e.currentTarget.getBoundingClientRect().left))}
      onPointerLeave={() => setHover(null)}
      onClick={e => onSelect(plyAt(e.clientX - e.currentTarget.getBoundingClientRect().left))}
      role="img" aria-label="Time spent on each move">
      {width > 0 && <Bars game={game} width={width} height={height} />}
      {width > 0 && (
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#1ee3cf] transition-[left] duration-100 ease-out"
          style={{ left: xOf(Math.max(0, ply)) - 1 }} />
      )}
      {h && width > 0 && (
        <div className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md bg-ink-950/95 px-2 py-1 text-[11px] leading-tight shadow-lg ring-1 ring-white/10"
          style={xOf(hover!) < width / 2 ? { left: xOf(hover!) + 8 } : { right: width - xOf(hover!) + 8 }}>
          <span className="font-semibold text-ink-100">{h.label}</span>
          <span className="ml-1.5 text-ink-400">took</span>
          <span className="ml-1 font-mono text-ink-100">{h.spent != null ? fmtSpent(h.spent) : 'unknown'}</span>
        </div>
      )}
    </div>
  )
}

function hoverInfo(game: GameRecord, p: number) {
  const m = game.moves[p - 1]
  if (!m) return null
  const no = Math.floor((p - 1) / 2) + 1
  return {
    label: `${no}${p % 2 ? '.' : '…'} ${m.san}`,
    spent: game.moveTimes?.spent[p - 1] ?? null,
  }
}

/** The bars, drawn once per game and width (moving through the game only moves the marker line). */
const Bars = memo(function Bars({ game, width, height }: { game: GameRecord; width: number; height: number }) {
  const bars = useMemo(() => {
    const spent = game.moveTimes?.spent ?? []
    const last = Math.max(1, game.moves.length)
    // Square-root scale: a long think stays the tallest bar without flattening every quick move to nothing.
    const top = Math.max(1, ...spent.map(s => s ?? 0))
    const half = height / 2 - 4
    const step = (width - 2 * MARGIN) / last
    const w = Math.max(1.5, Math.min(10, step * 0.72))
    return spent.map((s, i) => {
      if (s == null) return null
      const m = game.moves[i]
      const white = i % 2 === 0
      const len = s > 0 ? Math.max(1.5, Math.sqrt(s / top) * half) : 1
      const key = m && KEY_CLASSES.has(m.cls)
      return {
        x: MARGIN + step * (i + 1) - w / 2,
        y: white ? height / 2 - len : height / 2,
        w, h: len,
        fill: key ? CLS[m.cls].color : white ? 'rgba(232, 235, 242, 0.62)' : 'rgba(132, 142, 164, 0.72)',
        key: i,
      }
    })
  }, [game, width, height])

  return (
    <svg className="absolute inset-0" width={width} height={height} aria-hidden="true">
      <line x1={MARGIN} x2={width - MARGIN} y1={height / 2} y2={height / 2} stroke="rgba(255,255,255,0.12)" />
      {bars.map(b => b && <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(1.5, b.w / 2)} fill={b.fill} />)}
    </svg>
  )
})
