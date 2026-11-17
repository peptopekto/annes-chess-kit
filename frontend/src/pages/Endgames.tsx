import { Chess } from 'chess.js'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Bot, Check, ChevronLeft, ChevronRight, Crown, Flame, Lightbulb, RefreshCw, RotateCcw, Shuffle, Sparkles, Target, TriangleAlert, Undo2, User } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Board } from '../components/Board'
import { MaterialDiff } from '../components/MaterialDiff'
import { Button, Card, ErrorNote, PageHeader, PageSkeleton, Segmented, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { go } from '../lib/router'
import { controlledSquares, kingSquares, playUci, uciSquares } from '../lib/chess'
import { sound } from '../lib/sound'
import type { EndgameDrill, EndgameEval, EndgameMode, EndgamePosition, EndgameStatus, EndgameSummary } from '../lib/types'

const PREFS_KEY = 'endgame-prefs'
interface Prefs { mode: EndgameMode; level: number | null }
function loadPrefs(): Prefs {
  try { return { mode: 'perfect', level: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') } } catch { return { mode: 'perfect', level: null } }
}

// "Show control": the squares your pieces cover, and where the enemy king can still go.
const CONTROL_KEY = 'endgame-control'
const MINE_TINT = 'rgba(60, 190, 60, 0.55)', MINE_RING = 'rgba(40, 160, 40, 0.95)' // green: stands out on the blue-grey board
const KING_TINT = 'rgba(255, 150, 60, 0.30)', KING_RING = 'rgba(255, 150, 60, 0.85)'
function loadControl(): boolean {
  try { return localStorage.getItem(CONTROL_KEY) === '1' } catch { return false }
}

const GOAL_STYLE: Record<string, string> = {
  mate: 'bg-blunder/12 text-[#ff8796] ring-blunder/25',
  promote: 'bg-accent/10 text-accent ring-accent/25',
  win: 'bg-best/12 text-best ring-best/25',
  draw: 'bg-white/[0.06] text-ink-200 ring-white/10',
}

export function EndgamesPage({ drillId }: { drillId?: string }) {
  const [info, setInfo] = useState<EndgameSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  useEffect(() => { api.endgames().then(setInfo).catch(e => setError(String(e.message ?? e))) }, [])
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* private mode */ } }, [prefs])

  if (error) return <div className="mx-auto max-w-lg p-10"><ErrorNote>{error}</ErrorNote></div>
  if (!info) return <PageSkeleton tiles={0} />
  const mode: EndgameMode = prefs.mode === 'human' && !info.maia ? 'perfect' : prefs.mode
  const level = prefs.level ?? info.level
  const active = drillId ? info.drills.find(d => d.id === drillId) : undefined
  if (active) {
    return <Player key={active.id} drill={active} mode={mode} level={level} onBack={() => go('/endgames')}
      onRecord={rec => setInfo(i => i && { ...i, drills: i.drills.map(d => (d.id === active.id ? { ...d, record: rec } : d)) })} />
  }
  return <Catalog info={info} mode={mode} level={level} setPrefs={setPrefs} onPick={d => go(`/endgames/${d.id}`)} />
}

// --------------------------------------------------------------------------- //
//  Drill list
// --------------------------------------------------------------------------- //

