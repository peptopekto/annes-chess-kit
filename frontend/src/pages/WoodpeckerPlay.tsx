import { Chess } from 'chess.js'
import clsx from 'clsx'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { motion } from 'motion/react'
import {
  ArrowLeft, ArrowLeftRight, Brain, Check, ChevronLeft, ChevronRight, Cpu, Eye, Flame, Lightbulb, SkipForward, Timer, Trophy, Undo2, X,
} from 'lucide-react'
import { AnalysisBoard } from '../components/AnalysisBoard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Board, type BoardHandle } from '../components/Board'
import { MaterialBalance } from '../components/MaterialDiff'
import { EvalBar } from '../components/EvalBar'
import { BoardSkeleton, Button, Card, CountUp, ErrorNote, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { celebrate } from '../lib/celebrate'
import { SOLVED_CLASSES } from '../lib/classes'
import { accuracyColor, playUci, turnOf, uciSquares } from '../lib/chess'
import { go } from '../lib/router'
import { sound } from '../lib/sound'
import type { Color, Eval, Puzzle, PuzzleSet, RunStats } from '../lib/types'
import { SolutionPanel, themeLabel, threatShapes } from '../components/woodpecker/Solution'
import { fmtTime, runAccuracy } from './WoodpeckerSets'

/** Where a puzzle from your games comes from. While solving (`reveal` false) it must not name the
 *  tactic – "Missed forks" would give the answer away – so only the pattern behind it after solving. */
function puzzleOrigin(puzzle: Puzzle, reveal = true): string {
  const repeat = puzzle.repeat && puzzle.repeat > 1 ? `You went wrong in this exact position in ${puzzle.repeat} games.` : null
  const pt = puzzle.pattern
  if (!reveal || !pt || pt.count <= 1) return repeat ?? 'From one of your games.'
  return `${repeat ? repeat + ' ' : ''}Your pattern – ${pt.label.toLowerCase()}: ${pt.count}× in ${pt.games} of your games.`
}

/** Engine evaluation of a position, fetched once per position (shown after a puzzle is solved). */
const evalCache = new Map<string, Eval>()
function usePositionEval(fen: string, on: boolean): Eval | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!on || !fen || evalCache.has(fen)) return
    let alive = true
    api.lines(fen, 16, 1).then(r => { evalCache.set(fen, r.eval); if (alive) bump(x => x + 1) }).catch(() => {})
    return () => { alive = false }
  }, [fen, on])
  return on ? evalCache.get(fen) ?? null : null
}

/** The bar's slot is always there, so the board doesn't jump when the bar appears. */
function EvalSlot({ ev, orientation }: { ev: Eval | null; orientation: Color }) {
  return <div className="hidden w-7 shrink-0 sm:block">{ev && <EvalBar ev={ev} orientation={orientation} />}</div>
}

type Feedback = null | 'correct' | 'wrong' | 'solved' | 'checking'

interface PuzzleState {
  fens: string[]          // position history (for replay)
  ucis: string[]          // moves leading to fens[i+1]
  moveIndex: number       // next index into puzzle.moves
  attempts: number
  hinted: 0 | 1 | 2
  solved: boolean
  started: number
  /** After a wrong move: fens.length before it – the wrong move and Stockfish's answer are shown, then taken back. */
  retryFrom: number | null
}

/** Calculation mode: the line you worked out (your moves and the replies you expect), entered before any feedback. */
interface Draft { ucis: string[]; sans: string[]; fens: string[] }
const NO_DRAFT: Draft = { ucis: [], sans: [], fens: [] }
type CalcNote = null | { kind: 'more' } | { kind: 'defence'; expected: string; actual: string }
const CALC_KEY = 'woodpecker.calc', STILL_KEY = 'woodpecker.calc.still'
const stored = (key: string) => { try { return localStorage.getItem(key) === '1' } catch { return false } }
const store = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0') } catch { /* private mode */ } }

/** "12. Nxe5 dxe5 13. Qh5+" – numbered from the position the line starts in. */
function numbered(startFen: string, sans: string[]): string {
  const parts = startFen.split(' ')
  let no = Number(parts[5]) || 1, white = parts[1] === 'w'
  const out: string[] = []
  sans.forEach((san, i) => {
    if (white) out.push(`${no}.`)
    else if (i === 0) out.push(`${no}…`)
    out.push(san)
    if (!white) no++
    white = !white
  })
  return out.join(' ')
}

const newStats = (n: number): RunStats => ({
  timestamp: new Date().toISOString(), total_puzzles: n, total_time: 0, correct_first_try: 0, puzzles_data: {},
})

