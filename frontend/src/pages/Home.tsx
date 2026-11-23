import clsx from 'clsx'
import { motion } from 'motion/react'
import { ArrowRight, Bot, Check, CircleHelp, FileUp, Flame, Globe, GraduationCap, Layers, Rabbit, SlidersHorizontal, Sparkles, Trophy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BotGames } from '../components/BotGames'
import { openHelp } from '../components/HelpDialog'
import { LibraryImport } from '../components/LibraryImport'
import { LoadingNotice } from '../components/LoadingNotice'
import { QueuePanel } from '../components/QueuePanel'
import { Button, Card, ErrorNote, Segmented, Spinner, inputCls } from '../components/ui'
import { api } from '../lib/api'
import { ClassIcon } from '../lib/classes'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import { enqueue, openSettings, startAnalysis, toast, useQueue, useReviewsTick, useSettings } from '../lib/store'
import type { GameSummary, ParsedGame, QueueGameIn, QueueJob, SystemInfo } from '../lib/types'

type Source = 'online' | 'bots' | 'pgn'

// Quick choices next to "Analyze"; the Settings dialog has the full range (and the CPU use).
const DEPTHS = [
  { value: 12, label: <span title="Quickest – fine for a first look"><Rabbit size={14} className="mr-1 inline" />Quick</span> },
  { value: 16, label: <span title="Recommended"><Sparkles size={14} className="mr-1 inline" />Normal</span> },
  { value: 20, label: <span title="Slower, a little more precise"><Flame size={14} className="mr-1 inline" />Thorough</span> },
]
const TIMES = [
  { value: 0.5, label: <><Rabbit size={14} /> 0.5 s</> },
  { value: 1, label: <><Sparkles size={14} /> 1 s</> },
  { value: 3, label: <><Flame size={14} /> 3 s</> },
]

/** Fast / Standard / Deep (or the time per move), plus whatever custom value Settings holds. */
function AnalysisPicker() {
  const { settings, update } = useSettings()
  if (!settings) return null
  const timed = settings.analysis_mode === 'time'
  const value = timed ? settings.move_time : settings.depth
  const base = timed ? TIMES : DEPTHS
  const options = base.some(o => o.value === value) ? base
    : [...base, { value, label: <>{timed ? `${value} s` : `Depth ${value}`}</> }]
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs font-medium uppercase tracking-wide text-ink-400 sm:inline" title="How carefully the computer checks each move">{timed ? 'Time per move' : 'Analysis'}</span>
      <Segmented value={value} onChange={v => void update(timed ? { move_time: v } : { depth: v })} options={options} />
      <Button variant="ghost" size="sm" onClick={openSettings} title="More analysis settings" aria-label="More analysis settings">
        <SlidersHorizontal size={15} />
      </Button>
    </div>
  )
}

interface Actions {
  analyze: (g: QueueGameIn) => void
  batch: (gs: QueueGameIn[]) => Promise<void>
}