function Catalog({ info, mode, level, setPrefs, onPick }: {
  info: EndgameSummary; mode: EndgameMode; level: number | null
  setPrefs: (f: (p: Prefs) => Prefs) => void; onPick: (d: EndgameDrill) => void
}) {
  const groups = useMemo(() => {
    const out = new Map<string, EndgameDrill[]>()
    for (const d of info.drills) out.set(d.group, [...(out.get(d.group) ?? []), d])
    return [...out.entries()]
  }, [info.drills])
  const mastered = info.drills.filter(d => (d.record.perfect?.clean ?? 0) > 0).length

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <PageHeader icon={<Crown className="text-accent" />} title="Endgames"
        description="The basic mates, pawn endings and the theoretical positions every player has to know. Fresh positions every time, checked by the engine – so each one really can be won (or held)."
        actions={<div className="text-sm text-ink-400"><span className="font-mono text-white">{mastered}</span> / {info.drills.length} beaten against perfect defence</div>} />

      <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
        <div>
          <div className="mb-2 text-xs font-medium tracking-wide text-ink-500 uppercase">Opponent</div>
          <Segmented value={mode} onChange={m => setPrefs(p => ({ ...p, mode: m }))} options={[
            { value: 'perfect', label: <><Bot size={14} /> Perfect defence</> },
            ...(info.maia ? [{ value: 'human' as const, label: <><User size={14} /> Human (Maia)</> }] : []),
          ]} />
        </div>
        {mode === 'human' && info.levels.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium tracking-wide text-ink-500 uppercase">Plays like</div>
            <select value={level ?? ''} onChange={e => setPrefs(p => ({ ...p, level: Number(e.target.value) }))}
              className="h-9 rounded-[10px] bg-black/25 px-3 text-sm text-white ring-1 ring-inset ring-white/[0.09] outline-none">
              {info.levels.map(lv => <option key={lv} value={lv}>{lv}{lv === info.level ? ' · your level' : ''}</option>)}
            </select>
          </div>
        )}
        <p className="max-w-md flex-1 text-sm text-ink-400">
          {mode === 'perfect'
            ? <>Stockfish{info.tablebase ? ' with tablebases' : ''} defends perfectly: the king always runs the longest way, so only precise technique wins.</>
            : <>Maia defends like a club player around {level ?? 'your level'} – realistic resistance, including the mistakes humans make.</>}
        </p>
      </Card>

      {groups.map(([group, drills]) => (
        <section key={group}>
          <h2 className="mb-3 font-display text-lg font-semibold">{group}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {drills.map((d, i) => <DrillCard key={d.id} drill={d} mode={mode} index={i} onPick={() => onPick(d)} />)}
          </div>
        </section>
      ))}
    </div>
  )
}

function DrillCard({ drill, mode, index, onPick }: { drill: EndgameDrill; mode: EndgameMode; index: number; onPick: () => void }) {
  const r = drill.record[mode]
  const marks = [
    { on: (drill.record.human?.clean ?? 0) > 0, label: 'Beaten Maia without help' },
    { on: (drill.record.perfect?.clean ?? 0) > 0, label: 'Beaten perfect defence without help' },
    { on: (drill.record.perfect?.perfect ?? 0) > 0, label: 'Perfect technique: as fast as the engine' },
  ]
  return (
    <motion.button initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}
      onClick={onPick}
      className="glass group flex flex-col rounded-2xl p-4 text-left transition hover:bg-white/[0.05] hover:ring-1 hover:ring-accent/30 cursor-pointer">
      <div className="flex items-start justify-between gap-2">
        <div className="font-display text-[15px] font-semibold text-white">{drill.title}</div>
        <div className="flex gap-0.5 pt-1" title={`Difficulty ${drill.level}/5`}>
          {[1, 2, 3, 4, 5].map(n => <span key={n} className={clsx('size-1.5 rounded-full', n <= drill.level ? 'bg-accent' : 'bg-white/10')} />)}
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-400">{drill.blurb}</p>
      <div className="mt-auto flex items-center gap-2 pt-3">
        <span className={clsx('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', GOAL_STYLE[drill.goal])}>{drill.goalText}</span>
        {r && r.attempts > 0 && (
          <span className="text-xs text-ink-500">{r.solved}/{r.attempts} solved{r.streak > 1 ? ` · ${r.streak} in a row` : ''}</span>
        )}
        <span className="ml-auto flex gap-1">
          {marks.map((m, i) => (
            <span key={i} title={m.label} className={clsx('flex size-5 items-center justify-center rounded-full ring-1 ring-inset',
              m.on ? 'bg-accent/15 text-accent ring-accent/30' : 'text-ink-600 ring-white/[0.08]')}>
              {i === 2 ? <Sparkles size={11} /> : <Check size={11} />}
            </span>
          ))}
        </span>
      </div>
    </motion.button>
  )
}

