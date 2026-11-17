import { Chess } from 'chess.js'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Award, Bot, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Cpu, Flag, GitBranch, Microscope, Play, RotateCcw, Shuffle, Skull, Sparkles, Swords, Target, TriangleAlert, Trophy, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Board } from '../components/Board'
import { MaterialDiff } from '../components/MaterialDiff'
import { EvalBar } from '../components/EvalBar'
import { Button, Card, ErrorNote, PageHeader, PageSkeleton, Segmented, Spinner } from '../components/ui'
import { LoadingNotice } from '../components/LoadingNotice'
import { api } from '../lib/api'
import { go, leave, replace } from '../lib/router'
import { playUci, uciSquares } from '../lib/chess'
import { sound } from '../lib/sound'
import { startAnalysis, useSettings } from '../lib/store'
import type { BotGameResult, BotProgress, Cls, ConvertSpot, Color, EngineLine, Eval, NightmareGambit, NightmareMove, NightmareSummary } from '../lib/types'
import { CollectionView, GameXp, ProgressView, XpBar } from '../components/bot/BotProgress'
import { BAD_CLASSES, CLS, ClassIcon } from '../lib/classes'

const SAVE_KEY = 'nightmare-game'
const SETUP_KEY = 'nightmare-setup'
const FOCUS = { off: 0, human: 0.2, balanced: 0.6, ruthless: 0.9 } as const
type Focus = keyof typeof FOCUS
const FOCUS_LABEL: Record<Focus, string> = { off: 'Off', human: 'Human', balanced: 'Sneaky', ruthless: 'Ruthless' }
const DEPTHS = { fast: 10, normal: 12, deep: 16 } as const

/** Live coaching: every move is rated right away by a quick Stockfish search. */
interface Feedback {
  on: boolean
  depth: keyof typeof DEPTHS
  /** After a bad move of yours, show the better move as an arrow. */
  showBest: boolean
  /** Also rate the bot's moves during the game (so you see when there's something to punish). */
  botMoves: boolean
}
const DEFAULT_FEEDBACK: Feedback = { on: true, depth: 'normal', showBest: true, botMoves: false }

/** The quick verdict on one move. */
interface Mark { uci: string; cls: Cls; loss: number; bestSan: string; bestUci: string; text: string; evalText: string }

interface Decision { ply: number; san: string; uci: string; trap: NightmareMove['trap']; opening: NightmareMove['opening']; gambit?: NightmareMove['gambit']; fell?: boolean; reply?: string }
interface Game {
  color: Color; strength: number; focus: Focus; moves: string[]; sans: string[]; level: number; decisions: Decision[]
  over: null | { result: 'win' | 'draw' | 'loss'; reason: string }; takebacks?: number; practice?: boolean
  /** You used the analysis board during the game (counts like a takeback: half XP). */
  explored?: boolean
  feedback?: Feedback
  /** Opening variety: vary the bot's first moves. */
  variety?: boolean
  /** Gambit ids the bot plays when your moves allow it. */
  gambits?: string[]
  /** Ply (1-based) -> the quick verdict on that move. */
  marks?: Record<number, Mark>
  /** XP and statistics this game earned (after it's scored). */
  progress?: BotGameResult
  /** Start position other than the normal one (Convert your wins). */
  startFen?: string
  /** The won position from your games this game restarts. */
  convert?: ConvertSpot
}

interface SavedSetup {
  color: 'w' | 'b' | 'random'; strength: number; focus: Focus; feedback: Feedback; variety: boolean; gambitsOn: boolean; gambits: string[]
  /** Colours of your last games (newest last) – so "Random" doesn't give you the same colour again and again. */
  lastColors?: Color[]
}

/** "Random", but fair over a few games: after two games with the same colour you get the other one. */
function pickColour(last: Color[]): Color {
  const [a, b] = last.slice(-2)
  if (a && a === b) return a === 'w' ? 'b' : 'w'
  return Math.random() < 0.5 ? 'w' : 'b'
}
function loadSetup(): Partial<SavedSetup> {
  try { return JSON.parse(localStorage.getItem(SETUP_KEY) ?? '{}') as Partial<SavedSetup> } catch { return {} }
}
function saveSetup(s: SavedSetup) {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify(s)) } catch { /* private mode */ }
}

function load(): Game | null {
  try { const s = localStorage.getItem(SAVE_KEY); return s ? JSON.parse(s) as Game : null } catch { return null }
}
function save(g: Game | null) {
  try { if (g) localStorage.setItem(SAVE_KEY, JSON.stringify(g)); else localStorage.removeItem(SAVE_KEY) } catch { /* private mode */ }
}

const fenOf = (moves: string[], start?: string) => {
  const c = new Chess(start)
  for (const u of moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined })
  return c
}

function outcome(c: Chess, you: Color): Game['over'] {
  if (c.isCheckmate()) return { result: c.turn() === you ? 'loss' : 'win', reason: 'checkmate' }
  if (c.isStalemate()) return { result: 'draw', reason: 'stalemate' }
  if (c.isThreefoldRepetition()) return { result: 'draw', reason: 'repetition' }
  if (c.isInsufficientMaterial()) return { result: 'draw', reason: 'insufficient material' }
  if (c.isDraw()) return { result: 'draw', reason: '50-move rule' }
  return null
}

/** The position you last played from "Convert your wins" – selected again when you come back to the list. */
let lastSpot: string | null = null

const TABS: Tab[] = ['play', 'convert', 'progress', 'collection']

/**
 * Pages: #/nightmare/<tab> for the setup tabs, #/nightmare/game for the board. Starting a game opens the board
 * as a new page, so Back (or "Back to the list") returns to the tab you started it from. A game in progress is
 * kept when you leave it; plain #/nightmare (the sidebar) takes you back into it.
 */
export function NightmarePage({ sub }: { sub?: string }) {
  const [info, setInfo] = useState<NightmareSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [game, setGame] = useState<Game | null>(load)
  useEffect(() => { api.nightmare().then(setInfo).catch(e => setError(String(e.message ?? e))) }, [])
  useEffect(() => { save(game) }, [game])
  const tab: Tab = TABS.includes(sub as Tab) ? (sub as Tab) : 'play'
  const showGame = !!game && (sub === 'game' || (!sub && !game.over))
  // Back into a running game from the sidebar: give the board its own address, so the game stays on screen when it
  // ends (and Back leads to the setup).
  useEffect(() => { if (!sub && game && !game.over) replace('/nightmare/game') }, [sub, game])
  // A finished game you have left is done with.
  useEffect(() => { if (game?.over && !showGame) setGame(null) }, [game?.over, showGame]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = (g: Game) => {
    setGame(g)
    replace(`/nightmare/${tab}`) // so Back from the board lands on this tab
    go('/nightmare/game')
  }
  const exit = (g: Game) => {
    setGame(null)
    leave(g.convert ? '/nightmare/convert' : '/nightmare/play')
  }

  if (error) return <div className="mx-auto max-w-lg p-10"><ErrorNote>{error}</ErrorNote></div>
  if (info && !info.available) return <Missing />
  if (game && showGame) return <PlayView game={game} setGame={setGame} onSummary={setInfo} onExit={() => exit(game)} />
  if (!info) return <PageSkeleton tiles={0} /> // the setup needs the bot's info; the board doesn't
  return <Setup info={info} tab={tab} onTab={t => replace(`/nightmare/${t}`)} onStart={start} onInfo={setInfo}
    current={game && !game.over ? game : null} onAbandon={() => setGame(null)} />
}

function Missing() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <PageHeader icon={<Bot className="text-accent" />} title="Instructive bot" />
      <Card className="mt-6 p-6 text-sm text-ink-300">
        The Nightmare needs <b>Lc0</b> in <code>engine/lc0/</code> and the <b>Maia</b> networks in <code>engine/maia/</code>.
        See the README for the download links.
      </Card>
    </div>
  )
}

// --------------------------------------------------------------------------- //
//  Setup
// --------------------------------------------------------------------------- //

type Tab = 'play' | 'convert' | 'progress' | 'collection'

