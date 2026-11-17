import clsx from 'clsx'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import {
  ArrowLeftRight, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Copy, Cpu, Download, ExternalLink,
  ListOrdered, MoreHorizontal, Pause, Play, RefreshCw, Sparkles, Timer, Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Board, type BoardHandle } from '../components/Board'
import { MaterialDiff } from '../components/MaterialDiff'
import { EvalBar } from '../components/EvalBar'
import { EvalGraph } from '../components/EvalGraph'
import { MoveTimeChart } from '../components/MoveTimeChart'
import {
  alpha, CARD_HEIGHT, CoachCard, EngineLines, LineCard, MateStrip, PrincipleStrip, RetryCard, type Line, type Playout, type Retry,
} from '../components/review/Cards'
import { MoveList } from '../components/review/MoveList'
import { SummaryPanel } from '../components/review/SummaryPanel'
import { BoardSkeleton, Button, Card, ErrorNote } from '../components/ui'
import { api } from '../lib/api'
import { celebrate } from '../lib/celebrate'
import { CLS, KEY_CLASSES, RETRY_CLASSES, SOLVED_CLASSES } from '../lib/classes'
import { analysisLabel, buildLine, deeperAnalysis, lichessAnalysisUrl, playUci, turnOf, uciSquares } from '../lib/chess'
import { sound } from '../lib/sound'
import { startAnalysis, toast } from '../lib/store'
import type { Color, EngineLine, Eval, GameRecord, MoveRec, GameEnd } from '../lib/types'

type EngineResult = { eval: Eval; evalText: string; lines: EngineLine[]; over?: GameEnd | null }

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')
const ENGINE_KEY = 'brilliant.engineOn'
const readEngineOn = () => { try { return localStorage.getItem(ENGINE_KEY) === '1' } catch { return false } }
const PRINCIPLE_KEY = 'brilliant.principleOpen'
const readPrincipleOpen = () => { try { return localStorage.getItem(PRINCIPLE_KEY) === '1' } catch { return false } }
const TIMES_KEY = 'brilliant.moveTimes'
const readTimesOn = () => { try { return localStorage.getItem(TIMES_KEY) !== '0' } catch { return true } }

