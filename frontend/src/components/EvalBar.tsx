import { motion } from 'motion/react'
import { evalLabel, winPct } from '../lib/chess'
import type { Color, Eval } from '../lib/types'

export function EvalBar({ ev, orientation }: { ev: Eval; orientation: Color }) {
  const white = winPct(ev)
  const whiteAhead = white >= 50
  const label = evalLabel(ev).replace('+', '')
  // White's share grows from the bottom when White is at the bottom.
  const flipped = orientation === 'b'
  return (
    <div className="relative h-full w-7 overflow-hidden rounded-lg bg-[#2a2d38] ring-1 ring-white/10 shadow-lg">
      {/* Scaled, not resized: a transform runs on the GPU and never re-lays-out the page while it animates. */}
      <motion.div
        className="absolute inset-0 bg-[#e9ecf4]"
        style={{ transformOrigin: flipped ? 'top' : 'bottom' }}
        initial={false}
        animate={{ scaleY: white / 100 }}
        transition={{ type: 'spring', stiffness: 170, damping: 26 }}
      />
      <div className="absolute inset-x-0 top-1/2 h-px bg-accent/50" />
      <span
        className="absolute inset-x-0 text-center text-[10px] font-extrabold tracking-tight"
        style={{
          color: whiteAhead ? '#1b1e28' : '#e7eaf4',
          ...((whiteAhead !== flipped) ? { bottom: 6 } : { top: 6 }),
        }}
      >
        {label}
      </span>
    </div>
  )
}
