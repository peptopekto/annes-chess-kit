import confetti from 'canvas-confetti'

function origin(rect?: DOMRect | null) {
  if (!rect) return { x: 0.5, y: 0.45 }
  return { x: (rect.left + rect.width / 2) / window.innerWidth, y: (rect.top + rect.height / 2) / window.innerHeight }
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const celebrate = {
  brilliant(rect?: DOMRect | null) {
    if (reduced()) return
    const o = origin(rect)
    const colors = ['#1ee3cf', '#7ff5ea', '#ffffff', '#5b8cff', '#a78bfa']
    confetti({ particleCount: 90, spread: 75, startVelocity: 38, origin: o, colors, scalar: 0.9, ticks: 180 })
    setTimeout(() => confetti({ particleCount: 50, spread: 120, startVelocity: 24, origin: o, colors, shapes: ['star'], scalar: 1.1 }), 140)
  },
  great(rect?: DOMRect | null) {
    if (reduced()) return
    confetti({ particleCount: 40, spread: 55, startVelocity: 28, origin: origin(rect), colors: ['#5b8cff', '#9db8ff', '#ffffff'], scalar: 0.8, ticks: 120 })
  },
  solved(rect?: DOMRect | null) {
    if (reduced()) return
    confetti({ particleCount: 30, spread: 60, startVelocity: 26, origin: origin(rect), colors: ['#7fd858', '#1ee3cf', '#ffffff'], scalar: 0.75, ticks: 100 })
  },
  big() {
    if (reduced()) return
    const end = Date.now() + 900
    const colors = ['#1ee3cf', '#5b8cff', '#a78bfa', '#7fd858', '#f7c845']
    ;(function frame() {
      confetti({ particleCount: 5, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors })
      confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors })
      if (Date.now() < end) requestAnimationFrame(frame)
    })()
  },
}