export function WoodpeckerPlay({ id }: { id: string }) {
  const [set, setSet] = useState<PuzzleSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [idx, setIdx] = useState(0)
  const [stats, setStats] = useState<RunStats | null>(null)
  const [p, setP] = useState<PuzzleState | null>(null)
  const [view, setView] = useState<number | null>(null) // replay position, null = live
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [orientation, setOrientation] = useState<Color>('w')
  const [analysing, setAnalysing] = useState(false)
  const [autoNext, setAutoNext] = useState(true)
  // Calculation mode: enter the whole line first, then check it in one go.
  const [calc, setCalc] = useState(() => stored(CALC_KEY))
  const [still, setStill] = useState(() => stored(STILL_KEY))
  const [draft, setDraft] = useState<Draft>(NO_DRAFT)
  const [calcNote, setCalcNote] = useState<CalcNote>(null)
  const [typed, setTyped] = useState('')
  const [typedError, setTypedError] = useState<string | null>(null)
  const checks = useRef(0)             // "Check line" presses on this puzzle
  const [oneGo, setOneGo] = useState(false)
  useEffect(() => { store(CALC_KEY, calc) }, [calc])
  useEffect(() => { store(STILL_KEY, still) }, [still])
  const resetDraft = () => { setDraft(NO_DRAFT); setTyped(''); setTypedError(null) }
  const [streak, setStreak] = useState(0)
  // Stockfish's answer to your wrong move: null while asking, false if it has none.
  const [punish, setPunish] = useState<null | false | { san: string }>(null)
  const punishToken = useRef(0) // a retry (or the next puzzle) cancels a pending answer
  const [shake, setShake] = useState(0)
  // Puzzles finished this session (to look back at one – e.g. after Auto-next moved on too fast).
  const history = useRef(new Map<number, { puzzle: Puzzle; state: PuzzleState }>())
  const [peek, setPeek] = useState<number | null>(null)
  const [done, setDone] = useState<{ stats: RunStats; prev?: RunStats } | null>(null)
  // The clock on screen (state, so render never reads the refs below).
  const [clock, setClock] = useState({ base: 0, start: 0 })
  const [now, setNow] = useState(0)
  const board = useRef<BoardHandle>(null)
  // Time accumulated in this cycle before the current session started.
  const baseTime = useRef(0)
  const sessionStart = useRef(0)
  const runTime = () => baseTime.current + (Date.now() - sessionStart.current) / 1000

  // ---------------------------------------------------------------- load
  useEffect(() => {
    api.set(id).then(s => {
      setSet(s)
      const ap = s.metadata.active_progress
      if (ap) {
        setIdx(ap.current_idx); setStats(ap.stats); baseTime.current = ap.accumulated_time
      } else {
        setIdx(0); setStats(newStats(s.puzzles.length)); baseTime.current = 0
      }
      sessionStart.current = Date.now()
      setClock({ base: baseTime.current, start: sessionStart.current })
    }).catch(e => setError(String(e.message ?? e)))
  }, [id])

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  // Save progress when leaving the page.
  const latest = useRef({ idx, stats, set, done })
  useEffect(() => { latest.current = { idx, stats, set, done } })
  useEffect(() => () => {
    const { idx, stats, set, done } = latest.current
    if (!set || !stats || done) return
    void fetch(`/api/woodpecker/sets/${set.id}/progress`, {
      method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_idx: idx, stats, accumulated_time: runTime() }),
    })
  }, [])

  // ---------------------------------------------------------------- puzzle setup
  const puzzle = set?.puzzles[idx]

  useEffect(() => {
    if (!puzzle) return
    setFeedback(null); setView(null); setPunish(null); punishToken.current++
    setDraft(NO_DRAFT); setTyped(''); setTypedError(null); setCalcNote(null); checks.current = 0; setOneGo(false)
    const start: PuzzleState = { fens: [puzzle.fen], ucis: [], moveIndex: 0, attempts: 0, hinted: 0, solved: false, started: Date.now(), retryFrom: null }
    setP(start)
    const player = turnOf(puzzle.fen) === 'w' ? 'b' : 'w'
    setOrientation(player)
    // Opponent's setup move, animated after a beat.
    const t = setTimeout(() => {
      const r = playUci(puzzle.fen, puzzle.moves[0])
      sound.move(r.capture)
      setP(s => s && { ...s, fens: [...s.fens, r.fen], ucis: [puzzle.moves[0]], moveIndex: 1, started: Date.now() })
    }, 450)
    return () => clearTimeout(t)
  }, [puzzle])

  // ---------------------------------------------------------------- flow
  const finishRun = useCallback(async (final: RunStats) => {
    if (!set) return
    const out = { ...final, total_time: runTime() }
    const prev = set.metadata.completed_runs[set.metadata.completed_runs.length - 1]
    await api.completeRun(set.id, out).catch(() => {})
    setDone({ stats: out, prev })
    const better = !prev || runAccuracy(out) >= runAccuracy(prev) || out.total_time < prev.total_time
    if (better) { celebrate.big(); sound.fanfare() }
  }, [set])

  const next = useCallback(() => {
    if (!set || !stats) return
    const n = idx + 1
    if (n >= set.puzzles.length) { void finishRun(stats); return }
    setIdx(n)
    void api.saveProgress(set.id, { current_idx: n, stats, accumulated_time: runTime() }).catch(() => {})
  }, [set, stats, idx, finishRun])

  const markSolved = (state: PuzzleState) => {
    if (!puzzle || !stats) return
    history.current.set(idx, { puzzle, state })
    const first = state.attempts === 0 && state.hinted === 0
    const time = (Date.now() - state.started) / 1000
    const s: RunStats = {
      ...stats,
      correct_first_try: stats.correct_first_try + (first ? 1 : 0),
      puzzles_data: { ...stats.puzzles_data, [puzzle.id]: { time, attempts: state.attempts + 1, correct_first: first } },
    }
    setStats(s)
    setStreak(x => (first ? x + 1 : 0))
    setOneGo(first && checks.current === 1)
    setFeedback('solved')
    sound.success()
    if (first) setTimeout(() => celebrate.solved(board.current?.badgeRect()), 80)
  }

  useEffect(() => {
    if (feedback === 'solved' && autoNext && peek === null) {
      const t = setTimeout(next, 1100)
      return () => clearTimeout(t)
    }
  }, [feedback, autoNext, next, peek])

  /** Finished puzzles before `from`, newest first. */
  const earlier = (from: number) => [...history.current.keys()].filter(i => i < from).sort((a, b) => b - a)
  const later = (from: number) => [...history.current.keys()].filter(i => i > from && i < idx).sort((a, b) => a - b)

  const fail = () => {
    setP(s => s && { ...s, attempts: s.attempts + 1 })
    setStreak(0)
    setFeedback('wrong')
    setShake(x => x + 1)
    sound.fail()
  }

  /** Wrong move: play it, let Stockfish answer it the way a strong opponent would, then you retry. */
  const punishWrong = async (fen: string, uci: string) => {
    fail()
    setPunish(null)
    const token = ++punishToken.current
    const wrong = playUci(fen, uci)
    sound.move(wrong.capture)
    setP(s => s && { ...s, fens: [...s.fens, wrong.fen], ucis: [...s.ucis, uci], retryFrom: s.fens.length })
    let reply: string | null = null, replySan: string | null = null
    try {
      const r = await api.check(fen, uci, { depth: 16 })
      reply = r.replyUci ?? null; replySan = r.replySan ?? null
    } catch { /* engine unavailable: just retry */ }
    if (token !== punishToken.current) return
    if (!reply || !replySan) { setPunish(false); return }
    const san = replySan, move = reply
    setTimeout(() => {
      if (token !== punishToken.current) return
      const r = playUci(wrong.fen, move)
      sound.move(r.capture)
      setP(s => s && s.retryFrom != null ? { ...s, fens: [...s.fens, r.fen], ucis: [...s.ucis, move] } : s)
      setPunish({ san })
    }, 350)
  }

  /** Take back the wrong move and Stockfish's answer. */
  const retry = () => {
    punishToken.current++
    setP(s => s && s.retryFrom != null
      ? { ...s, fens: s.fens.slice(0, s.retryFrom), ucis: s.ucis.slice(0, s.retryFrom - 1), retryFrom: null } : s)
    setPunish(null)
    setFeedback(null)
    setView(null)
    resetDraft(); setCalcNote(null)
  }

  // ---------------------------------------------------------------- calculation mode
  /** Is `uci` right at this point of the puzzle? (the stored move, an equally good one, or mate) */
  const judge = async (fen: string, uci: string, moveIndex: number) => {
    const expected = puzzle!.moves[moveIndex]
    const res = playUci(fen, uci)
    const isMate = res.san.endsWith('#')
    const matches = uci === expected || (uci.slice(0, 4) === expected.slice(0, 4) && !expected[4] && !uci[4])
    const step = (moveIndex - 1) / 2
    const alts = puzzle!.altSteps?.[step] ?? (step === 0 ? puzzle!.alternatives : undefined)
    const altOk = !!alts?.includes(uci)
    let ok = matches || isMate || altOk
    if (!ok && puzzle!.engineCheck && !alts) { // older sets: ask the engine
      try { ok = SOLVED_CLASSES.has((await api.check(fen, uci)).cls) } catch { ok = false }
    }
    return { ok, res, isMate, matches, altOk }
  }

  /** Add a move to your line (either side). Nothing is judged yet. */
  const addDraft = (uci: string) => {
    if (!p) return
    const base = draft.fens[draft.fens.length - 1] ?? p.fens[p.fens.length - 1]
    let r
    try { r = playUci(base, uci) } catch { return }
    sound.move(r.capture)
    setDraft(d => ({ ucis: [...d.ucis, r.uci], sans: [...d.sans, r.san], fens: [...d.fens, r.fen] }))
    setCalcNote(null); setTypedError(null)
    if (feedback === 'correct') setFeedback(null)
  }

  /** Typed moves ("Nxe5 dxe5 Qh5+"): added to the line one by one; stops at the first that can't be played. */
  const addTyped = () => {
    if (!p) return
    const tokens = typed.replace(/\d+\.(\.\.)?|…/g, ' ').split(/\s+/).filter(Boolean)
    if (!tokens.length) { if (draft.ucis.length) void checkLine(); return }
    let fen = draft.fens[draft.fens.length - 1] ?? p.fens[p.fens.length - 1]
    const add: Draft = { ucis: [], sans: [], fens: [] }
    let bad: string | null = null
    for (const t of tokens) {
      try {
        const c = new Chess(fen)
        const m = c.move(t, { strict: false })
        fen = c.fen()
        add.ucis.push(m.from + m.to + (m.promotion ?? '')); add.sans.push(m.san); add.fens.push(fen)
      } catch { bad = t; break }
    }
    if (add.ucis.length) {
      setDraft(d => ({ ucis: [...d.ucis, ...add.ucis], sans: [...d.sans, ...add.sans], fens: [...d.fens, ...add.fens] }))
      setCalcNote(null)
      if (feedback === 'correct') setFeedback(null)
    }
    setTyped(bad ? tokens.slice(add.ucis.length).join(' ') : '')
    setTypedError(bad ? `"${bad}" can't be played in that position.` : null)
  }

  /**
   * Check the whole line at once. Your moves are judged against the solution as long as the replies you
   * expected are the ones that get played; the board then shows the line up to where it stops:
   * solved · a wrong move (Stockfish answers it, you try again from there) · a different defence than you
   * expected, or the line simply isn't finished – then you calculate on from the new position.
   */
  const checkLine = async () => {
    if (!p || !puzzle || p.solved || p.retryFrom != null || feedback === 'checking' || !draft.ucis.length) return
    checks.current++
    setFeedback('checking')
    const fens = [...p.fens], ucis = [...p.ucis]
    let fen = fens[fens.length - 1], moveIndex = p.moveIndex
    const line = draft
    resetDraft()
    for (let i = 0; i < line.ucis.length; i += 2) {
      let v
      try { v = await judge(fen, line.ucis[i], moveIndex) } catch { break }
      if (!v.ok) {
        setP({ ...p, fens, ucis, moveIndex })
        setCalcNote(null); setFeedback(null)
        void punishWrong(fen, line.ucis[i])
        return
      }
      fens.push(v.res.fen); ucis.push(line.ucis[i]); moveIndex++
      // An equally good move that leaves the stored line ends the puzzle as solved (like Lichess).
      if (v.isMate || moveIndex >= puzzle.moves.length || (!v.matches && (v.altOk || !!puzzle.engineCheck))) {
        const after: PuzzleState = { ...p, fens, ucis, moveIndex, solved: true }
        sound.move(v.res.capture)
        setP(after); setCalcNote(null)
        markSolved(after)
        return
      }
      const reply = puzzle.moves[moveIndex]
      const r = playUci(v.res.fen, reply)
      fens.push(r.fen); ucis.push(reply); moveIndex++
      fen = r.fen
      const predicted = line.ucis[i + 1]
      if (predicted === undefined || predicted !== r.uci || i + 2 >= line.ucis.length) {
        sound.move(r.capture)
        setP({ ...p, fens, ucis, moveIndex })
        setCalcNote(predicted !== undefined && predicted !== r.uci
          ? { kind: 'defence', expected: line.sans[i + 1], actual: r.san } : { kind: 'more' })
        setFeedback('correct')
        return
      }
    }
    setFeedback(null)
  }

  const onMove = async (uci: string) => {
    if (!p || !puzzle || p.solved || view !== null || feedback === 'checking' || p.retryFrom != null) return
    const fen = p.fens[p.fens.length - 1]
    const expected = puzzle.moves[p.moveIndex]
    const res = playUci(fen, uci)
    const isMate = res.san.endsWith('#')
    const matches = uci === expected || (uci.slice(0, 4) === expected.slice(0, 4) && !expected[4] && !uci[4])

    // Equally good moves for every step were computed when the set was built – accept them instantly.
    const step = (p.moveIndex - 1) / 2
    const alts = puzzle.altSteps?.[step] ?? (step === 0 ? puzzle.alternatives : undefined)
    const altOk = !!alts?.includes(uci)
    let ok = matches || isMate || altOk
    if (!ok && puzzle.engineCheck && !alts) { // older sets: ask the engine
      setFeedback('checking')
      try { ok = SOLVED_CLASSES.has((await api.check(fen, uci)).cls) } catch { ok = false }
    }
    if (!ok) { setFeedback(null); void punishWrong(fen, uci); return }

    sound.move(res.capture)
    const after: PuzzleState = { ...p, fens: [...p.fens, res.fen], ucis: [...p.ucis, uci], moveIndex: p.moveIndex + 1 }
    // An equally good move that leaves the stored line ends the puzzle as solved (like Lichess).
    const finished = isMate || after.moveIndex >= puzzle.moves.length || (!matches && (altOk || !!puzzle.engineCheck))
    if (finished) {
      after.solved = true
      setP(after)
      markSolved(after)
      return
    }
    setP(after)
    setFeedback('correct')
    // Opponent reply.
    setTimeout(() => {
      const reply = puzzle.moves[after.moveIndex]
      const r = playUci(res.fen, reply)
      sound.move(r.capture)
      setP(s => s && { ...s, fens: [...s.fens, r.fen], ucis: [...s.ucis, reply], moveIndex: s.moveIndex + 1 })
    }, 380)
  }

  const showSolution = () => {
    if (!p || !puzzle) return
    punishToken.current++
    setPunish(null); setView(null)
    // Play out the rest of the line (after taking back a wrong move); counts as not-first-try.
    const keep = p.retryFrom ?? p.fens.length
    const fens = p.fens.slice(0, keep), ucis = p.ucis.slice(0, keep - 1)
    let fen = fens[fens.length - 1]
    for (let i = p.moveIndex; i < puzzle.moves.length; i++) {
      fen = playUci(fen, puzzle.moves[i]).fen
      fens.push(fen); ucis.push(puzzle.moves[i])
    }
    const s = { ...p, fens, ucis, moveIndex: puzzle.moves.length, solved: true, attempts: Math.max(1, p.attempts), retryFrom: null }
    setP(s)
    markSolved(s)
    setStreak(0)
  }

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!p || peek !== null) return  // the look-back view has its own keys
      if (e.target instanceof HTMLInputElement) return  // typing a line
      if (e.key === 'ArrowLeft') setView(v => Math.max(0, (v ?? p.fens.length - 1) - 1))
      else if (e.key === 'ArrowRight') setView(v => (v == null || v + 1 >= p.fens.length - 1 ? null : v + 1))
      else if ((e.key === 'Enter' || e.key === ' ') && feedback === 'solved') { e.preventDefault(); next() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // After solving: the evaluation of the position on the board (any move of the line you step to).
  const evNow = usePositionEval(p && peek === null ? p.fens[view ?? p.fens.length - 1] ?? '' : '', !!p?.solved && peek === null)

  if (error) return <div className="mx-auto max-w-lg p-10"><ErrorNote>{error}</ErrorNote></div>
  if (!set || !stats) return <BoardSkeleton />
  if (done) return <RunSummary set={set} stats={done.stats} prev={done.prev} />
  if (!puzzle || !p) return null

  const peeked = peek !== null ? history.current.get(peek) : undefined
  if (peek !== null && peeked) {
    const older = earlier(peek)[0], newer = later(peek)[0]
    return <PreviousPuzzle key={peek} index={peek} total={set.puzzles.length} puzzle={peeked.puzzle} state={peeked.state}
      orientation={turnOf(peeked.puzzle.fen) === 'w' ? 'b' : 'w'}
      onBack={() => setPeek(null)}
      onOlder={older !== undefined ? () => setPeek(older) : undefined}
      onNewer={newer !== undefined ? () => setPeek(newer) : undefined} />
  }
  const previous = earlier(idx)[0]

  // ---------------------------------------------------------------- render
  const shownIdx = view ?? p.fens.length - 1
  // Calculation mode: you are entering your line (nothing has been judged yet).
  const drafting = calc && view === null && !p.solved && p.moveIndex > 0 && p.retryFrom == null
  const liveFen = p.fens[p.fens.length - 1]
  const showDraft = drafting && draft.fens.length > 0 && !still
  const fen = showDraft ? draft.fens[draft.fens.length - 1] : p.fens[shownIdx]
  const lastUci = showDraft ? draft.ucis[draft.ucis.length - 1] : shownIdx > 0 ? p.ucis[shownIdx - 1] : null
  const expected = puzzle.moves[p.moveIndex]
  const shapes: DrawShape[] = []
  let highlight = null
  if (view === null && !p.solved && p.retryFrom == null && expected && p.hinted > 0 && !showDraft) {
    const [o, d] = uciSquares(expected)
    if (p.hinted === 1) highlight = { square: o, color: '#1ee3cf' }
    else shapes.push({ orig: o as Key, dest: d as Key, brush: 'hint' })
  }
  // Once solved: show what *your* final move threatens (forked pieces, pinned piece, mated king) – only on the
  // final position and only when the opponent is to move there. In-between positions of the line would
  // otherwise show whatever happens to be attacked at that moment (often your own pieces), which misleads.
  const atEnd = shownIdx === p.fens.length - 1
  const solver = turnOf(puzzle.fen) === 'w' ? 'b' : 'w' // the opponent makes the setup move, you solve
  if (p.solved && shownIdx > 1 && atEnd && turnOf(fen) !== solver) {
    const t = threatShapes(fen)
    shapes.push(...t.shapes)
    if (t.king) highlight = { square: t.king, color: '#ff3d55' }
  }
  const playerTurn = turnOf(fen) === orientation
  const solvedFirst = Object.values(stats.puzzles_data).filter(x => x.correct_first).length
  const attempted = Object.keys(stats.puzzles_data).length
  const lmColor = showDraft ? undefined : feedback === 'solved' ? 'rgba(127, 216, 88, .55)' : feedback === 'correct' ? 'rgba(127, 216, 88, .4)'
    : p.retryFrom != null ? 'rgba(255, 61, 85, .45)' : undefined

  return (
    <div className="mx-auto flex h-full max-w-[1300px] flex-col gap-4 p-4 lg:flex-row lg:items-start lg:p-6">
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="flex flex-col gap-3" style={{ width: 'min(100%, calc(100vh - 7rem))' }}>
          <div className="flex items-center gap-3 px-1">
            <span className={clsx('size-4 rounded ring-1 ring-white/30', orientation === 'w' ? 'bg-white' : 'bg-ink-950')} />
            <span className="font-display text-lg font-semibold">{orientation === 'w' ? 'White' : 'Black'} to move</span>
            {showDraft && <span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-bold text-accent">Your line · not checked yet</span>}
            {view !== null && <span className="rounded-md bg-great/15 px-2 py-0.5 text-xs font-bold text-great">Replay {view}/{p.fens.length - 1}</span>}
            <MaterialBalance fen={fen} className="ml-auto" />
          </div>
          <div className="flex gap-3">
          <EvalSlot ev={evNow} orientation={orientation} />
          <motion.div key={shake} className="min-w-0 flex-1" animate={shake ? { x: [0, -10, 10, -7, 7, 0] } : {}} transition={{ duration: 0.4 }}>
            <Board wheelSteps ref={board} fen={fen} orientation={orientation} lastMove={lastUci ? uciSquares(lastUci) : null}
              lastMoveColor={view === null ? lmColor : undefined}
              movable={drafting ? !still && feedback !== 'checking'
                : view === null && !p.solved && playerTurn && feedback !== 'checking' && p.moveIndex > 0 && p.retryFrom == null}
              onMove={drafting ? addDraft : onMove} shapes={shapes} highlight={highlight}
              badge={feedback === 'solved' && lastUci && view === null
                ? { square: lastUci.slice(2, 4), cls: p.attempts === 0 && p.hinted === 0 ? 'best' : 'good', id: `s${idx}` } : null} />
          </motion.div>
          </div>
        </div>
      </div>

      <Card className="flex w-full shrink-0 flex-col gap-4 p-4 lg:w-[360px]">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => go('/woodpecker')}><ArrowLeft size={15} /> Sets</Button>
          <span className="flex items-center gap-1.5 font-mono text-sm tabular-nums text-ink-200"><Timer size={14} /> {fmtTime(clock.base + (clock.start && now > clock.start ? (now - clock.start) / 1000 : 0))}</span>
        </div>

        <div>
          <div className="truncate text-xs font-medium uppercase tracking-wide text-ink-400">{set.metadata.name}</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="font-display text-[30px] leading-tight font-semibold tabular-nums">{idx + 1}<span className="text-lg text-ink-400">/{set.puzzles.length}</span></span>
            {puzzle.rating != null && <span className="rounded-lg bg-ink-700 px-2 py-1 text-sm font-bold tabular-nums">★ {puzzle.rating}</span>}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
            <motion.div className="h-full rounded-full bg-gradient-to-r from-accent to-great" animate={{ width: `${(idx / set.puzzles.length) * 100}%` }} />
          </div>
          <Pace set={set} stats={stats} />
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="First try" value={`${solvedFirst}/${attempted}`} />
          <Stat label="Accuracy" value={attempted ? `${Math.round((solvedFirst / attempted) * 100)}%` : '—'} color={attempted ? accuracyColor((solvedFirst / attempted) * 100) : undefined} />
          <div className="rounded-xl bg-ink-850 py-2 ring-1 ring-white/5">
            <motion.div key={streak} initial={{ scale: 1.5 }} animate={{ scale: 1 }}
              className={clsx('flex items-center justify-center gap-1 font-display text-xl font-semibold', streak >= 3 ? 'text-mistake' : 'text-ink-100')}>
              <Flame size={18} className={streak >= 3 ? 'fill-mistake' : ''} />{streak}
            </motion.div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Streak</div>
          </div>
        </div>

        <div className="min-h-[76px]">
            <motion.div key={feedback ?? 'idle'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className={clsx('flex items-center gap-3 rounded-2xl p-3.5 ring-1',
                feedback === 'solved' && 'bg-best/12 ring-best/30',
                feedback === 'correct' && 'bg-best/8 ring-best/20',
                feedback === 'wrong' && 'bg-blunder/10 ring-blunder/30',
                (!feedback || feedback === 'checking') && 'bg-ink-850 ring-white/5')}>
              {feedback === 'solved' && <><Badge className="bg-best"><Check size={18} strokeWidth={3} /></Badge><div><b className="text-best">Solved!</b><div className="text-xs text-ink-300">{calc && oneGo ? 'The whole line, calculated in one go.' : p.attempts === 0 && p.hinted === 0 ? 'First try. Clean.' : 'Got there in the end.'}{autoNext ? ' Next one coming…' : ''}</div></div></>}
              {feedback === 'correct' && <><Badge className="bg-best"><Check size={18} strokeWidth={3} /></Badge><div><b className="text-best">Correct!</b><div className="text-xs text-ink-300">{!calc || !calcNote ? 'Keep going…'
                : calcNote.kind === 'defence' ? <>Right so far. You expected <b className="text-ink-100">{calcNote.expected}</b>, but the best defence is <b className="text-ink-100">{calcNote.actual}</b>. Calculate on from here.</>
                : 'Right so far – but the line goes on. Calculate the rest from here.'}</div></div></>}
              {feedback === 'wrong' && <><Badge className="bg-blunder"><X size={18} strokeWidth={3} /></Badge><div className="min-w-0 flex-1"><b className="text-[#ff8a9a]">Not the move.</b>
                <div className="text-xs text-ink-300">{punish ? <>Stockfish answers <b className="text-ink-100">{punish.san}</b>.</> : punish === null && p.retryFrom != null ? 'Stockfish is answering…' : 'Try again.'}</div></div>
                {p.retryFrom != null && <Button size="sm" onClick={retry}>Try again</Button>}</>}
              {feedback === 'checking' && <><Spinner /> <span className="text-sm">Asking the engine…</span></>}
              {!feedback && <div className="text-sm text-ink-300">{p.moveIndex === 0 ? 'Get ready…' : calc ? 'Calculate the whole line in your head, then enter it.' : 'Find the best move.'}
                {puzzle.played && <div className="mt-0.5 text-xs text-ink-400">{puzzleOrigin(puzzle, false)}</div>}</div>}
            </motion.div>
        </div>

        {drafting && (
          <div className="rounded-2xl bg-ink-850 p-3.5 ring-1 ring-white/5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-ink-400 uppercase"><Brain size={13} /> Your line</div>
            {draft.sans.length > 0
              ? <div className="mt-1.5 font-mono text-sm leading-relaxed text-ink-100">{numbered(liveFen, draft.sans)}</div>
              : <p className="mt-1.5 text-[13px] leading-snug text-ink-300">
                  Enter your moves <b className="text-ink-100">and the replies you expect</b>{still ? ' by typing them below' : ' on the board'}.
                  Nothing is judged until you press Check line.
                </p>}
            <form className="mt-2.5" onSubmit={e => { e.preventDefault(); addTyped() }}>
              <input value={typed} onChange={e => { setTyped(e.target.value); setTypedError(null) }} spellCheck={false} autoComplete="off"
                placeholder={still ? 'Type the line, e.g. Nxe5 dxe5 Qh5+' : 'Or type moves, e.g. Nxe5 dxe5 Qh5+'}
                className="h-9 w-full rounded-[10px] bg-ink-900 px-3 font-mono text-sm text-ink-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-ink-500 focus:ring-accent/60" />
              {typedError && <div className="mt-1 text-xs text-blunder">{typedError}</div>}
            </form>
            <div className="mt-2.5 grid grid-cols-[auto_auto_1fr] gap-2">
              <Button size="sm" disabled={!draft.ucis.length} title="Take back the last move of your line"
                onClick={() => setDraft(d => ({ ucis: d.ucis.slice(0, -1), sans: d.sans.slice(0, -1), fens: d.fens.slice(0, -1) }))}><Undo2 size={14} /></Button>
              <Button size="sm" disabled={!draft.ucis.length} onClick={resetDraft}>Clear</Button>
              <Button size="sm" variant="primary" disabled={!draft.ucis.length || feedback === 'checking'} onClick={() => void checkLine()}>
                <Check size={15} /> Check line
              </Button>
            </div>
            <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-ink-400"
              title="The pieces stay where they are while you enter the line – you have to see the positions in your head">
              <input type="checkbox" checked={still} onChange={e => setStill(e.target.checked)} className="accent-[#1ee3cf]" />
              Keep the board still (type the moves) – harder
            </label>
          </div>
        )}

        {p.solved && (
          <>
            <SolutionPanel puzzle={puzzle} ucis={p.ucis} shown={shownIdx}
              onSelect={i => setView(i >= p.fens.length - 1 ? null : i)} />
            {puzzle.played && puzzle.pattern && <div className="-mt-2 text-xs text-ink-400">{puzzleOrigin(puzzle)}</div>}
            {puzzle.themes.length > 1 && (
              <div className="-mt-2 flex flex-wrap gap-1.5">
                {puzzle.themes.slice(1).map(t => <span key={t} className="rounded-full bg-ink-700 px-2 py-0.5 text-[11px] font-semibold text-ink-300">{themeLabel(t)}</span>)}
              </div>
            )}
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setP(s => s && { ...s, hinted: Math.min(2, s.hinted + 1) as 0 | 1 | 2 })} disabled={p.solved || p.hinted >= 2 || p.retryFrom != null}>
            <Lightbulb size={15} /> Hint
          </Button>
          <Button onClick={showSolution} disabled={p.solved}><Eye size={15} /> Solution</Button>
          <Button onClick={() => setView(v => Math.max(0, (v ?? p.fens.length - 1) - 1))}><ChevronLeft size={16} /></Button>
          <Button onClick={() => setView(v => (v == null || v + 1 >= p.fens.length - 1 ? null : v + 1))}><ChevronRight size={16} /></Button>
        </div>
        {p.solved && (
          <Button onClick={() => setAnalysing(true)} title="Try other moves and see the evaluation"><Cpu size={15} /> Analyse this position</Button>
        )}
        <Button variant="primary" size="lg" onClick={next} disabled={!p.solved}><SkipForward size={17} /> Next puzzle</Button>
        <AnalysisBoard open={analysing} onClose={() => setAnalysing(false)} fen={puzzle.fen} orientation={orientation}
          moves={p.ucis} at={Math.max(0, shownIdx)} title="Analyse the puzzle" />

        <div className="flex items-center justify-between text-sm">
          <div className="flex flex-col gap-1">
            <label className="flex cursor-pointer items-center gap-2 text-ink-300">
              <input type="checkbox" checked={autoNext} onChange={e => setAutoNext(e.target.checked)} className="accent-[#1ee3cf]" /> Auto-next
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-ink-300"
              title="Enter the whole line – your moves and the replies you expect – before anything is checked">
              <input type="checkbox" checked={calc} onChange={e => { setCalc(e.target.checked); resetDraft(); setCalcNote(null) }} className="accent-[#1ee3cf]" /> Calculate first
            </label>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => previous !== undefined && setPeek(previous)} disabled={previous === undefined}
              title="Look at the puzzle you just finished again"><Undo2 size={15} /> Previous</Button>
            <Button variant="ghost" size="sm" onClick={() => setOrientation(o => (o === 'w' ? 'b' : 'w'))}><ArrowLeftRight size={15} /> Flip</Button>
          </div>
        </div>
        {puzzle.gameId && (
          <button className="text-left text-xs text-ink-400 hover:text-accent cursor-pointer" onClick={() => go(`/review/${puzzle.gameId}`)}>From one of your games → open review</button>
        )}
      </Card>
    </div>
  )
}

/** A puzzle you already finished, to look at again: the full line, replayable – it doesn't change your score. */
function PreviousPuzzle({ index, total, puzzle, state, orientation: initial, onBack, onOlder, onNewer }: {
  index: number; total: number; puzzle: Puzzle; state: PuzzleState; orientation: Color
  onBack: () => void; onOlder?: () => void; onNewer?: () => void
}) {
  const [view, setView] = useState<number | null>(null)
  const [orientation, setOrientation] = useState<Color>(initial)
  const [analysing, setAnalysing] = useState(false)
  const last = state.fens.length - 1
  const shown = view ?? last
  const fen = state.fens[shown]
  const lastUci = shown > 0 ? state.ucis[shown - 1] : null
  const ev = usePositionEval(fen, true)
  const back = () => setView(v => Math.max(0, (v ?? last) - 1))
  const fwd = () => setView(v => (v == null || v + 1 >= last ? null : v + 1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (analysing) return
      if (e.key === 'ArrowLeft') back()
      else if (e.key === 'ArrowRight') fwd()
      else if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const first = state.attempts === 0 && state.hinted === 0
  return (
    <div className="mx-auto flex h-full max-w-[1300px] flex-col gap-4 p-4 lg:flex-row lg:items-start lg:p-6">
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="flex flex-col gap-3" style={{ width: 'min(100%, calc(100vh - 7rem))' }}>
          <div className="flex items-center gap-3 px-1">
            <span className="font-display text-lg font-semibold">Puzzle {index + 1}</span>
            <span className="rounded-md bg-great/15 px-2 py-0.5 text-xs font-bold text-great">Looking back {shown}/{last}</span>
            <MaterialBalance fen={fen} className="ml-auto" />
          </div>
          <div className="flex gap-3">
            <EvalSlot ev={ev} orientation={orientation} />
            <div className="min-w-0 flex-1"><Board fen={fen} orientation={orientation} lastMove={lastUci ? uciSquares(lastUci) : null} movable={false} /></div>
          </div>
        </div>
      </div>

      <Card className="flex w-full shrink-0 flex-col gap-4 p-4 lg:w-[360px]">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Already finished · {index + 1}/{total}</div>
          <div className={clsx('mt-1 text-sm', first ? 'text-best' : 'text-ink-300')}>
            {first ? 'Solved on the first try.' : state.attempts > 0 ? `Solved after ${state.attempts} wrong ${state.attempts === 1 ? 'try' : 'tries'}.` : 'Solved with a hint or the solution.'}
          </div>
          {puzzle.played && <div className="mt-0.5 text-xs text-ink-400">{puzzleOrigin(puzzle)} In the game you played {puzzle.played}.</div>}
        </div>
        <SolutionPanel puzzle={puzzle} ucis={state.ucis} shown={shown} onSelect={i => setView(i >= last ? null : i)} />
        {puzzle.tip && <div className="rounded-xl bg-ink-850 p-3 text-xs text-ink-300 ring-1 ring-white/5"><Lightbulb size={13} className="mr-1 inline text-inaccuracy" />{puzzle.tip}</div>}
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={back}><ChevronLeft size={16} /></Button>
          <Button onClick={fwd}><ChevronRight size={16} /></Button>
        </div>
        <Button onClick={() => setAnalysing(true)} title="Try other moves and see the evaluation"><Cpu size={15} /> Analyse this position</Button>
        <Button variant="primary" size="lg" onClick={onBack}><ArrowLeft size={17} /> Back to the current puzzle</Button>
        <div className="flex items-center justify-between text-sm">
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={onOlder} disabled={!onOlder}><ChevronLeft size={15} /> Older</Button>
            <Button variant="ghost" size="sm" onClick={onNewer} disabled={!onNewer}>Newer <ChevronRight size={15} /></Button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setOrientation(o => (o === 'w' ? 'b' : 'w'))}><ArrowLeftRight size={15} /> Flip</Button>
        </div>
        {puzzle.gameId && (
          <button className="text-left text-xs text-ink-400 hover:text-accent cursor-pointer" onClick={() => go(`/review/${puzzle.gameId}`)}>From one of your games → open review</button>
        )}
        <AnalysisBoard open={analysing} onClose={() => setAnalysing(false)} fen={puzzle.fen} orientation={orientation}
          moves={state.ucis} at={Math.max(0, shown)} title="Analyse the puzzle" />
      </Card>
    </div>
  )
}

/** The Woodpecker idea is getting faster and cleaner on the same puzzles: compare with the last cycle as you go. */
function Pace({ set, stats }: { set: PuzzleSet; stats: RunStats }) {
  const runs = set.metadata.completed_runs
  const prev = runs[runs.length - 1]
  if (!prev) return null
  let now = 0, then = 0, firstNow = 0, firstThen = 0, n = 0
  for (const [id, d] of Object.entries(stats.puzzles_data)) {
    const old = prev.puzzles_data[id]
    if (!old) continue
    n++; now += d.time; then += old.time
    firstNow += d.correct_first ? 1 : 0; firstThen += old.correct_first ? 1 : 0
  }
  if (!n) return <div className="mt-1.5 text-[11px] text-ink-500">Cycle {runs.length + 1} – last time: {fmtTime(prev.total_time)}</div>
  const diff = then - now, clean = firstNow - firstThen
  return (
    <div className="mt-1.5 flex items-center justify-between text-[11px]" title={`The same ${n} puzzles in cycle ${runs.length}`}>
      <span className="text-ink-500">vs. cycle {runs.length}</span>
      <span className="flex gap-2 tabular-nums">
        <span className={diff >= 0 ? 'text-best' : 'text-mistake'}>{fmtTime(Math.abs(diff))} {diff >= 0 ? 'faster' : 'slower'}</span>
        {clean !== 0 && <span className={clean > 0 ? 'text-best' : 'text-mistake'}>{clean > 0 ? '+' : ''}{clean} first try</span>}
      </span>
    </div>
  )
}

/** End of a cycle: how each of your patterns went – the ones still missed are what to watch in your games. */
function PatternBreakdown({ set, stats }: { set: PuzzleSet; stats: RunStats }) {
  const groups = new Map<string, { label: string; total: number; first: number }>()
  for (const pz of set.puzzles) {
    const d = stats.puzzles_data[pz.id]
    if (!d) continue
    const key = pz.pattern?.key ?? pz.themes[0]
    if (!key) continue
    const g = groups.get(key) ?? { label: pz.pattern?.label ?? themeLabel(key), total: 0, first: 0 }
    g.total++; g.first += d.correct_first ? 1 : 0
    groups.set(key, g)
  }
  const rows = [...groups.values()].filter(g => g.total >= 2).sort((a, b) => a.first / a.total - b.first / b.total)
  if (rows.length < 2) return null
  return (
    <div className="mt-6 text-left">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-400">By pattern – weakest first</div>
      <div className="space-y-1.5">
        {rows.map(g => {
          const pct = Math.round((g.first / g.total) * 100)
          return (
            <div key={g.label} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{g.label}</span>
              <span className="h-1.5 w-28 overflow-hidden rounded-full bg-ink-700"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: accuracyColor(pct) }} /></span>
              <span className="w-16 text-right text-xs tabular-nums text-ink-400">{g.first}/{g.total}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 15 }}
      className={clsx('flex size-9 shrink-0 items-center justify-center rounded-full text-white shadow-lg', className)}>{children}</motion.span>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl bg-ink-850 py-2 ring-1 ring-white/5">
      <div className="font-display text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  )
}

function RunSummary({ set, stats, prev }: { set: PuzzleSet; stats: RunStats; prev?: RunStats }) {
  const acc = runAccuracy(stats)
  const accDelta = prev ? acc - runAccuracy(prev) : null
  const timeDelta = prev ? stats.total_time - prev.total_time : null
  const avg = stats.total_time / Math.max(1, stats.total_puzzles)
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-lg p-8 text-center">
        <motion.div initial={{ scale: 0, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 14 }}
          className="mx-auto flex size-20 items-center justify-center rounded-3xl bg-gradient-to-br from-[#2ef0dc] to-[#5b8cff] text-ink-950 shadow-[0_10px_40px_-8px_rgba(30,227,207,.7)]">
          <Trophy size={40} />
        </motion.div>
        <h1 className="mt-5 font-display text-[30px] leading-tight font-semibold">Cycle {set.metadata.completed_runs.length + 1} complete!</h1>
        <p className="mt-1 text-ink-400">{set.metadata.name}</p>
        <div className="mt-6 grid grid-cols-3 gap-3">
          <div><div className="font-display text-4xl font-semibold" style={{ color: accuracyColor(acc) }}><CountUp to={acc} decimals={1} />%</div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Accuracy</div>
            {accDelta != null && <Delta v={accDelta} fmt={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`} good={accDelta >= 0} />}</div>
          <div><div className="font-display text-4xl font-semibold">{fmtTime(stats.total_time)}</div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Time</div>
            {timeDelta != null && <Delta v={timeDelta} fmt={v => `${v > 0 ? '+' : '−'}${fmtTime(Math.abs(v))}`} good={timeDelta <= 0} />}</div>
          <div><div className="font-display text-4xl font-semibold">{avg.toFixed(1)}s</div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-400">Per puzzle</div></div>
        </div>
        <PatternBreakdown set={set} stats={stats} />
        <div className="mt-8 flex justify-center gap-2">
          <Button onClick={() => go('/woodpecker')}><ArrowLeft size={16} /> Back to sets</Button>
          <Button variant="primary" onClick={() => window.location.reload()}>Next cycle</Button>
        </div>
      </Card>
    </div>
  )
}

function Delta({ v, fmt, good }: { v: number; fmt: (v: number) => string; good: boolean }) {
  return <div className={clsx('mt-1 text-sm font-bold', good ? 'text-best' : 'text-mistake')}>{fmt(v)} vs last</div>
}