// --------------------------------------------------------------------------- //
//  Playing a drill
// --------------------------------------------------------------------------- //

interface Slip { ply: number; better?: { uci: string; san: string }; verdict: EndgameEval['verdict'] }

const EMPTY = '8/8/8/8/8/8/8/8 w - - 0 1'

function fenAt(start: string, moves: string[]) {
  const c = new Chess(start)
  for (const u of moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined })
  return c.fen()
}

function Player({ drill, mode, level, onBack, onRecord }: {
  drill: EndgameDrill; mode: EndgameMode; level: number | null
  onBack: () => void; onRecord: (r: EndgameDrill['record']) => void
}) {
  const [pos, setPos] = useState<EndgamePosition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moves, setMoves] = useState<string[]>([])
  const [sans, setSans] = useState<string[]>([])
  const [over, setOver] = useState<EndgameStatus | null>(null)
  const [ev, setEv] = useState<EndgameEval | null>(null)
  const [slip, setSlip] = useState<Slip | null>(null)
  const [thinking, setThinking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [takebacks, setTakebacks] = useState(0)
  const [hints, setHints] = useState(0)
  const [arrow, setArrow] = useState<{ uci: string; brush: string } | null>(null)
  const [view, setView] = useState<number | null>(null)
  const [showControl, setShowControl] = useState(loadControl)
  useEffect(() => { try { localStorage.setItem(CONTROL_KEY, showControl ? '1' : '0') } catch { /* private mode */ } }, [showControl])
  const reported = useRef(false)
  const session = useRef(0) // answers for an older position are ignored
  const evals = useRef(new Map<number, EndgameEval>()) // the verdict after each of your moves (for takebacks)

  const report = useCallback((result: 'success' | 'fail', mine: number) => {
    if (reported.current || !pos) return
    reported.current = true
    api.endgameFinish({ drill: drill.id, mode, result, moves: mine, optimal: pos.optimal, takebacks, hints }).then(onRecord).catch(() => {})
  }, [drill.id, mode, pos, takebacks, hints, onRecord])

  const load = useCallback((same?: EndgamePosition) => {
    session.current++
    const id = session.current
    reported.current = false
    evals.current.clear()
    setMoves([]); setSans([]); setOver(null); setSlip(null); setTakebacks(0); setHints(0); setArrow(null); setView(null); setError(null)
    if (same) { setPos(same); setEv(same.eval); setLoading(false); return }
    // The board stays mounted (showing the old position) while the next one is made: rebuilding it
    // would re-measure it right when you reach for the first piece.
    setLoading(true)
    api.endgameNew(drill.id).then(p => { if (session.current === id) { setPos(p); setEv(p.eval); setLoading(false) } })
      .catch(e => { if (session.current === id) { setError(String(e.message ?? e)); setLoading(false) } })
  }, [drill.id])
  useEffect(() => { load() }, [load])

  const live = moves.length
  const shown = view == null ? live : Math.max(0, Math.min(live, view))
  const browsing = shown !== live
  const fen = useMemo(() => (pos ? fenAt(pos.fen, moves) : null), [pos, moves])
  const shownFen = useMemo(() => (pos ? (browsing ? fenAt(pos.fen, moves.slice(0, shown)) : fen) : null), [pos, moves, shown, browsing, fen])
  const yourTurn = !!pos && !!fen && fen.split(' ')[1] === pos.you
  const mine = Math.ceil(moves.length / 2)

  const leave = (then: () => void) => {
    if (over?.result === 'fail' || (slip && moves.length)) report('fail', mine)
    then()
  }

  const onMove = (uci: string) => {
    if (!pos || !fen || loading || over || thinking || browsing || !yourTurn) return
    let played
    try { played = playUci(fen, uci) } catch { return }
    sound.move(played.capture)
    const nextMoves = [...moves, played.uci]
    const nextSans = [...sans, played.san]
    setMoves(nextMoves); setSans(nextSans); setArrow(null)
    setThinking(true)
    const id = session.current
    const started = Date.now()
    api.endgamePlay(drill.id, pos.fen, nextMoves, mode, level)
      .then(async r => {
        if (session.current !== id) return
        setEv(r.eval)
        evals.current.set(nextMoves.length, r.eval)
        if (r.slipped) setSlip(s => s ?? { ply: nextMoves.length, better: r.better, verdict: r.eval.verdict })
        if (r.reply) {
          await new Promise(res => setTimeout(res, Math.max(0, 380 - (Date.now() - started))))
          if (session.current !== id) return
          const rp = playUci(played.fen, r.reply.uci)
          sound.move(rp.capture)
          setMoves([...nextMoves, rp.uci]); setSans([...nextSans, rp.san])
        }
        if (r.status) {
          setOver(r.status)
          if (r.status.result === 'success') { sound.success(); report('success', Math.ceil(nextMoves.length / 2)) }
          else sound.fail()
        }
      })
      .catch(e => { if (session.current === id) setError(String(e.message ?? e)) })
      .finally(() => { if (session.current === id) setThinking(false) })
  }

  // Take back your last move (and the answer to it).
  const canTakeBack = !thinking && moves.length > 0 && (!over || over.result === 'fail')
  const takeBack = (showBetter = false) => {
    if (!canTakeBack || !fen) return
    const back = yourTurn ? 2 : 1
    const keep = Math.max(0, moves.length - back)
    session.current++ // nothing in flight may land on the old position
    setMoves(moves.slice(0, keep)); setSans(sans.slice(0, keep)); setOver(null); setView(null)
    setTakebacks(t => t + 1)
    if (slip && keep < slip.ply) {
      if (showBetter && slip.better && keep === slip.ply - 1) { setArrow({ uci: slip.better.uci, brush: 'best' }); setHints(h => h + 1) }
      else setArrow(null)
      setSlip(null)
    } else setArrow(null)
    let restored: EndgameEval | undefined
    for (let p = keep; p > 0 && !restored; p--) restored = evals.current.get(p)
    for (const p of [...evals.current.keys()]) if (p > keep) evals.current.delete(p)
    setEv(restored ?? pos?.eval ?? null)
  }

  const hint = () => {
    if (!pos || loading || thinking || over || browsing || !yourTurn) return
    const id = session.current
    api.endgameHint(drill.id, pos.fen, moves).then(h => {
      if (session.current !== id) return
      setArrow({ uci: h.uci, brush: 'hint' }); setHints(n => n + 1)
    }).catch(() => {})
  }

  // ← → browse the moves, ↓ back to the live position.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); setView(Math.max(0, shown - 1)) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setView(shown + 1 >= live ? null : shown + 1) }
      else if (e.key === 'ArrowUp' || e.key === 'Home') { e.preventDefault(); setView(0) }
      else if (e.key === 'ArrowDown' || e.key === 'End') { e.preventDefault(); setView(null) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [shown, live])

  const lastMove = shown > 0 ? uciSquares(moves[shown - 1]) : null
  const shapes = arrow && !browsing ? [{ orig: arrow.uci.slice(0, 2) as never, dest: arrow.uci.slice(2, 4) as never, brush: arrow.brush }] : []
  const halfmove = fen ? Number(fen.split(' ')[4]) : 0
  const controlSwitch = (
    <button onClick={() => setShowControl(v => !v)} aria-pressed={showControl}
      title="Colour the squares your pieces cover and the squares the enemy king can still move to"
      className={clsx('ml-auto flex h-9 items-center gap-2 rounded-[10px] px-3 text-sm font-medium ring-1 ring-inset transition cursor-pointer',
        showControl ? 'bg-accent/15 text-white ring-accent/40' : 'text-ink-300 ring-white/10 hover:text-white')}>
      <span className={clsx('relative h-4 w-7 rounded-full transition', showControl ? 'bg-accent' : 'bg-white/15')}>
        <span className={clsx('absolute top-0.5 size-3 rounded-full bg-white transition-all', showControl ? 'left-3.5' : 'left-0.5')} />
      </span>
      Show control
    </button>
  )
  const tints = useMemo(() => {
    if (!showControl || !shownFen || !pos || loading) return []
    const them: 'w' | 'b' = pos.you === 'w' ? 'b' : 'w'
    const king = kingSquares(shownFen, them)
    const mine = controlledSquares(shownFen, pos.you)
    return [...[...mine].filter(sq => !king.has(sq)).map(square => ({ square, color: MINE_TINT, ring: MINE_RING, ringWidth: 1.5 })),
      ...[...king].map(square => ({ square, color: KING_TINT, ring: KING_RING }))]
  }, [showControl, shownFen, pos, loading])

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 p-4 lg:flex-row lg:p-6">
      <div className="mx-auto w-full max-w-[calc(min(100%,calc(100vh-150px))*var(--board-zoom,1))] lg:mx-0">
        <div className="flex h-10 items-center gap-2 px-1 text-sm font-medium">
          {mode === 'perfect' ? <Bot size={15} className="text-ink-300" /> : <User size={15} className="text-ink-300" />}
          <span>{mode === 'perfect' ? 'Perfect defence' : `Maia ${level ?? ''}`}</span>
          {thinking && <Spinner size={13} />}
          {pos && shownFen && !loading && <MaterialDiff fen={shownFen} color={pos.you === 'w' ? 'b' : 'w'} className="ml-1.5" />}
        </div>
        <div className="relative">
          <div className={clsx('board-frame aspect-square w-full min-w-0 transition', browsing && 'opacity-90')}>
            <Board wheelSteps resizable fen={shownFen ?? EMPTY} orientation={pos?.you ?? 'w'} movable={!loading && !over && yourTurn && !thinking && !browsing}
              premove={!loading && !over && !browsing && pos ? pos.you : undefined}
              lastMove={loading ? null : lastMove} onMove={onMove} shapes={loading ? [] : shapes} tints={tints} />
          </div>
          {loading && !error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-[14px] bg-ink-950/55 text-sm text-ink-200 backdrop-blur-[1px]">
              <Spinner size={16} /><span className="ml-2">Setting up a position…</span>
            </div>
          )}
          <AnimatePresence>
            {browsing && (
              <motion.button initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} onClick={() => setView(null)}
                className="popover absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-3.5 py-1.5 text-xs font-medium whitespace-nowrap text-ink-100 cursor-pointer">
                Viewing an earlier move · back to the position <span className="text-ink-500">(↓)</span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <div className="flex h-10 items-center gap-2 px-1 text-sm font-medium">
          <span className={clsx('size-3 rounded-full ring-1 ring-white/30', pos?.you === 'b' ? 'bg-ink-950' : 'bg-white')} />You
          {pos && shownFen && !loading && <MaterialDiff fen={shownFen} color={pos.you} className="ml-1.5" />}
          {showControl && (
            <span className="ml-auto flex items-center gap-3 text-xs font-normal text-ink-400">
              <span className="flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: MINE_TINT, boxShadow: `inset 0 0 0 1.5px ${MINE_RING}` }} /> your pieces cover</span>
              <span className="flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: KING_TINT, boxShadow: `inset 0 0 0 2px ${KING_RING}` }} /> enemy king can go</span>
            </span>
          )}
        </div>
      </div>

      <Card className="flex min-h-[420px] w-full flex-col p-5 lg:max-w-[420px]">
        <button onClick={() => leave(onBack)} className="mb-3 flex items-center gap-1 self-start text-xs text-ink-400 hover:text-white cursor-pointer">
          <ArrowLeft size={13} /> All endgames
        </button>
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-xl font-semibold">{drill.title}</h2>
          <span className={clsx('mt-1 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', GOAL_STYLE[drill.goal])}>{drill.goalText}</span>
        </div>
        <p className="mt-1 text-sm text-ink-300">{goalLine(drill, pos)}</p>
        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}

        <StatusPanel drill={drill} pos={pos} ev={ev} mine={mine} over={over} slip={slip} thinking={thinking} yourTurn={yourTurn} halfmove={halfmove} />

        <AnimatePresence>
          {slip && !over && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mt-3 rounded-xl bg-blunder/10 p-3 text-sm ring-1 ring-inset ring-blunder/25">
              <div className="flex items-center gap-2 font-medium text-[#ff8796]"><TriangleAlert size={15} />
                {drill.goal === 'draw' ? 'That move loses.' : slip.verdict === 'loss' ? 'That move loses.' : 'That move lets the win slip – it\'s a draw now.'}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => takeBack()}><Undo2 size={13} /> Take back</Button>
                {slip.better && <Button size="sm" variant="ghost" onClick={() => takeBack(true)}><Lightbulb size={13} /> Take back & show the better move</Button>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <MoveList sans={sans} startFen={pos?.fen} shown={shown} onPick={p => setView(p >= live ? null : p)} slipPly={slip?.ply} />
        <div className="mt-2 flex gap-1.5">
          <NavBtn onClick={() => setView(Math.max(0, shown - 1))} disabled={shown === 0} title="Back (←)"><ChevronLeft size={17} /></NavBtn>
          <NavBtn onClick={() => setView(shown + 1 >= live ? null : shown + 1)} disabled={shown >= live} title="Forward (→)"><ChevronRight size={17} /></NavBtn>
        </div>

        {over ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            {over.result === 'fail' && moves.length > 0 && <Button onClick={() => takeBack()}><Undo2 size={14} /> Take back</Button>}
            <Button variant="primary" onClick={() => leave(() => load())}><Shuffle size={14} /> Next position</Button>
            <Button onClick={() => leave(() => pos && load(pos))}><RotateCcw size={14} /> Same again</Button>
            {controlSwitch}
          </div>
        ) : (
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            <Button onClick={hint} disabled={!yourTurn || thinking || browsing || loading || !pos}><Lightbulb size={14} /> Hint</Button>
            <Button onClick={() => takeBack()} disabled={!canTakeBack}><Undo2 size={14} /> Take back</Button>
            <Button variant="ghost" onClick={() => leave(() => pos && load(pos))} disabled={!moves.length}><RotateCcw size={14} /> Restart</Button>
            <Button variant="ghost" onClick={() => leave(() => load())}><RefreshCw size={14} /> New</Button>
            {controlSwitch}
          </div>
        )}
        {(takebacks > 0 || hints > 0) && (
          <div className="mt-2 text-xs text-ink-500">
            {[takebacks && `${takebacks} takeback${takebacks === 1 ? '' : 's'}`, hints && `${hints} hint${hints === 1 ? '' : 's'}`].filter(Boolean).join(' · ')} – solve it without help to earn the mark
          </div>
        )}
        <Lesson drill={drill} failed={over?.result === 'fail'} />
      </Card>
    </div>
  )
}

