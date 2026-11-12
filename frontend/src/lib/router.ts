import { useSyncExternalStore } from 'react'

/*
 * Minimal hash router (#/a/b) with a "Back" that knows where it goes.
 *
 * Every history entry of this window gets a number (kept in history.state, so it survives a reload): the first
 * page is 0, each new page one more. So "can I go back inside the app?" is just "is this entry above 0?", and
 * Back is the browser's own back – the same as Alt+← or the mouse's back button.
 */

interface Entry { brilliantIdx: number }
const listeners = new Set<() => void>()
const pathOf = () => window.location.hash.replace(/^#/, '') || '/'
let idx = 0
const known: string[] = []  // path of each entry seen in this window (index = entry number)

function stamp(i: number) {
  idx = i
  known[i] = pathOf()
  known.length = i + 1 // entries after a new one are gone (as in the browser)
  window.history.replaceState({ ...(window.history.state ?? {}), brilliantIdx: i } satisfies Entry, '')
}

if (typeof window !== 'undefined') {
  const s = window.history.state as Partial<Entry> | null
  if (typeof s?.brilliantIdx === 'number') { idx = s.brilliantIdx; known[idx] = pathOf() } else stamp(0)
  window.addEventListener('hashchange', () => {
    const st = window.history.state as Partial<Entry> | null
    if (typeof st?.brilliantIdx === 'number') { idx = st.brilliantIdx; known[idx] = pathOf() } // back / forward
    else stamp(idx + 1)                                                                       // a new page
    listeners.forEach(l => l())
  })
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  listeners.add(cb)
  return () => { window.removeEventListener('hashchange', cb); listeners.delete(cb) }
}

/** Path segments of `#/a/b`. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
}

/** True when there is a page of the app to go back to in this window. */
export function useCanGoBack(): boolean {
  return useSyncExternalStore(subscribe, () => idx > 0)
}

const norm = (path: string) => (path.startsWith('/') ? path : `/${path}`)

/** Open a page (a new history entry: Back returns here). */
export function go(path: string) {
  window.location.hash = norm(path)
}

/** Show another view of the same page without a new history entry (e.g. switching tabs). */
export function replace(path: string) {
  const p = norm(path)
  if (pathOf() === p) return
  window.history.replaceState(window.history.state, '', `#${p}`)
  known[idx] = p
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Back one page; with nothing to go back to, up one level (#/a/b → #/a) or to Home. */
export function back() {
  if (idx > 0) { window.history.back(); return }
  const segs = pathOf().split('/').filter(Boolean)
  replace(segs.length > 1 ? `/${segs.slice(0, -1).join('/')}` : '/')
}

/** Leave this view for `path`: steps back if that is the page you came from (so Back doesn't bounce), else opens it. */
export function leave(path: string) {
  const p = norm(path)
  if (idx > 0 && known[idx - 1] === p) window.history.back()
  else replace(p)
}
