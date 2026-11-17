import clsx from 'clsx'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { motion } from 'motion/react'
import { BookOpen, Check, Cpu, Dumbbell, Lightbulb, Play, RefreshCw, RotateCcw, Target, X } from 'lucide-react'
import { AnalysisBoard } from '../components/AnalysisBoard'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Board } from '../components/Board'
import { MaterialBalance } from '../components/MaterialDiff'
import { Section } from '../components/insights/Section'
import { Button, Card, ErrorNote, Segmented } from '../components/ui'
import { LoadingNotice } from '../components/LoadingNotice'
import { api } from '../lib/api'
import { CLS } from '../lib/classes'
import { playUci, uciSquares } from '../lib/chess'
import { go } from '../lib/router'
import { sound } from '../lib/sound'
import { toast } from '../lib/store'
import type { MyOpening, RepMistake, RepNode, Repertoire } from '../lib/types'

const SOURCE: Record<string, string> = { book: 'theory', yours: 'your system', engine: 'engine' }

export function Openings() {
  const [mine, setMine] = useState<MyOpening[] | null>(null)
  const [sel, setSel] = useState<MyOpening | null>(null)
  const [rep, setRep] = useState<Repertoire | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [startAt, setStartAt] = useState<string | null>(null)
  const [trainerKey, setTrainerKey] = useState(0)
  const trainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.myOpenings().then(list => { setMine(list); setSel(list[0] ?? null) }).catch(e => setError(String(e.message ?? e)))
  }, [])

  const latest = useRef<MyOpening | null>(null) // building a repertoire takes a while: ignore answers for an opening no longer selected
  const load = useCallback(async (o: MyOpening, rebuild = false) => {
    latest.current = o
    setLoading(true); setError(null)
    try {
      const r = await api.repertoire(o.family, o.color, rebuild)
      if (latest.current === o) setRep(r)
    } catch (e) { if (latest.current === o) setError((e as Error).message) }
    finally { if (latest.current === o) setLoading(false) }
  }, [])

  useEffect(() => { if (sel) { setRep(null); setStartAt(null); void load(sel) } }, [sel, load])

  const practise = (epd: string) => {
    setStartAt(epd); setTrainerKey(k => k + 1)
    setTimeout(() => trainer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const drill = async () => {
    if (!sel) return
    try { const set = await api.openingDrill(sel.family, sel.color); go(`/woodpecker/${set.id}`) }
    catch (e) { toast({ title: 'Could not build drill', body: (e as Error).message, tone: 'bad' }) }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[30px] leading-tight font-semibold"><span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-white/[0.08]"><BookOpen size={18} className="text-book" /></span> Opening trainer</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            Your repertoire, built from opening theory, the moves you and your opponents really play, and Stockfish as a safety net.
          </p>
        </div>
        {sel && (
          <Button variant="ghost" size="sm" onClick={() => load(sel, true)} disabled={loading} title="Rebuild from your latest games">
            <RefreshCw size={14} /> Rebuild
          </Button>
        )}
      </div>

      {mine && mine.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {mine.map(o => (
            <button key={o.family + o.color} onClick={() => setSel(o)}
              className={clsx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ring-1 transition cursor-pointer',
                sel?.family === o.family && sel.color === o.color ? 'bg-accent/15 text-white ring-accent/50' : 'bg-ink-800 text-ink-300 ring-white/5 hover:text-white')}>
              <span className={clsx('size-2.5 rounded-full ring-1 ring-white/40', o.color === 'w' ? 'bg-white' : 'bg-ink-950')} />
              {o.family}<span className="text-xs font-normal text-ink-400">{o.games}</span>
            </button>
          ))}
        </div>
      )}
      {!mine && !error && <LoadingNotice compact title="Finding your openings" tasks={['summaries']} />}
      {mine && mine.length === 0 && <Card className="p-8 text-ink-300">Review some of your games first – the trainer is built from them.</Card>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && (
        <LoadingNotice title={`Building your ${sel?.family ?? ''} repertoire from your games`} tasks={['repertoire']}
          note="The first time takes about 15 seconds: the engine checks the positions you reach. After that it opens straight away." />
      )}

      {rep && !loading && (
        <>
          <Mistakes rep={rep} onPractise={practise} onDrill={drill} />
          <div ref={trainer}>
            <LineTrainer key={`${rep.family}-${rep.color}-${trainerKey}`} rep={rep} startAt={startAt} />
          </div>
          <p className="text-xs text-ink-500">
            Built from {rep.games} of your games in this opening · {Object.values(rep.nodes).filter(n => n.user && n.main).length} positions where it's your move.
            "Theory" = Lichess openings book; "your system" = your usual move, checked by Stockfish; "engine" = Stockfish's choice where your usual move was clearly worse or you had none.
          </p>
        </>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //

function Mistakes({ rep, onPractise, onDrill }: { rep: Repertoire; onPractise: (epd: string) => void; onDrill: () => void }) {
  const [n, setN] = useState(6)
  const list = rep.mistakes
  return (
    <Section title="Where you go wrong" icon={<Target size={18} className="text-mistake" />}
      action={list.length > 0 && <Button size="sm" variant="primary" onClick={onDrill}><Dumbbell size={14} /> Drill all {list.length}</Button>}
      help={<>Positions you reached at least twice where your <b>usual move</b> isn't part of the repertoire and costs at least 5% win
        chance. Sorted by how often × how costly. <b>Red arrow</b>: what you usually play, <b>green</b>: what to play instead.
        "Practise from here" starts the line trainer in that position.</>}>
      {list.length === 0 ? <p className="text-sm text-ink-300">No recurring opening mistakes – your repertoire is in good shape.</p> : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {list.slice(0, n).map((m, i) => <MistakeCard key={m.epd + m.played} m={m} i={i} color={rep.color} onPractise={onPractise} />)}
        </div>
      )}
      {list.length > n && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" onClick={() => setN(x => x + 6)}>Show more · {list.length - n} left</Button>
        </div>
      )}
    </Section>
  )
}

function MistakeCard({ m, i, color, onPractise }: { m: RepMistake; i: number; color: 'w' | 'b'; onPractise: (epd: string) => void }) {
  const shapes: DrawShape[] = [
    { orig: uciSquares(m.played)[0] as Key, dest: uciSquares(m.played)[1] as Key, brush: 'blunder' },
    { orig: uciSquares(m.main)[0] as Key, dest: uciSquares(m.main)[1] as Key, brush: 'best' },
  ]
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: (i % 6) * 0.04 }}
      className="flex flex-col gap-2 rounded-2xl bg-ink-850 p-3 ring-1 ring-white/5">
      <div className="pointer-events-none"><Board fen={m.fen} orientation={color} shapes={shapes} /></div>
      <div className="text-[11px] leading-snug text-ink-400">{m.path.join(' ')}</div>
      <div className="text-sm">
        You usually play <b style={{ color: CLS.mistake.color }}>{m.playedSan}</b> <span className="text-ink-400">({m.count}× · −{Math.round(m.loss * 100)}%)</span>
      </div>
      <div className="text-sm">
        Play <b style={{ color: CLS.best.color }}>{m.mainSan}</b> <span className="text-xs text-ink-400">({SOURCE[m.source] ?? m.source})</span>
        {m.allowedSan.length > 1 && <span className="text-xs text-ink-400"> · also fine: {m.allowedSan.filter(s => s !== m.mainSan).join(', ')}</span>}
      </div>
      {m.name && <div className="truncate text-[11px] text-book">{m.name}</div>}
      <Button size="sm" variant="soft" className="mt-auto" onClick={() => onPractise(m.epd)}><Play size={13} /> Practise from here</Button>
    </motion.div>
  )
}