function Setup({ info, tab, onTab: setTab, onStart, onInfo, current, onAbandon }: {
  info: NightmareSummary; tab: Tab; onTab: (t: Tab) => void; onStart: (g: Game) => void; onInfo: (s: NightmareSummary) => void
  /** A game you left without finishing it. */
  current: Game | null; onAbandon: () => void
}) {
  const [progress, setProgress] = useState<BotProgress | null>(null)
  const [progressError, setProgressError] = useState<string | null>(null)
  useEffect(() => { api.botProgress().then(setProgress).catch(e => setProgressError(String((e as Error).message ?? e))) }, [])
  const waiting = progressError
    ? <ErrorNote>Couldn't load your progress ({progressError}). If you just updated the app, close all its windows and start it again.</ErrorNote>
    : <div className="flex items-center gap-2 py-10 text-sm text-ink-400"><Spinner size={16} /> Loading…</div>
  const saved = useMemo(loadSetup, [])
  const [color, setColor] = useState<'w' | 'b' | 'random'>(saved.color ?? 'random')
  const [strength, setStrength] = useState(saved.strength ?? 0)
  const [focus, setFocus] = useState<Focus>(saved.focus && saved.focus in FOCUS ? saved.focus : 'balanced')
  const [feedback, setFeedback] = useState<Feedback>({ ...DEFAULT_FEEDBACK, ...saved.feedback })
  const fb = (p: Partial<Feedback>) => setFeedback(f => ({ ...f, ...p }))
  const [variety, setVariety] = useState(saved.variety ?? false)
  const [gambitsOn, setGambitsOn] = useState(saved.gambitsOn ?? false)
  const [gambits, setGambits] = useState<string[]>(saved.gambits ?? [])
  const [gambitList, setGambitList] = useState<NightmareGambit[] | null>(null)
  useEffect(() => { if (gambitsOn && !gambitList) api.nightmareGambits().then(setGambitList).catch(() => setGambitList([])) }, [gambitsOn, gambitList])
  // Losing every game teaches little: after a bad run (≤ 1 point from the last 6), suggest an easier setting.
  const last6 = info.recent.slice(0, 6)
  const struggling = last6.length >= 6 && last6.reduce((p, g) => p + (g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0), 0) <= 1
  const easier = strength > 0 || focus === 'ruthless'
  const r = info.record
  const level = Math.min(Math.max(...info.levels.filter(l => l <= info.rating + strength + 50), info.levels[0]), info.levels.at(-1)!)

  /** Convert your wins: play on from a won position of yours, with the bot settings from "New game". */
  const playSpot = (spot: ConvertSpot) => {
    saveSetup({ color, strength, focus, feedback, variety, gambitsOn, gambits, lastColors: loadSetup().lastColors })
    lastSpot = spot.id
    onStart({ color: spot.color, strength, focus, moves: [], sans: [], level, decisions: [], over: null, feedback, marks: {},
      startFen: spot.fen, convert: spot })
  }

  const start = () => {
    // Your last colours: remembered here, or (the first time) taken from your recent games against the bot.
    const lastColors = (loadSetup().lastColors ?? info.recent.slice(0, 2).reverse().map(g => g.color))
      .filter((x): x is Color => x === 'w' || x === 'b')
    const c: Color = color === 'random' ? pickColour(lastColors) : color
    saveSetup({ color, strength, focus, feedback, variety, gambitsOn, gambits, lastColors: [...lastColors, c].slice(-6) })
    onStart({ color: c, strength, focus, moves: [], sans: [], level, decisions: [], over: null, feedback, marks: {},
      variety, gambits: gambitsOn ? gambits : [] })
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <PageHeader icon={<Bot className="text-accent" />} title="Instructive bot"
        description="A human-like opponent at the strength you choose (Maia), with live coaching: every move you play is rated on the spot. Switch on Nightmare mode and it also plays for your weaknesses – the openings where you go wrong and the traps you fall for."
        actions={progress && <button onClick={() => setTab('progress')} className="w-72 rounded-2xl p-2 text-left transition hover:bg-white/[0.03] cursor-pointer" title="Your progress against the bot"><XpBar info={progress} /></button>} />

      {current && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <Play size={18} className="text-accent" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">You have a game in progress</div>
            <div className="text-ink-400">
              {current.convert ? `Convert your wins · from your game against ${current.convert.opponent}` : `Against Maia ${current.level}`}
              {' · '}{current.moves.length ? `${Math.ceil(current.moves.length / 2)} moves played` : 'not started yet'}
            </div>
          </div>
          <Button variant="primary" onClick={() => go('/nightmare/game')}><Play size={14} /> Continue</Button>
          <Button variant="ghost" onClick={onAbandon}>Abandon it</Button>
        </Card>
      )}

      <Segmented value={tab} onChange={setTab} options={[
        { value: 'play', label: <><Swords size={14} /> New game</> },
        { value: 'convert', label: <><Trophy size={14} /> Convert your wins</> },
        { value: 'progress', label: <><Award size={14} /> Progress &amp; stats</> },
        { value: 'collection', label: <><Sparkles size={14} /> Collection{progress?.collectionSize ? ` · ${progress.collectionSize}` : ''}</> },
      ]} />

      {tab === 'convert' && <ConvertTab level={level} stats={progress?.convert} onPlay={playSpot} />}
      {tab === 'progress' && (progress ? <ProgressView p={progress} onReset={setProgress} /> : waiting)}
      {tab === 'collection' && (progress ? <CollectionView p={progress} /> : waiting)}

      {tab === 'play' && <>
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-blunder/12 text-blunder ring-1 ring-inset ring-blunder/25"><Skull size={28} /></div>
            <div>
              <div className="font-display text-xl font-semibold">The bot plays like a {level} player</div>
              <div className="mt-1 text-sm text-ink-400">
                <RatingLine info={info} onInfo={onInfo} /> It moves like a human at its level (Maia), checked by Stockfish so it
                never just throws the game – and it knows {info.reviewed.toLocaleString()} of your reviewed games.
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-500 uppercase"><Target size={13} /> Traps it sets for you</div>
              {!info.themes.length && <p className="text-sm text-ink-400">None known yet – review some of your games and it learns which tactics you miss.</p>}
              <div className="flex flex-wrap gap-1.5">
                {info.themes.map((t, i) => (
                  <span key={t.theme} className={clsx('rounded-full px-2.5 py-1 text-xs ring-1 ring-inset',
                    i === 0 ? 'bg-blunder/12 text-[#ff8796] ring-blunder/30' : 'bg-white/[0.04] text-ink-200 ring-white/[0.08]')}>
                    {t.label} <span className="text-ink-500">· {t.count}×</span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-500">How often each one cost you material in your reviews.</p>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-500 uppercase"><Swords size={13} /> Openings it steers into</div>
              {info.openings.length ? (
                <ul className="space-y-1.5 text-sm">
                  {info.openings.map(o => (
                    <li key={o.name} className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-ink-200">{o.name}</span>
                      <span className="shrink-0 font-mono text-xs text-[#ff8796]">{o.rate}% · {o.games} games</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-ink-400">No clear weak spots in your openings yet.</p>}
              <p className="mt-2 text-xs text-ink-500">How often you went wrong within three moves of reaching them.</p>
            </div>
          </div>
        </Card>

        <Card className="flex flex-col gap-5 p-6">
          <Option label="You play">
            <Segmented value={color} onChange={setColor} options={[
              { value: 'w', label: 'White' }, { value: 'random', label: 'Random' }, { value: 'b', label: 'Black' },
            ]} />
          </Option>
          <Option label="Strength (Maia)" hint={`Maia ${level}`}>
            <Segmented value={strength} onChange={setStrength} options={[
              { value: -200, label: '−200' }, { value: -100, label: '−100' }, { value: 0, label: 'Your level' },
              { value: 100, label: '+100' }, { value: 200, label: '+200' }, { value: 400, label: '+400' },
            ]} />
          </Option>
          <Option label="Nightmare mode" hint={focus === 'off' ? 'a plain human-like opponent' : focus === 'human' ? 'mostly natural moves' : focus === 'balanced' ? 'natural moves, sets traps when it can' : 'hunts your weaknesses every move'}>
            <Segmented value={focus} onChange={setFocus} options={(Object.keys(FOCUS) as Focus[]).map(f => ({ value: f, label: FOCUS_LABEL[f] }))} />
          </Option>
          <div className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.06]">
            <Toggle label="Instant feedback" hint="rate each of your moves right away" on={feedback.on} onChange={on => fb({ on })} />
            {feedback.on && (
              <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
                <Option label="Speed" hint={`Stockfish depth ${DEPTHS[feedback.depth]}`}>
                  <Segmented value={feedback.depth} onChange={depth => fb({ depth })} options={[
                    { value: 'fast', label: 'Fast' }, { value: 'normal', label: 'Normal' }, { value: 'deep', label: 'Deep' },
                  ]} />
                </Option>
                <Toggle label="Show the better move" hint="arrow after a mistake" on={feedback.showBest} onChange={showBest => fb({ showBest })} />
                <Toggle label="Rate the bot's moves too" hint="see when it slips up" on={feedback.botMoves} onChange={botMoves => fb({ botMoves })} />
              </div>
            )}
          </div>
          <Toggle label="Opening variety" hint="the bot varies its first moves between the ones players at its level often choose"
            on={variety} onChange={setVariety} />
          <div className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.06]">
            <Toggle label="Gambits" hint="the bot plays the gambits you pick whenever your moves allow it" on={gambitsOn} onChange={setGambitsOn} />
            {gambitsOn && (
              <GambitPicker list={gambitList} picked={gambits} onChange={setGambits} />
            )}
          </div>
          {struggling && easier && (
            <div className="rounded-xl bg-inaccuracy/10 p-3 text-xs text-ink-200 ring-1 ring-inset ring-inaccuracy/25">
              You scored {last6.reduce((p, g) => p + (g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0), 0)} from your last 6 games.
              Games you can win teach more – try it at your level first.
              <button className="mt-1.5 block font-medium text-inaccuracy hover:underline cursor-pointer"
                onClick={() => { setStrength(0); if (focus === 'ruthless') setFocus('balanced') }}>Use your level</button>
            </div>
          )}
          <Button variant="primary" size="lg" onClick={start} className="mt-auto"><Play size={16} /> Start the game</Button>
        </Card>
      </div>

      {r.played > 0 && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <h2 className="font-display text-lg font-semibold">Your record</h2>
            <Stat label="Won" value={r.won} color="text-best" />
            <Stat label="Drawn" value={r.drawn} />
            <Stat label="Lost" value={r.lost} color="text-blunder" />
            <Stat label="Traps dodged" value={r.traps ? `${Math.round(((r.traps - r.fell) / r.traps) * 100)}%` : '—'} />
          </div>
          {info.recent.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {info.recent.map((g, i) => (
                <span key={i} title={`${g.color === 'w' ? 'White' : 'Black'} vs Maia ${g.level} · ${g.moves} moves · fell for ${g.fell}/${g.traps} traps`}
                  className={clsx('flex size-7 items-center justify-center rounded-lg font-mono text-xs font-semibold ring-1 ring-inset',
                    g.result === 'win' ? 'bg-best/12 text-best ring-best/25' : g.result === 'loss' ? 'bg-blunder/12 text-[#ff7b8d] ring-blunder/25' : 'bg-white/[0.06] text-ink-300 ring-white/10')}>
                  {g.result === 'win' ? 'W' : g.result === 'loss' ? 'L' : 'D'}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}
      </>}
    </div>
  )
}

const SITE_NAME: Record<string, string> = { lichess: 'Lichess', 'chess.com': 'Chess.com' }

/** "You're about 1340 (…)" – with a way to set your rating yourself when the automatic one is off. */
function RatingLine({ info, onInfo }: { info: NightmareSummary; onInfo: (s: NightmareSummary) => void }) {
  const r = info.ratingInfo
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(info.rating))
  const [busy, setBusy] = useState(false)
  const save = async (rating: number | null) => {
    setBusy(true)
    try { onInfo(await api.setBotRating(rating)); setEditing(false) } finally { setBusy(false) }
  }
  if (editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        Your rating (Lichess scale):
        <input type="number" min={400} max={3000} step={10} value={value} onChange={e => setValue(e.target.value)} autoFocus
          className="h-7 w-20 rounded-md bg-black/30 px-2 text-sm text-white ring-1 ring-inset ring-white/15 outline-none focus:ring-accent/60" />
        <Button size="sm" variant="primary" disabled={busy || !Number(value)} onClick={() => save(Number(value))}>Save</Button>
        {r?.manual && <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(null)}>Use automatic{r.auto ? ` (${r.auto})` : ''}</Button>}
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </span>
    )
  }
  const from = r?.manual ? 'set by you' : r?.site ? `from your last games on ${SITE_NAME[r.site] ?? r.site}` : 'from your recent games'
  return (
    <span>
      You're about <b className="text-ink-200">{info.rating}</b> (Lichess scale, {from}){' '}
      <button onClick={() => { setValue(String(info.rating)); setEditing(true) }} className="text-accent hover:underline cursor-pointer">change</button>.
    </span>
  )
}

const LEADS = [
  { value: 70, label: 'Clear lead' },
  { value: 80, label: 'Big lead' },
  { value: 90, label: 'Huge lead' },
]
const moveLabel = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'}`
const END_TEXT: Record<string, string> = {
  checkmate: 'got mated', resignation: 'resigned', repetition: 'drew by repetition', stalemate: 'stalemated',
  agreement: 'agreed a draw', insufficient: 'drew (insufficient material)', fifty: 'drew (50-move rule)',
}

/**
 * Convert your wins: positions from your own games where you were clearly winning and still lost (not on
 * time). Each starts at the last moment it was your move and you were still winning – finish the job.
 */
function ConvertTab({ level, stats, onPlay }: { level: number; stats?: BotProgress['convert']; onPlay: (s: ConvertSpot) => void }) {
  const [minWin, setMinWin] = useState(70)
  const [draws, setDraws] = useState(false)
  const [all, setAll] = useState<ConvertSpot[] | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ConvertSpot | null>(null)
  useEffect(() => {
    setAll(null)
    api.convertSpots(minWin, draws)
      .then(s => { setAll(s); setError(null) })
      .catch(e => setError(String((e as Error).message ?? e)))
  }, [minWin, draws])
  // Positions you have already won against the bot leave the list (shown again on request).
  const converted = (s: ConvertSpot) => s.played?.best === 'win'
  const doneCount = all ? all.filter(converted).length : 0
  const spots = useMemo(() => (all ? (showDone ? all : all.filter(s => !converted(s))) : null), [all, showDone])
  useEffect(() => {
    if (spots) setPicked(p => spots.find(x => x.id === (p?.id ?? lastSpot)) ?? spots[0] ?? null)
  }, [spots])
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <p className="text-sm text-ink-300">
          Positions from your games where you were clearly winning and still lost – games lost on time are left out. Each one
          starts at the last moment it was your move and you were still winning. Finish the job against the bot
          (Maia {level}, as set under New game).
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented value={minWin} onChange={setMinWin} options={LEADS} />
          <div className="w-64"><Toggle label="Include draws" hint="games you only drew from a winning position" on={draws} onChange={setDraws} /></div>
          {stats && stats.tried > 0 && (
            <span className="ml-auto text-sm text-ink-400">
              Converted <b className="text-best">{stats.won}</b> of {stats.positions ?? stats.tried} position{(stats.positions ?? stats.tried) === 1 ? '' : 's'} tried
            </span>
          )}
        </div>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}
      {!spots && !error && <LoadingNotice compact title="Looking through your games for won positions you lost" tasks={['insights', 'summaries']} />}
      {spots && spots.length === 0 && (
        <Card className="p-6 text-sm text-ink-400">
          {doneCount > 0
            ? <>You have converted all {doneCount} position{doneCount === 1 ? '' : 's'} at this lead. Try a smaller lead, include draws,
                or <button onClick={() => setShowDone(true)} className="text-accent hover:underline cursor-pointer">show the converted ones</button>.</>
            : <>No games like that found – either you convert your wins, or there are too few reviewed games. Try a smaller lead,
                include draws, or analyze more of your games.</>}
        </Card>
      )}
      {spots && spots.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5 text-xs text-ink-400">
              <span>{spots.length} position{spots.length === 1 ? '' : 's'}, newest first</span>
              <span className="flex items-center gap-1">
                {doneCount > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setShowDone(v => !v)}
                    title="Positions you have already won against the bot">
                    {showDone ? 'Hide converted' : `Show converted (${doneCount})`}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setPicked(spots[Math.floor(Math.random() * spots.length)])}>
                  <Shuffle size={13} /> Random
                </Button>
              </span>
            </div>
            <div className="max-h-[520px] overflow-y-auto p-1.5">
              {spots.map(s => (
                <button key={s.id} onClick={() => setPicked(s)}
                  className={clsx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition cursor-pointer',
                    picked?.id === s.id ? 'bg-white/[0.07] ring-1 ring-inset ring-accent/30' : 'hover:bg-white/[0.04]')}>
                  <span className={clsx('size-3 shrink-0 rounded-full ring-1 ring-white/30', s.color === 'w' ? 'bg-white' : 'bg-ink-950')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">vs {s.opponent}{s.oppElo ? <span className="text-ink-400"> ({s.oppElo})</span> : null}</span>
                    <span className="block text-xs text-ink-400">{s.date} · move {s.moveNumber} · {s.outcome === 'draw' ? 'drawn' : 'lost'}</span>
                  </span>
                  {s.played && (s.played.best === 'win'
                    ? <span className="flex shrink-0 items-center gap-1 rounded-md bg-best/10 px-1.5 py-0.5 text-[11px] font-medium text-best" title={`Converted · ${s.played.xp} XP earned here. Playing it again only pays XP above that.`}><Check size={12} /> Converted</span>
                    : <span className="shrink-0 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-ink-400" title={`Best result so far: ${s.played.best ?? '–'}`}>Tried {s.played.tries}×</span>)}
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-sm font-semibold text-best">{s.win}%</span>
                    <span className="block text-[10px] text-ink-500">winning chances</span>
                  </span>
                </button>
              ))}
            </div>
          </Card>
          {picked && (
            <Card className="p-4">
              <div className="pointer-events-none"><Board fen={picked.fen} orientation={picked.color} /></div>
              <div className="mt-3 text-sm">
                <div className="font-semibold">You're {picked.color === 'w' ? 'White' : 'Black'}, to move · {picked.win}% winning chances</div>
                <p className="mt-1 text-xs leading-relaxed text-ink-400">
                  In the game you then {END_TEXT[picked.end] ?? picked.end}{picked.outcome === 'loss' && picked.end !== 'checkmate' && picked.end !== 'resignation' ? ' and lost' : ''}.
                  The costly move: <b className="text-ink-200">{moveLabel(picked.threw.ply)}{picked.threw.san}</b>
                  {' '}<span style={{ color: CLS[picked.threw.cls]?.color }}>({CLS[picked.threw.cls]?.label ?? picked.threw.cls})</span>
                  {picked.threw.bestSan && <> – better was <b className="text-best">{picked.threw.bestSan}</b></>}.
                </p>
              </div>
              <Button variant="primary" className="mt-3 w-full" onClick={() => onPlay(picked)}><Play size={15} /> Play from here</Button>
              <button onClick={() => go(`/review/${picked.gameId}`)} className="mt-2 w-full text-center text-xs text-ink-400 hover:text-ink-200 cursor-pointer">
                Open the original game
              </button>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

/** Which gambits the bot may play: grouped by the colour the bot needs to have. */
function GambitPicker({ list, picked, onChange }: { list: NightmareGambit[] | null; picked: string[]; onChange: (ids: string[]) => void }) {
  if (!list) return <div className="mt-3 flex items-center gap-2 text-xs text-ink-400"><Spinner size={12} /> Loading gambits…</div>
  const toggle = (id: string) => onChange(picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id])
  return (
    <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
      {(['w', 'b'] as const).map(side => (
        <div key={side}>
          <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-500 uppercase">When the bot has {side === 'w' ? 'White' : 'Black'}</div>
          <div className="flex flex-wrap gap-1.5">
            {list.filter(g => g.bot === side).map(g => (
              <button key={g.id} type="button" onClick={() => toggle(g.id)} title={`Against ${g.against}: ${g.idea}`}
                className={clsx('rounded-lg px-2.5 py-1 text-xs ring-1 ring-inset transition-colors cursor-pointer',
                  picked.includes(g.id) ? 'bg-accent/15 text-accent ring-accent/40' : 'text-ink-300 ring-white/10 hover:bg-white/[0.05]')}>
                {g.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-ink-500">
        {picked.length ? `${picked.length} picked. ` : 'None picked yet – pick the ones you want to practise. '}
        If more than one fits a position, the bot picks one of them. Choose your colour so the gambit's side is the bot's.
      </p>
    </div>
  )
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 text-left cursor-pointer">
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink-200">{label}</span>
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
      <span className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-ink-600')}>
        <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]', on ? 'left-[18px]' : 'left-0.5')} />
      </span>
    </button>
  )
}

function Option({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-[13px]"><span className="font-medium text-ink-200">{label}</span>{hint && <span className="text-xs text-ink-500">{hint}</span>}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return <div><div className="text-xs text-ink-500">{label}</div><div className={clsx('font-display text-2xl font-semibold tabular-nums', color)}>{value}</div></div>
}

// --------------------------------------------------------------------------- //
//  Playing
// --------------------------------------------------------------------------- //

type Arrow = { orig: string; dest: string; brush: string }

/** The game as PGN – for the review and for the "Bot games" list. */
function gamePgn(game: Game, me: string) {
  const c = fenOf(game.moves, game.startFen)
  const oppName = `Nightmare (Maia ${game.level})`
  c.setHeader('Event', "Anne's Chess Kit: Nightmare")
  c.setHeader('Site', "Anne's Chess Kit (local)")
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'))
  c.setHeader('White', game.color === 'w' ? me : oppName)
  c.setHeader('Black', game.color === 'w' ? oppName : me)
  const res = !game.over ? '*' : game.over.result === 'draw' ? '1/2-1/2'
    : (game.over.result === 'win') === (game.color === 'w') ? '1-0' : '0-1'
  c.setHeader('Result', res)
  return c.pgn()
}

function PlayView({ game, setGame, onSummary, onExit }: {
  game: Game; setGame: React.Dispatch<React.SetStateAction<Game | null>>; onSummary: (s: NightmareSummary) => void
  /** Leave the board: back to the setup tab (or the Convert list) the game came from. */
  onExit: () => void
}) {
  const { settings } = useSettings()
  const gameRef = useRef(game)
  gameRef.current = game
  // Convert-your-wins games start from a position of yours; everything else from the normal start.
  const fenAt = (moves: string[]) => fenOf(moves, game.startFen)
  const firstColor: Color = (game.startFen?.split(' ')[1] as Color | undefined) ?? 'w'
  const startMove = game.startFen ? Number(game.startFen.split(' ')[5]) || 1 : 1
  const fbk = game.feedback
  const [checking, setChecking] = useState(0) // quick ratings in flight
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<number | null>(null) // ply being looked at; null = the live position
  const [arrows, setArrows] = useState<Arrow[]>([])
  // After the game: your own variation branching off the game at `base` (Lichess-style analysis).
  const [explore, setExplore] = useState<{ base: number; moves: string[]; sans: string[]; at: number } | null>(null)
  const [tab, setTab] = useState<'traps' | 'analyse'>('traps')
  // During the game: the analysis board is open and the bot waits (counts like a takeback).
  const [exploring, setExploring] = useState(false)
  const live = game.moves.length
  const shown = view == null ? live : Math.max(0, Math.min(live, view))
  const browsing = shown !== live
  const liveChess = useMemo(() => fenOf(game.moves, game.startFen), [game.moves, game.startFen])
  const shownChess = useMemo(() => {
    if (explore) return fenAt([...game.moves.slice(0, explore.base), ...explore.moves.slice(0, explore.at)])
    return browsing ? fenAt(game.moves.slice(0, shown)) : liveChess
  }, [explore, browsing, game.moves, shown, liveChess])
  const fen = liveChess.fen()
  const yourTurn = liveChess.turn() === game.color
  const lastShown = explore
    ? (explore.at > 0 ? explore.moves[explore.at - 1] : explore.base > 0 ? game.moves[explore.base - 1] : undefined)
    : shown > 0 ? game.moves[shown - 1] : undefined
  const busy = useRef(false)
  const opp: Color = game.color === 'w' ? 'b' : 'w'

  // A new move snaps the board back to the live position (like Lichess).
  useEffect(() => { setView(null); setArrows([]); setExplore(null) }, [live])
  useEffect(() => { if (!game.over) { setExplore(null); setTab('traps') } setExploring(false) }, [game.over])

  const goTo = useCallback((ply: number, withSound = true) => {
    setExplore(null)
    const p = Math.max(0, Math.min(live, ply))
    if (withSound && p > 0 && p !== shown) sound.move(fenAt(game.moves.slice(0, p)).history({ verbose: true }).at(-1)?.captured != null)
    setArrows([])
    setView(p >= live ? null : p)
  }, [live, shown, game.moves])

  // ← → step, ↑ / Home start, ↓ / End live.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (explore && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const at = explore.at + (e.key === 'ArrowLeft' ? -1 : 1)
        if (at < 0) goTo(explore.base, false)  // stepped back past the branch point: onto the game
        else if (at <= explore.moves.length) { setArrows([]); setExplore({ ...explore, at }) }
        return
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(shown - 1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(shown + 1) }
      else if (e.key === 'ArrowUp' || e.key === 'Home') { e.preventDefault(); goTo(0, false) }
      else if (e.key === 'ArrowDown' || e.key === 'End') { e.preventDefault(); goTo(live, false) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [goTo, shown, live, explore])

  const finish = useCallback(async (g: Game) => {
    const traps = g.decisions.filter(d => d.trap).length
    const fell = g.decisions.filter(d => d.fell).length
    if (g.over) {
      if (g.over.result === 'win') sound.success()
      else if (g.over.result === 'loss') sound.fail()
      const marks = Object.fromEntries(Object.entries(g.marks ?? {}).map(([p, m]) => [p, { uci: m.uci, cls: m.cls, loss: m.loss }]))
      api.nightmareFinish({ result: g.over.result, color: g.color, level: g.level, traps, fell, moves: Math.ceil(g.moves.length / 2),
        pgn: gamePgn(g, settings?.chesscom_username || settings?.lichess_username || 'You'),
        strength: g.strength, focus: FOCUS[g.focus] ?? 0, takebacks: g.takebacks ?? 0, practice: !!g.practice, marks,
        mode: g.convert ? 'convert' : 'game', spot: g.convert?.id, explored: !!g.explored })
        .then(r => {
          onSummary(r)
          const progress = r.progress
          if (progress) setGame(cur => (cur && cur.over && cur.moves.length === g.moves.length ? { ...cur, progress } : cur))
        })
        .catch(() => {})
    }
  }, [onSummary, settings, setGame])

  /** Rate a move with a quick search and keep the verdict with the game (if the game still has that move). */
  const markMove = useCallback((ply: number, fenBefore: string, uci: string, prevUci?: string, prevLoss?: number) => {
    const f = gameRef.current.feedback
    if (!f?.on) return
    setChecking(n => n + 1)
    api.check(fenBefore, uci, { depth: DEPTHS[f.depth] ?? 12, prevUci, prevLoss, book: true })
      .then(r => setGame(g => (g && g.moves[ply - 1] === uci
        ? { ...g, marks: { ...(g.marks ?? {}), [ply]: { uci, cls: r.cls, loss: r.loss, bestSan: r.bestSan, bestUci: r.bestUci, text: r.text, evalText: r.evalText } } }
        : g)))
      .catch(() => {})
      .finally(() => setChecking(n => n - 1))
  }, [setGame])

  // The bot's turn. (Runs again only when the moves change – not when a move rating arrives.)
  const movesKey = game.moves.join(' ')
  useEffect(() => {
    const g0 = gameRef.current
    if (g0.over || yourTurn || busy.current) return
    busy.current = true
    setThinking(true)
    const started = Date.now()
    let cancelled = false // abandoned / left the page while it was thinking
    api.nightmareMove(g0.moves, g0.strength, FOCUS[g0.focus] ?? FOCUS.balanced, { gambits: g0.gambits ?? [], variety: !!g0.variety, fen: g0.startFen })
      .then(async r => {
        await new Promise(res => setTimeout(res, Math.max(0, 650 - (Date.now() - started)))) // feels like thinking
        if (cancelled) return
        const game = gameRef.current
        const played = playUci(fen, r.uci)
        sound.move(played.capture)
        const moves = [...game.moves, played.uci]
        const next: Game = {
          ...game, moves, sans: [...game.sans, played.san], level: r.level,
          decisions: [...game.decisions, { ply: moves.length, san: played.san, uci: played.uci, trap: r.trap, opening: r.opening, gambit: r.gambit ?? null }],
        }
        next.over = outcome(fenAt(moves), game.color)
        setGame(next)
        // Rated too (needed to tell a "Miss" on your next move; shown if you asked for it, or after the game).
        markMove(moves.length, fen, played.uci, game.moves.at(-1), game.marks?.[game.moves.length]?.loss)
        if (next.over) void finish(next)
      })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
      .finally(() => { busy.current = false; setThinking(false) })
    return () => { cancelled = true; busy.current = false } // a re-run asks again instead of stalling
  }, [movesKey, game.over, yourTurn, fen, setGame, finish, markMove]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (uci: string) => {
    if (game.over || exploring) return exploreMove(uci)
    if (!yourTurn || thinking || browsing) return
    let played
    try { played = playUci(fen, uci) } catch { return }
    sound.move(played.capture)
    const moves = [...game.moves, played.uci]
    // Did you walk into the trap it just set?
    const decisions = game.decisions.map((d, i) => i === game.decisions.length - 1 && d.trap
      ? { ...d, reply: played.san, fell: d.trap.bad.some(b => b.uci === played.uci) } : d)
    const next: Game = { ...game, moves, sans: [...game.sans, played.san], decisions }
    next.over = outcome(fenAt(moves), game.color)
    setGame(next)
    markMove(moves.length, fen, played.uci, game.moves.at(-1), game.marks?.[game.moves.length]?.loss)
    if (next.over) void finish(next)
  }

  // The analysis board (after the game, or paused during it): try your own moves for either side.
  // Following the game's move just steps along it.
  const exploreMove = (uci: string) => {
    const from = shownChess.fen()
    let played
    try { played = playUci(from, uci) } catch { return }
    sound.move(played.capture)
    setArrows([])
    if (game.over) setTab('analyse')
    if (!explore) {
      if (game.moves[shown] === played.uci) { setView(shown + 1 >= live ? null : shown + 1); return }
      setExplore({ base: shown, moves: [played.uci], sans: [played.san], at: 1 })
      return
    }
    if (explore.moves[explore.at] === played.uci) { setExplore({ ...explore, at: explore.at + 1 }); return }
    setExplore({ base: explore.base, moves: [...explore.moves.slice(0, explore.at), played.uci],
      sans: [...explore.sans.slice(0, explore.at), played.san], at: explore.at + 1 })
  }

  // From the analysis board: keep playing the Nightmare from this position.
  const playOn = () => {
    const prefix = explore ? [...game.moves.slice(0, explore.base), ...explore.moves.slice(0, explore.at)] : game.moves.slice(0, shown)
    const sans = explore ? [...game.sans.slice(0, explore.base), ...explore.sans.slice(0, explore.at)] : game.sans.slice(0, shown)
    const c = fenAt(prefix)
    if (outcome(c, game.color)) return
    setGame({ ...game, moves: prefix, sans, decisions: game.decisions.filter(d => d.ply <= prefix.length && prefix.slice(0, d.ply).join() === game.moves.slice(0, d.ply).join()),
      marks: Object.fromEntries(Object.entries(game.marks ?? {}).filter(([p, m]) => Number(p) <= prefix.length && prefix[Number(p) - 1] === m.uci)),
      over: null, takebacks: game.takebacks ?? 0, practice: true }) // already counted once: not in your record again
  }

  // Pause the game and open the analysis board on the current position; the bot waits until you come back.
  const canExplore = !game.over && !thinking && yourTurn && !exploring
  const startExplore = () => {
    if (!canExplore) return
    setArrows([])
    setExploring(true)
    if (!game.explored) setGame({ ...game, explored: true })
  }
  const stopExplore = () => {
    setExploring(false)
    goTo(live, false)
  }

  // Take back your last move (and the Nightmare's answer to it).
  const firstMine = game.color === 'w' ? 0 : 1
  const canTakeBack = !game.over && !thinking && yourTurn && !exploring && live - 2 >= firstMine
  const takeBack = () => {
    if (!canTakeBack) return
    const keep = live - 2
    const decisions = game.decisions.filter(d => d.ply <= keep)
      .map((d, i, all) => (i === all.length - 1 ? { ...d, fell: undefined, reply: undefined } : d))
    const marks = Object.fromEntries(Object.entries(game.marks ?? {}).filter(([p]) => Number(p) <= keep))
    setGame({ ...game, moves: game.moves.slice(0, keep), sans: game.sans.slice(0, keep), decisions, marks, takebacks: (game.takebacks ?? 0) + 1 })
  }

  const resign = () => {
    const next: Game = { ...game, over: { result: 'loss', reason: 'resignation' } }
    setGame(next)
    void finish(next)
  }

  const pgn = () => gamePgn(game, settings?.chesscom_username || settings?.lichess_username || 'You')

  const review = () => startAnalysis({ pgn: pgn(), title: `You vs Nightmare (Maia ${game.level})`, source: 'nightmare' })

  // Debrief: show a trap on the board.
  const showTrap = (d: Decision) => {
    if (!d.trap) return
    if (d.fell && d.reply) {
      // After your losing reply: the punishment.
      const at = d.ply + 1
      const c = fenAt(game.moves.slice(0, at))
      const bad = d.trap.bad.find(b => b.san === d.reply) ?? d.trap.bad[0]
      let first = null
      try { first = bad?.punish?.[0] ? c.move(bad.punish[0]) : null } catch { /* a line that doesn't fit: no arrow */ }
      setView(at >= live ? null : at)
      setArrows(first ? [{ orig: first.from, dest: first.to, brush: 'blunder' }] : [])
    } else {
      setView(d.ply >= live ? null : d.ply)
      setArrows(d.trap.bad.map(b => ({ orig: b.uci.slice(0, 2), dest: b.uci.slice(2, 4), brush: 'blunder' })))
    }
  }

  const analysing = (!!game.over && tab === 'analyse') || exploring
  const [engine, setEngine] = useState<{ fen: string; eval: Eval; evalText: string; lines: EngineLine[]; over?: { text: string } | null } | null>(null)
  const shownFen = shownChess.fen()
  useEffect(() => {
    if (!analysing) return
    let alive = true
    const t = setTimeout(() => {
      api.lines(shownFen, 16, 3).then(r => { if (alive) setEngine({ fen: shownFen, ...r }) }).catch(() => {})
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [analysing, shownFen])
  const lines = engine?.fen === shownFen ? engine.lines : []
  const engineArrows: Arrow[] = analysing
    ? lines.slice(0, 2).map((l, i) => ({ orig: l.uci.slice(0, 2), dest: l.uci.slice(2, 4), brush: i === 0 ? 'engine' : 'engine2' }))
    : []
  const playLine = (l: EngineLine, all = false) => {
    // Play the line's first move – or the whole line – as a variation.
    let fen = shownFen
    const ucis: string[] = [], sans: string[] = []
    const c = new Chess(fen)
    for (const san of all ? l.line.slice(0, 10) : l.line.slice(0, 1)) {
      try { const m = c.move(san); ucis.push(m.from + m.to + (m.promotion ?? '')); sans.push(m.san) } catch { break }
    }
    fen = c.fen()
    if (!ucis.length) return
    sound.move(false)
    setArrows([])
    if (explore) setExplore({ base: explore.base, moves: [...explore.moves.slice(0, explore.at), ...ucis], sans: [...explore.sans.slice(0, explore.at), ...sans], at: explore.at + ucis.length })
    else setExplore({ base: shown, moves: ucis, sans, at: ucis.length })
  }

  const trapPlies = new Map(game.decisions.filter(d => d.trap).map(d => [d.ply, d]))
  // The gambit the bot is playing (its last move came from a gambit line).
  const activeGambit = game.decisions.at(-1)?.gambit ?? null
  // Which move ratings to show: yours always; the bot's after the game, or during it if you asked for that.
  const myPly = (ply: number) => (ply % 2 === 1) === (game.color === firstColor)
  const visibleMark = (ply: number): Mark | undefined => {
    const m = game.marks?.[ply]
    if (!m || game.moves[ply - 1] !== m.uci) return undefined
    return myPly(ply) || game.over || fbk?.botMoves ? m : undefined
  }
  const shownMark = !explore && shown > 0 ? visibleMark(shown) : undefined
  // Move number of a ply index (0 = the first move of this game), for games that start mid-game too.
  const moveNum = (i: number) => {
    const q = i + (firstColor === 'b' ? 1 : 0)
    return `${startMove + Math.floor(q / 2)}${q % 2 === 0 ? '.' : '…'}`
  }
  const badge = shownMark ? { square: shownMark.uci.slice(2, 4), cls: shownMark.cls, id: `${shown}-${shownMark.cls}` } : null
  const bestArrow: Arrow[] = shownMark && myPly(shown) && fbk?.showBest && BAD_CLASSES.has(shownMark.cls) && shownMark.bestUci !== shownMark.uci
    ? [{ orig: shownMark.bestUci.slice(0, 2), dest: shownMark.bestUci.slice(2, 4), brush: 'best' }] : []
  const lastMine = [...Array(live).keys()].map(i => i + 1).filter(myPly).at(-1)
  const lastMark = lastMine ? visibleMark(lastMine) : undefined
  const sideBar = (col: Color, name: string, icon: React.ReactNode, isThinking?: boolean) => (
    <div className="flex h-10 items-center gap-2 px-1 text-sm font-medium">
      {icon}<span>{name}</span>{isThinking && <Spinner size={13} />}
      <MaterialDiff fen={shownChess.fen()} color={col} className="ml-1.5" />
    </div>
  )

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 p-4 lg:flex-row lg:p-6">
      <div className="mx-auto w-full max-w-[calc(min(100%,calc(100vh-150px))*var(--board-zoom,1))] lg:mx-0">
        {sideBar(opp, game.focus === 'off' ? `Maia ${game.level}` : `Nightmare · Maia ${game.level}`,
          game.focus === 'off' ? <Bot size={15} className="text-accent" /> : <Skull size={15} className="text-blunder" />, thinking)}
        <div className="relative flex gap-2">
          {analysing && <div className="w-3 shrink-0 sm:w-4"><EvalBar ev={engine?.eval ?? { cp: 0 }} orientation={game.color} /></div>}
          <div className={clsx('board-frame aspect-square w-full min-w-0 transition', browsing && !game.over && !exploring && 'opacity-90')}>
            <Board wheelSteps resizable fen={shownChess.fen()} orientation={game.color} movable={game.over || exploring ? true : yourTurn && !thinking && !browsing}
              premove={game.over || exploring || browsing ? undefined : game.color}
              lastMove={lastShown ? uciSquares(lastShown) : null} onMove={onMove}
              lastMoveColor={shownMark ? CLS[shownMark.cls].color : undefined} badge={badge}
              shapes={(arrows.length ? arrows : engineArrows.length ? engineArrows : bestArrow).map(a => ({ orig: a.orig as never, dest: a.dest as never, brush: a.brush }))} />
          </div>
          <AnimatePresence>
            {browsing && !game.over && !exploring && (
              <motion.button initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                onClick={() => goTo(live, false)}
                className="popover absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-3.5 py-1.5 text-xs font-medium whitespace-nowrap text-ink-100 cursor-pointer">
                Viewing move {Math.ceil(shown / 2)} · back to the game <span className="text-ink-500">(↓)</span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        {sideBar(game.color, 'You', <span className={clsx('size-3 rounded-full ring-1 ring-white/30', game.color === 'w' ? 'bg-white' : 'bg-ink-950')} />)}
      </div>

      <Card className="flex min-h-[420px] w-full flex-col p-5 lg:max-w-[420px]">
        {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
        {game.over && (
          <div className="mb-4 flex items-center justify-between gap-2">
            <Segmented value={tab} onChange={v => { setTab(v); setArrows([]) }} options={[
              { value: 'traps', label: <><Target size={14} /> Traps</> },
              { value: 'analyse', label: <><Cpu size={14} /> Analyse</> },
            ]} />
            <span className="text-xs text-ink-500">{tab === 'analyse' ? 'move any piece to try a line' : ''}</span>
          </div>
        )}
        {exploring && (
          <div className="mb-3 rounded-xl bg-accent/[0.07] px-3 py-2 text-[13px] ring-1 ring-inset ring-accent/25">
            <span className="font-semibold text-accent">Game paused.</span>
            <span className="text-ink-300"> Try moves for either side and see what the engine answers. The bot waits until you go back.
              {(game.takebacks ?? 0) === 0 && ' Exploring counts like a takeback: this game earns half XP.'}</span>
          </div>
        )}
        {analysing ? (
          <AnalysisPanel engine={engine?.fen === shownFen ? engine : null} lines={lines} onPlay={playLine}
            explore={explore} gameSans={game.sans} shown={shown} moveNum={moveNum}
            onStep={at => { setArrows([]); setExplore(e => (e ? { ...e, at } : e)) }}
            onLeave={() => goTo(explore?.base ?? shown, false)} onPlayOn={exploring ? undefined : playOn} />
        ) : game.over ? (
          <Debrief game={game} onReview={review} onShow={t => { setTab('traps'); setExplore(null); showTrap(t) }}
            onExplore={() => { setArrows([]); setTab('analyse') }}
            onRematch={() => setGame({ ...game, moves: [], sans: [], decisions: [], marks: {}, over: null, takebacks: 0, explored: false, practice: false, progress: undefined,
              color: game.convert ? game.color : game.color === 'w' ? 'b' : 'w' })}
            onExit={onExit} />
        ) : (
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">{thinking ? 'The bot is thinking…' : yourTurn ? 'Your move' : ''}</h2>
            <span className="text-xs text-ink-500">
              {game.practice && <span className="mr-2 rounded bg-white/[0.06] px-1.5 py-0.5 text-ink-300" title="Continued from the analysis board – not counted in your record">practice</span>}
              {game.focus === 'off' ? 'Maia' : `Nightmare · ${FOCUS_LABEL[game.focus] ?? 'Sneaky'}`}
            </span>
          </div>
        )}
        {!game.over && !exploring && game.convert && (
          <div className="mt-2 rounded-xl bg-best/[0.07] px-3 py-2 text-[13px] ring-1 ring-inset ring-best/25">
            <span className="font-semibold text-best">Convert this win.</span>
            <span className="text-ink-300"> You were {game.convert.win}% to win against {game.convert.opponent} ({game.convert.date}) – and lost. Finish it this time.</span>
          </div>
        )}
        {!game.over && !exploring && activeGambit && (
          <div className="mt-2 rounded-xl bg-accent/[0.07] px-3 py-2 text-[13px] ring-1 ring-inset ring-accent/25">
            <span className="font-semibold text-accent">{activeGambit.name}</span>
            <span className="text-ink-300"> – {activeGambit.idea}</span>
          </div>
        )}
        {!game.over && !exploring && fbk?.on && <LiveFeedback mark={lastMark} checking={checking > 0 && !lastMark} ply={lastMine} showBest={fbk.showBest} />}
        {!game.over && !exploring && !fbk?.on && game.focus !== 'off' && <p className="mt-1 text-sm text-ink-400">Traps stay hidden until the game is over. Check every capture and check before you move.</p>}

        <MoveList sans={game.sans} shown={explore ? explore.base : shown} onPick={p => goTo(p)} traps={game.over ? trapPlies : undefined} dim={!!explore}
          start={{ color: firstColor, move: startMove }}
          marks={visibleMark} />
        <NavBar shown={shown} live={live} goTo={goTo} />

        {exploring && (
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            <Button variant="primary" onClick={stopExplore}><Play size={14} /> Back to the game</Button>
          </div>
        )}
        {!game.over && !exploring && (
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            <Button onClick={takeBack} disabled={!canTakeBack} title="Take back your last move"><Undo2 size={14} /> Take back</Button>
            <Button onClick={startExplore} disabled={!canExplore}
              title="Pause and try moves on an analysis board with the engine. Counts like a takeback (half XP)."><Microscope size={14} /> Explore</Button>
            <Button variant="danger" onClick={resign} disabled={thinking}><Flag size={14} /> Resign</Button>
            <Button variant="ghost" onClick={onExit} title="End this game without scoring it">Abandon</Button>
            {(game.takebacks ?? 0) > 0 && <span className="ml-auto self-center text-xs text-ink-500">{game.takebacks} takeback{game.takebacks === 1 ? '' : 's'}</span>}
          </div>
        )}
      </Card>
    </div>
  )
}

/** Under the board while you play: the verdict on your last move, as soon as the quick search has it. */
function LiveFeedback({ mark, checking, ply, showBest }: { mark?: Mark; checking: boolean; ply?: number; showBest: boolean }) {
  if (!ply) return <p className="mt-1 text-sm text-ink-400">Make your first move – each one gets rated right away.</p>
  if (!mark) {
    return (
      <div className="mt-2 flex h-[52px] items-center gap-2 text-sm text-ink-400">
        {checking ? <><Spinner size={14} /> Checking your move…</> : 'No rating for this move.'}
      </div>
    )
  }
  const meta = CLS[mark.cls]
  const bad = BAD_CLASSES.has(mark.cls)
  return (
    <motion.div key={`${ply}-${mark.cls}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      className="mt-2 rounded-xl p-3 ring-1 ring-inset" style={{ background: `${meta.color}14`, boxShadow: `inset 0 0 0 1px ${meta.color}40` }}>
      <div className="flex items-center gap-2">
        <ClassIcon cls={mark.cls} size={20} />
        <span className="font-display text-[15px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
        <span className="ml-auto font-mono text-xs text-ink-400" title="Evaluation after your move">{mark.evalText}</span>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-ink-200">{mark.text}</p>
      {bad && showBest && mark.bestSan && <p className="mt-1 text-xs text-ink-400">Better was <b className="text-best">{mark.bestSan}</b> (green arrow).</p>}
    </motion.div>
  )
}

function NavBar({ shown, live, goTo }: { shown: number; live: number; goTo: (p: number, s?: boolean) => void }) {
  const btn = 'flex h-9 flex-1 items-center justify-center rounded-[10px] bg-white/[0.04] text-ink-300 ring-1 ring-inset ring-white/[0.06] transition hover:bg-white/[0.08] hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer'
  return (
    <div className="mt-2 flex gap-1.5">
      <button className={btn} onClick={() => goTo(0, false)} disabled={shown === 0} title="Start (↑)"><ChevronsLeft size={17} /></button>
      <button className={btn} onClick={() => goTo(shown - 1)} disabled={shown === 0} title="Back (←)"><ChevronLeft size={17} /></button>
      <button className={btn} onClick={() => goTo(shown + 1)} disabled={shown >= live} title="Forward (→)"><ChevronRight size={17} /></button>
      <button className={btn} onClick={() => goTo(live, false)} disabled={shown >= live} title="Live position (↓)"><ChevronsRight size={17} /></button>
    </div>
  )
}

function MoveList({ sans, shown, onPick, traps, dim, marks, start = { color: 'w', move: 1 } }: {
  sans: string[]; shown: number; onPick: (ply: number) => void; traps?: Map<number, Decision>; dim?: boolean
  marks?: (ply: number) => Mark | undefined
  /** Who moves first and the move number – for games from a set-up position. */
  start?: { color: Color; move: number }
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[data-current="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
    else if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown, sans.length])
  // With Black to move first, the first row is "31. … Qd3": shift every ply by one.
  const shift = start.color === 'b' ? 1 : 0
  const rows: number[] = []
  for (let i = 0; i < sans.length + shift; i += 2) rows.push(i)
  const cell = (slot: number) => {
    const ply = slot - shift
    if (ply < 1) return <span className="px-1.5 text-ink-500">…</span>
    if (ply > sans.length) return <span />
    const t = traps?.get(ply)
    const fellNext = traps?.get(ply - 1)?.fell
    const m = marks?.(ply)
    const special = m && (BAD_CLASSES.has(m.cls) || m.cls === 'brilliant' || m.cls === 'great')
    return (
      <button data-current={ply === shown} onClick={() => onPick(ply)} title={m ? CLS[m.cls].label : undefined}
        className={clsx('flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors cursor-pointer',
          ply === shown ? (dim ? 'bg-white/[0.05] text-ink-200 ring-1 ring-inset ring-accent/30' : 'bg-white/[0.1] text-white') : 'text-ink-200 hover:bg-white/[0.05]',
          fellNext && 'text-[#ff8796]')}
        style={special ? { color: CLS[m.cls].color } : undefined}>
        {m && <ClassIcon cls={m.cls} size={13} />}
        {sans[ply - 1]}
        {t && <Target size={11} className={t.fell ? 'text-blunder' : 'text-ink-500'} />}
      </button>
    )
  }
  return (
    <div ref={box} className="mt-4 max-h-[300px] min-h-[120px] overflow-y-auto rounded-xl bg-black/20 p-1.5 font-mono text-[13px] ring-1 ring-inset ring-white/[0.05]">
      {rows.length === 0 && <div className="p-2 text-ink-500">No moves yet.</div>}
      {rows.map(i => (
        <div key={i} className="grid grid-cols-[2.25rem_1fr_1fr] items-center gap-0.5">
          <span className="pl-1.5 text-ink-500">{i / 2 + start.move}.</span>{cell(i + 1)}{cell(i + 2)}
        </div>
      ))}
    </div>
  )
}

function Debrief({ game, onReview, onRematch, onExit, onShow, onExplore }:
  { game: Game; onReview: () => void; onRematch: () => void; onExit: () => void; onShow: (d: Decision) => void; onExplore: () => void }) {
  const traps = game.decisions.filter(d => d.trap)
  const fell = traps.filter(d => d.fell)
  const steered = game.decisions.filter(d => d.opening)
  const over = game.over!
  const moveNo = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'}`
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col">
      <div className={clsx('font-display text-2xl font-semibold', over.result === 'win' ? 'text-best' : over.result === 'loss' ? 'text-blunder' : '')}>
        {game.convert ? (over.result === 'win' ? 'Converted – you won it this time!' : over.result === 'draw' ? 'Draw – half a point back' : 'Slipped away again')
          : over.result === 'win' ? (game.focus === 'off' ? 'You won!' : 'You beat your nightmare!')
          : over.result === 'loss' ? (game.focus === 'off' ? 'The bot won' : 'The nightmare got you') : 'Draw'}
      </div>
      <div className="text-sm text-ink-400">
        by {over.reason} · {Math.ceil(game.moves.length / 2)} moves{(game.takebacks ?? 0) > 0 && ` · ${game.takebacks} takeback${game.takebacks === 1 ? '' : 's'}`}{game.explored && ' · explored'}
      </div>
      {game.convert && (
        <div className="mt-1 text-xs text-ink-400">
          From your game against {game.convert.opponent} ({game.convert.date}) –{' '}
          <button onClick={() => go(`/review/${game.convert!.gameId}`)} className="text-accent hover:underline cursor-pointer">open the original review</button>
        </div>
      )}
      {!game.practice && <GameXp result={game.progress} pending />}

      <div className="mt-4 flex gap-6">
        <div><div className="text-xs text-ink-500">Traps set</div><div className="font-display text-2xl font-semibold">{traps.length}</div></div>
        <div><div className="text-xs text-ink-500">You fell for</div><div className={clsx('font-display text-2xl font-semibold', fell.length ? 'text-blunder' : 'text-best')}>{fell.length}</div></div>
        <div><div className="text-xs text-ink-500">Openings steered</div><div className="font-display text-2xl font-semibold">{steered.length}</div></div>
      </div>

      <div className="mt-3 max-h-[260px] space-y-2 overflow-y-auto pr-1">
        {traps.length === 0 && steered.length === 0 && <p className="text-sm text-ink-400">It didn't find a trap worth setting this game.</p>}
        {steered.slice(0, 2).map(d => (
          <div key={`o${d.ply}`} className="rounded-xl bg-white/[0.03] p-3 text-sm ring-1 ring-inset ring-white/[0.06]">
            <div className="flex items-center gap-2 font-medium"><Swords size={14} className="text-book" /> {moveNo(d.ply)} {d.san} – a line you know badly</div>
            <div className="mt-1 text-xs text-ink-400">You reached this position in {d.opening!.games} games and went wrong {Math.round(d.opening!.extra * 100)}% more often than usual.</div>
          </div>
        ))}
        {traps.map(d => {
          const worst = [...d.trap!.bad].sort((a, b) => b.prob - a.prob)[0]
          return (
            <button key={d.ply} onClick={() => onShow(d)} title="Show on the board"
              className={clsx('block w-full rounded-xl p-3 text-left text-sm ring-1 ring-inset transition cursor-pointer',
                d.fell ? 'bg-blunder/[0.08] ring-blunder/25 hover:bg-blunder/[0.12]' : 'bg-white/[0.03] ring-white/[0.06] hover:bg-white/[0.06]')}>
              <div className="flex items-center gap-2 font-medium">
                {d.fell ? <TriangleAlert size={14} className="text-blunder" /> : <Sparkles size={14} className="text-best" />}
                {moveNo(d.ply)} {d.san} <span className={clsx('ml-auto text-xs', d.fell ? 'text-[#ff8796]' : 'text-best')}>{d.fell ? `you played ${d.reply}` : d.reply ? `dodged with ${d.reply}` : 'dodged'}</span>
              </div>
              <div className="mt-1 text-xs text-ink-400">
                The trap: <b className="text-ink-200">{d.trap!.bad.map(b => b.san).join(' / ')}</b>
                {worst?.label && <> loses to a {worst.label.toLowerCase()}</>}
                {(worst?.punish?.length ?? 0) > 0 && <> ({worst.punish.slice(0, 3).join(' ')})</>}.
                {worst && <>{' '}A player at your level picks {worst.san} {Math.round(worst.prob * 100)}% of the time.</>}
              </div>
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onReview}><Microscope size={15} /> Review this game</Button>
        <Button onClick={onExplore} title="Step through the game and try other moves with the engine"><Cpu size={14} /> Explore variations</Button>
        <Button onClick={onRematch}><RotateCcw size={14} /> {game.convert ? 'Try this position again' : 'Rematch'}</Button>
        <Button variant="ghost" onClick={onExit}><ArrowLeft size={14} /> {game.convert ? 'Back to the list' : 'Back to setup'}</Button>
      </div>
    </motion.div>
  )
}

function AnalysisPanel({ engine, lines, onPlay, explore, gameSans, shown, moveNum, onStep, onLeave, onPlayOn }: {
  engine: { eval: Eval; evalText: string; over?: { text: string } | null } | null; lines: EngineLine[]; onPlay: (l: EngineLine, all?: boolean) => void
  explore: { base: number; moves: string[]; sans: string[]; at: number } | null; gameSans: string[]; shown: number
  moveNum: (ply: number) => string
  onStep: (at: number) => void; onLeave: () => void; onPlayOn?: () => void
}) {
  const base = explore ? explore.base : shown
  const num = moveNum
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold">Stockfish</h2>
        <span className="font-mono text-xl font-semibold tabular-nums">{engine ? engine.evalText : <Spinner size={14} />}</span>
      </div>
      <div className="mt-2 space-y-1">
        {!engine && [0, 1, 2].map(i => <div key={i} className="skeleton h-9" />)}
        {engine && lines.length === 0 && (
          <div className="rounded-lg bg-white/[0.03] px-3 py-2.5 text-sm text-ink-200 ring-1 ring-inset ring-white/[0.05]">
            {engine.over?.text ?? 'Game over – no legal moves.'}
          </div>
        )}
        {lines.map((l, i) => (
          <div key={l.uci} className="group flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 ring-1 ring-inset ring-white/[0.05] hover:bg-white/[0.06]">
            <span className={clsx('w-14 shrink-0 rounded-md px-1.5 py-0.5 text-center font-mono text-xs font-semibold',
              i === 0 ? 'bg-accent/15 text-accent' : 'bg-white/[0.06] text-ink-200')}>{l.evalText}</span>
            <button onClick={() => onPlay(l)} title="Play this move" className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-ink-200 cursor-pointer">
              <b className="text-white">{l.san}</b> {l.line.slice(1, 8).join(' ')}
            </button>
            <button onClick={() => onPlay(l, true)} title="Play the whole line"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-ink-500 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08] hover:text-white cursor-pointer">line ▸</button>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl bg-black/20 p-3 ring-1 ring-inset ring-white/[0.05]">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-500 uppercase">
          <GitBranch size={13} /> {explore ? 'Your variation' : 'Game position'}
        </div>
        {explore ? (
          <div className="flex flex-wrap gap-x-1 gap-y-0.5 font-mono text-[13px]">
            <span className="text-ink-500">{base > 0 ? `${gameSans.slice(Math.max(0, base - 1), base).join('')} →` : 'start →'}</span>
            {explore.sans.map((san, i) => {
              const ply = base + i
              return (
                <button key={i} onClick={() => onStep(i + 1)}
                  className={clsx('rounded px-1 cursor-pointer', i + 1 === explore.at ? 'bg-accent/20 text-white' : 'text-ink-200 hover:bg-white/[0.06]')}>
                  {(i === 0 || num(ply).endsWith('.')) && <span className="text-ink-500">{num(ply)}</span>}{san}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-ink-400">Move any piece – for either side – to try an alternative. Click a Stockfish line to play it.</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {explore && <Button size="sm" onClick={onLeave}><X size={13} /> {onPlayOn ? 'Back to the game' : 'Back to the game position'}</Button>}
        {onPlayOn && <Button size="sm" variant="soft" onClick={onPlayOn} title="Continue against the bot from this position"><Bot size={13} /> Play on vs the bot</Button>}
      </div>
    </div>
  )
}
