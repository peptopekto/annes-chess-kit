import type { Key } from 'chessground/types'
import { motion } from 'motion/react'
import { ChevronsDown, Trophy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { CLS, ClassIcon } from '../../lib/classes'
import { turnOf, uciSquares } from '../../lib/chess'
import { go } from '../../lib/router'
import type { Highlight, Trophies } from '../../lib/types'
import { Board } from '../Board'
import { Button, Segmented, Spinner } from '../ui'

const PAGE = 8

/** Your brilliant & great moves, newest first, loaded a page at a time. */
export function TrophyRoom({ refresh, onCounts }: { refresh: number; onCounts: (c: Trophies['counts']) => void }) {
  const [kind, setKind] = useState<'all' | 'brilliant' | 'great'>('all')
  const [items, setItems] = useState<Highlight[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Trophies['counts'] | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchPage = async (offset: number, replace: boolean) => {
    setLoading(true)
    try {
      const r = await api.trophies({ kind, offset, limit: PAGE })
      setItems(prev => (replace ? r.items : [...prev, ...r.items]))
      setTotal(r.total)
      setCounts(r.counts)
      onCounts(r.counts)
    } finally { setLoading(false) }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchPage(0, true) }, [kind, refresh])

  if (counts && counts.brilliant + counts.great === 0) return null

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
          <Trophy size={20} className="text-inaccuracy" /> Trophy room
        </h2>
        {counts && (
          <Segmented value={kind} onChange={setKind} options={[
            { value: 'all', label: `All ${counts.brilliant + counts.great}` },
            { value: 'brilliant', label: <><ClassIcon cls="brilliant" size={14} /> {counts.brilliant}</> },
            { value: 'great', label: <><ClassIcon cls="great" size={14} /> {counts.great}</> },
          ]} />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((t, i) => (
          <motion.button key={`${t.gameId}-${t.ply}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: (i % PAGE) * 0.03 }}
            onClick={() => go(`/review/${t.gameId}/${t.ply}`)}
            className="glass group rounded-2xl p-2.5 text-left transition hover:-translate-y-0.5 cursor-pointer"
            style={{ boxShadow: `0 0 30px -14px ${CLS[t.cls].color}` }}>
            <div className="pointer-events-none">
              <Board fen={t.fenBefore} orientation={turnOf(t.fenBefore)}
                shapes={[{ orig: uciSquares(t.uci)[0] as Key, dest: uciSquares(t.uci)[1] as Key, brush: t.cls }]} />
            </div>
            <div className="mt-2 flex items-center gap-2 px-1">
              <ClassIcon cls={t.cls} size={20} />
              <span className="font-display font-semibold" style={{ color: CLS[t.cls].color }}>{t.san}</span>
              <span className="ml-auto truncate text-[11px] text-ink-400">{t.date}</span>
            </div>
          </motion.button>
        ))}
      </div>
      {items.length < total && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" onClick={() => fetchPage(items.length, false)} disabled={loading}>
            {loading ? <Spinner /> : <ChevronsDown size={16} />} Show {Math.min(PAGE, total - items.length)} more · {total - items.length} left
          </Button>
        </div>
      )}
    </section>
  )
}
