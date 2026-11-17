import { useSyncExternalStore } from 'react'

/*
 * Board size, like Lichess: one setting for every board you play or review on. It scales the largest board
 * that fits the page (1 = as large as fits) and is kept in this browser. Pages read it as the CSS variable
 * --board-zoom; the grip on the board's corner (Board `resizable`) sets it.
 */

const KEY = 'brilliant.boardZoom'
export const MIN_ZOOM = 0.4
export const MAX_ZOOM = 1

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 1000) / 1000))

function stored(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return v ? clamp(v) : MAX_ZOOM
  } catch {
    return MAX_ZOOM
  }
}

let zoom = typeof window === 'undefined' ? MAX_ZOOM : stored()
const listeners = new Set<() => void>()

function apply() {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--board-zoom', String(zoom))
}
apply()

export const getBoardZoom = () => zoom

/** Change the board size; `save` = keep it for the next visit (false while dragging). */
export function setBoardZoom(z: number, save = true) {
  const next = clamp(z)
  if (next !== zoom) {
    zoom = next
    apply()
    listeners.forEach(l => l())
  }
  if (save) {
    try { localStorage.setItem(KEY, String(zoom)) } catch { /* private window: size lasts this visit */ }
  }
}

export function useBoardZoom(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => zoom)
}
