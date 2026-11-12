import { api } from '../../lib/api'
import { go } from '../../lib/router'
import { toast } from '../../lib/store'
import type { MoveRef } from '../../lib/types'

/** Build a Woodpecker set from these positions and open it. */
export async function drill(refs: MoveRef[], name: string) {
  if (!refs.length) return
  try {
    const set = await api.createSet({ kind: 'moves', name, amount: 60, moves: refs.map(r => ({ gameId: r.gameId, ply: r.ply })) })
    const n = set.puzzles?.length ?? 0
    if (n && n < Math.min(refs.length, 60)) {
      toast({ title: `${n} puzzles from ${refs.length} positions`,
        body: 'Only positions with a clear point to find become puzzles – quiet positional moves and tiny inaccuracies are left out.' })
    }
    go(`/woodpecker/${set.id}`)
  } catch (e) {
    toast({ title: 'Could not build drill set', body: (e as Error).message, tone: 'bad' })
  }
}
