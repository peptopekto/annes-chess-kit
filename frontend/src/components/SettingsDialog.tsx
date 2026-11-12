import { Clock, Cpu, Layers, Volume2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { setSoundEnabled, setSoundVolume, sound } from '../lib/sound'
import { useSettings } from '../lib/store'
import type { Settings, SystemInfo } from '../lib/types'
import { BoardAppearance } from './BoardAppearance'
import { Button, Field, Modal, Segmented, inputCls } from './ui'

const MOVE_TIMES = [0.5, 1, 2, 5]

/** Rough review time of a 40-move game: ~80 positions, ~1.7 searches each (best + played/second line). */
function estimate(moveTime: number, engines: number) {
  const s = (80 * 1.7 * moveTime) / Math.max(1, engines)
  return s < 90 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, update } = useSettings()
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  useEffect(() => { if (open) setDraft(settings) }, [open, settings])
  useEffect(() => { if (open) api.system().then(setSystem).catch(() => {}) }, [open])
  if (!draft) return null

  const save = async () => { await update(draft); onClose() }
  // Volume/enable are previewed live; undo that if the dialog is dismissed.
  const cancel = () => {
    if (settings) { setSoundVolume(settings.volume); setSoundEnabled(settings.sounds) }
    onClose()
  }
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v })
  const cpus = system?.cpus ?? 8
  const auto = system?.autoEngines ?? Math.max(1, cpus - 2)
  const engines = draft.engine_threads || auto

  return (
    <Modal open={open} onClose={cancel} title="Settings">
      <div className="space-y-6">
        <Section title="Your accounts">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Chess.com username">
              <input className={inputCls} value={draft.chesscom_username} onChange={e => set('chesscom_username', e.target.value)} />
            </Field>
            <Field label="Lichess username">
              <input className={inputCls} value={draft.lichess_username} onChange={e => set('lichess_username', e.target.value)} />
            </Field>
          </div>
          <Field label="Other names you play as" hint="Comma-separated. Used to spot your side in pasted PGNs (e.g. OTB games).">
            <input className={inputCls} value={draft.aliases.join(', ')}
              onChange={e => set('aliases', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
          </Field>
        </Section>

        <Section title="Analysis">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-ink-200">Search each move</div>
            <Segmented value={draft.analysis_mode} onChange={m => set('analysis_mode', m)} options={[
              { value: 'depth', label: <><Layers size={14} /> To a fixed depth</> },
              { value: 'time', label: <><Clock size={14} /> For a fixed time</> },
            ]} />
          </div>

          {draft.analysis_mode === 'depth' ? (
            <Field label={`Depth ${draft.depth}`}
              hint="Identical results every time. 12 is quick, 16 is the standard, 20+ is thorough but takes about 3× as long.">
              <input type="range" min={8} max={30} step={1} value={draft.depth} onChange={e => set('depth', Number(e.target.value))}
                className="w-full accent-[#1ee3cf]" aria-label="Analysis depth" />
            </Field>
          ) : (
            <>
              <div>
                <div className="mb-1.5 text-[13px] font-medium text-ink-200">Time per move</div>
                <Segmented value={draft.move_time} onChange={t => set('move_time', t)}
                  options={[...MOVE_TIMES, ...(MOVE_TIMES.includes(draft.move_time) ? [] : [draft.move_time])].map(t => ({ value: t, label: `${t} s` }))} />
                <p className="mt-1 text-xs text-ink-400">
                  A faster PC searches deeper in the same time. A 40-move game takes roughly {estimate(draft.move_time, engines)} with
                  {' '}{engines} engine{engines === 1 ? '' : 's'}. Results can differ slightly between runs.
                </p>
              </div>
              <Field label={`Depth limit ${draft.max_depth}`} hint="Simple positions stop at this depth instead of using the whole time.">
                <input type="range" min={10} max={40} step={1} value={draft.max_depth} onChange={e => set('max_depth', Number(e.target.value))}
                  className="w-full accent-[#1ee3cf]" aria-label="Maximum depth" />
              </Field>
            </>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-ink-200">CPU use: {engines} of {cpus} threads</span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-300">
                <input type="checkbox" checked={!draft.engine_threads} className="size-3.5 accent-[#1ee3cf]"
                  onChange={e => set('engine_threads', e.target.checked ? 0 : auto)} />
                Automatic (all but two)
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Cpu size={15} className="shrink-0 text-ink-400" />
              <input type="range" min={1} max={cpus} step={1} value={engines}
                onChange={e => set('engine_threads', Number(e.target.value))} className="w-full accent-[#1ee3cf]" aria-label="CPU threads for analysis" />
            </div>
            <p className="mt-1 text-xs text-ink-400">Fewer threads keep your PC responsive during big batches; more make reviews faster. Applies right away.</p>
          </div>
          <p className="text-xs text-ink-500">Games you already reviewed keep their review – use “Re-analyze” on a review to redo it with new settings.</p>
        </Section>

        <Section title="Board and pieces">
          <BoardAppearance />
        </Section>

        <Section title="Sounds">
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold text-ink-200">
              <input type="checkbox" checked={draft.sounds} onChange={e => set('sounds', e.target.checked)} className="size-4 accent-[#1ee3cf]" />
              Sounds
            </label>
            <input type="range" min={0} max={1} step={0.05} value={draft.volume} disabled={!draft.sounds}
              onChange={e => { set('volume', Number(e.target.value)); setSoundVolume(Number(e.target.value)) }}
              className="flex-1 accent-[#1ee3cf] disabled:opacity-40" aria-label="Volume" />
            <Button size="sm" variant="ghost" disabled={!draft.sounds} onClick={() => { setSoundEnabled(true); sound.preview() }}>
              <Volume2 size={15} /> Test
            </Button>
          </div>
        </Section>

        <Section title="Data">
          <Field label="Mass analyze: games per batch" hint="How many recent games “Analyze last N” queues up.">
            <input type="number" min={1} max={500} className={inputCls} value={draft.batch_size}
              onChange={e => set('batch_size', Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="Lichess puzzle database (CSV)" hint="Used by Woodpecker to generate new sets.">
            <input className={inputCls} value={draft.puzzle_csv} onChange={e => set('puzzle_csv', e.target.value)} />
          </Field>
        </Section>

        <div className="flex items-center justify-end gap-2 pt-1">
          {system && <span className="mr-auto text-xs text-ink-500">Anne's Chess Kit {system.version}</span>}
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium tracking-wide text-ink-400 uppercase">{title}</h3>
      {children}
    </section>
  )
}
