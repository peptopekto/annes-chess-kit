import { Command } from 'cmdk'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft, RotateCcw, Search, Settings as Cog, ShieldAlert, Swords, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import type { GameSummary } from '../lib/types'
import { Kbd } from './ui'

export interface PaletteNav { id: string; label: string; icon: typeof Search; hint: string }

// Your reviews, kept between openings (refreshed in the background each time).
let cachedGames: GameSummary[] | null = null
export function prefetchPaletteGames() {
  return api.games().then(g => { cachedGames = g; return g }).catch(() => cachedGames)
}

/** ⌘K / Ctrl+K: jump to any page, run an action, or open one of your reviewed games by opponent. */
export function CommandPalette({ open, onClose, nav, muted, onToggleSound, onOpenSettings }:
  { open: boolean; onClose: () => void; nav: PaletteNav[]; muted: boolean; onToggleSound: () => void; onOpenSettings: () => void }) {
  const [q, setQ] = useState('')
  const [games, setGames] = useState<GameSummary[] | null>(cachedGames)

  useEffect(() => {
    if (!open) return
    setQ('')
    let alive = true
    void prefetchPaletteGames().then(g => { if (alive && g) setGames(g) })
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => { alive = false; window.removeEventListener('keydown', k) }
  }, [open, onClose])

  // Filter games ourselves (thousands of reviews) and show only the best few.
  const matches = useMemo(() => {
    if (!games) return []
    const needle = q.trim().toLowerCase()
    const sorted = [...games].sort((a, b) => (b.playedAt || b.analysedAt) - (a.playedAt || a.analysedAt))
    if (!needle) return sorted.slice(0, 5)
    return sorted.filter(g => `${g.white} ${g.black} ${g.opening?.name ?? ''}`.toLowerCase().includes(needle)).slice(0, 8)
  }, [games, q])

  const run = (fn: () => void) => { onClose(); fn() }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 px-4 pt-[14vh] backdrop-blur-[3px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onClick={onClose}>
          <motion.div className="popover w-full max-w-xl overflow-hidden rounded-2xl"
            initial={{ opacity: 0, scale: 0.98, y: -6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }} onClick={e => e.stopPropagation()}>
            <Command label="Command menu" loop filter={(value, search, keywords) =>
              value.startsWith('game:') ? 1 : `${value} ${keywords?.join(' ') ?? ''}`.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
              <div className="flex items-center gap-3 border-b border-white/[0.07] px-4">
                <Search size={17} className="text-ink-400" />
                <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Search pages, actions or an opponent…"
                  className="h-14 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-ink-500" />
                <Kbd>esc</Kbd>
              </div>
              <Command.List className="max-h-[min(60vh,440px)] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-500 [&_[cmdk-group-heading]]:uppercase">
                <Command.Empty className="px-3 py-10 text-center text-sm text-ink-400">
                  {games ? 'Nothing found.' : 'Searching your games…'}
                </Command.Empty>

                <Command.Group heading="Go to">
                  {nav.map(n => (
                    <Item key={n.id} value={n.label} keywords={[n.hint]} onSelect={() => run(() => go(`/${n.id}`))}
                      icon={<n.icon size={16} />} hint={n.hint}>{n.label}</Item>
                  ))}
                </Command.Group>

                <Command.Group heading="Actions">
                  <Item value="Start a blunder check" keywords={['safety', 'train', 'session']} icon={<ShieldAlert size={16} />}
                    onSelect={() => run(() => go('/safety/play/mixed/20'))}>Start a blunder check (20 cards)</Item>
                  <Item value="Review blunder check misses" keywords={['safety', 'mistakes']} icon={<RotateCcw size={16} />}
                    onSelect={() => run(() => go('/safety/play/review/30'))}>Review blunder-check misses</Item>
                  <Item value="Train woodpecker" keywords={['puzzles', 'tactics']} icon={<Swords size={16} />}
                    onSelect={() => run(() => go('/woodpecker'))}>Train puzzles</Item>
                  <Item value={muted ? 'Turn sounds on' : 'Turn sounds off'} keywords={['mute', 'audio', 'volume']}
                    icon={muted ? <Volume2 size={16} /> : <VolumeX size={16} />} onSelect={() => run(onToggleSound)}>
                    {muted ? 'Turn sounds on' : 'Turn sounds off'}
                  </Item>
                  <Item value="Settings" keywords={['username', 'depth', 'preferences']} icon={<Cog size={16} />}
                    onSelect={() => run(onOpenSettings)}>Settings</Item>
                </Command.Group>

                {!games && q.trim() && (
                  <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-ink-500"><span className="skeleton size-3 rounded-full" /> Loading your reviewed games…</div>
                )}
                {matches.length > 0 && (
                  <Command.Group heading={q.trim() ? 'Reviewed games' : 'Recent reviews'}>
                    {matches.map(g => {
                      const acc = g.me ? g.accuracy[g.me] : g.accuracy.w
                      const opp = g.me === 'w' ? g.black : g.me === 'b' ? g.white : `${g.white} vs ${g.black}`
                      return (
                        <Item key={g.id} value={`game:${g.id}`} onSelect={() => run(() => go(`/review/${g.id}`))}
                          icon={<span className="size-2 rounded-full" style={{ background: accuracyColor(acc) }} />}
                          hint={g.date?.replace(/\./g, '-')}>
                          <span className="truncate">{g.me ? <>vs <b className="font-medium text-white">{opp}</b></> : opp}</span>
                          {acc != null && <span className="ml-2 font-mono text-xs" style={{ color: accuracyColor(acc) }}>{acc.toFixed(0)}%</span>}
                        </Item>
                      )
                    })}
                  </Command.Group>
                )}
              </Command.List>
              <div className="flex items-center gap-4 border-t border-white/[0.07] px-4 py-2.5 text-[11px] text-ink-500">
                <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
                <span className="flex items-center gap-1.5"><Kbd><CornerDownLeft size={11} /></Kbd> open</span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Item({ value, keywords, onSelect, icon, hint, children }:
  { value: string; keywords?: string[]; onSelect: () => void; icon: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect}
      className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-sm text-ink-200 select-none data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white">
      <span className="flex size-5 items-center justify-center text-ink-400">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
      {hint && <span className="text-xs text-ink-500">{hint}</span>}
    </Command.Item>
  )
}
