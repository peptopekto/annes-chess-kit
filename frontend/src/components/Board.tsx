import { Chess } from 'chess.js'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Config } from 'chessground/config'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react'
import { CLS, ClassIcon } from '../lib/classes'
import { cgColor, dests, needsPromotion, squareXY, turnOf } from '../lib/chess'
import { getBoardZoom, MAX_ZOOM, MIN_ZOOM, setBoardZoom, useBoardZoom } from '../lib/boardZoom'
import type { Cls, Color } from '../lib/types'

const brushes = {
  green: { key: 'g', color: '#15781B', opacity: 1, lineWidth: 10 },
  red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
  blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
  yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
  best: { key: 'best', color: '#58c43a', opacity: 0.85, lineWidth: 11 },
  engine: { key: 'eng', color: '#5b8cff', opacity: 0.75, lineWidth: 9 },
  engine2: { key: 'eng2', color: '#5b8cff', opacity: 0.4, lineWidth: 7 },
  hint: { key: 'hint', color: '#1ee3cf', opacity: 0.85, lineWidth: 11 },
  principle: { key: 'pr', color: '#e0b44c', opacity: 0.9, lineWidth: 6 },
  ...Object.fromEntries(Object.entries(CLS).map(([k, m]) => [k, { key: k, color: m.color, opacity: 0.9, lineWidth: 10 }])),
}

export interface BoardBadge { square: string; cls: Cls; id: string | number }

export interface BoardProps {
  fen: string
  orientation: Color
  lastMove?: [string, string] | null
  lastMoveColor?: string
  movable?: boolean
  /** Your side: while the other side is to move you can already pick up a piece and set a premove
   *  (like Chess.com / Lichess). It is played the moment it's your turn, if it's legal then. */
  premove?: Color
  onMove?: (uci: string) => void
  shapes?: DrawShape[]
  badge?: BoardBadge | null
  highlight?: { square: string; color: string } | null
  /** Coloured squares under the pieces' layer (e.g. which squares a side controls). */
  tints?: { square: string; color: string; ring?: string; ringWidth?: number }[]
  /** Mouse wheel over the board steps through the moves (sends ← / → like the keyboard). */
  wheelSteps?: boolean
  /** Show the grip on the bottom-right corner that resizes the board (the size is shared by every board). */
  resizable?: boolean
}

export interface BoardHandle { badgeRect(): DOMRect | null }