export function Review({ id, initialPly }: { id: string; initialPly?: number }) {
  const [game, setGame] = useState<GameRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ply, setPly] = useState(0)
  const [tab, setTab] = useState<'summary' | 'moves'>('summary')
  const [orientation, setOrientation] = useState<Color>('w')
  const [line, setLine] = useState<Line | null>(null)
  const [linePlaying, setLinePlaying] = useState(false)
  const [gamePlaying, setGamePlaying] = useState(false)
  const [retry, setRetry] = useState<Retry | null>(null)
  const [engineOn, setEngineOn] = useState(readEngineOn)
  const [timesOn, setTimesOn] = useState(readTimesOn)
  const [engineCache, setEngineCache] = useState<Record<string, EngineResult>>({})
  const [shake, setShake] = useState(0)
  const [menu, setMenu] = useState(false)
  // Playing a position out against Stockfish (a line with `vs` set).
  const [playout, setPlayout] = useState<Playout>({ status: 'your-move' })
  const [hint, setHint] = useState(false)
  const board = useRef<BoardHandle>(null)

  useEffect(() => {
    setGame(null); setError(null); setPly(0); setTab('summary'); setLine(null); setRetry(null); setGamePlaying(false)
    let alive = true
    api.game(id).then(g => {
      if (!alive) return
      setGame(g)
      setOrientation(g.me === 'b' ? 'b' : 'w')
      if (initialPly) { setPly(Math.min(initialPly, g.moves.length)); setTab('moves') }
      if (g.me && (g.counts[g.me].brilliant ?? 0) > 0) setTimeout(() => celebrate.big(), 500)
    }).catch(e => { if (alive) setError(String(e.message ?? e)) })
    return () => { alive = false }
  }, [id, initialPly])

  useEffect(() => { try { localStorage.setItem(ENGINE_KEY, engineOn ? '1' : '0') } catch { /* private mode */ } }, [engineOn])
  useEffect(() => { try { localStorage.setItem(TIMES_KEY, timesOn ? '1' : '0') } catch { /* private mode */ } }, [timesOn])
  // For the "Getting started" checklist on Home: you've opened a review.
  useEffect(() => { try { localStorage.setItem('brilliant.openedReview', '1') } catch { /* private mode */ } }, [])
  const [principleOpen, setPrincipleOpen] = useState(readPrincipleOpen)
  useEffect(() => { try { localStorage.setItem(PRINCIPLE_KEY, principleOpen ? '1' : '0') } catch { /* private mode */ } }, [principleOpen])

  const moves = useMemo(() => game?.moves ?? [], [game])
  const current: MoveRec | undefined = ply > 0 ? moves[ply - 1] : undefined
  const isMine = useCallback((m: MoveRec) => !game?.me || m.color === game.me, [game])

  // ------------------------------------------------------------ navigation
  const goTo = useCallback((p: number) => {
    if (!game) return
    const next = Math.max(0, Math.min(game.moves.length, p))
    setLine(null); setRetry(null); setLinePlaying(false)
    setPly(prev => {
      if (next !== prev && next > 0) sound.move(game.moves[next - 1].capture)
      return next
    })
    if (next > 0) setTab('moves')
  }, [game])

  const key = (dir: 1 | -1) => {
    for (let p = ply + dir; p >= 1 && p <= moves.length; p += dir) {
      const m = moves[p - 1]
      if (KEY_CLASSES.has(m.cls) && isMine(m)) return goTo(p)
    }
  }

  // Game autoplay.
  useEffect(() => {
    if (!gamePlaying) return
    if (ply >= moves.length) { setGamePlaying(false); return }
    const t = setTimeout(() => goTo(ply + 1), 1100)
    return () => clearTimeout(t)
  }, [gamePlaying, ply, moves.length, goTo])

  // Celebrate *your* great/brilliant moves (the opponent's just get their badge).
  const celebrated = useRef(new Set<number>())
  useEffect(() => { celebrated.current.clear() }, [id])
  useEffect(() => {
    if (!current || line || retry || !isMine(current) || celebrated.current.has(current.ply)) return
    const t = setTimeout(() => {
      celebrated.current.add(current.ply) // once per move, not every time you pass it
      if (current.cls === 'brilliant') { celebrate.brilliant(board.current?.badgeRect()); sound.cls('brilliant') }
      else if (current.cls === 'great') { celebrate.great(board.current?.badgeRect()); sound.cls('great') }
      else if (current.cls === 'blunder' || current.cls === 'miss') sound.cls(current.cls)
    }, 260)
    return () => clearTimeout(t)
  }, [current, line, retry, isMine])

  // ------------------------------------------------------------ lines (best line / why / engine / explore)
  const baseFen = game ? (ply > 0 ? moves[ply - 1].fen : game.startFen) : ''
  const lineFen = line ? (line.cursor === 0 ? line.startFen : line.fens[line.cursor - 1]) : null

  const openLine = (label: string, startFen: string, sans: string[], basePly: number, returnPly: number, note?: string) => {
    const built = buildLine(startFen, sans)
    if (!built.sans.length) return
    setRetry(null); setGamePlaying(false)
    setPly(basePly)
    setTab('moves')
    setLine({ label, startFen, basePly, returnPly, ...built, cursor: 0, explore: false, note })
    setLinePlaying(true)
  }

  const setCursor = useCallback((c: number) => {
    setLine(l => {
      if (!l) return l
      const next = Math.max(0, Math.min(l.sans.length, c))
      if (next > l.cursor) sound.move(l.captures[next - 1])
      return { ...l, cursor: next }
    })
  }, [])

  // Line autoplay: a beat before the first move, then one move every ~0.85s.
  useEffect(() => {
    if (!linePlaying || !line) return
    if (line.cursor >= line.sans.length) { setLinePlaying(false); return }
    const t = setTimeout(() => setCursor(line.cursor + 1), line.cursor === 0 ? 450 : 850)
    return () => clearTimeout(t)
  }, [linePlaying, line, setCursor])

  const exitLine = () => {
    if (line) setPly(line.returnPly)
    setLine(null); setLinePlaying(false)
  }

  const onExploreMove = (uci: string) => {
    const from = lineFen ?? baseFen
    if (line?.vs && (turnOf(from) === line.vs || playout.status === 'thinking' || playout.status === 'won')) return
    let res
    try { res = playUci(from, uci) } catch { return }
    sound.move(res.capture)
    setLinePlaying(false); setGamePlaying(false); setHint(false)
    if (line?.vs) setPlayout({ status: 'your-move' })
    setLine(l => {
      const base: Line = l ?? { label: 'Your line', startFen: baseFen, basePly: ply, returnPly: ply, ucis: [], sans: [], fens: [], captures: [], cursor: 0, explore: true }
      const keep = base.cursor
      return {
        ...base, label: base.vs ? base.label : 'Your line', explore: true,
        ucis: [...base.ucis.slice(0, keep), uci], sans: [...base.sans.slice(0, keep), res.san],
        fens: [...base.fens.slice(0, keep), res.fen], captures: [...base.captures.slice(0, keep), res.capture],
        cursor: keep + 1,
      }
    })
  }

  // Live engine for the displayed position (when toggled on, or while viewing a line).
  const displayFen = retry ? retry.fen : lineFen ?? baseFen
  const wantEngine = !!game && !retry && (engineOn || !!line)
  const engineNow = engineCache[displayFen]
  const inflight = useRef(new Set<string>())
  useEffect(() => {
    if (!wantEngine || engineCache[displayFen] || inflight.current.has(displayFen)) return
    // Short debounce so scrubbing quickly doesn't queue a search per position.
    const t = setTimeout(() => {
      inflight.current.add(displayFen)
      api.lines(displayFen, 18, 3)
        .then(r => setEngineCache(c => ({ ...c, [displayFen]: r }))) // cache even if we've moved on
        .catch(() => {})
        .finally(() => inflight.current.delete(displayFen))
    }, 250)
    return () => clearTimeout(t)
  }, [wantEngine, displayFen, engineCache])

  // ------------------------------------------------------------ play it out against Stockfish
  const cacheRef = useRef(engineCache)
  useEffect(() => { cacheRef.current = engineCache })
  const lines = useCallback(async (fen: string): Promise<EngineResult> => {
    const hit = cacheRef.current[fen]
    if (hit) return hit
    const r = await api.lines(fen, 18, 3)
    setEngineCache(c => (c[fen] ? c : { ...c, [fen]: r }))
    return r
  }, [])

  const startPlayout = (goal: number | null) => {
    const fen0 = displayFen
    setRetry(null); setGamePlaying(false); setLinePlaying(false); setTab('moves'); setHint(false)
    setPlayout({ status: 'your-move' })
    setLine({
      label: goal ? `Find the mate in ${goal}` : 'You vs Stockfish', startFen: fen0,
      basePly: line ? line.basePly : ply, returnPly: line ? line.returnPly : ply,
      ucis: [], sans: [], fens: [], captures: [], cursor: 0, explore: true, vs: other(turnOf(fen0)), goal,
    })
  }

  // After your move Stockfish answers with its best move. Looking for a mate, a move that lets it slip
  // stops the game (take back, or play on), and a slower mate is pointed out.
  const replied = useRef('')
  const mateLeft = useRef<number | null>(null)
  useEffect(() => {
    if (!line?.vs || line.cursor !== line.ucis.length) return
    const fenNow = line.cursor === 0 ? line.startFen : line.fens[line.cursor - 1]
    if (turnOf(fenNow) !== line.vs) return
    const key = `${line.startFen}|${line.ucis.join(',')}|${line.goal ?? ''}`
    if (replied.current === key) return
    replied.current = key
    if (line.cursor <= 1) mateLeft.current = line.goal ?? null
    const solver = other(line.vs)
    const goal = line.goal
    let alive = true, done = false
    setPlayout({ status: 'thinking' })
    const started = Date.now()
    void (async () => {
      try {
        const r = await lines(fenNow)
        if (!alive) return
        if (r.over || !r.lines.length) {
          const won = r.over?.winner === solver
          setPlayout({ status: won ? 'won' : 'over', text: r.over?.text.split(' – ')[0] ?? 'Game over' })
          if (won) { sound.success(); setTimeout(() => celebrate.solved(board.current?.badgeRect()), 120) }
          return
        }
        const m = r.eval.mate
        const winning = m != null && m !== 0 && (m > 0) === (solver === 'w')
        if (goal && !winning) {
          sound.fail()
          setPlayout({ status: 'slip', text: `That lets the mate slip – Stockfish says ${r.evalText} now. Take back and look again.` })
          return
        }
        let note: string | undefined
        if (goal && winning) {
          const left = Math.abs(m!)
          if (mateLeft.current != null && left > mateLeft.current - 1) note = `Still mate – but a slower one: mate in ${left} now.`
          mateLeft.current = left
        }
        await new Promise(res => setTimeout(res, Math.max(0, 500 - (Date.now() - started))))
        if (!alive) return
        const res = playUci(fenNow, r.lines[0].uci)
        sound.move(res.capture)
        setLine(l => (l && l.vs && l.cursor === l.ucis.length && (l.cursor === 0 ? l.startFen : l.fens[l.cursor - 1]) === fenNow
          ? { ...l, ucis: [...l.ucis, res.uci], sans: [...l.sans, res.san], fens: [...l.fens, res.fen], captures: [...l.captures, res.capture], cursor: l.cursor + 1 }
          : l))
        setPlayout({ status: 'your-move', text: note })
      } catch (e) {
        if (alive) setPlayout({ status: 'over', text: `Stockfish couldn't answer: ${(e as Error).message}` })
      } finally {
        done = true
      }
    })()
    return () => { alive = false; if (!done) replied.current = '' } // interrupted: ask again next time
  }, [line, lines])

  // Take back your last move (and Stockfish's answer to it).
  const takeBack = () => {
    setHint(false)
    setPlayout({ status: 'your-move' })
    setLine(l => {
      if (!l?.vs) return l
      const to = Math.max(0, l.cursor % 2 === 1 ? l.cursor - 1 : l.cursor - 2) // you move at even cursors
      return { ...l, ucis: l.ucis.slice(0, to), sans: l.sans.slice(0, to), fens: l.fens.slice(0, to), captures: l.captures.slice(0, to), cursor: to }
    })
  }
  const playOn = () => {
    setPlayout({ status: 'your-move' })
    setLine(l => (l ? { ...l, goal: null, label: 'You vs Stockfish' } : l))
  }

  // A forced mate on the board: from the live engine, or (for game positions) from the stored analysis.
  const shownEval: Eval | undefined = engineCache[displayFen]?.eval
    ?? (!line && !retry && game ? (current ? current.eval : game.startEval) : undefined)
  const mate = shownEval?.mate ? { side: (shownEval.mate > 0 ? 'w' : 'b') as Color, n: Math.abs(shownEval.mate) } : null
  const showMate = async () => {
    if (!mate) return
    const fen0 = displayFen
    const stored = !line ? moves[ply]?.bestLine : undefined // the review's own line from this game position
    const r = engineCache[fen0] ?? await lines(fen0).catch(() => null)
    const sans = r?.lines[0]?.line ?? stored ?? []
    openLine(`Mate in ${mate.n}`, fen0, sans, line ? line.basePly : ply, line ? line.returnPly : ply)
  }

  const playWhy = async () => {
    if (!current) return
    const next = moves[ply] // engine's analysis of the position after this move
    let sans = next?.bestLine
    if (!sans?.length) {
      const r = engineCache[current.fen] ?? await api.lines(current.fen, 16, 1).catch(() => null)
      sans = r?.lines[0]?.line ?? []
    }
    openLine(`After ${current.san} – best play`, current.fen, sans, ply, ply)
  }

  // ------------------------------------------------------------ retry
  const startRetry = (p: number) => {
    const m = moves[p - 1]
    setLine(null); setLinePlaying(false); setGamePlaying(false)
    setPly(p)
    setTab('moves')
    setRetry({ ply: p, status: 'idle', fen: m.fenBefore, attempts: 0, reveal: false })
  }

  const onRetryMove = async (uci: string) => {
    if (!retry || retry.status === 'checking') return
    const res = playUci(retry.fen, uci)
    sound.move(res.capture)
    setRetry(r => r && { ...r, status: 'checking', tried: uci })
    try {
      const prev = retry.ply > 1 ? moves[retry.ply - 2] : undefined // the opponent's move before
      const result = await api.check(retry.fen, uci, {
        depth: game?.depth, k: game?.ratingModel?.k, prevUci: prev?.uci, prevLoss: prev?.loss,
      })
      const ok = SOLVED_CLASSES.has(result.cls)
      setRetry(r => r && { ...r, status: ok ? 'solved' : 'failed', result, attempts: r.attempts + 1 })
      if (ok) {
        sound.success()
        setTimeout(() => celebrate.solved(board.current?.badgeRect()), 150)
      } else {
        sound.fail()
        setShake(s => s + 1)
        setTimeout(() => setRetry(r => r && r.status === 'failed' ? { ...r, status: 'idle', tried: undefined } : r), 1100)
      }
    } catch (e) {
      setRetry(r => r && { ...r, status: 'idle', tried: undefined })
      setError(String(e))
    }
  }

  const nextRetry = () => {
    for (let p = (retry?.ply ?? ply) + 1; p <= moves.length; p++) {
      const m = moves[p - 1]
      if (RETRY_CLASSES.has(m.cls) && m.cls !== 'inaccuracy' && isMine(m)) return startRetry(p)
    }
    setRetry(null)
  }

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (line) { if (line.cursor === 0) exitLine(); else { setLinePlaying(false); setCursor(line.cursor - 1) } }
        else goTo(ply - 1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (line) { setLinePlaying(false); setCursor(line.cursor + 1) } else if (!retry) goTo(ply + 1)
      } else if (e.key === 'ArrowUp') { e.preventDefault(); key(-1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); key(1) }
      else if (e.key === ' ') {
        e.preventDefault()
        if (line) setLinePlaying(p => !p); else setGamePlaying(p => !p)
      }
      else if (e.key === 'Home') goTo(0)
      else if (e.key === 'End') goTo(moves.length)
      else if (e.key === 'Escape') { exitLine(); setRetry(null) }
      else if (e.key === 'f') setOrientation(o => (o === 'w' ? 'b' : 'w'))
      else if (e.key === 'e') setEngineOn(v => !v)
      else if (e.key === 't') setTimesOn(v => !v)
      else if (e.key === 'p') setPrincipleOpen(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (error && !game) return <div className="mx-auto max-w-xl p-10"><ErrorNote>{error}</ErrorNote></div>
  if (!game) return <BoardSkeleton />

  // ------------------------------------------------------------ board state
  let fen = baseFen
  let lastMove: [string, string] | null = current ? uciSquares(current.uci) : null
  let lmColor = current ? alpha(CLS[current.cls].color, 0.5) : undefined
  let badge = current ? { square: current.uci.slice(2, 4), cls: current.cls, id: `m${ply}` } : null
  const shapes: DrawShape[] = []
  let evalNow: Eval = current ? current.eval : game.startEval
  let movable = true
  let onMove = onExploreMove
  const arrow = (uci: string, brush: string) => {
    const [o, d] = uciSquares(uci)
    shapes.push({ orig: o as Key, dest: d as Key, brush })
  }

  if (retry) {
    const m = moves[retry.ply - 1]
    const prev = retry.ply > 1 ? moves[retry.ply - 2] : null
    onMove = onRetryMove
    movable = retry.status === 'idle'
    evalNow = prev ? prev.eval : game.startEval
    if (retry.tried) {
      fen = playUci(retry.fen, retry.tried).fen
      lastMove = uciSquares(retry.tried)
      const cls = retry.result?.cls
      lmColor = cls ? alpha(CLS[cls].color, 0.5) : 'rgba(255,255,255,.25)'
      badge = cls ? { square: retry.tried.slice(2, 4), cls, id: `r${retry.attempts}` } : null
      if (retry.result) evalNow = retry.result.eval
    } else {
      fen = retry.fen
      lastMove = prev ? uciSquares(prev.uci) : null
      lmColor = undefined
      badge = null
    }
    if (retry.reveal || retry.status === 'solved') arrow(m.bestUci, 'best')
  } else if (line && lineFen) {
    fen = lineFen
    badge = null
    if (line.cursor > 0) {
      lastMove = uciSquares(line.ucis[line.cursor - 1])
      lmColor = 'rgba(91, 140, 255, 0.4)'
    }
    const next = line.cursor < line.ucis.length ? line.ucis[line.cursor] : null
    const best = engineNow?.lines[0]?.uci
    if (line.vs) {
      if (hint && best && turnOf(lineFen) !== line.vs) arrow(best, 'hint') // only when you ask for it
      movable = turnOf(lineFen) !== line.vs && playout.status !== 'thinking' && playout.status !== 'won'
    } else {
      if (next) arrow(next, 'engine') // the line's next move
      if (best && best !== next) arrow(best, next ? 'engine2' : 'engine') // Stockfish's choice here (e.g. in your own line)
    }
    if (engineNow) evalNow = engineNow.eval
    else if (line.cursor === 0) evalNow = current ? current.eval : game.startEval
  } else {
    if (current && !['best', 'brilliant', 'great', 'book', 'forced'].includes(current.cls)) arrow(current.bestUci, 'best')
    // Why it was bad: the opponent's punishing reply, in red (the coach card refers to it) – also with the engine on.
    const refute = current?.refute?.uci
    if (refute) arrow(refute, 'blunder')
    // The squares the principle is about (a hole, an outpost, the passed pawn), while it's open.
    if (principleOpen && current?.principle) {
      for (const sq of new Set(current.principle.concepts.flatMap(c => c.squares))) shapes.push({ orig: sq as Key, brush: 'principle' })
    }
    if (engineOn) {
      // The review already knows the best move here – draw it at once; the live engine takes over when it answers.
      // It's usually the punishing reply itself: then the red arrow already shows it.
      const best = engineNow?.lines[0]?.uci ?? moves[ply]?.bestUci
      if (best && best !== refute) arrow(best, 'engine')
    }
  }

  const top: Color = orientation === 'w' ? 'b' : 'w'
  const copyFen = async () => {
    await navigator.clipboard.writeText(fen).catch(() => {})
    toast({ title: 'FEN copied', body: fen })
    setMenu(false)
  }
  const deeper = deeperAnalysis(game)
  const reanalyze = () => {
    setMenu(false)
    void startAnalysis({ pgn: game.pgn, title: `${game.white} vs ${game.black}`, source: game.source ?? undefined, url: game.url ?? undefined },
      { depth: deeper.depth, moveTime: deeper.moveTime, force: true })
  }

  return (
    <div className="mx-auto flex h-full max-w-[1400px] flex-col gap-4 p-4 lg:flex-row lg:items-start lg:p-6">
      {/* ------------------------------------------------ board column */}
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="flex flex-col gap-2" style={{ width: 'calc(min(100%, calc(100vh - 9.5rem + 2.25rem)) * var(--board-zoom, 1))' }}>
          <PlayerStrip game={game} color={top} fen={fen} />
          <div className="flex gap-3">
            <div className="hidden sm:block"><EvalBar ev={evalNow} orientation={orientation} /></div>
            <div key={shake} className={clsx('relative min-w-0 flex-1', shake > 0 && 'animate-shake')}>
              <Board wheelSteps resizable ref={board} fen={fen} orientation={orientation} lastMove={lastMove} lastMoveColor={lmColor}
                movable={movable} onMove={onMove} shapes={shapes} badge={badge} />
              {game.end && ply === moves.length && !line && !retry && <EndBadge end={game.end} />}
            </div>
          </div>
          <PlayerStrip game={game} color={orientation} fen={fen} />
        </div>
      </div>

      {/* ------------------------------------------------ side panel */}
      <Card className="flex w-full shrink-0 flex-col overflow-hidden lg:h-[calc(100vh-3rem)] lg:max-h-[880px] lg:w-[410px]">
        <div className="relative flex items-center gap-1 border-b border-white/5 p-2">
          <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')}><Sparkles size={15} /> Summary</TabBtn>
          <TabBtn active={tab === 'moves'} onClick={() => { setTab('moves'); if (ply === 0) goTo(1) }}><ListOrdered size={15} /> Review</TabBtn>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" title="Engine lines (E)" onClick={() => setEngineOn(v => !v)}
            className={clsx(engineOn && 'bg-great/15 text-great hover:text-great')}>
            <Cpu size={16} />
          </Button>
          {game.moveTimes && (
            <Button variant="ghost" size="sm" title={timesOn ? 'Hide move times (T)' : 'Show move times (T)'} aria-pressed={timesOn}
              onClick={() => setTimesOn(v => !v)} className={clsx(timesOn && 'bg-great/15 text-great hover:text-great')}>
              <Timer size={16} />
            </Button>
          )}
          <Button variant="ghost" size="sm" title="Flip board (F)" onClick={() => setOrientation(o => (o === 'w' ? 'b' : 'w'))}>
            <ArrowLeftRight size={16} />
          </Button>
          <Button variant="ghost" size="sm" title="More" onClick={() => setMenu(m => !m)}><MoreHorizontal size={16} /></Button>
          {menu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
              <div className="popover absolute top-12 right-2 z-40 w-56 rounded-xl p-1.5 text-sm">
                <MenuItem onClick={copyFen}><Copy size={15} /> Copy FEN</MenuItem>
                <MenuItem href={api.pgnUrl(game.id)} onClick={() => setMenu(false)}><Download size={15} /> Download annotated PGN</MenuItem>
                <MenuItem href={lichessAnalysisUrl(fen)} external onClick={() => setMenu(false)}><ExternalLink size={15} /> Open position on Lichess</MenuItem>
                {game.url?.startsWith('http') && (
                  <MenuItem href={game.url} external onClick={() => setMenu(false)}><ExternalLink size={15} /> Open original game</MenuItem>
                )}
                <div className="my-1 h-px bg-white/5" />
                <MenuItem onClick={reanalyze}><RefreshCw size={15} /> Re-analyze deeper ({deeper.label})</MenuItem>
                <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-ink-500">This review: Stockfish, {analysisLabel(game)}</div>
              </div>
            </>
          )}
        </div>

        {tab === 'summary' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SummaryPanel game={game} onStart={() => { setTab('moves'); goTo(1) }} onJump={p => { setTab('moves'); goTo(p) }} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className={clsx('shrink-0 p-3 pb-2', CARD_HEIGHT)}>
              {retry ? (
                <RetryCard key={`retry-${retry.ply}`} retry={retry} move={moves[retry.ply - 1]}
                  onReveal={() => setRetry(r => r && { ...r, reveal: true })}
                  onExit={() => setRetry(null)} onNext={nextRetry} />
              ) : line ? (
                <LineCard key="line" line={line} evalText={engineNow?.evalText} playing={linePlaying}
                  playout={line.vs ? { state: playout, onHint: () => setHint(true), onTakeBack: takeBack, onPlayOn: playOn } : undefined}
                  onCursor={c => { setLinePlaying(false); setCursor(c) }}
                  onTogglePlay={() => {
                    if (!linePlaying && line.cursor >= line.sans.length) setCursor(0)
                    setLinePlaying(p => !p)
                  }}
                  onExit={exitLine} />
              ) : (
                <CoachCard key={`m${ply}`} move={current} game={game}
                  onRetry={current && RETRY_CLASSES.has(current.cls) ? () => startRetry(ply) : undefined}
                  onBestLine={current ? () => openLine(`Best line instead of ${current.san}`, current.fenBefore, current.bestLine, ply - 1, ply) : undefined}
                  onWhy={current ? () => void playWhy() : undefined} />
              )}
            </div>
            {current?.principle && !retry && !line && (
              <div className="shrink-0 px-3 pb-2">
                <PrincipleStrip key={`p${ply}`} principle={current.principle} open={principleOpen} onToggle={() => setPrincipleOpen(o => !o)}
                  onExample={ex => openLine(`Example: ${ex.title}`, ex.fen, ex.line, ply, ply, ex.note)}
                  onShowReply={moves[ply]?.bestLine?.length
                    ? () => openLine(`How to use ${current.san}`, current.fen, moves[ply].bestLine.slice(0, 4), ply, ply)
                    : undefined}
                  onFeedback={(c, fits) => {
                    c.fits = fits // kept on the loaded review, so it shows when you come back to this move
                    api.coachFeedback({ game: game.id, ply: current.ply, concept: c.concept, fits, strength: c.strength })
                      .then(() => toast({ title: fits ? 'Thanks – noted' : 'Noted – lessons like this need clearer evidence from now on', tone: 'good' }))
                      .catch(e => toast({ title: 'Couldn’t save that', body: String(e.message ?? e), tone: 'bad' }))
                  }} />
              </div>
            )}
            {mate && mate.n > 0 && !retry && !line?.vs && (
              <div className="shrink-0 px-3 pb-2">
                <MateStrip n={mate.n}
                  who={!game.me ? `${mate.side === 'w' ? 'White' : 'Black'} has` : mate.side === game.me ? 'You have' : 'Your opponent has'}
                  onShow={() => void showMate()}
                  onTry={turnOf(displayFen) === mate.side ? () => startPlayout(mate.n) : undefined} />
              </div>
            )}
            {(engineOn || line) && !retry && !line?.vs && (
              <div className="shrink-0 px-3 pb-2">
                <EngineLines lines={engineNow?.lines ?? null} loading={!engineNow} over={engineNow?.over}
                  onPlay={l => openLine('Engine line', fen, l.line, line ? line.basePly : ply, line ? line.returnPly : ply)}
                  onPlayOut={() => startPlayout(null)} />
              </div>
            )}
            <div className="shrink-0 px-3 pb-2">
              <EvalGraph game={game} ply={ply} onSelect={p => goTo(p)} height={76} />
              {timesOn && game.moveTimes && (
                <div className="mt-1.5"><MoveTimeChart game={game} ply={ply} onSelect={p => goTo(p)} height={56} /></div>
              )}
            </div>
            <MoveList moves={moves} ply={ply} onSelect={p => goTo(p)} end={game.end} />
          </div>
        )}

        {/* controls */}
        <div className="grid grid-cols-[1fr_1fr_1.4fr_1fr_1fr_1fr] gap-1.5 border-t border-white/5 p-2">
          <Button variant="soft" onClick={() => goTo(0)} title="Start (Home)"><ChevronFirst size={18} /></Button>
          <Button variant="soft" onClick={() => (line ? (line.cursor ? setCursor(line.cursor - 1) : exitLine()) : goTo(ply - 1))} title="Back (←)"><ChevronLeft size={20} /></Button>
          <Button variant="primary" onClick={() => (line ? setCursor(line.cursor + 1) : goTo(ply + 1))} title="Next (→)"
            disabled={line ? line.cursor >= line.sans.length : ply >= moves.length && !retry}>
            <ChevronRight size={22} />
          </Button>
          <Button variant="soft" onClick={() => goTo(moves.length)} title="End (End)"><ChevronLast size={18} /></Button>
          <Button variant="soft" onClick={() => (line ? setLinePlaying(p => !p) : setGamePlaying(p => !p))} title="Autoplay (Space)"
            className={clsx((gamePlaying || linePlaying) && 'bg-great/20 text-great')}>
            {gamePlaying || linePlaying ? <Pause size={16} /> : <Play size={16} />}
          </Button>
          <Button variant="soft" onClick={() => key(1)} title="Next key moment (↓)"><Zap size={16} /></Button>
        </div>
      </Card>
    </div>
  )
}

