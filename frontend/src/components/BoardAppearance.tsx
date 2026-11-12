import clsx from 'clsx'
import { Check, Download, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { applyAppearance, BOARD_THEMES, boardColours, BUILTIN_PIECES, loadAppearance, pieceUrl, type Appearance } from '../lib/appearance'
import type { PieceSet, PieceSets } from '../lib/types'
import { Spinner } from './ui'

/** A 2×2 corner of a board in the given colours. */
function Swatch({ light, dark }: { light: string; dark: string }) {
  return (
    <span className="grid size-10 grid-cols-2 overflow-hidden rounded-md">
      <span style={{ background: light }} /><span style={{ background: dark }} />
      <span style={{ background: dark }} /><span style={{ background: light }} />
    </span>
  )
}

/** Two pieces of a set on a light/dark square pair (the built-in set via the board's own images). */
function Preview({ set, board }: { set: PieceSet; board: { light: string; dark: string } }) {
  const builtin = set.id === BUILTIN_PIECES
  const cell = 'relative size-9'
  const piece = (file: string, cls: string) => builtin
    ? <span className="cg-wrap pieces-preview" style={{ display: 'block', position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <piece className={cls} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none' }} />
      </span>
    : <img src={pieceUrl(set.id, file)} alt="" className="absolute inset-0 size-full" draggable={false} />
  return (
    <span className="flex overflow-hidden rounded-md">
      <span className={cell} style={{ background: board.light }}>{piece('wN', 'white knight')}</span>
      <span className={cell} style={{ background: board.dark }}>{piece('bQ', 'black queen')}</span>
    </span>
  )
}

/** Settings → Board and pieces: board colours and piece set, applied right away. */
export function BoardAppearance() {
  const [a, setA] = useState<Appearance>(loadAppearance)
  const [sets, setSets] = useState<PieceSets | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.pieceSets().then(setSets).catch(e => setError(String((e as Error).message ?? e))) }, [])
  const change = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch }
    setA(next)
    applyAppearance(next)
  }
  const colours = boardColours(a)

  const download = async (s: PieceSet) => {
    setBusy(s.id); setError(null)
    try {
      await api.pieceSetDownload(s.id)
      setSets(cur => cur && { ...cur, sets: cur.sets.map(x => (x.id === s.id ? { ...x, downloaded: true } : x)) })
      change({ pieces: s.id })
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (s: PieceSet) => {
    setBusy(s.id); setError(null)
    try {
      setSets(await api.pieceSetRemove(s.id))
      if (a.pieces === s.id) change({ pieces: BUILTIN_PIECES })
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const all = sets ? [sets.builtin, ...sets.sets] : []
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-ink-200">Board colours</div>
        <div className="flex flex-wrap gap-2">
          {BOARD_THEMES.map(t => (
            <button key={t.id} onClick={() => change({ board: t.id })} title={t.name} aria-label={t.name} aria-pressed={a.board === t.id}
              className={clsx('rounded-lg p-1 ring-2 transition cursor-pointer', a.board === t.id ? 'ring-accent' : 'ring-transparent hover:ring-white/20')}>
              <Swatch light={t.light} dark={t.dark} />
            </button>
          ))}
          <label title="Your own colours" aria-pressed={a.board === 'custom'}
            className={clsx('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 ring-2 transition', a.board === 'custom' ? 'ring-accent' : 'ring-white/10 hover:ring-white/20')}
            onClick={() => a.board !== 'custom' && change({ board: 'custom', light: colours.light, dark: colours.dark })}>
            <span className="text-xs text-ink-300">Custom</span>
            <input type="color" value={a.board === 'custom' ? a.light : colours.light} aria-label="Light squares"
              onChange={e => change({ board: 'custom', light: e.target.value, dark: a.board === 'custom' ? a.dark : colours.dark })}
              className="size-7 cursor-pointer rounded border-0 bg-transparent p-0" />
            <input type="color" value={a.board === 'custom' ? a.dark : colours.dark} aria-label="Dark squares"
              onChange={e => change({ board: 'custom', dark: e.target.value, light: a.board === 'custom' ? a.light : colours.light })}
              className="size-7 cursor-pointer rounded border-0 bg-transparent p-0" />
          </label>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[13px] font-medium text-ink-200">Pieces</div>
        {!sets && !error && <Spinner size={16} />}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {all.map(s => {
            const have = s.id === BUILTIN_PIECES || s.downloaded
            const active = a.pieces === s.id
            return (
              <div key={s.id} className={clsx('flex items-center gap-2.5 rounded-xl p-2 ring-1 transition',
                active ? 'bg-accent/10 ring-accent/60' : 'ring-white/[0.08] hover:ring-white/20')}>
                <button disabled={!have || busy != null} onClick={() => change({ pieces: s.id })}
                  className="shrink-0 enabled:cursor-pointer disabled:opacity-60" aria-label={`Use ${s.name}`}>
                  {have ? <Preview set={s} board={colours} /> : <span className="flex h-9 w-[72px] items-center justify-center rounded-md bg-white/[0.04] text-[11px] text-ink-500">not loaded</span>}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 truncate text-[13px] font-medium text-ink-100">
                    {s.name}{active && <Check size={13} className="shrink-0 text-accent" />}
                  </div>
                  <div className="truncate text-[11px] text-ink-500" title={`${s.author} · ${s.license}`}>{s.license}</div>
                </div>
                {!have ? (
                  <button onClick={() => download(s)} disabled={busy != null} title={`Download ${s.name} (by ${s.author}, ${s.license})`}
                    className="shrink-0 rounded-md p-1.5 text-ink-300 hover:bg-white/[0.06] hover:text-white disabled:opacity-40 cursor-pointer">
                    {busy === s.id ? <Spinner size={14} /> : <Download size={15} />}
                  </button>
                ) : s.id !== BUILTIN_PIECES && (
                  <button onClick={() => remove(s)} disabled={busy != null} title="Delete the downloaded files"
                    className="shrink-0 rounded-md p-1.5 text-ink-500 hover:bg-white/[0.06] hover:text-white disabled:opacity-40 cursor-pointer">
                    {busy === s.id ? <Spinner size={14} /> : <Trash2 size={14} />}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {error && <p className="mt-2 text-xs text-blunder">{error}</p>}
        <p className="mt-2 text-xs text-ink-500">
          Changes apply right away. The extra piece sets are the free sets Lichess uses; each is downloaded once
          (12 small images) and then works offline. Authors and licences show when you hover a set.
        </p>
      </div>
    </div>
  )
}

/** On start: apply the saved look, and fall back to the built-in pieces if the chosen set is gone. */
export function initAppearance() {
  const a = loadAppearance()
  applyAppearance(a, false)
  if (a.pieces !== BUILTIN_PIECES) {
    api.pieceSets().then(s => {
      if (!s.sets.some(x => x.id === a.pieces && x.downloaded)) applyAppearance({ ...a, pieces: BUILTIN_PIECES })
    }).catch(() => {})
  }
}
