import clsx from 'clsx'
import { motion } from 'motion/react'
import { useState } from 'react'
import {
  BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Crown, Eye, HelpCircle, Lightbulb, Pause, Play, RotateCcw, SkipForward, Swords, Undo2,
} from 'lucide-react'
import { BAD_CLASSES, CLS, ClassIcon } from '../../lib/classes'
import { moveNumber } from '../../lib/chess'
import type { CardExample, CheckResult, Color, EngineLine, GameRecord, MoveRec, GameEnd, Principle, PrincipleConcept } from '../../lib/types'
import { Button, Spinner } from '../ui'

export const alpha = (hex: string, a: number) => hex + Math.round(a * 255).toString(16).padStart(2, '0')

/** Fixed-height slot so the move list below never jumps around. */
export const CARD_HEIGHT = 'h-[232px]'

// A plain crossfade: no scale/position change, so nothing "bounces".
const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.14 } }

const NO_ALT = ['best', 'brilliant', 'great', 'book', 'forced']

const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a')

/** Who the card is talking about: "you" on your moves, "your opponent" on theirs, the colours if unknown. */
interface Sides { mine: boolean | null; mover: string; other: string }
function sidesFor(m: MoveRec, me: Color | null | undefined): Sides {
  if (!me) {
    const w = m.color === 'w'
    return { mine: null, mover: w ? 'White' : 'Black', other: w ? 'Black' : 'White' }
  }
  return m.color === me ? { mine: true, mover: 'You', other: 'Your opponent' } : { mine: false, mover: 'Your opponent', other: 'You' }
}

/** Plain-language "why": what the move allowed and/or what was missed; falls back to the stored text. */
function explainBody(m: MoveRec, s: Sides): string {
  const stored = m.text.replace(/^[^.!]*?[.!]+\s*/, '')
  const parts: string[] = []
  if (m.refute?.label) {
    const lbl = m.refute.label.toLowerCase()
    parts.push(m.refute.theme === 'mate' || m.refute.theme === 'back_rank'
      ? `It allows ${m.refute.san} – ${article(lbl)} ${lbl} is coming.`
      : `It allows ${m.refute.san} – ${article(lbl)} ${lbl}.`)
  } else if (m.refute && /hanging|allows mate/i.test(stored)) {
    parts.push(stored)
  } else if (m.refute) {
    parts.push(`${s.other} can answer ${m.refute.san}.`)
  }
  if (m.missed?.label) {
    const lbl = m.missed.label.toLowerCase()
    parts.push(`${s.mover} missed ${article(lbl)} ${lbl} with ${m.bestSan}.`)
  }
  return parts.length ? parts.join(' ') : stored
}

function headline(m: MoveRec) {
  const label = CLS[m.cls].label.toLowerCase()
  switch (m.cls) {
    case 'brilliant': return `${m.san} is brilliant!!`
    case 'great': return `${m.san} is a great move!`
    case 'best': return `${m.san} is best`
    case 'book': return `${m.san} is a book move`
    case 'forced': return `${m.san} is forced`
    default: return `${m.san} is ${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`
  }
}

function Shell({ color, glow, children }: { color: string; glow?: boolean; children: React.ReactNode }) {
  return (
    <motion.div {...fade}
      className={clsx('flex h-full flex-col overflow-hidden rounded-2xl p-3.5 ring-1')}
      style={{
        background: `linear-gradient(135deg, ${alpha(color, glow ? 0.22 : 0.12)}, rgba(16,19,29,.6) 70%)`,
        boxShadow: glow ? `0 0 40px -14px ${color}` : undefined,
        ['--tw-ring-color' as string]: alpha(color, 0.35),
      }}>
      {children}
    </motion.div>
  )
}

