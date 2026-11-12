import { useEffect, useState } from 'react'
import { api, PRACTICE_EVENT } from './api'
import { celebrate } from './celebrate'
import { sound } from './sound'
import { toast } from './store'
import type { Training } from './types'

// One shared copy of the training summary (sidebar streak, Coach card, …), refreshed after practice.
let current: Training | null = null
const listeners = new Set<(t: Training) => void>()
let inflight: Promise<void> | null = null

function publish(t: Training) {
  const before = current
  current = t
  listeners.forEach(l => l(t))
  if (!before) return
  // Moments worth a little celebration: today's goal reached, a streak milestone.
  if (!before.goalMet && t.goalMet) {
    celebrate.big()
    sound.fanfare()
    toast({ title: `Daily goal reached – ${t.streak}-day streak`, body: t.nextMilestone ? `${t.nextMilestone - t.streak} more days to a ${t.nextMilestone}-day streak.` : 'Keep it going tomorrow.', tone: 'good', href: '/coach' })
  }
}

/** Ask the backend again (call after practice: a solved puzzle, a finished drill, …). */
export function trainingChanged(): Promise<void> {
  if (!inflight) {
    inflight = api.training().then(publish).catch(() => {}).finally(() => { inflight = null })
  }
  return inflight
}

/** The training summary; reloads when `refreshKey` changes (e.g. the page) and when the window gets focus. */
export function useTraining(refreshKey?: unknown): Training | null {
  const [t, setT] = useState<Training | null>(current)
  useEffect(() => {
    listeners.add(setT)
    return () => { listeners.delete(setT) }
  }, [])
  useEffect(() => { void trainingChanged() }, [refreshKey])
  useEffect(() => {
    const refresh = () => { void trainingChanged() }
    window.addEventListener('focus', refresh)
    window.addEventListener(PRACTICE_EVENT, refresh)
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener(PRACTICE_EVENT, refresh) }
  }, [])
  return t
}

export function setTrainingGoal(goal: number) {
  return api.setTrainingGoal(goal).then(publish)
}