// --------------------------------------------------------------------------- //
//  Line trainer
// --------------------------------------------------------------------------- //

interface Step { fen: string; uci: string | null; san: string | null }

function LineTrainer({ rep, startAt }: { rep: Repertoire; startAt: string | null }) {
  const nodes = rep.nodes
  const startEpd = startAt && nodes[startAt] ? startAt : rep.root
  const [epd, setEpd] = useState(startEpd)
  const [steps, setSteps] = useState<Step[]>([{ fen: nodes[startEpd].fen, uci: null, san: null }])
  const [analysing, setAnalysing] = useState(false)
  const [feedback, setFeedback] = useState<null | 'ok' | 'alt' | 'wrong' | 'done'>(null)
  const [tries, setTries] = useState(0)
  const [score, setScore] = useState({ right: 0, total: 0, lines: 0 })
  const [shake, setShake] = useState(0)
  const [mode, setMode] = useState<'weak' | 'common'>('weak')
  const node: RepNode | undefined = nodes[epd]
  const fen = steps[steps.length - 1].fen
  const stats = useRef(rep.stats)

  // Opponent replies: weighted by how often your opponents play them, boosted towards your weak spots.
  const pickReply = useCallback((n: RepNode): string | null => {
    const reps = (n.replies ?? []).filter(r => n.children[r.uci])
    if (!reps.length) return null
    const weight = (r: { uci: string; count: number; book: boolean }) => {
      let w = r.count + (r.book ? 1 : 0) + 0.5
      const child = n.children[r.uci]
      const s = child ? stats.current[child] : undefined
      if (mode === 'weak' && s) w *= 1 + 2 * s.fail / (s.ok + s.fail || 1) + (s.ok + s.fail === 0 ? 0.5 : 0)
      return w
    }
    const total = reps.reduce((a, r) => a + weight(r), 0)
    let x = Math.random() * total
    for (const r of reps) { x -= weight(r); if (x <= 0) return r.uci }
    return reps[0].uci
  }, [mode])

  // A line ends where the repertoire has no move for you, or no known reply for the opponent.
  const isEnd = (n: RepNode | undefined) => !n || (n.user ? !n.main : !(n.replies ?? []).some(r => n.children[r.uci]))

  // Auto-play the opponent's move.
  useEffect(() => {
    if (!node || node.user || feedback === 'done') return
    const u = pickReply(node)
    if (!u) { setFeedback('done'); setScore(s => ({ ...s, lines: s.lines + 1 })); return }
    const t = setTimeout(() => {
      const r = playUci(node.fen, u)
      sound.move(r.capture)
      setSteps(st => [...st, { fen: r.fen, uci: u, san: r.san }])
      setEpd(node.children[u]!)
    }, 550)
    return () => clearTimeout(t)
  }, [node, feedback, pickReply])

  const restart = (from: string = rep.root) => {
    setEpd(from); setSteps([{ fen: nodes[from].fen, uci: null, san: null }]); setFeedback(null); setTries(0)
  }

  const onMove = (uci: string) => {
    if (!node || !node.user || !node.main || feedback === 'done') return
    const allowed = new Set(node.allowed ?? [node.main])
    if (!allowed.has(uci)) {
      setTries(t => t + 1); setFeedback('wrong'); setShake(s => s + 1); sound.fail()
      if (tries === 0) {
        void api.openingResult(rep.family, rep.color, node.epd, false)
        stats.current = { ...stats.current, [node.epd]: { ok: stats.current[node.epd]?.ok ?? 0, fail: (stats.current[node.epd]?.fail ?? 0) + 1 } }
        setScore(s => ({ ...s, total: s.total + 1 }))
      }
      return
    }
    if (tries === 0) {
      void api.openingResult(rep.family, rep.color, node.epd, true)
      stats.current = { ...stats.current, [node.epd]: { ok: (stats.current[node.epd]?.ok ?? 0) + 1, fail: stats.current[node.epd]?.fail ?? 0 } }
      setScore(s => ({ ...s, right: s.right + 1, total: s.total + 1 }))
    }
    // Any allowed move is right; the repertoire continues with the main move.
    const play = node.main
    const r = playUci(node.fen, play)
    sound.move(r.capture)
    setFeedback(uci === play ? 'ok' : 'alt')
    setTries(0)
    setSteps(st => [...st, { fen: r.fen, uci: play, san: r.san }])
    const next = node.children[play]
    if (next && nodes[next] && !isEnd(nodes[next])) setEpd(next)
    else { setEpd(next ?? node.epd); setFeedback('done'); setScore(s => ({ ...s, lines: s.lines + 1 })); sound.success() }
  }

  const shapes: DrawShape[] = []
  let highlight = null
  if (node?.user && node.main && feedback !== 'done') {
    const [o, d] = uciSquares(node.main)
    if (tries === 1) highlight = { square: o, color: '#1ee3cf' }
    if (tries >= 2) shapes.push({ orig: o as Key, dest: d as Key, brush: 'hint' })
  }
  const last = steps[steps.length - 1]
  const name = node?.name || rep.family
  const startPly = nodes[startEpd]?.ply ?? 0
  const firstPly = steps.length > 1 && steps[0].fen === nodes[startEpd]?.fen ? startPly : 0

  const sanList = useMemo(() => steps.slice(1), [steps])

  return (
    <Section title="Line trainer" icon={<Play size={18} className="text-accent" />}
      action={<Segmented value={mode} onChange={setMode} options={[{ value: 'weak', label: 'Weak spots' }, { value: 'common', label: 'Most common' }]} />}
      help={<>Play your side of the opening from move 1. Your opponent answers with the moves your real opponents play
        (<b>Most common</b>) or steers you towards positions you got wrong before (<b>Weak spots</b>). Theory moves and
        equally good engine moves are accepted; the line then continues with your repertoire move. After a wrong try you
        get a hint, after two the arrow.</>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,calc(520px*var(--board-zoom,1)))_1fr]">
        <motion.div key={shake} animate={shake ? { x: [0, -10, 10, -7, 7, 0] } : {}} transition={{ duration: 0.4 }}>
          <Board resizable fen={fen} orientation={rep.color} movable={!!node?.user && feedback !== 'done'} onMove={onMove}
            lastMove={last.uci ? uciSquares(last.uci) : null} shapes={shapes} highlight={highlight} />
          <MaterialBalance fen={fen} className="mt-2 px-1" />
        </motion.div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl bg-ink-850 p-3 ring-1 ring-white/5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Current line</div>
            <div className="mt-0.5 font-display font-semibold text-book">{name || rep.family}</div>
            <div className="mt-2 flex flex-wrap gap-1 text-xs">
              {sanList.map((s, i) => {
                const ply = firstPly + i
                const mine = (rep.color === 'w') === (ply % 2 === 0)
                const no = ply % 2 === 0 ? `${ply / 2 + 1}.` : i === 0 ? `${(ply + 1) / 2}…` : ''
                return <span key={i} className={clsx('rounded px-1.5 py-0.5 font-semibold', mine ? 'bg-best/15 text-best' : 'bg-white/5 text-ink-300')}>
                  {no && <span className="mr-0.5 opacity-60">{no}</span>}{s.san}</span>
              })}
            </div>
          </div>

          <div className={clsx('flex items-center gap-3 rounded-xl p-3 ring-1',
            feedback === 'wrong' ? 'bg-blunder/10 ring-blunder/30' : feedback === 'done' ? 'bg-best/12 ring-best/30' : 'bg-ink-850 ring-white/5')}>
            {feedback === 'wrong' && <><X className="text-blunder" size={20} /><div className="text-sm"><b>Not your repertoire move.</b> {tries >= 2 ? 'Follow the arrow.' : 'Hint: the highlighted piece.'}</div></>}
            {feedback === 'ok' && <><Check className="text-best" size={20} /><div className="text-sm"><b className="text-best">Correct!</b></div></>}
            {feedback === 'alt' && <><Check className="text-best" size={20} /><div className="text-sm"><b className="text-best">Also fine!</b> Your repertoire continues with {last.san}.</div></>}
            {feedback === 'done' && <><Check className="text-best" size={20} /><div className="text-sm"><b className="text-best">Line complete!</b> You know this one to the end of your repertoire.</div></>}
            {!feedback && <div className="text-sm text-ink-300">{node?.user ? 'Your move.' : 'Opponent is thinking…'}</div>}
          </div>

          {node?.user && node.played && node.played.length > 0 && feedback !== 'done' && tries >= 2 && (
            <div className="flex items-start gap-2 rounded-xl bg-inaccuracy/8 px-3 py-2 text-xs text-ink-100">
              <Lightbulb size={13} className="mt-0.5 shrink-0 text-inaccuracy" />
              In your games you played {node.played.map(p => `${p.san} (${p.count}×)`).join(', ')} here.
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 text-center">
            <Mini label="First try" value={`${score.right}/${score.total}`} />
            <Mini label="Accuracy" value={score.total ? `${Math.round((score.right / score.total) * 100)}%` : '—'} />
            <Mini label="Lines done" value={String(score.lines)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => restart()}><RotateCcw size={15} /> {feedback === 'done' ? 'Next line' : 'Restart from move 1'}</Button>
            {startAt && <Button variant="soft" onClick={() => restart(startEpd)}><Target size={15} /> Back to the drilled position</Button>}
            <Button variant="ghost" onClick={() => setAnalysing(true)} title="Try other moves and see the evaluation"><Cpu size={15} /> Analyse</Button>
          </div>
          <AnalysisBoard open={analysing} onClose={() => setAnalysing(false)} fen={steps[0].fen} orientation={rep.color}
            moves={steps.slice(1).map(s => s.uci!).filter(Boolean)} title="Opening analysis" />
        </div>
      </div>
    </Section>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ink-850 py-2 ring-1 ring-white/5">
      <div className="font-display text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  )
}
