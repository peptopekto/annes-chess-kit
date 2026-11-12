import { api } from '../../lib/api'
import { go } from '../../lib/router'
import { toast } from '../../lib/store'
import type { DrillPool, MoveRef } from '../../lib/types'

let building = false

/**
 * Build a Woodpecker set from these positions and open it. `pool` (when the page has it) is the full list of
 * positions of the category – only some positions make a clear puzzle, so the drill picks from all of them,
 * not just from the examples shown.
 */
export async function drill(refs: MoveRef[], name: string, pool?: DrillPool) {
  const moves = pool?.length ? pool.map(([gameId, ply]) => ({ gameId, ply })) : refs.map(r => ({ gameId: r.gameId, ply: r.ply }))
  if (!moves.length || building) return
  building = true
  toast({ title: 'Building puzzles…', body: `Checking ${moves.length} position${moves.length === 1 ? '' : 's'} for a clear tactic or mate – this can take a moment.` })
  try {
    const set = await api.createSet({ kind: 'moves', name, amount: 60, moves })
    const n = set.puzzles?.length ?? 0
    if (n && n < Math.min(moves.length, 60)) {
      toast({ title: `${n} puzzle${n === 1 ? '' : 's'} from ${moves.length} positions`,
        body: 'Only positions with a clear point to find become puzzles – quiet positional moves and tiny inaccuracies are left out.' })
    }
    go(`/woodpecker/${set.id}`)
  } catch (e) {
    toast({ title: 'Could not build drill set', body: (e as Error).message, tone: 'bad' })
  } finally {
    building = false
  }
}