export function CoachCard({ move, game, onRetry, onBestLine, onWhy }:
  { move?: MoveRec; game: GameRecord; onRetry?: () => void; onBestLine?: () => void; onWhy?: () => void }) {
  if (!move) {
    return (
      <Shell color="#5d6888">
        <div className="font-display text-lg font-semibold">Starting position</div>
        <div className="mt-1 text-sm text-ink-300">{game.opening ? `${game.opening.eco} · ${game.opening.name}` : 'Press → to step through the game.'}</div>
        <div className="mt-auto text-xs text-ink-400">← → step · ↑ ↓ key moments · Space autoplay · F flip · E engine</div>
      </Shell>
    )
  }
  const meta = CLS[move.cls]
  const sides = sidesFor(move, game.me)
  const body = move.coach?.why || explainBody(move, sides)
  const better = move.coach?.better
  const mine = sides.mine !== false
  const special = move.cls === 'brilliant' || move.cls === 'great'
  const showAlt = !NO_ALT.includes(move.cls)
  return (
    <Shell color={meta.color} glow={special}>
      <div className="flex items-start gap-3">
        <ClassIcon cls={move.cls} size={34} glow={special} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate font-display text-lg font-semibold leading-tight" style={{ color: meta.color }}>
              <span className="mr-1 text-sm text-ink-400">{moveNumber(move.fenBefore)}</span>{headline(move)}
            </div>
            <span className="shrink-0 rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs font-bold text-ink-100">{move.evalText}</span>
          </div>
          {move.coach && move.coach.before !== move.coach.after && (
            <div className="mt-0.5 text-[11px] font-semibold text-ink-400" title={`How the position looks for ${sides.mine ? 'you' : sides.mine === false ? 'your opponent' : sides.mover} before and after this move`}>
              {sides.mine === false ? 'Opponent: ' : sides.mine === null ? `${sides.mover}: ` : ''}{move.coach.before} → <span className={BAD_CLASSES.has(move.cls) ? 'text-[#ff8a9a]' : 'text-best'}>{move.coach.after}</span>
            </div>
          )}
          {body && <p className="mt-0.5 line-clamp-3 text-sm leading-snug text-ink-200">{body}</p>}
          {better && <p className="mt-1 line-clamp-2 text-sm leading-snug text-best">{better}</p>}
          {move.refute && (
            <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-[#ff8a9a]">
              <span className="inline-block h-0.5 w-3 rounded bg-blunder" /> red arrow: {sides.mine ? 'their' : sides.mine === false ? 'your' : 'the'} punishing reply
            </p>
          )}
        </div>
      </div>
      {showAlt && (
        <div className="mt-2 flex min-w-0 items-center gap-1 overflow-hidden text-xs">
          <span className="shrink-0 font-semibold text-best">Best:</span>
          {move.bestLine.slice(0, 6).map((s, i) => (
            <span key={i} className={clsx('shrink-0 rounded px-1.5 py-0.5 font-semibold', i === 0 ? 'bg-best/20 text-best' : 'bg-white/5 text-ink-300')}>{s}</span>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
        {onRetry && mine && BAD_CLASSES.has(move.cls) && (
          <Button variant="primary" size="sm" onClick={onRetry}><RotateCcw size={14} /> Retry</Button>
        )}
        {showAlt && onBestLine && (
          <Button variant="soft" size="sm" onClick={onBestLine} title="Play the engine's best line from before this move">
            <Play size={13} fill="currentColor" /> Best line
          </Button>
        )}
        {onWhy && (
          <Button variant="soft" size="sm" onClick={onWhy} title="See how the game would continue after this move with best play">
            <HelpCircle size={14} /> {special || move.cls === 'best' ? 'Why is it strong?' : move.refute ? 'Show the punishment' : 'What happens next?'}
          </Button>
        )}
      </div>
    </Shell>
  )
}

export interface Retry {
  ply: number
  status: 'idle' | 'checking' | 'solved' | 'failed'
  fen: string
  tried?: string
  result?: CheckResult
  attempts: number
  reveal: boolean
}

export function RetryCard({ retry, move, onReveal, onExit, onNext }:
  { retry: Retry; move: MoveRec; onReveal: () => void; onExit: () => void; onNext: () => void }) {
  const r = retry.result
  const solved = retry.status === 'solved'
  const failed = retry.status === 'failed'
  const color = solved ? CLS[r!.cls].color : failed ? '#ff3d55' : '#1ee3cf'
  return (
    <Shell color={color} glow={solved}>
      <div className="flex items-start gap-3">
        {solved && r ? <ClassIcon cls={r.cls} size={34} glow />
          : <div className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent"><Lightbulb size={18} /></div>}
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-semibold leading-tight" style={{ color }}>
            {retry.status === 'idle' && (retry.attempts ? 'Not quite – try again!' : `Find a better move for ${move.color === 'w' ? 'White' : 'Black'}`)}
            {retry.status === 'checking' && <span className="flex items-center gap-2 text-ink-100"><Spinner /> Checking…</span>}
            {failed && r && `${r.san} is ${/^[aeiou]/.test(r.cls) ? 'an' : 'a'} ${CLS[r.cls].label.toLowerCase()}`}
            {solved && r && `${r.san} – ${CLS[r.cls].label}! You got it.`}
          </div>
          <p className="mt-1 text-sm text-ink-300">
            {solved ? `That's the idea. In the game you played ${move.san}.`
              : retry.reveal ? `The move was ${move.bestSan}.`
              : `In the game you played ${move.san} (${CLS[move.cls].label.toLowerCase()}).`}
          </p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
        {solved
          ? <Button variant="primary" size="sm" onClick={onNext}><SkipForward size={14} /> Next mistake</Button>
          : <Button variant="soft" size="sm" onClick={onReveal} disabled={retry.reveal}><Eye size={14} /> Show solution</Button>}
        <Button variant="ghost" size="sm" onClick={onExit}><Undo2 size={14} /> Back to game</Button>
      </div>
    </Shell>
  )
}

export interface Line {
  label: string
  startFen: string
  returnPly: number
  basePly: number
  ucis: string[]
  sans: string[]
  fens: string[]
  captures: boolean[]
  cursor: number // moves shown, 0 = startFen
  explore: boolean // user has played their own moves into it
  /** What to look at (a lesson card's example). */
  note?: string
  /** Play-out: Stockfish answers your moves, playing this side. */
  vs?: Color
  /** Play-out goal: the forced mate (in this many of your moves) you're trying to find. */
  goal?: number | null
}

/** Where a play-out against Stockfish stands. */
export interface Playout {
  status: 'your-move' | 'thinking' | 'slip' | 'won' | 'over'
  text?: string
}

export function LineCard({ line, evalText, playing, onCursor, onTogglePlay, onExit, playout }:
  {
    line: Line; evalText?: string; playing: boolean; onCursor: (c: number) => void; onTogglePlay: () => void; onExit: () => void
    playout?: { state: Playout; onHint: () => void; onTakeBack: () => void; onPlayOn: () => void }
  }) {
  const firstNo = moveNumber(line.startFen)
  const white = line.startFen.split(' ')[1] === 'w'
  const startNo = Number(line.startFen.split(' ')[5])
  return (
    <Shell color="#5b8cff">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate font-display text-base font-semibold text-great">{line.label}</div>
        {/* No eval while you're solving – it would give the answer away. */}
        {!(line.vs && line.goal) && <span className="shrink-0 rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs font-bold">{evalText ?? '…'}</span>}
      </div>
      {line.note && <p className="mt-1 line-clamp-3 text-xs leading-snug text-ink-300">{line.note}</p>}
      {playout && <PlayoutStatus line={line} state={playout.state} />}
      <div className="mt-2 flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto text-xs">
        {line.sans.map((s, i) => {
          const ply = (white ? 0 : 1) + i
          const no = ply % 2 === 0 ? `${startNo + ply / 2}.` : i === 0 ? firstNo : ''
          return (
            <button key={i} onClick={() => onCursor(i + 1)}
              className={clsx('rounded px-1.5 py-0.5 font-semibold transition cursor-pointer',
                i + 1 === line.cursor ? 'bg-great text-white' : i < line.cursor ? 'bg-great/20 text-ink-100' : 'bg-white/5 text-ink-400 hover:text-white')}>
              {no && <span className="mr-0.5 opacity-60">{no}</span>}{s}
            </button>
          )
        })}
      </div>
      {playout ? (
        <div className="mt-2 flex items-center gap-1.5">
          <Button variant="soft" size="sm" onClick={playout.onHint} disabled={playout.state.status !== 'your-move'} title="Show the best move as an arrow">
            <Lightbulb size={14} /> Hint
          </Button>
          <Button variant="soft" size="sm" onClick={playout.onTakeBack} disabled={line.cursor === 0 || playout.state.status === 'thinking'}>
            <Undo2 size={14} /> Take back
          </Button>
          {playout.state.status === 'slip' && <Button variant="ghost" size="sm" onClick={playout.onPlayOn} title="Keep playing against Stockfish from here">Play on</Button>}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onExit}>Back to game</Button>
        </div>
      ) : (
      <div className="mt-2 flex items-center gap-1.5">
        <Button variant="soft" size="sm" onClick={() => onCursor(line.cursor - 1)} disabled={line.cursor === 0}><ChevronLeft size={15} /></Button>
        <Button variant="primary" size="sm" onClick={onTogglePlay}>
          {playing ? <><Pause size={13} fill="currentColor" /> Pause</> : <><Play size={13} fill="currentColor" /> {line.cursor >= line.sans.length ? 'Replay' : 'Play'}</>}
        </Button>
        <Button variant="soft" size="sm" onClick={() => onCursor(line.cursor + 1)} disabled={line.cursor >= line.sans.length}><ChevronRight size={15} /></Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onExit}><Undo2 size={14} /> Back to game</Button>
      </div>
      )}
    </Shell>
  )
}

function PlayoutStatus({ line, state }: { line: Line; state: Playout }) {
  const side = line.vs === 'w' ? 'Black' : 'White'
  const text = state.status === 'thinking' ? 'Stockfish is thinking…'
    : state.status === 'won' ? 'Checkmate – you found it!'
    : state.status === 'your-move' && !state.text
      ? (line.cursor === 0 ? (line.goal ? `${side} to move – find the mate in ${line.goal}.` : `You play ${side}; Stockfish answers.`) : 'Your move.')
      : state.text
  return (
    <div className={clsx('mt-1 flex items-center gap-1.5 text-sm',
      state.status === 'won' ? 'font-semibold text-best' : state.status === 'slip' ? 'text-[#ff8a9a]' : 'text-ink-200')}>
      {state.status === 'thinking' && <Spinner size={12} />}
      {state.status === 'won' && <Crown size={15} />}
      {text}
    </div>
  )
}

/** "You have mate in 3": watch it, or find it yourself against Stockfish's best defence. */
export function MateStrip({ who, n, onShow, onTry }: { who: string; n: number; onShow: () => void; onTry?: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-blunder/10 px-3 py-2 ring-1 ring-inset ring-blunder/25">
      <Crown size={15} className="shrink-0 text-[#ff8a9a]" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-100">{who} mate in {n}</span>
      <Button variant="soft" size="sm" onClick={onShow} title="Play the mating line on the board"><Play size={13} fill="currentColor" /> Show</Button>
      {onTry && <Button variant="primary" size="sm" onClick={onTry} title="Play the mating side yourself – Stockfish defends"><Swords size={13} /> Try it</Button>}
    </div>
  )
}

const PHASE: Record<string, string> = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' }
const GOLD = '#e0b44c'

/**
 * The positional principle behind a bad move, from its lesson card: one line while you step through the game;
 * opened (click or P), what happened, the rule, why it holds, the question to ask yourself next time, when it
 * doesn't apply, the book – and a model position to play through. The squares get marked on the board.
 */
export function PrincipleStrip({ principle, open, onToggle, onExample, onFeedback, onShowReply }: {
  principle: Principle; open: boolean; onToggle: () => void
  onExample: (ex: CardExample) => void; onFeedback: (c: PrincipleConcept, fits: boolean) => void
  /** Your opponent's move: play the engine's way of using it on the board. */
  onShowReply?: () => void
}) {
  const [first, ...rest] = principle.concepts
  return (
    <div className="rounded-xl bg-[#e0b44c]/[0.07] ring-1 ring-inset ring-[#e0b44c]/25">
      <button onClick={onToggle} aria-expanded={open} title={open ? 'Hide the principle (P)' : 'Show the principle behind this move (P)'}
        className="flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer">
        <BookOpen size={15} className="shrink-0" style={{ color: GOLD }} />
        <span className="min-w-0 flex-1 truncate text-sm">
          <b className="font-semibold text-ink-100">{first.title}</b>
          {rest.length > 0 && <span className="text-ink-400"> + {rest.map(c => c.title.toLowerCase()).join(', ')}</span>}
          {!open && <span className="text-ink-400"> – {first.chance ?? first.inGame}</span>}
        </span>
        <ChevronDown size={15} className={clsx('shrink-0 text-ink-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="max-h-72 space-y-4 overflow-y-auto px-3 pb-3">
          {principle.concepts.map(c => (
            <Lesson key={c.concept} c={c} phase={principle.phase} titled={principle.concepts.length > 1}
              onExample={onExample} onFeedback={fits => onFeedback(c, fits)} onShowReply={onShowReply} />
          ))}
        </div>
      )}
    </div>
  )
}

function Lesson({ c, phase, titled, onExample, onFeedback, onShowReply }: {
  c: PrincipleConcept; phase: string; titled: boolean; onExample: (ex: CardExample) => void; onFeedback: (fits: boolean) => void
  onShowReply?: () => void
}) {
  const [fits, setFits] = useState<boolean | undefined>(c.fits)
  const give = (v: boolean) => { setFits(v); onFeedback(v) }
  return (
    <div className="space-y-2 text-[13px] leading-snug">
      {titled && <div className="text-xs font-semibold text-ink-200">{c.title}</div>}
      <p className="text-ink-100">{c.inGame}</p>
      {c.chance && (
        <div className="rounded-lg bg-best/10 px-2.5 py-2 ring-1 ring-inset ring-best/25">
          <div className="text-[11px] font-medium tracking-wide text-best uppercase">Your chance</div>
          <p className="text-ink-100">{c.chance}</p>
          {c.replyLine && (
            <div className="mt-1 flex items-center gap-2 text-xs text-ink-300">
              <span className="min-w-0 truncate">Engine: <span className="font-mono text-ink-100">{c.replyLine}</span></span>
              {onShowReply && (
                <Button variant="soft" size="sm" onClick={onShowReply} title="Play the engine's line on the board">
                  <Play size={12} fill="currentColor" /> Show
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <div>
        <div className="text-[11px] font-medium tracking-wide uppercase" style={{ color: GOLD }}>{PHASE[phase] ?? 'The'} principle</div>
        <p className="text-ink-100">{c.principle}</p>
      </div>
      <p className="text-ink-300">{c.explanation}</p>
      {!c.chance && <p className="text-ink-300"><span className="text-ink-400">Ask yourself:</span> {c.ask_yourself}</p>}
      {c.exceptions.length > 0 && (
        <details className="text-ink-400">
          <summary className="cursor-pointer text-xs hover:text-ink-200">When it doesn’t apply</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">{c.exceptions.map(e => <li key={e}>{e}</li>)}</ul>
        </details>
      )}
      {c.examples.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.examples.map(ex => (
            <Button key={ex.title} variant="soft" size="sm" onClick={() => onExample(ex)} title={ex.note}>
              <Play size={12} fill="currentColor" /> Example: {ex.title}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span className="text-[11px] text-ink-500">Idea from {c.source}</span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-500">
          Fits this move?
          <button onClick={() => give(true)} title="Yes – the lesson explains this move"
            className={clsx('rounded px-1.5 py-0.5 transition cursor-pointer', fits === true ? 'bg-best/20 text-best' : 'hover:text-ink-200')}>
            <Check size={12} className="inline" /> Yes
          </button>
          <button onClick={() => give(false)} title="No – lessons like this one will need clearer evidence"
            className={clsx('rounded px-1.5 py-0.5 transition cursor-pointer', fits === false ? 'bg-mistake/20 text-mistake' : 'hover:text-ink-200')}>
            No
          </button>
        </span>
      </div>
    </div>
  )
}

export function EngineLines({ lines, loading, onPlay, over, onPlayOut }:
  { lines: EngineLine[] | null; loading: boolean; onPlay: (l: EngineLine) => void; over?: GameEnd | null; onPlayOut?: () => void }) {
  return (
    <div className="space-y-1 rounded-xl bg-ink-850/80 p-2 ring-1 ring-white/5">
      {!lines && loading && <div className="flex items-center gap-2 px-1 py-1 text-xs text-ink-400"><Spinner size={12} /> Engine thinking…</div>}
      {lines?.length === 0 && <div className="px-1 py-1 text-xs text-ink-300"><b className="text-ink-100">{over ? over.text.split(' – ')[0] : 'Game over'}</b>{over?.text.includes(' – ') && <span className="text-ink-400"> – {over.text.split(' – ')[1]}</span>}</div>}
      {lines?.map((l, i) => (
        <button key={i} onClick={() => onPlay(l)} title="Play this line on the board"
          className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-xs transition hover:bg-white/5 cursor-pointer">
          <span className="w-12 shrink-0 rounded bg-black/30 px-1 text-center font-mono font-bold">{l.evalText}</span>
          <span className="truncate text-ink-300"><b className="text-ink-100">{l.san}</b> {l.line.slice(1, 8).join(' ')}</span>
        </button>
      ))}
      {onPlayOut && !!lines?.length && (
        <button onClick={onPlayOut} title="Take over the side to move – Stockfish answers your moves"
          className="flex w-full items-center gap-1.5 rounded-lg px-1 pt-1 text-left text-xs text-ink-400 transition hover:text-white cursor-pointer">
          <Swords size={12} /> Play it out from here against Stockfish
        </button>
      )}
    </div>
  )
}
