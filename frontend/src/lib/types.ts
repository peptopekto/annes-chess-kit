export type Cls =
  | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book'
  | 'inaccuracy' | 'mistake' | 'miss' | 'blunder' | 'forced'

export type Color = 'w' | 'b'
/** White's point of view. `mate: 0` is a checkmate on the board; `winner` says who gave it. */
export type Eval = { cp?: number; mate?: number; winner?: Color }

export interface MoveRec {
  ply: number
  san: string
  uci: string
  color: Color
  fenBefore: string
  fen: string
  cls: Cls
  loss: number
  epBest: number
  epAfter: number
  bestUci: string
  bestSan: string
  bestLine: string[]
  bestEval: Eval
  secondUci: string | null
  eval: Eval
  evalText: string
  sacrifice: number
  text: string
  check: boolean
  capture: boolean
  /** Opponent's punishing reply after a bad move (added when the review is opened). */
  refute?: { san: string; uci: string; line: string[]; theme: string | null; label: string | null }
  /** The tactic you missed with this move, if any. */
  missed?: { theme: string; label: string }
  /** Plain-language coaching: what went wrong / what the move does, and what was better. */
  coach?: { why: string; better: string | null; before: string; after: string }
  /** The positional principle behind a bad move, when the concept detectors and the engine's lines agree. */
  principle?: Principle
}

/** A model position from a lesson card: the position, a short line that shows the idea, and what to look at. */
export interface CardExample {
  title: string
  fen: string
  line: string[]
  side: Color
  note: string
}

/** A lesson card (backend/data/coach/*.yaml). */
export interface LessonCard {
  id: string
  concept: string
  title: string
  level: 'beginner' | 'improver' | 'club'
  phase: string[]
  family: string
  principle: string
  explanation: string
  ask_yourself: string
  exceptions: string[]
  source: string
  related: string[]
  examples: CardExample[]
}

/** A card as taught for one move. */
export interface PrincipleConcept extends LessonCard {
  card: string
  /** Whose position it's about: the mover's own (they created a weakness) or the other side's (they let it improve). */
  side: 'own' | 'other'
  /** What happened in this game, already worded for whoever moved. */
  inGame: string
  /** Squares to mark on the board after the move. */
  squares: string[]
  strength: number
  /** On your opponent's move: what it gave you and how to use it, and the engine's line for doing so. */
  chance?: string
  replyLine?: string
  /** Your verdict, if you gave one: does the lesson fit this move? */
  fits?: boolean
}

export interface Principle {
  phase: 'opening' | 'middlegame' | 'endgame'
  concepts: PrincipleConcept[]
}

export interface GameSummary {
  id: string
  white: string
  black: string
  whiteElo: string
  blackElo: string
  result: string
  date: string
  timeControl: string
  plies: number
  opening: { eco: string; name: string } | null
  me: Color | null
  accuracy: { w: number | null; b: number | null }
  counts: { w: Partial<Record<Cls, number>>; b: Partial<Record<Cls, number>> }
  analysedAt: number
  playedAt: number
  source: string | null
  url: string | null
}

export interface GameRecord extends GameSummary {
  headers: Record<string, string>
  startFen: string
  depth: number
  /** The rating-aware win-probability curve the review was made with. */
  ratingModel?: { rating: number | null; k: number }
  /** Seconds per move for a time-limited review (then `depth` is the cap and `depthReached` the average). */
  moveTime?: number | null
  depthReached?: number | null
  startEval: Eval
  winPct: number[]
  moves: MoveRec[]
  pgn: string
  habits?: { key: string; title: string; fix: string; plies: number[] }[]  // your bad habits seen in this game
  /** Seconds spent on each move and the clock left after it (from the PGN's clock comments); null without clocks. */
  moveTimes?: { spent: (number | null)[]; clock: (number | null)[]; base: number | null; inc: number } | null
  end?: GameEnd | null  // how the game ended (checkmate, stalemate, repetition, resignation…)
}

export interface GameEnd { reason: string; text: string; winner: Color | null; result?: string }

