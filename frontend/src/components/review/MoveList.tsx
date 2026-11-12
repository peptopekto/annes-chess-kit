import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import { ClassIcon } from '../../lib/classes'
import type { MoveRec, GameEnd } from '../../lib/types'

export function MoveList({ moves, ply, onSelect, end }: { moves: MoveRec[]; ply: number; onSelect: (p: number) => void; end?: GameEnd | null }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-ply="${ply}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [ply])

  // Rows of [white, black]; a game starting with Black to move gets an empty first cell.
  const offset = moves[0]?.color === 'b' ? 1 : 0
  const rows: (MoveRec | null)[][] = []
  for (let i = -offset; i < moves.length; i += 2) rows.push([moves[i] ?? null, moves[i + 1] ?? null])
  const firstNo = Number(moves[0]?.fenBefore.split(' ')[5] ?? 1) || 1

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      {rows.map((row, r) => (
        <div key={r} className={clsx('grid grid-cols-[36px_1fr_1fr] items-center gap-1 rounded-md', r % 2 && 'bg-white/[0.02]')}>
          <span className="pl-2 text-xs font-semibold tabular-nums text-ink-500">{firstNo + r}.</span>
          {row.map((m, c) => m ? (
            <button key={m.ply} data-ply={m.ply} onClick={() => onSelect(m.ply)}
              className={clsx('flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-sm font-semibold transition cursor-pointer',
                m.ply === ply ? 'bg-ink-600 text-white ring-1 ring-white/10' : 'text-ink-200 hover:bg-white/5')}>
              <ClassIcon cls={m.cls} size={16} />
              <span className="truncate">{m.san}</span>
            </button>
          ) : <span key={c} />)}
        </div>
      ))}
      {end && moves.length > 0 && (
        <button onClick={() => onSelect(moves.length)}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-md py-1.5 text-xs text-ink-300 hover:bg-white/[0.04] cursor-pointer">
          <span className="font-mono font-semibold text-ink-100">{end.result === '1-0' ? '1–0' : end.result === '0-1' ? '0–1' : end.result === '1/2-1/2' ? '½–½' : ''}</span>
          {end.text.split(' – ')[0]}
        </button>
      )}
    </div>
  )
}
