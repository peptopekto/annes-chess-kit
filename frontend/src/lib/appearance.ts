/*
 * Board colours and piece set – kept in this browser (localStorage) and applied at once, everywhere a board is
 * drawn. Piece sets other than the built-in one are downloaded once (Settings → Board and pieces) and served by
 * the local backend.
 */

export interface BoardTheme { id: string; name: string; light: string; dark: string }

export const BOARD_THEMES: BoardTheme[] = [
  { id: 'blue', name: 'Blue', light: '#dfe4ee', dark: '#7d8bb0' },
  { id: 'brown', name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
  { id: 'green', name: 'Green', light: '#eeeed2', dark: '#769656' },
  { id: 'grey', name: 'Grey', light: '#dedede', dark: '#999999' },
  { id: 'ice', name: 'Ice', light: '#e8f1f8', dark: '#9fbdd6' },
  { id: 'purple', name: 'Purple', light: '#ece6f6', dark: '#9d8fc7' },
  { id: 'coral', name: 'Coral', light: '#f4e4d6', dark: '#cf8a6b' },
  { id: 'olive', name: 'Olive', light: '#e9e6c9', dark: '#9b9a63' },
]

export interface Appearance {
  /** A theme id, or 'custom' for your own two colours. */
  board: string
  light: string
  dark: string
  /** 'cburnett' (built in) or a downloaded set. */
  pieces: string
}

export const BUILTIN_PIECES = 'cburnett'
const KEY = 'brilliant.appearance'
const DEFAULT: Appearance = { board: 'blue', light: BOARD_THEMES[0].light, dark: BOARD_THEMES[0].dark, pieces: BUILTIN_PIECES }
const HEX = /^#[0-9a-f]{6}$/i
const SET_ID = /^[a-z0-9-]{1,40}$/

export function loadAppearance(): Appearance {
  try {
    const a = { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } as Appearance
    return {
      board: typeof a.board === 'string' ? a.board : DEFAULT.board,
      light: HEX.test(a.light) ? a.light : DEFAULT.light,
      dark: HEX.test(a.dark) ? a.dark : DEFAULT.dark,
      pieces: SET_ID.test(a.pieces) ? a.pieces : BUILTIN_PIECES,
    }
  } catch {
    return DEFAULT
  }
}

export function boardColours(a: Appearance): { light: string; dark: string } {
  const t = BOARD_THEMES.find(x => x.id === a.board)
  return t ? { light: t.light, dark: t.dark } : { light: a.light, dark: a.dark }
}

const ROLE = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' } as const
export const pieceUrl = (set: string, file: string) => `/api/pieces/${set}/${file}.svg`

/** Apply (and remember) the look: board colours as CSS variables, the piece set as background images. */
export function applyAppearance(a: Appearance, remember = true) {
  const { light, dark } = boardColours(a)
  const root = document.documentElement.style
  root.setProperty('--board-light', light)
  root.setProperty('--board-dark', dark)

  let style = document.getElementById('brilliant-pieces') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'brilliant-pieces'
    document.head.appendChild(style)
  }
  // Previews of the built-in set carry .pieces-preview, so they keep showing it.
  style.textContent = a.pieces === BUILTIN_PIECES || !SET_ID.test(a.pieces) ? '' : (['w', 'b'] as const).flatMap(c =>
    (Object.keys(ROLE) as (keyof typeof ROLE)[]).map(p =>
      `.cg-wrap:not(.pieces-preview) piece.${ROLE[p]}.${c === 'w' ? 'white' : 'black'}{background-image:url("${pieceUrl(a.pieces, c + p)}")}`)).join('\n')

  if (remember) {
    try { localStorage.setItem(KEY, JSON.stringify(a)) } catch { /* private mode */ }
  }
}