export interface LibraryGame {
  id: string | null
  source: 'chess.com' | 'lichess'
  url: string
  white: string
  black: string
  whiteElo: string
  blackElo: string
  myColor: Color
  outcome: 'win' | 'loss' | 'draw'
  timeClass: string
  endTime: number
  moves: number
  review: { id: string; accuracy: number | null } | null
}

export interface LibrarySync { state: 'idle' | 'syncing' | 'error'; fetched: number; error: string | null }
export interface Library { games: LibraryGame[]; syncedAt: number | null; status: LibrarySync }

export interface ParsedGame {
  white: string
  black: string
  whiteElo: string
  blackElo: string
  result: string
  date: string
  event: string
  timeControl: string
  plies: number
  pgn: string
  analysedId: string | null
}

export interface Settings {
  chesscom_username: string
  lichess_username: string
  aliases: string[]
  /** Reviews search each position to a fixed depth, or for a time per move (up to max_depth). */
  analysis_mode: 'depth' | 'time'
  depth: number
  move_time: number
  max_depth: number
  /** Analysis engines (one CPU thread each); 0 = automatic. */
  engine_threads: number
  sounds: boolean
  volume: number
  batch_size: number
  puzzle_csv: string
}

export interface SystemInfo {
  version: string
  engine: boolean; enginePath: string | null
  /** Lc0 + Maia networks present (Nightmare, human opponents in Endgames). */
  maia: boolean
  tablebase: boolean
  cpus: number; autoEngines: number; engines: number
  /** When this server started; missing on versions from before the update check. */
  started?: number
  /** Code or UI changed after the server started: the app needs a restart. */
  outdated?: boolean
}

export interface QueueJob {
  id: number
  title: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  done: number
  total: number
  fen: string | null
  gameId: string | null
  error: string | null
  source: string | null
  url: string | null
  depth: number
  moveTime: number | null
  summary: { me: Color | null; accuracy: number | null; counts: Partial<Record<Cls, number>>; white: string; black: string; result: string } | null
}

export interface QueueCounts { queued: number; running: number; done: number; error: number; cancelled: number }
export interface QueueState { jobs: QueueJob[]; counts: QueueCounts }

export interface QueueGameIn { pgn: string; title?: string; source?: string; url?: string }

export interface Trophies {
  total: number
  items: Highlight[]
  counts: { brilliant: number; great: number; mistakes: number }
}

export interface Highlight {
  gameId: string
  white: string
  black: string
  date: string
  ply: number
  san: string
  uci: string
  color: Color
  cls: Cls
  fenBefore: string
  bestUci: string
  bestSan: string
  text: string
  loss: number
}

export interface EngineLine {
  uci: string
  san: string
  eval: Eval
  evalText: string
  line: string[]
}

export interface CheckResult {
  /** Stockfish's answer to the move (how a strong opponent punishes it). */
  replyUci?: string | null
  replySan?: string | null
  cls: Cls
  loss: number
  san: string
  bestSan: string
  bestUci: string
  text: string
  eval: Eval
  evalText: string
}

// ---- Woodpecker (same shape as the old trainer's JSON) ----
export interface Puzzle {
  id: string
  fen: string
  moves: string[]
  rating: number | null
  length?: number
  themes: string[]
  engineCheck?: boolean
  /** Equally good first moves (UCI), precomputed for puzzles from your games. */
  alternatives?: string[]
  /** Accepted moves for each move you have to find (precomputed). */
  altSteps?: string[][]
  /** What to look for, e.g. "Find the fork" (shown only after solving). */
  goal?: string
  /** Habit tip for the puzzle's theme. */
  tip?: string
  gameId?: string
  ply?: number
  played?: string
  /** The recurring mistake of yours this puzzle trains, and how often it happened in your games. */
  pattern?: { key: string; label: string; count: number; games: number }
  /** You made this very mistake (same position, same move) in this many games. */
  repeat?: number
}

export interface TrainingMastery {
  key: string; label: string
  mistakes: number; weight: number
  /** Puzzles of this pattern you solved, and the share on the first try. */
  solved: number; firstTry: number | null
  /** How often it happens per game lately, and in the games before that. */
  perGame: number; perGameBefore: number | null
}

