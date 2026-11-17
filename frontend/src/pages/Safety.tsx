import clsx from 'clsx'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { motion } from 'motion/react'
import { Check, ChevronRight, Cpu, Flame, Lightbulb, RotateCcw, ShieldAlert, ShieldCheck, Trophy, X } from 'lucide-react'
import { AnalysisBoard } from '../components/AnalysisBoard'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Board, type BoardHandle } from '../components/Board'
import { MaterialBalance } from '../components/MaterialDiff'
import { BoardSkeleton, Button, Card, ErrorNote } from '../components/ui'
import { api } from '../lib/api'
import { celebrate } from '../lib/celebrate'
import { accuracyColor, buildLine, moveNumber, playUci, turnOf, uciSquares } from '../lib/chess'
import { go } from '../lib/router'
import { sound } from '../lib/sound'
import type { SafetyCard, SafetySummary } from '../lib/types'

type Phase = 'ask' | 'reveal'

export function SafetyPlay({ mode = 'mixed', count = 20 }: { mode?: string; count?: number }) {
  const [cards, setCards] = useState<SafetyCard[] | null>(null)
  const [summary, setSummary] = useState<SafetySummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [i, setI] = useState(0)
  const [phase, setPhase] = useState<Phase>('ask')
  const [answer, setAnswer] = useState<boolean | null>(null)
  const [analysing, setAnalysing] = useState(false)
  const [right, setRight] = useState(0)
  const [streak, setStreak] = useState(0)
  const [lineAt, setLineAt] = useState(0) // how far into the punishing line we're showing
  const [finished, setFinished] = useState<SafetySummary | null>(null)
  const started = useRef(0) // set when the deck loads
  const board = useRef<BoardHandle>(null)

  const load = useCallback(() => {
    setCards(null); setError(null); setI(0); setPhase('ask'); setAnswer(null); setRight(0); setStreak(0); setFinished(null)
    started.current = Date.now()
    api.safetyDeck(count, mode).then(r => {
      if (!r.cards.length) setError(mode === 'review' ? 'Nothing to review – you got every card right last time.' : 'No cards yet – review some of your games first.')
      setCards(r.cards); setSummary(r.summary)
    }).catch(e => setError(String(e.message ?? e)))
  }, [count, mode])
  useEffect(load, [load])

  const card = cards?.[i]

  const respond = useCallback((saysSafe: boolean) => {
    if (!card || phase !== 'ask') return
    const correct = saysSafe === card.safe
    setAnswer(correct); setPhase('reveal'); setLineAt(0)
    void api.safetyAnswer(card, saysSafe)
    if (correct) {
      setRight(r => r + 1); setStreak(s => s + 1); sound.success()
      if (!card.safe) setTimeout(() => celebrate.solved(board.current?.badgeRect()), 100)
    } else { setStreak(0); sound.fail() }
    sound.move(false)
  }, [card, phase])

  const next = useCallback(async () => {
    if (!cards) return
    if (i + 1 >= cards.length) {
      const s = await api.safetyFinish(right, cards.length, (Date.now() - started.current) / 1000, mode).catch(() => null)
      setFinished(s ?? summary)
      if (right / cards.length >= 0.8) { celebrate.big(); sound.fanfare() }
      return
    }
    setI(x => x + 1); setPhase('ask'); setAnswer(null); setLineAt(0)
  }, [cards, i, right, summary, mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === 'ask' && (e.key === 's' || e.key === 'ArrowLeft')) respond(true)
      else if (phase === 'ask' && (e.key === 'u' || e.key === 'ArrowRight')) respond(false)
      else if (phase === 'reveal' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void next() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (error) return <div className="mx-auto max-w-lg space-y-4 p-10"><ErrorNote>{error}</ErrorNote><Button onClick={() => go('/safety')}>Back to the hub</Button></div>
  if (!cards) return <BoardSkeleton />
  if (finished) return <Done right={right} total={cards.length} summary={finished} onAgain={load} />
  if (!card) return null

  // ---- board state
  const orientation = turnOf(card.fen)
  const [from, to] = uciSquares(card.uci)
  const shapes: DrawShape[] = []
  let fen = card.fen
  let lastMove: [string, string] | null = null
  let highlight = null
  let lmColor: string | undefined
  if (phase === 'ask') {
    shapes.push({ orig: from as Key, dest: to as Key, brush: 'engine' })
  } else {
    const after = playUci(card.fen, card.uci)
    fen = after.fen
    lastMove = [from, to]
    lmColor = card.safe ? 'rgba(127,216,88,.45)' : 'rgba(255,61,85,.45)'
    if (!card.safe && card.refute) {
      const line = buildLine(after.fen, card.refute.line)
      if (lineAt > 0 && line.fens[lineAt - 1]) {
        fen = line.fens[lineAt - 1]
        lastMove = uciSquares(line.ucis[lineAt - 1])
        lmColor = 'rgba(255,61,85,.45)'
      } else {
        const [o, d] = uciSquares(card.refute.uci)
        shapes.push({ orig: o as Key, dest: d as Key, brush: 'blunder' })
      }
    }
    highlight = { square: to, color: card.safe ? '#7fd858' : '#ff3d55' }
  }
  const refuteLine = !card.safe && card.refute ? buildLine(playUci(card.fen, card.uci).fen, card.refute.line) : null

  return (
    <div className="mx-auto flex h-full max-w-[1300px] flex-col gap-4 p-4 lg:flex-row lg:items-start lg:p-6">
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="flex flex-col gap-3" style={{ width: 'calc(min(100%, calc(100vh - 7rem)) * var(--board-zoom, 1))' }}>
          <div className="flex items-center gap-3 px-1">
            <span className={clsx('size-4 rounded ring-1 ring-white/30', orientation === 'w' ? 'bg-white' : 'bg-ink-950')} />
            <span className="font-display text-lg font-semibold">You are {orientation === 'w' ? 'White' : 'Black'}</span>
            <MaterialBalance fen={fen} className="ml-auto" />
          </div>
          <Board resizable ref={board} fen={fen} orientation={orientation} shapes={shapes} lastMove={lastMove}
            lastMoveColor={lmColor} highlight={highlight} />
        </div>
      </div>

      <Card className="flex w-full shrink-0 flex-col gap-4 p-4 lg:w-[380px]">
        <div className="flex items-center justify-between">
          <button onClick={() => go('/safety')} className="flex items-center gap-2 font-display text-lg font-semibold hover:text-accent cursor-pointer" title="Back to the hub">
            <ShieldAlert size={18} className="text-mistake" /> Is it safe?{mode === 'review' && <span className="text-xs font-semibold text-inaccuracy">review</span>}
          </button>
          <span className="text-sm font-semibold tabular-nums text-ink-300">{i + 1}/{cards.length}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
          <motion.div className="h-full rounded-full bg-gradient-to-r from-accent to-great" animate={{ width: `${(i / cards.length) * 100}%` }} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-ink-850 py-2 ring-1 ring-white/5">
            <div className="font-display text-xl font-semibold tabular-nums">{right}/{i + (phase === 'reveal' ? 1 : 0)}</div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Correct</div>
          </div>
          <div className="rounded-xl bg-ink-850 py-2 ring-1 ring-white/5">
            <motion.div key={streak} initial={{ scale: 1.4 }} animate={{ scale: 1 }}
              className={clsx('flex items-center justify-center gap-1 font-display text-xl font-semibold', streak >= 3 && 'text-mistake')}>
              <Flame size={17} className={streak >= 3 ? 'fill-mistake' : ''} />{streak}
            </motion.div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">Streak</div>
          </div>
        </div>

        {phase === 'ask' ? (
          <>
            <div className="rounded-2xl bg-great/10 p-4 ring-1 ring-great/30">
              <div className="text-sm text-ink-200">You're thinking about playing</div>
              <div className="mt-0.5 font-display text-2xl font-semibold text-great">{moveNumber(card.fen)} {card.san}</div>
              <div className="mt-2 text-xs text-ink-400">
                Check before you answer: what does it attack, what does it leave undefended, what checks and captures does
                your opponent get?
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {/* Equal visual weight – the colours must not hint at the answer. */}
              <Button size="lg" variant="ghost" className="bg-best/12 text-best ring-1 ring-best/30 hover:bg-best/20 hover:text-best" onClick={() => respond(true)}>
                <ShieldCheck size={18} /> Safe
              </Button>
              <Button size="lg" variant="ghost" className="bg-blunder/12 text-[#ff8a9a] ring-1 ring-blunder/30 hover:bg-blunder/20 hover:text-[#ff8a9a]" onClick={() => respond(false)}>
                <ShieldAlert size={18} /> Unsafe
              </Button>
            </div>
            <div className="text-center text-[11px] text-ink-500">Keys: S / ← safe · U / → unsafe</div>
          </>
        ) : (
          <>
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className={clsx('rounded-2xl p-4 ring-1', answer ? 'bg-best/10 ring-best/30' : 'bg-blunder/10 ring-blunder/30')}>
              <div className="flex items-center gap-2 font-display text-lg font-semibold">
                {answer ? <Check className="text-best" /> : <X className="text-blunder" />}
                <span className={answer ? 'text-best' : 'text-[#ff8a9a]'}>{answer ? 'Correct!' : 'Not quite.'}</span>
              </div>
              <p className="mt-1 text-sm text-ink-100">
                {card.safe
                  ? <>{card.san} was <b className="text-best">safe</b>. {card.why ?? 'A sound move from your game.'}</>
                  : <>{card.san} was <b className="text-blunder">unsafe</b>: it allows <b>{card.refute?.san}</b>
                    {card.label ? <> – {/^[aeiou]/i.test(card.label) ? 'an' : 'a'} {card.label.toLowerCase()}</> : null}.</>}
              </p>
              {refuteLine && refuteLine.sans.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <button onClick={() => setLineAt(0)} className={clsx('rounded px-1.5 py-0.5 font-semibold cursor-pointer', lineAt === 0 ? 'bg-accent text-ink-950' : 'bg-white/5 text-ink-300')}>
                    after {card.san}
                  </button>
                  {refuteLine.sans.map((s, k) => (
                    <button key={k} onClick={() => setLineAt(k + 1)}
                      className={clsx('rounded px-1.5 py-0.5 font-semibold cursor-pointer', lineAt === k + 1 ? 'bg-accent text-ink-950' : k % 2 === 0 ? 'bg-blunder/15 text-[#ff8a9a]' : 'bg-white/5 text-ink-300')}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
            {card.tip && (
              <div className="flex items-start gap-2 rounded-xl bg-inaccuracy/8 px-3 py-2 text-xs text-ink-100">
                <Lightbulb size={13} className="mt-0.5 shrink-0 text-inaccuracy" /> {card.tip}
              </div>
            )}
            <Button onClick={() => setAnalysing(true)} title="Try the move and its alternatives on a free board"><Cpu size={15} /> Analyse this position</Button>
            <Button variant="primary" size="lg" onClick={() => { setAnalysing(false); void next() }}>
              {i + 1 >= cards.length ? 'Finish' : 'Next'} <ChevronRight size={18} />
            </Button>
            <AnalysisBoard open={analysing} onClose={() => setAnalysing(false)} fen={card.fen} orientation={orientation}
              moves={[card.uci, ...(card.refute ? [card.refute.uci] : [])]} at={card.refute ? 2 : 1} title="Is it safe? – analysis" />
            <button className="text-left text-xs text-ink-400 hover:text-accent cursor-pointer" onClick={() => go(`/review/${card.gameId}/${card.ply}`)}>
              Open this moment in the game review →
            </button>
          </>
        )}
      </Card>
    </div>
  )
}

function Done({ right, total, summary, onAgain }: { right: number; total: number; summary: SafetySummary; onAgain: () => void }) {
  const pct = (right / total) * 100
  const prev = summary.sessions.slice(0, -1).map(s => (s.right / s.total) * 100)
  const avgPrev = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md p-8 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-[#2ef0dc] to-[#5b8cff] text-ink-950"><Trophy size={32} /></div>
        <h1 className="mt-4 font-display text-[30px] leading-tight font-semibold">Session done</h1>
        <div className="mt-4 font-display text-5xl font-semibold" style={{ color: accuracyColor(pct) }}>{right}/{total}</div>
        <p className="mt-1 text-sm text-ink-400">
          {avgPrev != null ? `Your average before: ${avgPrev.toFixed(0)}%.` : 'Your first session – it gets easier fast.'}
          {summary.toReview > 0 && ` ${summary.toReview} card${summary.toReview === 1 ? '' : 's'} you missed will come back next time.`}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => go('/safety')}>Back to the hub</Button>
          <Button variant="primary" onClick={onAgain}><RotateCcw size={16} /> Another round</Button>
        </div>
      </Card>
    </div>
  )
}