/** How it works: the idea, when to look for it, the plan step by step, the usual mistakes – and the short tip. */
function Lesson({ drill, failed }: { drill: EndgameDrill; failed: boolean }) {
  const l = drill.lesson
  const [open, setOpen] = useState(true)
  useEffect(() => { if (failed) setOpen(true) }, [failed])
  const head = 'mb-1 text-[11px] font-medium tracking-wide text-ink-500 uppercase'
  return (
    <div className="mt-4 rounded-xl bg-white/[0.03] text-sm ring-1 ring-inset ring-white/[0.06]">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center gap-1.5 p-3 text-left font-medium text-ink-200 cursor-pointer">
        <Lightbulb size={14} className="text-accent" /> How it works
        <ChevronRight size={15} className={clsx('ml-auto text-ink-500 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 leading-relaxed text-ink-300">
          {failed && <p className="rounded-lg bg-blunder/10 px-2.5 py-1.5 text-[13px] text-ink-200">Compare your moves with the steps below, then try the same position again.</p>}
          {l ? <>
            <p className="text-ink-200">{l.idea}</p>
            {l.spot && l.spot.length > 0 && (
              <div><div className={head}>When to look for it</div>
                <ul className="list-disc space-y-0.5 pl-4">{l.spot.map(t => <li key={t}>{t}</li>)}</ul></div>
            )}
            <div><div className={head}>Step by step</div>
              <ol className="space-y-1.5">
                {l.steps.map((t, i) => (
                  <li key={t} className="flex gap-2">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">{i + 1}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol></div>
            {l.mistakes && l.mistakes.length > 0 && (
              <div><div className={head}>Common mistakes</div>
                <ul className="list-disc space-y-0.5 pl-4">{l.mistakes.map(t => <li key={t}>{t}</li>)}</ul></div>
            )}
            <div><div className={head}>In short</div><p>{drill.tip}</p></div>
          </> : <p>{drill.tip}</p>}
        </div>
      )}
    </div>
  )
}

function goalLine(drill: EndgameDrill, pos: EndgamePosition | null) {
  const side = pos ? (pos.you === 'w' ? 'White' : 'Black') : ''
  switch (drill.goal) {
    case 'mate': return `${side} to move and mate.`
    case 'promote': return `${side} to move: promote a pawn without losing the win.`
    case 'win': return `${side} to move: win the enemy material (or mate).`
    default: return `${side} to move: hold the draw for ${drill.survive} moves.`
  }
}

function StatusPanel({ drill, pos, ev, mine, over, slip, thinking, yourTurn, halfmove }: {
  drill: EndgameDrill; pos: EndgamePosition | null; ev: EndgameEval | null; mine: number; over: EndgameStatus | null
  slip: Slip | null; thinking: boolean; yourTurn: boolean; halfmove: number
}) {
  if (over) {
    const ok = over.result === 'success'
    const opt = pos?.optimal
    return (
      <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className={clsx('mt-4 rounded-xl p-4 ring-1 ring-inset', ok ? 'bg-best/10 ring-best/25' : 'bg-blunder/10 ring-blunder/25')}>
        <div className={clsx('flex items-center gap-2 font-display text-lg font-semibold', ok ? 'text-best' : 'text-[#ff8796]')}>
          {ok ? <Crown size={18} /> : <TriangleAlert size={18} />}{over.reason}
        </div>
        <div className="mt-1 text-sm text-ink-300">
          {ok
            ? <>Done in {mine} move{mine === 1 ? '' : 's'}{opt && drill.goal === 'mate' ? (mine <= opt ? ' – exactly as fast as perfect play!' : ` (perfect play: ${opt})`) : ''}.{slip ? ' You recovered after a slip – try it once more cleanly.' : ''}</>
            : 'Take back and find a better way, or try a new position.'}
        </div>
      </motion.div>
    )
  }
  const remaining = drill.goal === 'mate' && pos?.optimal ? pos.optimal - mine : null
  const verdict = ev?.verdict
  const pill = verdict === 'win' ? ['Winning', 'text-best bg-best/10 ring-best/25']
    : verdict === 'loss' ? ['Losing', 'text-[#ff8796] bg-blunder/10 ring-blunder/25']
    : verdict === 'draw' ? ['Drawn', 'text-ink-200 bg-white/[0.06] ring-white/10']
    : ['Unclear', 'text-ink-300 bg-white/[0.04] ring-white/10']
  return (
    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
      <Tile label="Position">
        {ev ? <span className={clsx('rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', pill[1])}>{pill[0]}</span> : '—'}
      </Tile>
      <Tile label={drill.goal === 'draw' ? 'Hold for' : ev?.mate && ev.mate > 0 ? 'Mate in' : 'Your moves'}>
        {drill.goal === 'draw' ? <span className="font-mono">{Math.max(0, drill.survive - mine)}</span>
          : ev?.mate && ev.mate > 0 ? <span className="font-mono">{ev.mate}</span> : <span className="font-mono">{mine}</span>}
      </Tile>
      <Tile label={remaining != null ? 'vs perfect' : halfmove >= 20 ? '50-move rule' : 'Status'}>
        {remaining != null && ev?.mate && ev.mate > 0
          ? <span className={clsx('font-mono', ev.mate <= remaining ? 'text-best' : 'text-inaccuracy')}>{ev.mate <= remaining ? 'on track' : `+${ev.mate - remaining}`}</span>
          : halfmove >= 20 ? <span className={clsx('font-mono', halfmove >= 80 && 'text-[#ff8796]')}>{Math.max(0, 50 - Math.floor(halfmove / 2))} left</span>
          : <span className="text-xs text-ink-300">{thinking ? 'thinking…' : yourTurn ? 'your move' : ''}</span>}
      </Tile>
    </div>
  )
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-black/20 px-2 py-2.5 ring-1 ring-inset ring-white/[0.05]">
      <div className="text-[10px] font-medium tracking-wide text-ink-500 uppercase">{label}</div>
      <div className="mt-1 flex h-6 items-center justify-center text-[15px] text-white">{children}</div>
    </div>
  )
}

function NavBtn({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className="flex h-9 flex-1 items-center justify-center rounded-[10px] bg-white/[0.04] text-ink-300 ring-1 ring-inset ring-white/[0.06] transition hover:bg-white/[0.08] hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer">
      {children}
    </button>
  )
}

function MoveList({ sans, startFen, shown, onPick, slipPly }: { sans: string[]; startFen?: string; shown: number; onPick: (ply: number) => void; slipPly?: number }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[data-current="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [shown, sans.length])
  // Drills can start with Black to move: "1… Kd7".
  const offset = startFen?.split(' ')[1] === 'b' ? 1 : 0
  const rows: number[] = []
  for (let i = -offset; i < sans.length; i += 2) rows.push(i)
  const cell = (ply: number) => {
    if (ply < 1 || ply > sans.length) return <span className="px-1.5 text-ink-600">{ply < 1 ? '…' : ''}</span>
    return (
      <button data-current={ply === shown} onClick={() => onPick(ply)}
        className={clsx('flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors cursor-pointer',
          ply === shown ? 'bg-white/[0.1] text-white' : 'text-ink-200 hover:bg-white/[0.05]',
          ply === slipPly && 'text-[#ff8796]')}>
        {sans[ply - 1]}{ply === slipPly && <Flame size={11} />}
      </button>
    )
  }
  return (
    <div ref={box} className="mt-4 max-h-[220px] min-h-[90px] overflow-y-auto rounded-xl bg-black/20 p-1.5 font-mono text-[13px] ring-1 ring-inset ring-white/[0.05]">
      {sans.length === 0 && <div className="flex items-center gap-1.5 p-2 text-ink-500"><Target size={13} /> Your move.</div>}
      {sans.length > 0 && rows.map(i => (
        <div key={i} className="grid grid-cols-[2.25rem_1fr_1fr] items-center gap-0.5">
          <span className="pl-1.5 text-ink-500">{(i + offset) / 2 + 1}.</span>{cell(i + 1)}{cell(i + 2)}
        </div>
      ))}
    </div>
  )
}