export interface Training {
  goal: number; goals: number[]
  today: { points: number; counts: Record<string, number>; minutes: number }
  goalMet: boolean; streak: number; bestStreak: number; nextMilestone: number | null
  week: number; daysTrained: number
  calendar: { day: string; points: number }[]
  mastery: TrainingMastery[]
}

export interface RunStats {
  timestamp: string
  total_puzzles: number
  total_time: number
  correct_first_try: number
  puzzles_data: Record<string, { time: number; attempts: number; correct_first: boolean }>
}

export interface SetMeta {
  name: string
  amount: number
  min_rating?: number
  max_rating?: number
  min_length?: number
  max_length?: number
  created_at?: string
  source?: string
  completed_runs: RunStats[]
  active_progress?: { current_idx: number; stats: RunStats; accumulated_time: number } | null
}

export interface SetSummary {
  id: string
  meta: SetMeta
  count: number
  activeIdx: number | null
}

export interface PuzzleSet {
  id: string
  metadata: SetMeta
  puzzles: Puzzle[]
}

// ---- Insights ----
export interface MoveRef {
  gameId: string; ply: number; san: string; cls: Cls; bestSan: string; fenBefore: string
  white: string; black: string; date: string
}
/** [game id, ply] of every position a drill may build puzzles from (newest first, more than the examples). */
export type DrillPool = [string, number][]
export interface RateRow { bucket: string; moves: number; errorRate: number | null; blunderRate: number | null }
export interface Core {
  games: number
  accuracy: number | null
  blundersPerGame: number | null
  errorsPer40: number | null
  winRate: number | null
  rating: number | null
  opening: number | null
  middlegame: number | null
  endgame: number | null
  hung_piece: number | null
  allowed_mate: number | null
  missed_mate: number | null
  missed_punish: number | null
  missed_tactic: number | null
}
export interface TrendPoint extends Core { label: string; start: number; end: number }
export interface Trend { bucket: string; points: TrendPoint[] }

export interface Insights {
  span?: [number, number] | null
  allSpan?: [number, number] | null
  core?: Core | null
  baseline?: Core | null
  games: number
  moves: number
  timeClasses: string[]
  accuracy?: number | null
  blundersPerGame?: number
  errorsPer40?: number
  record?: { win: number; draw: number; loss: number }
  phases?: { phase: string; moves: number; accuracy: number | null; errorRate: number | null; blunders: number; lossPerMove: number | null; examples: MoveRef[]; drill?: DrillPool; count: number }[]
  clock?: { moves: number; remaining: RateRow[]; spent: RateRow[] }
  tags?: { tag: string; label: string; count: number; games: number; examples: MoveRef[]; drill?: DrillPool }[]
  pieces?: { piece: string; moves: number; errors: number; blunders: number; errorRate: number | null }[]
  openings?: { name: string; color: Color; games: number; score: number; accuracy: number | null; openingAccuracy: number | null }[]
  thrown?: (MoveRef & { peak: number; outcome: string; moves: number })[]
  thrownCount?: number
  comebackCount?: number
  comebacks?: { gameId: string; white: string; black: string; date: string; low: number; outcome: string }[]
  summary: { kind: string; tone: 'good' | 'bad'; text: string; tag?: string }[]
  focus?: { theme: string; title: string; text: string; tip: string; drill?: string } | null
  tacticsAgainst?: TacticRow[]
  tacticsMissed?: TacticRow[]
  endings?: Record<'win' | 'loss' | 'draw', { reason: string; label: string; count: number }[]>
  habits?: {
    games: number; castleRate: number; avgCastleMove: number | null; kingsideShare: number | null
    earlyQueenRate: number; underdevelopedRate: number; avgBookExit: number | null
    scoreCastledBy10: number | null; gamesCastledBy10: number; scoreNotCastledBy10: number | null; gamesNotCastledBy10: number
    scoreEarlyQueen: number | null; scoreNoEarlyQueen: number | null
  }
  vsRating?: { label: string; games: number; score: number | null; accuracy: number | null }[]
  conversion?: { winningGames: number; converted: number | null; losingGames: number; saved: number | null }
  tilt?: { samples: number; rate: number | null; baseline: number | null }
  colors?: Record<'w' | 'b', { games: number; score: number | null; accuracy: number | null }>
}
export interface TacticRow { theme: string; label: string; tip: string; count: number; games: number; examples: MoveRef[]; drill?: DrillPool }