export function Home() {
  const [source, setSource] = useState<Source>('online')
  const { settings } = useSettings()
  const [recent, setRecent] = useState<GameSummary[]>([])
  const tick = useReviewsTick()
  const [system, setSystem] = useState<SystemInfo | null>(null)
  useEffect(() => { api.system().then(setSystem).catch(() => {}) }, [])
  // First start of the single-file app: the engines are being unpacked – ask again until they're ready.
  useEffect(() => {
    if (!system?.preparing) return
    const t = setTimeout(() => { api.system().then(setSystem).catch(() => {}) }, 1500)
    return () => clearTimeout(t)
  }, [system])
  // Refresh the "recently reviewed" grid as queued games finish.
  useEffect(() => {
    api.games(6).then(setRecent).catch(() => {})
  }, [tick])

  const actions: Actions = {
    // No depth here: the server uses the analysis settings (depth or time per move).
    analyze: g => void startAnalysis(g),
    batch: async gs => {
      if (!gs.length) return
      const jobs = await enqueue(gs)
      const fresh = jobs.filter(j => j.status === 'queued' || j.status === 'running').length
      toast({ title: `Queued ${fresh} game${fresh === 1 ? '' : 's'}`, body: fresh < gs.length ? `${gs.length - fresh} already reviewed` : 'They\'ll be analysed in the background.' })
    },
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-8 lg:py-12">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="mb-7">
        <h1 className="font-display text-[34px] leading-[1.1] font-semibold sm:text-[44px]">
          Review your games. <span className="text-gradient">Learn from your mistakes.</span>
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-400">
          Load your games from Chess.com or Lichess, let the computer check every move, then practise what you got wrong.
          Free, no account needed – everything runs on your computer.
        </p>
      </motion.div>

      <GettingStarted hasAccount={!!(settings?.chesscom_username || settings?.lichess_username)} recent={recent} />
      {recent.length > 0 && <NextSteps latest={recent[0]} />}

      {system?.preparing && (
        <LoadingNotice compact className="mb-6" title="Getting the chess engines ready" tasks={['engines']}
          note="This happens once, on the first start. Reviews and training can start as soon as it's done." />
      )}
      {system && !system.preparing && !system.engine && <EngineMissing dir={system.engineDir} />}

      <Card className="p-5 sm:p-6">
        <div className="mb-4">
          <h2 className="font-display text-lg font-semibold">Your games</h2>
          <p className="text-xs text-ink-400">Pick games to analyze, or open the ones you've already analyzed.</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented value={source} onChange={setSource} options={[
            { value: 'online', label: <><Globe size={14} /> Chess.com &amp; Lichess</> },
            { value: 'bots', label: <><Bot size={14} /> Bot games</> },
            { value: 'pgn', label: <><FileUp size={14} /> PGN file</> },
          ]} />
          <AnalysisPicker />
        </div>

        <div className="mt-5">
          {source === 'pgn' ? <PgnImport actions={actions} />
            : source === 'bots' ? <BotGames />
            : <LibraryImport />}
        </div>
      </Card>

      <div className="mt-6"><QueuePanel /></div>

      {recent.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-xl font-semibold">Your latest reviews</h2>
            <Button variant="ghost" size="sm" onClick={() => go('/progress')}>All games <ArrowRight size={14} /></Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recent.slice(0, 6).map((g, i) => <RecentCard key={g.id} g={g} i={i} />)}
          </div>
        </section>
      )}
    </div>
  )
}

const STARTED_KEY = 'brilliant.gettingStartedHidden'
export const OPENED_REVIEW_KEY = 'brilliant.openedReview'
const readFlag = (k: string) => { try { return localStorage.getItem(k) === '1' } catch { return false } }

