import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, type QueueOpts } from './api'
import { go } from './router'
import { setSoundEnabled, setSoundVolume, sound } from './sound'
import type { QueueCounts, QueueGameIn, QueueJob, QueueState, Settings } from './types'

// --------------------------------------------------------------------------- //
//  Settings
// --------------------------------------------------------------------------- //

const SettingsCtx = createContext<{ settings: Settings | null; update: (p: Partial<Settings>) => Promise<void> }>({
  settings: null,
  update: async () => {},
})

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    // Everything that depends on your usernames waits for this, so keep trying until it loads.
    let alive = true, delay = 1000
    const load = () => api.settings().then(s => { if (alive) setSettings(s) })
      .catch(() => { if (alive) { setTimeout(load, delay); delay = Math.min(delay * 2, 10000) } })
    void load()
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!settings) return
    setSoundEnabled(settings.sounds)
    setSoundVolume(settings.volume ?? 0.6)
  }, [settings])
  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings(s => (s ? { ...s, ...patch } : s)) // optimistic
    setSettings(await api.saveSettings(patch))
  }, [])
  return <SettingsCtx.Provider value={{ settings, update }}>{children}</SettingsCtx.Provider>
}

export const useSettings = () => useContext(SettingsCtx)

// Any page can open the Settings dialog (e.g. the analysis options next to "Analyze").
const OPEN_SETTINGS = 'brilliant:open-settings'
export const openSettings = () => window.dispatchEvent(new Event(OPEN_SETTINGS))
export function useOpenSettings(cb: () => void) {
  useEffect(() => {
    window.addEventListener(OPEN_SETTINGS, cb)
    return () => window.removeEventListener(OPEN_SETTINGS, cb)
  }, [cb])
}

// --------------------------------------------------------------------------- //
//  Tiny external stores
// --------------------------------------------------------------------------- //

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (v: T) => { value = v; listeners.forEach(l => l()) },
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

// --------------------------------------------------------------------------- //
//  Toasts
// --------------------------------------------------------------------------- //

export interface Toast { id: number; title: string; body?: string; href?: string; tone?: 'good' | 'info' | 'bad' }
const toasts = createStore<Toast[]>([])
let toastId = 0

export function toast(t: Omit<Toast, 'id'>) {
  const id = ++toastId
  toasts.set([...toasts.get(), { ...t, id }].slice(-4))
  setTimeout(() => dismissToast(id), 6000)
}
export const dismissToast = (id: number) => toasts.set(toasts.get().filter(t => t.id !== id))
export const useToasts = () => useSyncExternalStore(toasts.subscribe, toasts.get)

// --------------------------------------------------------------------------- //
//  Analysis queue (polled from the backend)
// --------------------------------------------------------------------------- //

const EMPTY_COUNTS: QueueCounts = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 }
const queueStore = createStore<QueueState>({ jobs: [], counts: EMPTY_COUNTS })
let polling: ReturnType<typeof setTimeout> | null = null
const announced = new Set<number>()
let primed = false
let batchDone = 0 // games finished since the queue last became busy (for one summary toast)
const BIG_BATCH = 10

