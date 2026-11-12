import { memo, useMemo, useRef } from 'react'
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CLS, ClassIcon, KEY_CLASSES } from '../lib/classes'
import type { GameRecord } from '../lib/types'

interface Point { ply: number; w: number; cls?: string; san?: string; evalText?: string; color?: string }

const MARGIN = 6

/**
 * The chart itself is drawn once per game; the marker for the move you're looking at is a separate line on
 * top. Stepping through a game (arrow keys, mouse wheel) then only moves that line instead of re-drawing
 * the whole chart on every move.
 */
export function EvalGraph({ game, ply, onSelect, height = 110 }:
  { game: GameRecord; ply: number; onSelect: (ply: number) => void; height?: number }) {
  const select = useRef(onSelect)
  select.current = onSelect
  const stable = useRef((p: number) => select.current(p)).current
  const last = Math.max(1, game.winPct.length - 1)
  const at = Math.max(0, Math.min(1, ply / last))
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#262a36] ring-1 ring-white/5" style={{ height }}>
      <Chart game={game} onSelect={stable} />
      <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#1ee3cf] transition-[left] duration-100 ease-out"
        style={{ left: `calc(${MARGIN}px + (100% - ${2 * MARGIN}px) * ${at} - 1px)` }} />
    </div>
  )
}

function dot(props: { cx?: number; cy?: number; payload?: Point; index?: number }) {
  const { cx, cy, payload, index } = props
  if (!payload?.cls || !KEY_CLASSES.has(payload.cls as never) || cx == null || cy == null) return <g key={index} />
  const c = CLS[payload.cls as keyof typeof CLS].color
  return <circle key={index} cx={cx} cy={cy} r={4} fill={c} stroke="#262a36" strokeWidth={2} />
}

const Chart = memo(function Chart({ game, onSelect }: { game: GameRecord; onSelect: (ply: number) => void }) {
  const data: Point[] = useMemo(() => game.winPct.map((w, i) => {
    const m = i > 0 ? game.moves[i - 1] : undefined
    return { ply: i, w, cls: m?.cls, san: m?.san, evalText: m?.evalText, color: m?.color }
  }), [game])

  return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN }}
          onClick={s => { if (s?.activeTooltipIndex != null) onSelect(Number(s.activeTooltipIndex)) }}
          style={{ cursor: 'pointer' }}
        >
          <defs>
            <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} />
              <stop offset="100%" stopColor="#d9deea" stopOpacity={0.9} />
            </linearGradient>
          </defs>
          <XAxis dataKey="ply" hide />
          <YAxis domain={[0, 100]} hide />
          <ReferenceLine y={50} stroke="#8f99b8" strokeOpacity={0.35} strokeDasharray="3 3" />
          <Tooltip
            cursor={{ stroke: '#ffffff', strokeOpacity: 0.3 }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const p = active && payload?.[0]?.payload as Point | undefined
              if (!p || !p.san) return null
              const moveNo = Math.ceil(p.ply / 2)
              return (
                <div className="glass flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">
                  {p.cls && <ClassIcon cls={p.cls as never} size={16} />}
                  <span className="font-semibold text-white">{moveNo}{p.color === 'w' ? '.' : '…'} {p.san}</span>
                  <span className="text-ink-300">{p.evalText}</span>
                </div>
              )
            }}
          />
          <Area
            type="monotone"
            dataKey="w"
            baseValue={0}
            stroke="#ffffff"
            strokeWidth={1.5}
            fill="url(#evalFill)"
            isAnimationActive
            animationDuration={900}
            activeDot={{ r: 4, fill: '#1ee3cf', stroke: '#fff', strokeWidth: 2 }}
            dot={dot}
          />
        </AreaChart>
      </ResponsiveContainer>
  )
})
