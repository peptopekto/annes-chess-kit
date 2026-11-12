import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { Check, Clock, CloudDownload, Flame, Layers, Rabbit, RefreshCw, Sparkles, Sun, Trophy } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type LibSource } from '../lib/api'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import { openJob, refreshQueue, toast, useQueue, useReviewsTick, useSettings } from '../lib/store'
import type { Library, LibraryGame, QueueJob } from '../lib/types'
import { Button, Spinner, inputCls } from './ui'

const TIME_ICON: Record<string, typeof Clock> = { bullet: Rabbit, blitz: Flame, rapid: Clock, daily: Sun, classical: Clock, correspondence: Sun }
const STALE_SECONDS = 5 * 60 // auto-sync when the local copy is older than this

type ResultFilter = 'all' | 'win' | 'loss' | 'draw'
type StateFilter = 'all' | 'new' | 'reviewed'

function ago(ts: number | null) {
  if (!ts) return 'never'
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const SITES: { source: LibSource; label: string; key: 'chesscom_username' | 'lichess_username' }[] = [
  { source: 'chesscom', label: 'Chess.com', key: 'chesscom_username' },
  { source: 'lichess', label: 'Lichess', key: 'lichess_username' },
]
const SITE_OF: Record<LibraryGame['source'], LibSource> = { 'chess.com': 'chesscom', lichess: 'lichess' }

interface Account { user: string; active: string | null; lib: Library | null; error: string | null }
const NO_ACCOUNT: Account = { user: '', active: null, lib: null, error: null }

/**
 * Your Chess.com and Lichess games in one list (newest first, each marked with its site): load both
 * accounts once, then filter, review single games or queue a batch – across both sites at once.
 */
export function LibraryImport() {
  const { settings, update } = useSettings()
  const [acc, setAcc] = useState<Record<LibSource, Account>>({ chesscom: NO_ACCOUNT, lichess: NO_ACCOUNT })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [site, setSite] = useState<'all' | LibraryGame['source']>('all')
  const [tc, setTc] = useState('all')
  const [result, setResult] = useState<ResultFilter>('all')
  const [state, setState] = useState<StateFilter>('all')
  const [q, setQ] = useState('')
  const queue = useQueue()
  const batchSize = settings?.batch_size ?? 10
  const started = useRef(false)
  const patch = useCallback((source: LibSource, p: Partial<Account>) =>
    setAcc(a => ({ ...a, [source]: { ...a[source], ...p } })), [])

  const load = useCallback(async (source: LibSource, name: string) => {
    try { patch(source, { lib: await api.library(source, name), error: null }) } catch (e) { patch(source, { error: (e as Error).message }) }
  }, [patch])

  const sync = useCallback(async (source: LibSource, name: string, full = false) => {
    try {
      await api.syncLibrary(source, name, full)
      setAcc(a => {
        const l = a[source].lib
        return { ...a, [source]: { ...a[source], lib: l ? { ...l, status: { state: 'syncing', fetched: 0, error: null } } : l } }
      })
    } catch (e) { patch(source, { error: (e as Error).message }) }
  }, [patch])

  const open = useCallback(async (source: LibSource, name: string) => {
    name = name.trim()
    if (!name) return
    const key = SITES.find(s => s.source === source)!.key
    patch(source, { active: name, user: name })
    setSelected(new Set())
    if (settings && settings[key] !== name) void update({ [key]: name })
    const l = await api.library(source, name).catch(e => { patch(source, { error: (e as Error).message }); return null })
    if (!l) return
    patch(source, { lib: l, error: null })
    const stale = !l.syncedAt || Date.now() / 1000 - l.syncedAt > STALE_SECONDS
    if (stale && l.status.state !== 'syncing') void sync(source, name)
  }, [settings, update, sync, patch])

  // Open the saved accounts straight away (from the local copies, instantly).
  useEffect(() => {
    if (!settings || started.current) return
    started.current = true
    for (const s of SITES) {
      const saved = settings[s.key]
      if (saved) void open(s.source, saved)
    }
  }, [settings, open])

  // While a site syncs, poll so the list fills in as games arrive.
  const syncingKey = SITES.filter(s => acc[s.source].lib?.status.state === 'syncing' && acc[s.source].active).map(s => s.source).join()
  useEffect(() => {
    if (!syncingKey) return
    const t = setInterval(() => {
      for (const s of syncingKey.split(',') as LibSource[]) {
        const name = acc[s].active
        if (name) void load(s, name)
      }
    }, 2500)
    return () => clearInterval(t)
  }, [syncingKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh review marks/accuracy whenever a queued game finishes.
  const tick = useReviewsTick() // throttled during big batches
  useEffect(() => {
    if (!tick) return
    for (const s of SITES) {
      const name = acc[s.source].active
      if (name) void load(s.source, name)
    }
  }, [tick]) // eslint-disable-line react-hooks/exhaustive-deps

  const jobs = useMemo(() => {
    const m = new Map<string, QueueJob>()
    for (const j of queue) if (j.url) m.set(j.url, j)
    return m
  }, [queue])

  const chesscomGames = acc.chesscom.lib?.games
  const lichessGames = acc.lichess.lib?.games
  const games = useMemo(() => [...(chesscomGames ?? []), ...(lichessGames ?? [])].sort((a, b) => b.endTime - a.endTime),
    [chesscomGames, lichessGames])
  const sites = useMemo(() => [...new Set(games.map(g => g.source))], [games])
  const classes = useMemo(() => [...new Set(games.map(g => g.timeClass))].filter(Boolean), [games])
  const isPending = useCallback((g: LibraryGame) => {
    const j = jobs.get(g.url)
    return !g.review && !(j && ['queued', 'running', 'done'].includes(j.status))
  }, [jobs])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return games.filter(g =>
      (site === 'all' || g.source === site)
      && (tc === 'all' || g.timeClass === tc)
      && (result === 'all' || g.outcome === result)
      && (state === 'all' || (state === 'reviewed' ? !!g.review : isPending(g)))
      && (!needle || (g.myColor === 'w' ? g.black : g.white).toLowerCase().includes(needle)))
  }, [games, site, tc, result, state, q, isPending])
  const pending = useMemo(() => filtered.filter(isPending), [filtered, isPending])

  /** Queue games from either site: each site's library knows its own PGNs. */
  const queueUrls = async (urls: string[], front = false) => {
    const byUrl = new Map<string, LibraryGame>(games.map(g => [g.url, g]))
    const groups = new Map<LibSource, string[]>()
    for (const u of urls) {
      const g = byUrl.get(u)
      if (!g) continue
      const s = SITE_OF[g.source]
      groups.set(s, [...(groups.get(s) ?? []), u])
    }
    const out: QueueJob[] = []
    for (const [s, list] of groups) {
      const name = acc[s].active
      if (!name) continue
      try {
        out.push(...await api.queueLibrary(s, name, list, { front }))
      } catch (e) {
        toast({ title: 'Could not queue', body: (e as Error).message, tone: 'bad' })
      }
    }
    if (out.length) refreshQueue()
    return out
  }
  const batch = async (urls: string[]) => {
    const out = await queueUrls(urls)
    const fresh = out.filter(j => j.status === 'queued' || j.status === 'running').length
    if (out.length) toast({ title: `Queued ${fresh} game${fresh === 1 ? '' : 's'}`, body: 'They\'ll be analysed in the background.' })
    setSelected(new Set())
  }
  const analyzeOne = async (url: string) => {
    const [job] = await queueUrls([url], true)
    if (job) openJob(job)
  }

  // ---- virtual list --------------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({ count: filtered.length, getScrollElement: () => scroller.current, estimateSize: () => 58, overscan: 12 })

  const toggle = (url: string) => setSelected(s => { const n = new Set(s); if (n.has(url)) n.delete(url); else n.add(url); return n })
  const allPendingSelected = pending.length > 0 && pending.every(g => selected.has(g.url))
  const anyActive = SITES.some(s => acc[s.source].active)
  const loadingAny = SITES.some(s => acc[s.source].active && !acc[s.source].lib && !acc[s.source].error)
  const syncingAny = !!syncingKey

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SITES.map(s => (
          <AccountBox key={s.source} label={s.label} source={s.source} a={acc[s.source]}
            onUser={user => patch(s.source, { user })} onOpen={() => void open(s.source, acc[s.source].user)}
            onSync={() => { const n = acc[s.source].active; if (n) void sync(s.source, n) }} />
        ))}
      </div>

      {!anyActive && (
        <p className="mt-4 rounded-xl bg-white/[0.02] px-4 py-6 text-center text-sm text-ink-400 ring-1 ring-inset ring-white/[0.05]">
          Type your username for Chess.com, Lichess or both, and press <b className="text-ink-200">Load</b>. Your games then show up here.
        </p>
      )}

      {anyActive && games.length === 0 && loadingAny && (
        <div className="mt-6 flex items-center justify-center gap-2 py-10 text-sm text-ink-400">
          <Spinner size={16} /> Loading your games…
        </div>
      )}

      {anyActive && (games.length > 0 || !loadingAny) && (
        <div className="mt-4">
          {/* filters */}
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {sites.length > 1 && (
              <FilterGroup label="Site">
                <Chips value={site} onChange={v => setSite(v as typeof site)}
                  options={[['all', 'Both'], ['chess.com', 'Chess.com'], ['lichess', 'Lichess']]} />
              </FilterGroup>
            )}
            <FilterGroup label="Speed">
              <Chips value={tc} onChange={setTc} options={[['all', 'All'], ...classes.map(c => [c, c] as [string, string])]} />
            </FilterGroup>
            <FilterGroup label="Result">
              <Chips value={result} onChange={v => setResult(v as ResultFilter)} options={[['all', 'All'], ['win', 'Won'], ['loss', 'Lost'], ['draw', 'Drawn']]} />
            </FilterGroup>
            <FilterGroup label="Show">
              <Chips value={state} onChange={v => setState(v as StateFilter)} options={[['all', 'All'], ['new', 'Not analyzed yet'], ['reviewed', 'Analyzed']]} />
            </FilterGroup>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search opponent…" aria-label="Search by opponent"
              className="ml-auto h-8 w-40 rounded-lg bg-ink-850 px-2.5 text-xs ring-1 ring-white/8 outline-none focus:ring-accent/60" />
          </div>

          {/* batch bar */}
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-ink-850/80 p-2 ring-1 ring-white/5">
            <Check3 checked={allPendingSelected} disabled={!pending.length}
              onChange={() => setSelected(allPendingSelected ? new Set() : new Set(pending.map(g => g.url)))} />
            <span className="text-xs text-ink-400">
              {selected.size ? `${selected.size} selected` : `${filtered.length} games · ${pending.length} not analyzed yet · tick games to pick them`}
            </span>
            <div className="flex-1" />
            {selected.size > 0 && (
              <Button size="sm" variant="primary" onClick={() => batch(filtered.filter(g => selected.has(g.url)).map(g => g.url))}>
                <Layers size={14} /> Analyze {selected.size} picked game{selected.size === 1 ? '' : 's'}
              </Button>
            )}
            <div className="flex items-center gap-1 rounded-lg bg-ink-700 pl-2.5 ring-1 ring-white/5" title="Analyze your most recent games that aren't analyzed yet">
              <span className="text-xs text-ink-300">Analyze the newest</span>
              <input type="number" min={1} max={500} value={batchSize}
                onChange={e => void update({ batch_size: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })}
                className="h-8 w-12 bg-transparent text-center text-sm font-bold outline-none" aria-label="How many games" />
              <Button size="sm" variant={selected.size ? 'soft' : 'primary'} className="rounded-l-none" disabled={!pending.length}
                onClick={() => batch(pending.slice(0, batchSize).map(g => g.url))}>
                <Layers size={14} /> games
              </Button>
            </div>
          </div>

          {/* virtualized list */}
          <div ref={scroller} className="h-[480px] overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <div className="py-10 text-center text-sm text-ink-400">{syncingAny ? 'Downloading games…' : 'No games match these filters.'}</div>
            ) : (
              <div className="relative w-full" style={{ height: virt.getTotalSize() }}>
                {virt.getVirtualItems().map(row => {
                  const g = filtered[row.index]
                  return (
                    <div key={g.url} className="absolute inset-x-0" style={{ top: row.start, height: row.size }}>
                      <Row g={g} job={jobs.get(g.url)} selectable={isPending(g)} selected={selected.has(g.url)}
                        onToggle={() => toggle(g.url)} onAnalyze={() => analyzeOne(g.url)} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** One site's account: username, sync state, and a sync button. */
function AccountBox({ label, source, a, onUser, onOpen, onSync }: {
  label: string; source: LibSource; a: Account; onUser: (u: string) => void; onOpen: () => void; onSync: () => void
}) {
  const syncing = a.lib?.status.state === 'syncing'
  const shown = !!a.active && a.active.toLowerCase() === a.user.trim().toLowerCase()
  return (
    <div className="rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.06]">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); onOpen() }}>
        <div className="relative flex-1">
          <span className="absolute top-1/2 left-2.5 -translate-y-1/2"><SiteMark source={source === 'chesscom' ? 'chess.com' : 'lichess'} /></span>
          <input className={clsx(inputCls, 'h-10 pl-10 text-sm')} placeholder={`${label} username`}
            value={a.user} onChange={e => onUser(e.target.value)} />
        </div>
        <Button variant={shown ? 'soft' : 'primary'} type="submit" disabled={!a.user.trim()} className="h-10">
          <CloudDownload size={15} /> {shown ? 'Open' : 'Load'}
        </Button>
      </form>
      <div className="mt-2 flex min-h-5 items-center gap-2 text-xs text-ink-400">
        {a.error ? <span className="truncate text-blunder" title={a.error}>{a.error}</span>
          : !a.active ? <span>Not loaded yet</span>
          : !a.lib ? <span className="flex items-center gap-1.5"><Spinner size={12} /> Loading…</span>
          : syncing ? <span className="flex items-center gap-1.5 font-semibold text-accent"><Spinner size={12} /> Downloading… {a.lib.status.fetched} new</span>
          : <span><b className="text-ink-200">{a.lib.games.length}</b> games · synced {ago(a.lib.syncedAt)}</span>}
        {a.lib?.status.state === 'error' && <span className="truncate text-blunder">Sync failed: {a.lib.status.error}</span>}
        <div className="flex-1" />
        {a.active && a.lib && !syncing && (
          <button onClick={onSync} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/[0.06] hover:text-ink-100 cursor-pointer" title="Fetch new games">
            <RefreshCw size={12} /> Sync
          </button>
        )}
      </div>
    </div>
  )
}

/** Which site a game is from: a small lettered mark (C / L), not the sites' logos. */
export function SiteMark({ source }: { source: LibraryGame['source'] | 'bot' }) {
  const [letter, cls, title] = source === 'chess.com' ? ['C', 'bg-[#81b64c]/20 text-[#9fd06a] ring-[#81b64c]/40', 'Chess.com']
    : source === 'lichess' ? ['L', 'bg-white/[0.08] text-ink-100 ring-white/20', 'Lichess']
    : ['B', 'bg-accent/15 text-accent ring-accent/30', 'Bot game']
  return (
    <span title={title} aria-label={title}
      className={clsx('inline-flex size-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold ring-1 ring-inset', cls)}>
      {letter}
    </span>
  )
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">{label}</span>
      {children}
    </div>
  )
}

function Chips({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={clsx('rounded-full px-2.5 py-1 text-xs font-semibold capitalize transition cursor-pointer',
          value === v ? 'bg-ink-100 text-ink-950' : 'bg-white/[0.05] text-ink-300 ring-1 ring-inset ring-white/[0.06] hover:bg-white/[0.08] hover:text-white')}>{label}</button>
      ))}
    </div>
  )
}