async function poll() {
  polling = null
  try {
    const next = await api.queue()
    const before = queueStore.get()
    const prev = new Map(before.jobs.map(j => [j.id, j]))
    const busy = next.counts.queued + next.counts.running
    for (const j of next.jobs) {
      const was = prev.get(j.id)
      // Announce games that finished in the background (not on first load).
      if (primed && j.status === 'done' && was && was.status !== 'done' && !announced.has(j.id) && j.gameId) {
        announced.add(j.id)
        batchDone++
        // Big batches (mass analyze, re-analysing old reviews): no per-game toasts or chimes,
        // only the summary when the batch is done. Small batches: every game; mid-size: brilliant ones.
        const small = busy <= 1
        const big = busy > BIG_BATCH
        if (watched !== j.id && !big && (small || (j.summary?.counts.brilliant ?? 0) > 0)) announceDone(j)
      }
    }
    const wasBusy = before.counts.queued + before.counts.running > 0
    if (primed && wasBusy && busy === 0 && batchDone > 1) {
      toast({ title: `Batch finished – ${batchDone} games reviewed`, body: 'See them in Progress and Insights.', href: '/progress', tone: 'good' })
    }
    if (busy === 0) batchDone = 0
    primed = true
    // Publish only real changes; keep the counts object when the numbers didn't change, so components
    // that only read counts (and the reviews tick) don't re-render on every poll.
    const sameCounts = JSON.stringify(before.counts) === JSON.stringify(next.counts)
    const sameJobs = JSON.stringify(before.jobs) === JSON.stringify(next.jobs)
    if (!sameCounts || !sameJobs) queueStore.set({ jobs: sameJobs ? before.jobs : next.jobs, counts: sameCounts ? before.counts : next.counts })
    if (busy > 0) schedule(800)
  } catch {
    schedule(2000)
  }
}

function schedule(ms: number) {
  if (polling) clearTimeout(polling)
  polling = setTimeout(poll, ms)
}

function announceDone(j: QueueJob) {
  const c = j.summary?.counts ?? {}
  const bits = [
    c.brilliant ? `${c.brilliant} brilliant` : '',
    c.great ? `${c.great} great` : '',
    j.summary?.accuracy != null ? `${j.summary.accuracy.toFixed(1)}% accuracy` : '',
  ].filter(Boolean)
  toast({ title: `Reviewed: ${j.title}`, body: bits.join(' · '), href: `/review/${j.gameId}`, tone: c.brilliant ? 'good' : 'info' })
  if (c.brilliant) sound.cls('brilliant')
}

export function refreshQueue() { schedule(0) }

/**
 * Bumps when queued games finish, for pages that show reviews. Small batches refresh soon after each
 * game; during a big batch (a game every few seconds) at most every 30 s, and once when it's done –
 * so lists and charts don't re-download and redraw all the time.
 */
export function useReviewsTick(): number {
  const counts = useQueueCounts()
  const busy = counts.queued + counts.running
  const big = busy > 3
  const [tick, setTick] = useState(0)
  const last = useRef<number | null>(null)
  useEffect(() => {
    last.current ??= Date.now()
    if (!counts.done) return
    const wait = big ? Math.max(0, 30_000 - (Date.now() - (last.current ?? 0))) : 1500
    const t = setTimeout(() => { last.current = Date.now(); setTick(x => x + 1) }, wait)
    return () => clearTimeout(t)
  }, [counts.done, big])
  return tick
}
/** Active jobs plus the most recent finished ones (the server caps the list). */
export const useQueue = () => useSyncExternalStore(queueStore.subscribe, () => queueStore.get().jobs)
/** Totals over the whole queue, including jobs not in the capped list. */
export const useQueueCounts = () => useSyncExternalStore(queueStore.subscribe, () => queueStore.get().counts)

/** The job the Analyzing page is showing (finished jobs there navigate instead of toasting). */
let watched: number | null = null
export const watchJob = (id: number | null) => { watched = id }

export async function enqueue(games: QueueGameIn[], opts: QueueOpts = {}) {
  const jobs = await api.enqueue(games, opts)
  refreshQueue()
  return jobs
}

/** Show a freshly queued job: its review if it was already analysed, else its progress page. */
export function openJob(job: QueueJob) {
  refreshQueue()
  if (job.status === 'done' && job.gameId) go(`/review/${job.gameId}`)
  else go(`/analyzing/${job.id}`)
}

/** Analyse one game right now (jumps the queue) and open its progress page. */
export async function startAnalysis(game: QueueGameIn, opts: Omit<QueueOpts, 'front'> = {}) {
  try {
    const [job] = await enqueue([game], { ...opts, front: true })
    openJob(job)
  } catch (e) {
    toast({ title: 'Could not start analysis', body: (e as Error).message, tone: 'bad' })
  }
}
