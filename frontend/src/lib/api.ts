import type { PieceSet, PieceSets, BotGame, BotGameResult, BotProgress, CheckResult, ConvertSpot, NightmareGambit, Peers, Training, EngineLine, Eval, GameRecord, GameSummary, ParsedGame, PuzzleSet,
 Insights, Library, LibrarySync, MyOpening, QueueState, Repertoire, SafetyCard, SafetyHub, SafetySummary, Trend, Trophies, QueueGameIn, QueueJob, RunStats, SetSummary, Settings, NightmareMove, NightmareSummary, CoachReport, GameEnd, StatsReport, SystemInfo,
  EndgameMode, EndgamePosition, EndgameReply, EndgameSummary, EndgameModeRecord } from './types'

/** A slow backend job that is running (backend/app/progress.py). */
export interface ProgressTask { name: string; label: string; done: number; total: number; seconds: number }

export type LibSource = 'chesscom' | 'lichess'
/** How a queued review searches: omit both depth and moveTime to use the analysis settings. */
export interface QueueOpts { depth?: number; moveTime?: number; front?: boolean; force?: boolean }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Requests that record practice: after one, the training summary (goal, streak) is refreshed. */
const PRACTICE = /^\/api\/(woodpecker\/sets\/[^/]+\/(progress|complete)|safety\/answer|openings\/result|endgames\/finish|nightmare\/finish)$/
export const PRACTICE_EVENT = 'brilliant:practice'

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }
  // Reads are retried a few times, so a page opened while the server is still starting
  // (or restarting) fills in by itself instead of staying empty.
  let res: Response | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, init)
      if (method !== 'GET' || res.status < 500 || attempt >= 4) break
    } catch (e) {
      if (method !== 'GET' || attempt >= 4) throw new Error('The app isn’t reachable – is it still running?', { cause: e })
    }
    await sleep(400 * 2 ** attempt)
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch { /* not json */ }
    throw new Error(msg)
  }
  if (method !== 'GET' && PRACTICE.test(url)) window.dispatchEvent(new Event(PRACTICE_EVENT))
  return res.json()
}