/** For new users: the three steps, ticked off as they're done; hides itself once all are done (or on request). */
function GettingStarted({ hasAccount, recent }: { hasAccount: boolean; recent: GameSummary[] }) {
  const [hidden, setHidden] = useState(() => readFlag(STARTED_KEY))
  const opened = readFlag(OPENED_REVIEW_KEY)
  const steps = [
    { done: hasAccount, title: 'Load your games', text: 'Type your Chess.com or Lichess username below and press Load.' },
    { done: recent.length > 0, title: 'Analyze some games', text: 'Tick a few games in the list (or use “Analyze the newest”) – about a minute each.' },
    { done: opened, title: 'Open a review', text: 'See every move rated and the moves you should have played.' },
  ]
  if (hidden || steps.every(s => s.done)) return null
  const hide = () => { setHidden(true); try { localStorage.setItem(STARTED_KEY, '1') } catch { /* private mode */ } }
  return (
    <Card className="mb-6 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">Getting started</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={openHelp}><CircleHelp size={14} /> How it works</Button>
          <Button variant="ghost" size="sm" onClick={hide}>Hide</Button>
        </div>
      </div>
      <ol className="mt-3 grid gap-3 sm:grid-cols-3">
        {steps.map((st, i) => (
          <li key={st.title} className={clsx('flex gap-3 rounded-xl p-3 ring-1 ring-inset', st.done ? 'bg-best/[0.06] ring-best/20' : 'bg-white/[0.02] ring-white/[0.06]')}>
            <span className={clsx('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
              st.done ? 'bg-best text-ink-950' : 'bg-accent/15 text-accent')}>
              {st.done ? <Check size={13} strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0">
              <div className={clsx('text-sm font-semibold', st.done ? 'text-ink-300 line-through decoration-ink-500' : 'text-ink-100')}>{st.title}</div>
              <div className="mt-0.5 text-xs leading-snug text-ink-400">{st.text}</div>
              {i === 2 && !st.done && recent[0] && (
                <button onClick={() => go(`/review/${recent[0].id}`)} className="mt-1.5 text-xs font-semibold text-accent hover:underline cursor-pointer">
                  Open your latest review →
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

/** Three big, obvious next steps once you have reviews. */
function NextSteps({ latest }: { latest: GameSummary }) {
  const items = [
    { icon: <Trophy size={18} />, title: 'Review your last game', text: `${latest.white} vs ${latest.black}`, to: `/review/${latest.id}` },
    { icon: <GraduationCap size={18} />, title: 'Today’s training', text: 'What to practise, picked from your games', to: '/coach' },
    { icon: <Bot size={18} />, title: 'Play a practice game', text: 'Against a human-like bot, with live tips', to: '/nightmare' },
  ]
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-3">
      {items.map(it => (
        <button key={it.title} onClick={() => go(it.to)}
          className="glass group flex items-center gap-3 rounded-2xl p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-white/[0.14] cursor-pointer">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/25">{it.icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-100">{it.title}</span>
            <span className="block truncate text-xs text-ink-400">{it.text}</span>
          </span>
          <ArrowRight size={16} className="shrink-0 text-ink-500 transition group-hover:translate-x-0.5 group-hover:text-ink-200" />
        </button>
      ))}
    </div>
  )
}

/** First start without Stockfish: nothing can be analysed yet, so say exactly what to do. */
function EngineMissing({ dir }: { dir?: string }) {
  return (
    <div role="alert" className="mb-6 rounded-2xl bg-mistake/10 p-5 text-sm ring-1 ring-inset ring-mistake/30">
      <div className="font-display text-base font-semibold text-mistake">Stockfish isn't installed yet</div>
      <p className="mt-1.5 leading-relaxed text-ink-200">
        This app needs the free Stockfish engine to analyse games. Download it from{' '}
        <a className="text-accent underline underline-offset-2" href="https://stockfishchess.org/download/" target="_blank" rel="noreferrer">stockfishchess.org/download</a>,
        unpack it and put the program into the app's engine folder,{' '}
        <code className="rounded bg-black/30 px-1 break-all">{dir ?? 'engine'}</code> (any name starting with
        “stockfish” works), then restart the app. Already have it installed? It's used
        automatically if it's on your PATH, or set <code className="rounded bg-black/30 px-1">STOCKFISH_PATH</code>.
      </p>
    </div>
  )
}

function RecentCard({ g, i }: { g: GameSummary; i: number }) {
  const me = g.me ?? 'w'
  const acc = g.accuracy[me]
  const c = g.counts[me]
  return (
    <motion.button initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
      onClick={() => go(`/review/${g.id}`)}
      className="glass group flex flex-col gap-3 rounded-2xl p-4 text-left transition duration-200 hover:-translate-y-0.5 hover:border-white/[0.14] cursor-pointer">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{g.white} <span className="text-ink-400">vs</span> {g.black}</div>
          <div className="truncate text-xs text-ink-400">{Math.ceil(g.plies / 2)} moves · {g.opening?.name ?? g.date ?? ''}</div>
        </div>
        <ResultPill result={g.result} me={g.me} />
      </div>
      <div className="flex items-end justify-between">
        <div>
          <div className="font-display text-[30px] leading-tight font-semibold tabular-nums" style={{ color: accuracyColor(acc) }}>{acc?.toFixed(1) ?? '—'}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{g.me ? 'Your accuracy' : 'White accuracy'}</div>
        </div>
        <div className="flex gap-2">
          {(['brilliant', 'great', 'blunder'] as const).map(k => (c[k] ?? 0) > 0 && (
            <span key={k} className="flex items-center gap-1 text-sm font-bold"><ClassIcon cls={k} size={18} />{c[k]}</span>
          ))}
        </div>
      </div>
    </motion.button>
  )
}

export function ResultPill({ result, me }: { result: string; me: 'w' | 'b' | null }) {
  let label = result, cls = 'bg-ink-600 text-ink-200'
  if (me && (result === '1-0' || result === '0-1')) {
    const won = (result === '1-0') === (me === 'w')
    label = won ? 'Won' : 'Lost'
    cls = won ? 'bg-best/15 text-best' : 'bg-blunder/15 text-blunder'
  } else if (result === '1/2-1/2') { label = 'Draw'; cls = 'bg-ink-600 text-ink-200' }
  return <span className={clsx('shrink-0 rounded-md px-2 py-0.5 text-xs font-medium', cls)}>{label}</span>
}

// --------------------------------------------------------------------------- //

function GameStatus({ job, analysedId, onAnalyze }: { job?: QueueJob; analysedId: string | null; onAnalyze: () => void }) {
  const reviewId = job?.status === 'done' ? job.gameId : analysedId
  if (job?.status === 'running') {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
    return <span className="flex h-8 w-24 items-center justify-center gap-2 text-xs font-bold text-accent"><Spinner size={14} /> {pct}%</span>
  }
  if (job?.status === 'queued') return <span className="flex h-8 w-24 items-center justify-center text-xs font-semibold text-ink-400">Queued…</span>
  if (reviewId) {
    const acc = job?.summary?.accuracy
    return (
      <Button size="sm" variant="soft" onClick={() => go(`/review/${reviewId}`)}>
        <Trophy size={14} /> Review
        {acc != null && <span className="font-display font-semibold" style={{ color: accuracyColor(acc) }}>{acc.toFixed(0)}</span>}
      </Button>
    )
  }
  return <Button size="sm" variant="soft" onClick={onAnalyze}><Sparkles size={14} className="text-accent" /> Analyze</Button>
}

function PgnImport({ actions }: { actions: Actions }) {
  const [text, setText] = useState('')
  const [games, setGames] = useState<ParsedGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState(false)
  const queue = useQueue()

  const toQueue = (g: ParsedGame, i: number): QueueGameIn => ({
    pgn: g.pgn, source: 'pgn', title: `${g.white} vs ${g.black}`, url: `pgn:${i}:${g.white}:${g.black}:${g.date}:${g.plies}`,
  })

  const parse = async (pgn = text) => {
    if (!pgn.trim()) return
    setLoading(true); setError(null)
    try {
      const list = await api.parsePgn(pgn)
      if (list.length === 1 && !list[0].analysedId) actions.analyze(toQueue(list[0], 0))
      else setGames(list)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }

  const readFile = async (f: File) => {
    const t = await f.text()
    setText(t)
    void parse(t)
  }

  const jobFor = (g: ParsedGame, i: number) => queue.find(j => j.url === toQueue(g, i).url)
  const pending = games?.map((g, i) => [g, i] as const).filter(([g, i]) => !g.analysedId && !jobFor(g, i)) ?? []

  return (
    <div>
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void readFile(f) }}
        className={clsx('relative rounded-2xl ring-2 ring-dashed transition', drag ? 'ring-accent bg-accent/5' : 'ring-transparent')}>
        <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false}
          placeholder={'Paste PGN here (one or many games), a Lichess game link…\n\n…or drop a .pgn file anywhere in this box.'}
          className={clsx(inputCls, 'h-48 resize-y py-3 font-mono text-xs leading-relaxed')} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => parse()} disabled={loading || !text.trim()}>
          {loading ? <Spinner /> : <Sparkles size={16} />} Analyze
        </Button>
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-ink-700 px-4 text-sm font-semibold ring-1 ring-white/5 hover:bg-ink-600">
          <FileUp size={16} /> Open .pgn file
          <input type="file" accept=".pgn,.txt" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void readFile(f) }} />
        </label>
      </div>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      {games && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm text-ink-300">{games.length} game{games.length > 1 ? 's' : ''} found</span>
            {pending.length > 1 && (
              <Button size="sm" variant="primary" onClick={() => actions.batch(pending.map(([g, i]) => toQueue(g, i)))}>
                <Layers size={14} /> Analyze all ({pending.length})
              </Button>
            )}
          </div>
          <div className="max-h-[400px] space-y-1.5 overflow-y-auto pr-1">
            {games.map((g, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl bg-ink-850/80 px-3 py-2.5 ring-1 ring-white/5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{g.white} <span className="text-ink-400">vs</span> {g.black} <span className="font-normal text-ink-400">· {g.result}</span></div>
                  <div className="truncate text-xs text-ink-400">{[g.event, g.date, `${Math.ceil(g.plies / 2)} moves`].filter(Boolean).join(' · ')}</div>
                </div>
                <GameStatus job={jobFor(g, i)} analysedId={g.analysedId} onAnalyze={() => actions.analyze(toQueue(g, i))} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