// ---- Opening trainer ----
export interface RepNode {
  epd: string; fen: string; ply: number; user: boolean; parent: string | null; via: string | null; viaSan: string | null
  name: string; visits: number; children: Record<string, string | null>
  main?: string; mainSan?: string; allowed?: string[]; allowedSan?: string[]; source?: 'book' | 'yours' | 'engine'
  played?: { uci: string; san: string; count: number }[]
  replies?: { uci: string; san: string; count: number; book: boolean }[]
}
export interface RepMistake {
  epd: string; fen: string; ply: number; name: string; parentFen: string | null; via: string | null; viaSan: string | null
  played: string; playedSan: string; count: number; loss: number; main: string; mainSan: string
  allowed: string[]; allowedSan: string[]; source: string; path: string[]
}
export interface Repertoire {
  family: string; color: Color; root: string; nodes: Record<string, RepNode>; mistakes: RepMistake[]
  built: number; games: number; stats: Record<string, { ok: number; fail: number; last?: number }>
}
export interface MyOpening { family: string; color: Color; games: number }

// ---- Blunder check ----
export interface SafetyCard {
  id: string; gameId: string; ply: number; fen: string; uci: string; san: string; date: string; safe: boolean
  risky?: boolean; why?: string; theme?: string; label?: string; tip?: string; refute?: { san: string; uci: string; line: string[] }
}
export interface SafetySummary { sessions: { at: number; right: number; total: number; seconds: number }[]; best: number | null; toReview: number }
export interface SafetyHub {
  sessions: { at: number; right: number; total: number; seconds: number; mode?: string }[]
  totals: { sessions: number; answered: number; correct: number; seconds: number }
  missedDangers: { n: number; missed: number }
  falseAlarms: { n: number; wrong: number }
  recentAccuracy: number | null
  themes: { theme: string; label: string; seen: number; spotted: number; rate: number }[]
  toReview: number
  seenCards: number
}

export interface NightmareTrapReply { uci: string; san: string; prob: number; loss: number; theme: string | null; label: string | null; punish: string[] }
export interface NightmareMove {
  uci: string; san: string; level: number; youLevel: number; humanP: number
  trap: { value: number; bad: NightmareTrapReply[] } | null
  opening: { games: number; extra: number } | null
  /** Set when the move came from a gambit line. */
  gambit?: { id: string; name: string; idea: string } | null
  rank?: number
}
/** A gambit the Instructive bot can play (backend/data/gambits.yaml). */
export interface NightmareGambit { id: string; name: string; bot: Color; against: string; idea: string; line: string }
export interface NightmareSummary {
  available: boolean
  rating: number; level: number; levels: number[]; reviewed: number
  /** Where the rating comes from: your latest games on one site (`auto`), or one you set (`manual`). */
  ratingInfo?: { rating: number; auto: number | null; site: string | null; manual: boolean }
  themes: { theme: string; label: string; count: number }[]
  openings: { name: string; games: number; rate: number }[]
  record: { played: number; won: number; drawn: number; lost: number; traps: number; fell: number }
  recent: { at: number; result: 'win' | 'draw' | 'loss'; color: Color; level: number; traps: number; fell: number; moves: number }[]
}

