import clsx from 'clsx'
import { motion } from 'motion/react'
import { BarChart3, Bird, Dumbbell, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button, Card, CardsSkeleton, ErrorNote, Field, Modal, Spinner, inputCls } from '../components/ui'
import { api } from '../lib/api'
import { accuracyColor } from '../lib/chess'
import { go } from '../lib/router'
import type { RunStats, SetSummary } from '../lib/types'

export const runAccuracy = (r: RunStats) => (r.correct_first_try / Math.max(1, r.total_puzzles)) * 100
export const fmtTime = (s: number) => {
  s = Math.round(s)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function WoodpeckerSets() {
  const [sets, setSets] = useState<SetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [statsFor, setStatsFor] = useState<SetSummary | null>(null)

  const load = () => api.sets().then(setSets).catch(e => setError(String(e)))
  useEffect(() => { void load() }, [])

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 font-display text-[30px] leading-tight font-semibold"><span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-white/[0.08]"><Bird size={18} className="text-accent" /></span> Puzzles</h1>
          <p className="mt-2 max-w-xl text-sm text-ink-300">
            Puzzles made from your own mistakes. Solve the same set again and again, a bit faster each round, until the
            patterns stick (the “Woodpecker method”). Start with <b className="font-semibold text-ink-100">New set</b>.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} /> New set</Button>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {!sets ? <CardsSkeleton count={4} h="h-40" /> : sets.length === 0 ? (
        <Card className="p-10 text-center text-ink-300">No puzzle sets yet. Create one to get pecking!</Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {sets.map((s, i) => <SetCard key={s.id} s={s} i={i} onStats={() => setStatsFor(s)}
            onDelete={async () => { if (confirm(`Delete "${s.meta.name}"?`)) { await api.deleteSet(s.id); void load() } }} />)}
        </div>
      )}

      <CreateSetModal open={creating} onClose={() => setCreating(false)} />
      <StatsModal s={statsFor} onClose={() => setStatsFor(null)} />
    </div>
  )
}

function SetCard({ s, i, onStats, onDelete }: { s: SetSummary; i: number; onStats: () => void; onDelete: () => void }) {
  const runs = s.meta.completed_runs ?? []
  const last = runs[runs.length - 1]
  const best = runs.length ? Math.max(...runs.map(runAccuracy)) : null
  const progress = s.activeIdx != null ? s.activeIdx / Math.max(1, s.count) : 0
  const fromGames = s.meta.source === 'games'
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
      <Card className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {fromGames && <Dumbbell size={16} className="text-mistake" />}
              <h3 className="truncate font-display text-lg font-semibold">{s.meta.name}</h3>
            </div>
            <div className="mt-0.5 text-xs text-ink-400">
              {s.count} puzzles
              {s.meta.min_rating != null && ` · ${s.meta.min_rating}–${s.meta.max_rating}`}
              {s.meta.created_at && ` · ${new Date(s.meta.created_at).toLocaleDateString()}`}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={onStats} title="Stats"><BarChart3 size={16} /></Button>
            <Button variant="ghost" size="sm" onClick={onDelete} title="Delete"><Trash2 size={15} /></Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <Mini label="Cycles" value={String(runs.length)} />
          <Mini label="Best" value={best == null ? '—' : `${best.toFixed(0)}%`} color={accuracyColor(best)} />
          <Mini label="Last time" value={last ? fmtTime(last.total_time) : '—'} />
        </div>

        {s.activeIdx != null && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-ink-400"><span>Cycle in progress</span><span>{s.activeIdx}/{s.count}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full rounded-full bg-gradient-to-r from-accent to-great" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        <Button variant="primary" className="mt-auto" onClick={() => go(`/woodpecker/${s.id}`)}>
          <Play size={16} fill="currentColor" /> {s.activeIdx != null ? 'Continue' : runs.length ? `Start cycle ${runs.length + 1}` : 'Start'}
        </Button>
      </Card>
    </motion.div>
  )
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl bg-ink-850 py-2 ring-1 ring-white/5">
      <div className="font-display text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  )
}

function CreateSetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ amount: 100, min_rating: 1000, max_rating: 1500, min_length: 2, max_length: 50 })
  const [busy, setBusy] = useState<'lichess' | 'mistakes' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const create = async (kind: 'lichess' | 'mistakes') => {
    setBusy(kind); setError(null)
    try {
      const set = await api.createSet({ kind, ...f })
      onClose()
      go(`/woodpecker/${set.id}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  const num = (k: keyof typeof f, label: string, step = 1) => (
    <Field label={label}>
      <input type="number" step={step} className={inputCls} value={f[k]}
        onChange={e => setF({ ...f, [k]: Number(e.target.value) })} />
    </Field>
  )

  return (
    <Modal open={open} onClose={onClose} title="New puzzle set">
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-400">From the Lichess puzzle database</div>
          <div className="grid grid-cols-2 gap-3">
            {num('amount', 'Puzzles', 10)}
            <div />
            {num('min_rating', 'Min rating', 50)}
            {num('max_rating', 'Max rating', 50)}
            {num('min_length', 'Min length (half-moves)')}
            {num('max_length', 'Max length (half-moves)')}
          </div>
          <Button variant="primary" className="mt-4 w-full" onClick={() => create('lichess')} disabled={!!busy}>
            {busy === 'lichess' ? <Spinner /> : <Plus size={16} />} Generate set
          </Button>
        </div>
        <div className={clsx('flex items-center gap-3 text-xs text-ink-500 before:h-px before:flex-1 before:bg-white/10 after:h-px after:flex-1 after:bg-white/10')}>or</div>
        <Button className="w-full" onClick={() => create('mistakes')} disabled={!!busy}>
          {busy === 'mistakes' ? <Spinner /> : <Dumbbell size={16} />} Build from my own mistakes
        </Button>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  )
}

function StatsModal({ s, onClose }: { s: SetSummary | null; onClose: () => void }) {
  const runs = s?.meta.completed_runs ?? []
  const data = runs.map((r, i) => ({ run: i + 1, acc: runAccuracy(r), min: r.total_time / 60 }))
  return (
    <Modal open={!!s} onClose={onClose} title={s ? `Stats · ${s.meta.name}` : ''} wide>
      {runs.length === 0 ? <div className="py-8 text-center text-ink-400">No completed cycles yet.</div> : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <MiniChart title="Accuracy (first try) %" data={data} dataKey="acc" color="#1ee3cf" domain={[0, 100]} fmt={v => `${v.toFixed(1)}%`} />
            <MiniChart title="Cycle time (minutes)" data={data} dataKey="min" color="#a78bfa" fmt={v => `${v.toFixed(1)} min`} />
          </div>
          <div className="overflow-hidden rounded-xl ring-1 ring-white/5">
            <table className="w-full text-sm">
              <thead className="bg-ink-850 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr><th className="px-3 py-2">#</th><th>Date</th><th className="text-right">Correct</th><th className="text-right">Accuracy</th><th className="px-3 text-right">Time</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {runs.map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-semibold">{i + 1}</td>
                    <td className="text-ink-300">{r.timestamp?.slice(0, 10)}</td>
                    <td className="text-right tabular-nums">{r.correct_first_try}/{r.total_puzzles}</td>
                    <td className="text-right font-bold tabular-nums" style={{ color: accuracyColor(runAccuracy(r)) }}>{runAccuracy(r).toFixed(1)}%</td>
                    <td className="px-3 text-right tabular-nums">{fmtTime(r.total_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}

function MiniChart({ title, data, dataKey, color, domain, fmt }:
  { title: string; data: object[]; dataKey: string; color: string; domain?: [number, number]; fmt: (v: number) => string }) {
  return (
    <div className="rounded-xl bg-ink-850 p-3 ring-1 ring-white/5">
      <div className="mb-2 text-xs font-semibold text-ink-300">{title}</div>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
            <CartesianGrid stroke="#fff" strokeOpacity={0.05} vertical={false} />
            <XAxis dataKey="run" tick={{ fill: '#5d6888', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={domain ?? ['auto', 'auto']} tick={{ fill: '#5d6888', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ stroke: '#fff', strokeOpacity: 0.2 }} content={({ active, payload }) => {
              const p = active && payload?.[0]
              if (!p) return null
              return <div className="glass rounded-lg px-2.5 py-1.5 text-xs">Cycle {(p.payload as { run: number }).run}: <b>{fmt(Number(p.value))}</b></div>
            }} />
            <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={{ r: 4, fill: color, stroke: '#10131d', strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