export const api = {
  settings: () => req<Settings>('GET', '/api/settings'),
  system: () => req<SystemInfo>('GET', '/api/health'),
  saveSettings: (patch: Partial<Settings>) => req<Settings>('POST', '/api/settings', patch),

  parsePgn: (pgn: string) => req<ParsedGame[]>('POST', '/api/pgn/parse', { pgn }),
  library: (source: LibSource, user: string) => req<Library>('GET', `/api/library/${source}/${encodeURIComponent(user)}`),
  syncLibrary: (source: LibSource, user: string, full = false) =>
    req<LibrarySync>('POST', `/api/library/${source}/${encodeURIComponent(user)}/sync?full=${full}`),
  queueLibrary: (source: LibSource, user: string, urls: string[], opts: QueueOpts = {}) =>
    req<QueueJob[]>('POST', `/api/library/${source}/${encodeURIComponent(user)}/queue`, { urls, ...opts }),
  insights: (q: { tc: string; color: string; last: number; since?: string }) =>
    req<Insights>('GET', `/api/insights?tc=${q.tc}&color=${q.color}&last=${q.last}${q.since ? `&since=${q.since}` : ''}`),
  trend: (q: { tc: string; color: string; bucket: string }) =>
    req<Trend>('GET', `/api/insights/trend?tc=${q.tc}&color=${q.color}&bucket=${q.bucket}`),

  games: (limit = 0) => req<GameSummary[]>('GET', `/api/games?limit=${limit}`),
  game: (id: string) => req<GameRecord>('GET', `/api/games/${id}`),
  deleteGame: (id: string) => req('DELETE', `/api/games/${id}`),
  trophies: (q: { kind?: string; offset?: number; limit?: number } = {}) =>
    req<Trophies>('GET', `/api/trophies?kind=${q.kind ?? 'all'}&offset=${q.offset ?? 0}&limit=${q.limit ?? 12}`),

  lines: (fen: string, depth = 18, multipv = 3) =>
    req<{ eval: Eval; evalText: string; lines: EngineLine[]; over?: GameEnd | null }>('POST', '/api/engine/lines', { fen, depth, multipv }),
  /** Rate a move like the review does: pass the game's depth, rating curve and the previous move when known. */
  check: (fen: string, uci: string, ctx: { depth?: number; k?: number; prevUci?: string; prevLoss?: number; book?: boolean } = {}) =>
    req<CheckResult>('POST', '/api/engine/check', { fen, uci, ...ctx }),

  training: () => req<Training>('GET', '/api/training'),
  setTrainingGoal: (goal: number) => req<Training>('POST', '/api/training/goal', { goal }),
  coachFeedback: (body: { game: string; ply: number; concept: string; fits: boolean; strength?: number }) =>
    req<unknown>('POST', '/api/coach/feedback', body),
  sets: () => req<SetSummary[]>('GET', '/api/woodpecker/sets'),
  set: (id: string) => req<PuzzleSet>('GET', `/api/woodpecker/sets/${id}`),
  createSet: (body: Record<string, unknown>) => req<PuzzleSet>('POST', '/api/woodpecker/sets', body),
  deleteSet: (id: string) => req('DELETE', `/api/woodpecker/sets/${id}`),
  saveProgress: (id: string, progress: unknown) => req('PUT', `/api/woodpecker/sets/${id}/progress`, progress),
  completeRun: (id: string, stats: RunStats) => req('POST', `/api/woodpecker/sets/${id}/complete`, stats),

  queue: () => req<QueueState>('GET', '/api/queue'),
  job: (id: number) => req<QueueJob>('GET', `/api/queue/${id}`),
  enqueue: (games: QueueGameIn[], opts: QueueOpts = {}) =>
    req<QueueJob[]>('POST', '/api/queue', { games, ...opts }),
  cancelJob: (id: number) => req('DELETE', `/api/queue/${id}`),
  cancelAll: () => req('POST', '/api/queue/cancel-all'),
  clearQueue: () => req('POST', '/api/queue/clear'),
  pgnUrl: (id: string) => `/api/games/${id}/pgn`,

  myOpenings: () => req<MyOpening[]>('GET', '/api/openings'),
  repertoire: (family: string, color: string, rebuild = false) =>
    req<Repertoire>('GET', `/api/openings/repertoire?family=${encodeURIComponent(family)}&color=${color}&rebuild=${rebuild}`),
  openingResult: (family: string, color: string, epd: string, ok: boolean) =>
    req('POST', '/api/openings/result', { family, color, epd, ok }),
  openingDrill: (family: string, color: string) => req<PuzzleSet>('POST', '/api/openings/drill', { family, color }),

  safetyDeck: (count = 20, mode = 'mixed') =>
    req<{ cards: SafetyCard[]; summary: SafetySummary }>('GET', `/api/safety/deck?count=${count}&mode=${mode}`),
  safetyAnswer: (card: SafetyCard, saidSafe: boolean) => req('POST', '/api/safety/answer', { card, saidSafe }),
  safetyFinish: (right: number, total: number, seconds: number, mode = 'mixed') =>
    req<SafetySummary>('POST', '/api/safety/finish', { right, total, seconds, mode }),
  safetyHub: () => req<SafetyHub>('GET', '/api/safety/hub'),
  coach: () => req<CoachReport>('GET', '/api/coach'),
  stats: () => req<StatsReport>('GET', '/api/stats'),
  nightmare: () => req<NightmareSummary>('GET', '/api/nightmare'),
  botGames: () => req<BotGame[]>('GET', '/api/bots/games'),
  progress: () => req<{ tasks: ProgressTask[] }>('GET', '/api/progress'),
  peers: (q: { tc: string; last: number; band: number; platform: string }) =>
    req<Peers>('GET', `/api/peers?tc=${q.tc}&last=${q.last}&band=${q.band}&platform=${encodeURIComponent(q.platform)}`),
  nightmareMove: (moves: string[], strength: number, focus: number, opts: { gambits?: string[]; variety?: boolean; fen?: string } = {}) =>
    req<NightmareMove>('POST', '/api/nightmare/move', { moves, strength, focus, ...opts }),
  setBotRating: (rating: number | null) => req<NightmareSummary>('POST', '/api/nightmare/rating', { rating }),
  nightmareGambits: () => req<NightmareGambit[]>('GET', '/api/nightmare/gambits'),
  nightmareFinish: (body: {
    result: string; color: string; level: number; traps: number; fell: number; moves: number; pgn?: string
    strength?: number; focus?: number; takebacks?: number; practice?: boolean; marks?: Record<number, { uci: string; cls: string; loss: number }>
    mode?: 'game' | 'convert'; spot?: string; explored?: boolean
  }) => req<NightmareSummary & { progress?: BotGameResult }>('POST', '/api/nightmare/finish', body),
  convertSpots: (minWin: number, draws: boolean) => req<ConvertSpot[]>('GET', `/api/bot/convert?min_win=${minWin}&draws=${draws}`),
  botProgress: () => req<BotProgress>('GET', '/api/bot/progress'),
  pieceSets: () => req<PieceSets>('GET', '/api/pieces'),
  pieceSetDownload: (id: string) => req<PieceSet>('POST', `/api/pieces/${encodeURIComponent(id)}/download`),
  pieceSetRemove: (id: string) => req<PieceSets>('DELETE', `/api/pieces/${encodeURIComponent(id)}`),
  resetBotProgress: () => req<BotProgress>('DELETE', '/api/bot/progress'),
  endgames: () => req<EndgameSummary>('GET', '/api/endgames'),
  endgameNew: (drill: string) => req<EndgamePosition>('POST', '/api/endgames/new', { drill }),
  endgamePlay: (drill: string, fen: string, moves: string[], mode: EndgameMode, level: number | null) =>
    req<EndgameReply>('POST', '/api/endgames/play', { drill, fen, moves, mode, level }),
  endgameHint: (drill: string, fen: string, moves: string[]) =>
    req<{ uci: string; san: string }>('POST', '/api/endgames/hint', { drill, fen, moves }),
  endgameFinish: (body: { drill: string; mode: EndgameMode; result: 'success' | 'fail'; moves: number; optimal: number | null; takebacks: number; hints: number }) =>
    req<Partial<Record<EndgameMode, EndgameModeRecord>>>('POST', '/api/endgames/finish', body),
  reviewsOutdated: () => req<{ count: number; plies: number; version: number; active: boolean }>('GET', '/api/reviews/outdated'),
  upgradeReviews: () => req<{ queued: number }>('POST', '/api/reviews/upgrade'),
}
