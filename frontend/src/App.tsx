import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Bird, Bot, BookOpen, Brain, CircleHelp, Crown, GraduationCap, LineChart, Search, ShieldAlert, Settings as Cog, Sparkles, Users, Volume2, VolumeX } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react'
import { HELP_EVENT, HelpDialog } from './components/HelpDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { StreakChip } from './components/training/TrainingCard'
import { Toaster } from './components/Toaster'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CommandPalette, prefetchPaletteGames, type PaletteNav } from './components/CommandPalette'
import { Kbd, PageSkeleton, Spinner } from './components/ui'
import { api } from './lib/api'
import { back, go, useCanGoBack, useRoute } from './lib/router'
import { warmSounds } from './lib/sound'
import { refreshQueue, SettingsProvider, useOpenSettings, useQueue, useQueueCounts, useSettings } from './lib/store'
import { Home } from './pages/Home'

// Pages load on first visit, so the start page doesn't wait for charts, boards and trainers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>
const named = <M, K extends keyof M>(load: () => Promise<M>, key: K) =>
  lazy(async () => {
    try {
      const m = await load()
      try { sessionStorage.removeItem('chunk-reload') } catch { /* private mode */ }
      return { default: m[key] as Extract<M[K], AnyComponent> }
    } catch (e) {
      // After an update the old page asks for files that no longer exist: reload once to get the new ones.
      let first = true
      try { first = !sessionStorage.getItem('chunk-reload'); sessionStorage.setItem('chunk-reload', '1') } catch { /* private mode */ }
      if (first) { location.reload(); return new Promise<never>(() => {}) }
      throw e
    }
  })
const loadReview = () => import('./pages/Review')
const Analyzing = named(() => import('./pages/Analyzing'), 'Analyzing')
const Openings = named(() => import('./pages/Openings'), 'Openings')
const SafetyPlay = named(() => import('./pages/Safety'), 'SafetyPlay')
const SafetyHubPage = named(() => import('./pages/SafetyHub'), 'SafetyHubPage')
const InsightsPage = named(() => import('./pages/Insights'), 'InsightsPage')
const Progress = named(() => import('./pages/Progress'), 'Progress')
const PeersPage = named(() => import('./pages/Peers'), 'PeersPage')
const Review = named(loadReview, 'Review')
const WoodpeckerPlay = named(() => import('./pages/WoodpeckerPlay'), 'WoodpeckerPlay')
const WoodpeckerSets = named(() => import('./pages/WoodpeckerSets'), 'WoodpeckerSets')
const NightmarePage = named(() => import('./pages/Nightmare'), 'NightmarePage')
const EndgamesPage = named(() => import('./pages/Endgames'), 'EndgamesPage')
const CoachPage = named(() => import('./pages/Coach'), 'CoachPage')

type Group = 'Start' | 'Learn' | 'Practise'
const GROUPS: Group[] = ['Start', 'Learn', 'Practise']
const GROUP_LABEL: Record<Group, string> = { Start: '', Learn: 'Understand your games', Practise: 'Practise' }

export default function App() {
  return (
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  )
}