export interface CoachRef extends MoveRef { uci: string | null; bestUci: string | null; loss: number }
export interface CoachHabit {
  key: string; title: string; why: string; fix: string
  count: number; games: number; pct: number; recentPct: number | null; beforePct: number | null
  cost: number; impact: number; recentImpact: number | null; examples: CoachRef[]; drill?: DrillPool
  history?: number[]  // share of games per block of 100 games, oldest first
}
export interface CoachRepeat {
  fenBefore: string; san: string; uci: string | null; bestSan: string; bestUci: string | null
  times: number; reached: number; cost: number; moveNo: number; lastGame: string; lastPly: number; refs: CoachRef[]
}
export interface CoachReport {
  games: number; recentGames: number; beforeGames: number
  habits: CoachHabit[]; repeats: CoachRepeat[]; repeatTotal: number; checklist: { key: string; question: string }[]
  strengths?: CoachNote[]; warnings?: CoachNote[]; plan?: CoachPlanItem[]
}

export interface StatBlock { games: number; score: number | null; accuracy: number | null; wins: number; draws: number; losses: number }
export interface StatBucket extends StatBlock { bucket: string; blunders: number | null }
export interface StatsReport {
  games: number; recentGames: number; beforeGames: number
  record: { all: StatBlock; recent: StatBlock; white: StatBlock; black: StatBlock
    streak: { kind: 'win' | 'draw' | 'loss' | null; n: number }; bestWinStreak: number; bestUnbeaten: number }
  ratings: { source: string; tc: string; games: number; current: number; peak: number; low: number; change90: number | null
    points: { month: string; elo: number }[] }[]
  activity: { date: string; games: number; score: number }[]
  timing: { hours: StatBucket[]; weekdays: StatBucket[]; session: StatBucket[]; after: StatBucket[] }
  breakdown: { length: StatBucket[]; opponent: StatBucket[]; timeControl: StatBucket[] }
  records: { key: string; title: string; value: string; gameId?: string; opponent?: string; date?: string; detail?: string }[]
  trend: { key: string; label: string; unit: string; higherBetter: boolean; recent: number; before: number | null; all: number | null
    delta: number | null; better: boolean | null; notable: boolean }[]
}
export interface CoachNote { key: string; title: string; text: string; tip?: string }
export interface CoachPlanItem { key: string; title: string; why: string; action: string; habit?: string }

export type EndgameGoal = 'mate' | 'promote' | 'win' | 'draw'
export type EndgameMode = 'perfect' | 'human'
export interface EndgameModeRecord { attempts: number; solved: number; clean: number; streak: number; best: number | null; perfect?: number; last?: number }
export interface EndgameDrill {
  id: string; group: string; title: string; goal: EndgameGoal; goalText: string; level: number
  blurb: string; tip: string; survive: number
  /** How the pattern works: the idea, when to look for it, the plan step by step, common mistakes. */
  lesson?: { idea: string; spot?: string[]; steps: string[]; mistakes?: string[] } | null
  record: Partial<Record<EndgameMode, EndgameModeRecord>>
}
export interface EndgameSummary { drills: EndgameDrill[]; maia: boolean; levels: number[]; level: number | null; tablebase: boolean }
export interface EndgameEval { verdict: 'win' | 'draw' | 'loss' | 'unclear'; cp: number | null; mate: number | null; tb: boolean }
export interface EndgamePosition { fen: string; you: Color; eval: EndgameEval; optimal: number | null }
export interface EndgameStatus { result: 'success' | 'fail'; reason: string }
export interface EndgameReply {
  eval: EndgameEval; slipped: boolean; status: EndgameStatus | null
  reply: { uci: string; san: string } | null; better?: { uci: string; san: string }
}

// ----- you vs the players at your rating (backend/app/peers.py) -----
export type PeerGroup = 'you' | 'level' | 'stronger' | 'weaker'

export interface PeerMetric {
  key: string
  label: string
  section: string
  better: 'higher' | 'lower' | null
  unit: string
  you: number | null
  level: number | null
  stronger: number | null
  weaker: number | null
  youGames: number
  levelGames: number
  strongerGames: number
  weakerGames: number
  /** Standard errors by which you're better (+) or worse (−) than your level. */
  vsLevel: number | null
  /** …and by which stronger players are better than your level. */
  levelVsStronger: number | null
}

export interface PeerFinding {
  key: string
  label: string
  you: number | null
  level: number | null
  stronger?: number | null
  z: number
  text: string
}