export function Check3({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onChange}
      className={clsx('flex size-5 shrink-0 items-center justify-center rounded-md ring-1 transition cursor-pointer disabled:cursor-default disabled:opacity-25',
        checked ? 'bg-accent ring-accent text-ink-950' : 'ring-white/20 hover:ring-white/40')}>
      {checked && <Check size={13} strokeWidth={3.5} />}
    </button>
  )
}

function Row({ g, job, selectable, selected, onToggle, onAnalyze }:
  { g: LibraryGame; job?: QueueJob; selectable: boolean; selected: boolean; onToggle: () => void; onAnalyze: () => void }) {
  const opp = g.myColor === 'w' ? g.black : g.white
  const oppElo = g.myColor === 'w' ? g.blackElo : g.whiteElo
  const Icon = TIME_ICON[g.timeClass] ?? Clock
  const date = g.endTime ? new Date(g.endTime * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : ''
  const out = { win: ['W', 'bg-best/12 text-best ring-best/25'], loss: ['L', 'bg-blunder/12 text-[#ff7b8d] ring-blunder/25'], draw: ['D', 'bg-white/[0.06] text-ink-300 ring-white/10'] }[g.outcome]
  const reviewId = job?.status === 'done' ? job.gameId : g.review?.id
  const acc = job?.status === 'done' ? job.summary?.accuracy : g.review?.accuracy
  return (
    <div className={clsx('group flex h-[52px] items-center gap-3 rounded-xl px-3 ring-1 ring-inset transition-colors',
      selected ? 'bg-accent/[0.07] ring-accent/30' : 'bg-white/[0.02] ring-white/[0.05] hover:bg-white/[0.045] hover:ring-white/[0.09]')}>
      <Check3 checked={selected} onChange={onToggle} disabled={!selectable} />
      <SiteMark source={g.source} />
      <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold ring-1 ring-inset', out[1])}>{out[0]}</span>
      <span className={clsx('size-3 shrink-0 rounded-full ring-1 ring-white/30', g.myColor === 'w' ? 'bg-white' : 'bg-ink-950')} title={`You played ${g.myColor === 'w' ? 'White' : 'Black'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">vs {opp} <span className="font-normal text-ink-400">({oppElo})</span></div>
        <div className="flex items-center gap-1.5 text-xs text-ink-400"><Icon size={12} /> <span className="capitalize">{g.timeClass}</span> · {date} · {g.moves} moves</div>
      </div>
      {job?.status === 'running' ? (
        <span className="flex h-8 w-24 items-center justify-center gap-2 text-xs font-bold text-accent"><Spinner size={14} /> {job.total ? Math.round((job.done / job.total) * 100) : 0}%</span>
      ) : job?.status === 'queued' ? (
        <span className="flex h-8 w-24 items-center justify-center text-xs font-semibold text-ink-400">Queued…</span>
      ) : reviewId ? (
        <Button size="sm" variant="soft" onClick={() => go(`/review/${reviewId}`)}>
          <Trophy size={14} /> Review
          {acc != null && <span className="font-mono text-xs font-semibold" style={{ color: accuracyColor(acc) }}>{acc.toFixed(0)}</span>}
        </Button>
      ) : (
        <Button size="sm" variant="soft" onClick={onAnalyze} className="group-hover:bg-accent group-hover:text-ink-950 group-hover:ring-accent">
          <Sparkles size={14} className="text-accent group-hover:text-ink-950" /> Analyze
        </Button>
      )}
    </div>
  )
}
