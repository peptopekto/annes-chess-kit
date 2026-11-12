/** Sample-based sound effects (CC0, Kenney.nl – see public/sounds/LICENSE.txt). */
import type { Cls } from './types'

type Name = 'move-1' | 'move-2' | 'capture' | 'brilliant' | 'great' | 'success' | 'fail' | 'blunder' | 'fanfare'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let enabled = true
let volume = 0.6
const buffers = new Map<Name, Promise<AudioBuffer | null>>()

export function setSoundEnabled(on: boolean) { enabled = on }
export function setSoundVolume(v: number) {
  volume = Math.max(0, Math.min(1, v))
  if (master) master.gain.value = volume
}

function ac() {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = volume
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function load(name: Name) {
  let p = buffers.get(name)
  if (!p) {
    p = fetch(`/sounds/${name}.ogg`)
      .then(r => r.arrayBuffer())
      .then(b => ac().decodeAudioData(b))
      .catch(() => null)
    buffers.set(name, p)
  }
  return p
}

async function play(name: Name, gain = 1, delay = 0) {
  if (!enabled || volume === 0) return
  try {
    const c = ac()
    const buf = await load(name)
    if (!buf) return
    const src = c.createBufferSource()
    src.buffer = buf
    const g = c.createGain()
    g.gain.value = gain
    src.connect(g).connect(master!)
    src.start(c.currentTime + delay)
  } catch { /* audio unavailable */ }
}

/** Preload so the first move doesn't lag. */
export function warmSounds() {
  (['move-1', 'move-2', 'capture', 'brilliant', 'great', 'success', 'fail'] as Name[]).forEach(load)
}

let alt = false
export const sound = {
  move(capture = false) {
    alt = !alt
    if (capture) { void play(alt ? 'move-1' : 'move-2', 0.9); void play('capture', 0.55) }
    else void play(alt ? 'move-1' : 'move-2', 0.7)
  },
  cls(cls: Cls) {
    if (cls === 'brilliant') void play('brilliant', 0.8, 0.05)
    else if (cls === 'great') void play('great', 0.7, 0.05)
    else if (cls === 'blunder' || cls === 'miss') void play('blunder', 0.5, 0.05)
  },
  success() { void play('success', 0.6) },
  fail() { void play('fail', 0.5) },
  fanfare() { void play('fanfare', 0.6) },
  preview() { void play('brilliant', 0.8) },
}