export interface PeerCurveRow {
  from: number
  to: number
  opponents: number
  oppAccuracy: number | null
  oppBlunders: number | null
  you: number
  accuracy: number | null
  blunders: number | null
}

export interface PeerGroupInfo {
  games: number
  results: { games: number; score: number; expected: number; diff: number } | null
}

export interface Peers {
  games: number
  band: number
  far: number
  minGames: number
  zReal: number
  timeClasses: string[]
  platforms: string[]
  rating: { now: number | null; median: number | null; min: number | null; max: number | null }
  groups: Record<'level' | 'stronger' | 'weaker', PeerGroupInfo>
  metrics: PeerMetric[]
  concepts: { concept: string; title: string; you: number; level: number; z: number | null }[]
  curve: Record<string, PeerCurveRow[]>
  findings: { weaknesses: PeerFinding[]; strengths: PeerFinding[]; climb: PeerFinding[] }
}

/** A game against the Nightmare bot. */
export interface BotGame {
  at: number
  result: 'win' | 'draw' | 'loss' | null
  color: Color
  level: number | null
  moves: number
  traps: number | null
  fell: number | null
  /** Kept for games not reviewed yet, to send to the analysis. */
  pgn: string | null
  review: { id: string; accuracy: number | null; counts: Record<string, number> | null } | null
}

// ----- Instructive bot: XP, levels, statistics, collection (backend/app/botprogress.py) -----
export interface BotLevelInfo { level: number; title: string; xp: number; into: number; needed: number; next: number }
export interface BotGameScore {
  at: number; result: 'win' | 'draw' | 'loss'; color: Color; maia: number; strength: number; focus: number
  takebacks: number; explored?: boolean; moves: number; counts: Partial<Record<Cls, number>>; accuracy: number | null
  /** XP added to your total; `earned` is what the game was worth (less when the position had paid before). */
  xp: number; earned?: number; mode?: 'game' | 'convert'; spot?: string
}
export interface BotCollected { at: number; ply: number; fen: string; san: string; uci: string; cls: Cls; maia: number; color: Color }
export interface BotProgress extends BotLevelInfo {
  since: number | null
  record: { played: number; won: number; drawn: number; lost: number }
  /** Convert-your-wins games. */
  convert?: { tried: number; positions?: number; won: number; drawn: number; lost: number }
  streak: number; bestStreak: number; bestWin: number | null
  accuracy: number | null; recentAccuracy: number | null
  moves: number; counts: Partial<Record<Cls, number>>; goodShare: number | null; badShare: number | null
  perGame: Partial<Record<Cls, number | null>>
  levels: { maia: number; games: number; score: number; accuracy: number | null }[]
  recent: BotGameScore[]
  collection: BotCollected[]; collectionSize: number
  achievements: { id: string; name: string; desc: string; earned: boolean }[]
}
/** What one finished game added (shown after the game). */
export interface BotGameResult {
  gained: number; before: BotLevelInfo; after: BotLevelInfo; levelUp: boolean
  /** What the game was worth; for a Convert position played before, `previous` is the XP it had paid already. */
  earned?: number; previous?: number | null; repeat?: boolean
  game: BotGameScore; collected: BotCollected[]; difficulty: number
}

/** A position from your games where you were clearly winning – and then lost (not on time). */
export interface ConvertSpot {
  id: string; gameId: string; ply: number; fen: string; color: Color
  /** Your winning chances (%) here, and the highest they got in that game. */
  win: number; peak: number
  opponent: string; oppElo: number | null; elo: number | null
  date: string; playedAt: number; outcome: 'loss' | 'draw'; end: string; source: string | null; moveNumber: number
  /** Your costliest move after this point. */
  threw: { ply: number; san: string; cls: Cls; bestSan: string | null }
  /** Your attempts at this position against the bot, if any. */
  played?: { tries: number; best: 'win' | 'draw' | 'loss' | null; xp: number } | null
}

/** A piece set: the built-in one or a free set that can be downloaded once. */
export interface PieceSet { id: string; name: string; author: string; license: string; downloaded?: boolean }
export interface PieceSets { builtin: PieceSet; sets: PieceSet[] }