const SPECIAL = new Set<Cls>(['brilliant', 'great'])
/** Piece placement part of a FEN (what chessground's getFen() returns). */
const placement = (fen: string) => fen.split(' ')[0]
const PROMOS = ['q', 'r', 'b', 'n'] as const
const PROMO_ROLE = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' } as const

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(props, ref) {
  const el = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const badgeEl = useRef<HTMLDivElement>(null)
  const cg = useRef<Api | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [, resync] = useReducer((x: number) => x + 1, 0)
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null)
  // Right-click drawings (arrows/circles) you make, per position – like Lichess: they stay until you
  // left-click the board, and come back when you return to that position.
  const drawings = useRef(new Map<string, DrawShape[]>())
  const hasSize = () => (wrap.current?.clientWidth ?? 0) > 0

  useImperativeHandle(ref, () => ({ badgeRect: () => badgeEl.current?.getBoundingClientRect() ?? null }))

  const turn = turnOf(props.fen)
  const premoving = !props.movable && !!props.premove && turn !== props.premove
  const config: Config = {
    fen: props.fen,
    orientation: cgColor(props.orientation),
    turnColor: cgColor(turn),
    lastMove: (props.lastMove as Key[] | undefined) ?? undefined,
    check: props.fen && isCheck(props.fen) ? cgColor(turn) : false,
    coordinates: true,
    animation: { enabled: true, duration: 170 },
    highlight: { lastMove: true, check: true },
    movable: {
      free: false,
      color: props.movable ? cgColor(turn) : premoving ? cgColor(props.premove!) : undefined,
      dests: props.movable ? dests(props.fen) : new Map(),
      showDests: true,
      events: {
        after: (orig: Key, dest: Key) => {
          const p = latest.current
          if (needsPromotion(p.fen, orig, dest)) { setPromo({ from: orig, to: dest }); return }
          p.onMove?.(orig + dest)
          resync()
        },
      },
    },
    premovable: { enabled: !!props.premove, showDests: true, castle: true },
    draggable: { enabled: true, showGhost: true },
    drawable: {
      enabled: true, visible: true, eraseOnClick: true, autoShapes: props.shapes ?? [], brushes,
      onChange: (shapes: DrawShape[]) => { drawings.current.set(placement(latest.current.fen), shapes) },
    },
  }

  useEffect(() => {
    cg.current = Chessground(el.current!, config)
    // Chessground measures the board once; if that happens during an entry animation (page fade-in,
    // dialog opening) pieces and markings end up offset. Re-measure – but only rebuild the board when the
    // measurement is really off, and never while a piece is being dragged: a rebuild replaces every piece
    // element, so the piece in your hand would vanish until you let go.
    let retry: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      const api = cg.current
      if (!api || !wrap.current) return
      if (api.state.draggable.current || api.state.drawable.current) {
        clearTimeout(retry)
        retry = setTimeout(refresh, 150)
        return
      }
      const w = wrap.current.getBoundingClientRect()
      const c = wrap.current.querySelector('cg-container')?.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const want = (Math.floor((w.width * dpr) / 8) * 8) / dpr // chessground's own rounding
      if (c && Math.abs(c.width - want) < 0.5 && Math.abs(c.left - w.left) < 0.5 && Math.abs(c.top - w.top) < 0.5) {
        api.state.dom.bounds.clear() // the board is right; just forget the cached position
        return
      }
      api.redrawAll()
    }
    // When the board gets its real size (e.g. the window was hidden or tiny), draw the arrows it skipped.
    const ro = new ResizeObserver(() => {
      if (!cg.current) return
      if (hasSize()) cg.current.setAutoShapes(latest.current.shapes ?? [])
      refresh()
    })
    ro.observe(wrap.current!)
    const settle = [120, 400, 900].map(ms => setTimeout(refresh, ms))
    // Mouse wheel: step through the moves (down = forward, like Lichess), via the page's own ← / → keys.
    let acc = 0, last = 0
    const onWheel = (e: WheelEvent) => {
      if (!latest.current.wheelSteps) return
      e.preventDefault()
      acc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY
      const now = performance.now()
      if (Math.abs(acc) < 40 || now - last < 70) return
      const key = acc > 0 ? 'ArrowRight' : 'ArrowLeft'
      acc = 0
      last = now
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    const node = wrap.current!
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => { ro.disconnect(); settle.forEach(clearTimeout); clearTimeout(retry); node.removeEventListener('wheel', onWheel); cg.current?.destroy() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push every render's config; chessground diffs and animates. Passing `fen` makes chessground drop the
  // drawings, so it's only passed when the board really has to change position (a new position, or the
  // board showing something else after a move that was taken back) – with that position's drawings.
  useEffect(() => {
    const api = cg.current
    if (!api) return
    // A board with no size (hidden or minimised window) would draw arrows with NaN coordinates: skip them
    // until the resize observer sees a real size.
    const cfg = hasSize() ? config : { ...config, drawable: { ...config.drawable, autoShapes: [] } }
    if (api.getFen() === placement(props.fen)) {
      const { fen: _fen, ...rest } = cfg
      void _fen
      api.set(rest)
    } else {
      api.set({ ...cfg, drawable: { ...cfg.drawable, shapes: drawings.current.get(placement(props.fen)) ?? [] } })
    }
    // Your turn now: play the premove you set while waiting (dropped if it isn't legal any more). Without
    // premoves allowed (stepping back through the game, game over) a waiting one is forgotten.
    if (api.state.premovable.current) {
      if (!props.premove) api.cancelPremove()
      else if (props.movable) api.playPremove()
    }
  })

  const lmColor = props.lastMoveColor ?? 'rgba(247, 200, 69, 0.45)'
  const badgePos = props.badge ? squareXY(props.badge.square, props.orientation) : null
  const hl = props.highlight ? squareXY(props.highlight.square, props.orientation) : null
  const promoPos = promo ? squareXY(promo.to, props.orientation) : null

  return (
    <div ref={wrap} className="board-frame relative aspect-square w-full select-none" style={{ ['--lm' as string]: lmColor }}>
      <div ref={el} className="cg-wrap" />
      {props.resizable && <ResizeGrip board={wrap} />}

      {props.tints?.map(t => {
        const p = squareXY(t.square, props.orientation)
        return (
          <div key={t.square} className="pointer-events-none absolute z-[1]" style={{
            left: `${p.x * 12.5}%`, top: `${p.y * 12.5}%`, width: '12.5%', height: '12.5%',
            background: t.color, boxShadow: t.ring ? `inset 0 0 0 ${t.ringWidth ?? 3}px ${t.ring}` : undefined,
          }} />
        )
      })}

      {hl && (
        <div className="pointer-events-none absolute z-[1] rounded-sm" style={{
          left: `${hl.x * 12.5}%`, top: `${hl.y * 12.5}%`, width: '12.5%', height: '12.5%',
          boxShadow: `inset 0 0 0 4px ${props.highlight!.color}`, background: `${props.highlight!.color}33`,
        }} />
      )}

      <AnimatePresence>
        {props.badge && badgePos && (
          <motion.div
            key={props.badge.id}
            ref={badgeEl}
            className="pointer-events-none absolute z-20"
            style={{
              left: `calc(${(badgePos.x + 1) * 12.5}% - 3.4%)`,
              top: `calc(${badgePos.y * 12.5}% - 1.9%)`,
              width: '5.4%',
            }}
            // Only the special ratings get a bouncy pop; everything else just fades in.
            initial={{ scale: SPECIAL.has(props.badge.cls) ? 0.2 : 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={SPECIAL.has(props.badge.cls)
              ? { type: 'spring', stiffness: 500, damping: 18, delay: 0.1 }
              : { duration: 0.15, ease: 'easeOut', delay: 0.08 }}
          >
            <BadgeSized cls={props.badge.cls} />
          </motion.div>
        )}
      </AnimatePresence>

      {promo && promoPos && (
        // `cg-wrap` (for the piece images) brings chessground's unlayered `position: relative`, which beats
        // Tailwind's `absolute` – the picker then sat below the board, cut off. Hence the inline position.
        <div className="cg-wrap inset-0 z-30 bg-black/40 backdrop-blur-[1px]" style={{ position: 'absolute' }} onClick={() => { setPromo(null); resync() }}>
          <div className="absolute flex flex-col overflow-hidden rounded-lg bg-ink-100 shadow-2xl"
               style={{
                 left: `${promoPos.x * 12.5}%`, width: '12.5%',
                 ...(promoPos.y < 4 ? { top: 0 } : { bottom: 0 }),
               }}>
            {PROMOS.map(p => (
              <button key={p} className="relative aspect-square w-full hover:bg-accent/40"
                onClick={e => {
                  e.stopPropagation()
                  latest.current.onMove?.(promo.from + promo.to + p)
                  setPromo(null)
                  resync()
                }}>
                <piece className={`${cgColor(turn)} ${PROMO_ROLE[p]}`}
                       style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none' }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})

function BadgeSized({ cls }: { cls: Cls }) {
  // Scale the icon with the board: measure the wrapper once mounted.
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(30)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize(Math.max(18, e.contentRect.width)))
    ro.observe(ref.current!)
    return () => ro.disconnect()
  }, [])
  return <div ref={ref} className="aspect-square w-full"><ClassIcon cls={cls} size={size} glow={cls === 'brilliant' || cls === 'great'} /></div>
}

const checkCache = new Map<string, boolean>()
function isCheck(fen: string): boolean {
  let v = checkCache.get(fen)
  if (v === undefined) {
    try { v = new Chess(fen).inCheck() } catch { v = false }
    if (checkCache.size > 2000) checkCache.clear()
    checkCache.set(fen, v)
  }
  return v
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}

/**
 * The corner grip: drag to resize the board (as on Lichess), double-click for the largest size, or use the
 * arrow keys when it has focus. The size scales the largest board that fits, so it suits every page.
 */
function ResizeGrip({ board }: { board: React.RefObject<HTMLDivElement | null> }) {
  const zoom = useBoardZoom()
  const drag = useRef<{ x: number; y: number; width: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !board.current) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, width: board.current.getBoundingClientRect().width }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !board.current) return
    // Where the corner should be: the board grows by the pointer's average x/y movement.
    const target = d.width + ((e.clientX - d.x) + (e.clientY - d.y)) / 2
    const now = board.current.getBoundingClientRect().width
    if (now > 0) setBoardZoom(getBoardZoom() * target / now, false)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    setBoardZoom(getBoardZoom())
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key]
    if (step !== undefined) setBoardZoom(zoom + step)
    else if (e.key === 'Home') setBoardZoom(MIN_ZOOM)
    else if (e.key === 'End') setBoardZoom(MAX_ZOOM)
    else return
    e.preventDefault()
    e.stopPropagation()  // the arrow keys step through the moves elsewhere on the page
  }

  return (
    <div role="slider" tabIndex={0} aria-label="Board size" aria-valuemin={Math.round(MIN_ZOOM * 100)}
      aria-valuemax={Math.round(MAX_ZOOM * 100)} aria-valuenow={Math.round(zoom * 100)} aria-valuetext={`${Math.round(zoom * 100)} %`}
      title="Drag to resize the board · double-click for the largest size"
      className="board-grip" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp} onDoubleClick={() => setBoardZoom(MAX_ZOOM)} onKeyDown={onKeyDown}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M11 3 3 11M11 7 7 11" /></svg>
    </div>
  )
}