// --------------------------------------------------------------------------- //

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx('flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition cursor-pointer',
      active ? 'bg-ink-600 text-white' : 'text-ink-300 hover:bg-white/5 hover:text-white')}>
      {children}
    </button>
  )
}

function MenuItem({ children, onClick, href, external }:
  { children: React.ReactNode; onClick?: () => void; href?: string; external?: boolean }) {
  const cls = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-ink-200 transition hover:bg-white/5 hover:text-white cursor-pointer'
  if (href) return <a className={cls} href={href} onClick={onClick} {...(external ? { target: '_blank', rel: 'noreferrer' } : { download: '' })}>{children}</a>
  return <button className={cls} onClick={onClick}>{children}</button>
}

function PlayerStrip({ game, color, fen }: { game: GameRecord; color: Color; fen: string }) {
  const name = color === 'w' ? game.white : game.black
  const elo = color === 'w' ? game.whiteElo : game.blackElo
  const won = (game.result === '1-0' && color === 'w') || (game.result === '0-1' && color === 'b')
  return (
    <div className="flex items-center gap-2.5 px-1 sm:pl-10">
      <div className={clsx('flex size-7 items-center justify-center rounded-lg text-xs font-extrabold ring-1 ring-white/15',
        color === 'w' ? 'bg-white text-ink-900' : 'bg-ink-950 text-white')}>
        {name.slice(0, 1).toUpperCase()}
      </div>
      <span className="truncate text-sm font-semibold">{name}</span>
      {elo && <span className="text-xs text-ink-400">({elo})</span>}
      {game.me === color && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-bold text-accent">YOU</span>}
      <MaterialDiff fen={fen} color={color} className="ml-1" />
      {won && <span className="ml-auto rounded-md bg-best/15 px-1.5 py-0.5 text-[11px] font-bold text-best">WINNER</span>}
    </div>
  )
}

/** The result on the board once the game is over – like Lichess. */
function EndBadge({ end }: { end: GameEnd }) {
  const score = end.result === '1-0' ? '1–0' : end.result === '0-1' ? '0–1' : end.result === '1/2-1/2' ? '½–½' : ''
  const short = end.text.split(' – ')[0]
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 justify-center">
      <div className="popover flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm">
        {score && <span className="font-mono text-base font-semibold">{score}</span>}
        <span className="font-medium text-ink-100">{short}</span>
      </div>
    </div>
  )
}