function Shell() {
  const route = useRoute()
  const [settingsOpen, setSettingsOpen] = useState(false)
  useOpenSettings(useCallback(() => setSettingsOpen(true), []))
  const { settings, update } = useSettings()
  const section = route[0] ?? ''
  const canBack = useCanGoBack()

  // Heartbeat: as a standalone app (no console) the server quits once its window stops pinging.
  useEffect(() => {
    const ping = () => { void fetch('/api/ping', { method: 'POST' }).catch(() => {}) }
    ping()
    const t = setInterval(ping, 15_000)
    const onVisible = () => { if (document.visibilityState === 'visible') ping() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  useEffect(() => {
    refreshQueue()
    // The review page is the one you open most – fetch it in the background once the start page is up.
    const idle = setTimeout(() => { void loadReview(); void prefetchPaletteGames() }, 1500)
    const warm = () => { warmSounds(); window.removeEventListener('pointerdown', warm) }
    window.addEventListener('pointerdown', warm)
    return () => { clearTimeout(idle); window.removeEventListener('pointerdown', warm) }
  }, [])

  let page
  if (section === 'review' && route[1]) page = <Review id={route[1]} initialPly={route[2] ? Number(route[2]) : undefined} />
  else if (section === 'analyzing') page = <Analyzing jobId={route[1] ? Number(route[1]) : undefined} />
  else if (section === 'progress') page = <Progress />
  else if (section === 'insights') page = <InsightsPage />
  else if (section === 'peers') page = <PeersPage />
  else if (section === 'openings') page = <Openings />
  else if (section === 'safety' && route[1] === 'play') page = <SafetyPlay key={route.join('/')} mode={route[2]} count={Number(route[3]) || 20} />
  else if (section === 'safety') page = <SafetyHubPage />
  else if (section === 'woodpecker' && route[1]) page = <WoodpeckerPlay key={route[1]} id={route[1]} />
  else if (section === 'woodpecker') page = <WoodpeckerSets />
  else if (section === 'nightmare') page = <NightmarePage sub={route[1]} />
  else if (section === 'coach') page = <CoachPage />
  else if (section === 'endgames') page = <EndgamesPage drillId={route[1]} />
  else page = <Home />

  // Plain names, each with one line saying what it's for – shown right in the sidebar.
  const nav: (PaletteNav & { group: Group; active: boolean })[] = [
    { id: '', label: 'Home', icon: Sparkles, hint: 'Load and review your games', group: 'Start', active: ['', 'review', 'analyzing'].includes(section) },
    { id: 'coach', label: 'Coach', icon: GraduationCap, hint: 'Your training plan for today', group: 'Learn', active: section === 'coach' },
    { id: 'insights', label: 'My mistakes', icon: Brain, hint: 'Where you lose the most', group: 'Learn', active: section === 'insights' },
    { id: 'progress', label: 'My progress', icon: LineChart, hint: 'How your play changes', group: 'Learn', active: section === 'progress' },
    { id: 'peers', label: 'Compared to others', icon: Users, hint: 'You vs players at your rating', group: 'Learn', active: section === 'peers' },
    { id: 'woodpecker', label: 'Puzzles', icon: Bird, hint: 'Made from your own mistakes', group: 'Practise', active: section === 'woodpecker' },
    { id: 'nightmare', label: 'Instructive bot', icon: Bot, hint: 'Play with live tips', group: 'Practise', active: section === 'nightmare' },
    { id: 'safety', label: 'Blunder check', icon: ShieldAlert, hint: 'Stop hanging pieces', group: 'Practise', active: section === 'safety' },
    { id: 'openings', label: 'Openings', icon: BookOpen, hint: 'Learn your first moves', group: 'Practise', active: section === 'openings' },
    { id: 'endgames', label: 'Endgames', icon: Crown, hint: 'Basic mates and endings', group: 'Practise', active: section === 'endgames' },
  ]

  const muted = settings ? !settings.sounds : false
  const toggleSound = () => void update({ sounds: muted })
  const profile = settings?.chesscom_username || settings?.lichess_username || ''

  // ⌘K / Ctrl+K opens the command palette from anywhere.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  useEffect(() => { const open = () => setHelpOpen(true); window.addEventListener(HELP_EVENT, open); return () => window.removeEventListener(HELP_EVENT, open) }, [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* ---- sidebar (desktop) / top bar (mobile) ---- */}
      <aside className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] bg-ink-950/70 px-3 py-2 backdrop-blur-xl lg:w-[244px] lg:flex-col lg:items-stretch lg:gap-0 lg:border-r lg:border-b-0 lg:px-3 lg:overflow-y-auto lg:py-4 lg:[scrollbar-width:thin]">
        <button onClick={() => go('/')} className="mr-2 flex items-center gap-2.5 rounded-xl px-1.5 py-1 text-left lg:mr-0 lg:mb-4 cursor-pointer" title="Anne's Chess Kit">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent font-display text-[15px] font-semibold tracking-tight text-ink-950 shadow-[inset_0_1px_0_rgba(255,255,255,.5),0_6px_18px_-6px_rgba(46,230,209,.7)]">!!</span>
          <span className="hidden flex-col leading-none lg:flex">
            <span className="font-display text-[15px] font-semibold tracking-tight">Anne's Chess Kit</span>
            <span className="mt-1 text-[11px] text-ink-500">Learn from your own games</span>
          </span>
        </button>

        {/* Always in the same place; greyed out when there is nothing to go back to. Alt+← and the mouse's back button work too. */}
        <button onClick={back} disabled={!canBack} title="Back to the previous page (Alt+←)" aria-label="Back"
          className="mr-1 flex size-9 shrink-0 items-center justify-center gap-2 rounded-[10px] text-sm font-medium text-ink-300 transition hover:bg-white/[0.05] hover:text-white disabled:pointer-events-none disabled:opacity-35 lg:mr-0 lg:mb-2 lg:w-full lg:justify-start lg:px-2.5 cursor-pointer">
          <ArrowLeft size={17} /> <span className="hidden lg:inline">Back</span>
        </button>

        <button onClick={() => setPaletteOpen(true)}
          className="mb-5 hidden h-9 items-center gap-2 rounded-[10px] bg-white/[0.04] px-2.5 text-[13px] text-ink-400 ring-1 ring-inset ring-white/[0.07] transition hover:bg-white/[0.07] hover:text-ink-200 lg:flex cursor-pointer">
          <Search size={15} /> <span className="flex-1 text-left">Find a page or game…</span>
          <Kbd>{mac ? '⌘' : 'Ctrl'}</Kbd><Kbd>K</Kbd>
        </button>

        <nav className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] lg:flex-col lg:items-stretch lg:gap-0 lg:overflow-visible">
          {GROUPS.map(group => (
            <div key={group} className="contents lg:mb-4 lg:flex lg:flex-col lg:gap-0.5">
              {group !== 'Start' && <div className="mb-1 hidden px-2.5 text-[11px] font-medium tracking-wide text-ink-500 uppercase lg:block">{GROUP_LABEL[group]}</div>}
              {nav.filter(n => n.group === group).map(n => (
                <button key={n.id} onClick={() => go(`/${n.id}`)} aria-current={n.active ? 'page' : undefined}
                  title={n.hint}
                  className={clsx('group relative flex h-9 shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-sm font-medium transition-colors lg:h-auto lg:w-full lg:py-1.5 cursor-pointer',
                    n.active ? 'text-white' : 'text-ink-400 hover:bg-white/[0.04] hover:text-ink-100')}>
                  {n.active && (
                    <motion.span layoutId="nav-active" transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                      className="absolute inset-0 rounded-[10px] bg-white/[0.07] ring-1 ring-inset ring-white/[0.08]" />
                  )}
                  <n.icon size={17} strokeWidth={n.active ? 2.2 : 1.9} className={clsx('relative shrink-0', n.active && 'text-accent')} />
                  <span className="relative hidden min-w-0 text-left leading-tight sm:inline">
                    {n.label}
                    <span className={clsx('hidden truncate text-[11px] font-normal lg:block', n.active ? 'text-ink-300' : 'text-ink-500')}>{n.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex-1" />

        {/* daily goal and streak */}
        <StreakChip refreshKey={section} />

        {/* analysis queue (own component: the page must not re-render on every queue poll) */}
        <QueueCard />

        {/* profile + controls */}
        <div className="flex items-center gap-1 lg:border-t lg:border-white/[0.06] lg:pt-3">
          <button onClick={() => setSettingsOpen(true)} title="Settings"
            className="hidden min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-1.5 py-1.5 text-left transition hover:bg-white/[0.04] lg:flex cursor-pointer">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-xs font-medium text-ink-950 uppercase">
              {profile ? profile[0] : '?'}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[13px] font-medium text-ink-100">{profile || 'Set your username'}</span>
              <span className="block text-[11px] text-ink-500">Settings</span>
            </span>
          </button>
          <button onClick={() => setHelpOpen(true)} title="How Anne's Chess Kit works" aria-label="Help"
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-400 transition hover:bg-white/[0.05] hover:text-white cursor-pointer">
            <CircleHelp size={17} />
          </button>
          <button onClick={() => setPaletteOpen(true)} title="Search (Ctrl+K)" aria-label="Search"
            className="flex size-9 items-center justify-center rounded-[10px] text-ink-400 transition hover:bg-white/[0.05] hover:text-white lg:hidden cursor-pointer">
            <Search size={17} />
          </button>
          <button onClick={toggleSound} title={muted ? 'Sounds off' : 'Sounds on'} aria-label={muted ? 'Turn sounds on' : 'Turn sounds off'}
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-400 transition hover:bg-white/[0.05] hover:text-white cursor-pointer">
            {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <button onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-400 transition hover:bg-white/[0.05] hover:text-white lg:hidden cursor-pointer">
            <Cog size={17} />
          </button>
        </div>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <UpdateBanner />
        <Suspense fallback={<PageSkeleton />}>
          <motion.div key={section} className="h-full" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}>
            <ErrorBoundary resetKey={route.join('/')}>{page}</ErrorBoundary>
          </motion.div>
        </Suspense>
      </main>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={closePalette} nav={nav} muted={muted}
        onToggleSound={toggleSound} onOpenSettings={() => setSettingsOpen(true)} />
      <Toaster />
    </div>
  )
}


/** The sidebar's analysis-queue card. Subscribes to the queue itself, so polling only re-renders this card. */
function QueueCard() {
  const queue = useQueue()
  const counts = useQueueCounts()
  const activeCount = counts.queued + counts.running
  const running = queue.find(j => j.status === 'running')
  const pct = running?.total ? Math.round((running.done / running.total) * 100) : 0
  // A batch shows overall progress (games done of the batch); a single game its own progress.
  const batch = activeCount > 3
  const batchPct = batch ? Math.floor((counts.done / (counts.done + activeCount)) * 100) : pct
  return (
    <>
        <AnimatePresence>
          {activeCount > 0 && (
            <motion.button initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
              onClick={() => go('/analyzing')} title={`${activeCount} game(s) in the analysis queue`}
              className="ml-1 flex items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition hover:bg-white/[0.05] lg:mb-3 lg:ml-0 lg:block lg:bg-white/[0.03] lg:p-3 lg:ring-1 lg:ring-inset lg:ring-white/[0.06] cursor-pointer">
              <span className="flex items-center gap-2">
                <Spinner size={13} />
                <span className="font-medium text-ink-100">Analyzing</span>
                {batch
                  ? <span className="font-mono text-ink-400 tabular-nums">{activeCount.toLocaleString()} left</span>
                  : <span className="font-mono text-ink-400 tabular-nums">{pct}%</span>}
                {!batch && activeCount > 1 && <span className="hidden text-ink-500 lg:inline">· {activeCount - 1} queued</span>}
              </span>
              <span className="mt-2.5 hidden h-1 overflow-hidden rounded-full bg-white/[0.06] lg:block">
                <span className="block h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${batchPct}%` }} />
              </span>
              {running && <span className="mt-2 hidden truncate text-ink-500 lg:block">{running.title}</span>}
            </motion.button>
          )}
        </AnimatePresence>

    </>
  )
}

/**
 * The app was updated while it kept running in the background (the window can be closed and reopened without
 * the server stopping): the page is new, the server still old – so new features fail. Say how to fix it.
 */
function UpdateBanner() {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const check = () => { api.system().then(s => setStale(s.started == null || !!s.outdated)).catch(() => {}) }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  if (!stale) return null
  return (
    <div role="alert" className="sticky top-0 z-30 border-b border-inaccuracy/30 bg-[#2a2410]/95 px-4 py-2.5 text-sm text-ink-100 backdrop-blur">
      <b className="text-inaccuracy">Anne's Chess Kit was updated, but the old version is still running.</b>{' '}
      Close all its windows and start it again – some new features won't work until then.
      <span className="text-ink-400"> (Still there? End “Python” in the Task Manager, then start it again.)</span>
    </div>
  )
}

