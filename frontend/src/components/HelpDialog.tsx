import type { ReactNode } from 'react'
import { CLS, ClassIcon, SUMMARY_ORDER } from '../lib/classes'
import { Modal } from './ui'

export const HELP_EVENT = 'brilliant-help'
/** Open the help from anywhere (e.g. a "How does this work?" link on a page). */
export const openHelp = () => window.dispatchEvent(new Event(HELP_EVENT))

/** Plain-language help: how to get started, what the move labels mean, and the words used in the app. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="How Anne's Chess Kit works" wide>
      <div className="space-y-7 text-sm leading-relaxed text-ink-200">
        <Section title="Getting started">
          <ol className="space-y-3">
            <Step n={1} title="Load your games">
              On <b>Home</b>, type your Chess.com or Lichess username and press <b>Load</b>. Your games are copied to your
              computer once; later only new games are fetched.
            </Step>
            <Step n={2} title="Let the computer check them">
              Tick the games you want (or use <b>Analyze the newest games</b>) and press <b>Analyze</b>. The chess engine
              looks at every move. A game takes about a minute – you can keep using the app meanwhile.
            </Step>
            <Step n={3} title="Look at the review">
              Open a game to see every move rated, the moves you should have played, and short explanations.
              Use the arrow keys or the move list to step through it.
            </Step>
            <Step n={4} title="Practise what you got wrong">
              <b>Coach</b> shows what to work on today. <b>Puzzles</b> are made from your own mistakes, and the
              <b> Instructive bot</b> is an opponent that rates your moves while you play.
            </Step>
          </ol>
        </Section>

        <Section title="What the move labels mean">
          <div className="grid gap-2 sm:grid-cols-2">
            {SUMMARY_ORDER.map(c => (
              <div key={c} className="flex gap-2.5 rounded-lg bg-white/[0.03] p-2.5">
                <ClassIcon cls={c} size={20} />
                <div>
                  <div className="font-semibold" style={{ color: CLS[c].color }}>{CLS[c].label}</div>
                  <div className="text-xs text-ink-400">{CLS[c].desc}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Words you'll see">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Term name="Accuracy">How close your moves were to the best ones, from 0 to 100. Higher is better; compare it with your own earlier games rather than with strong players.</Term>
            <Term name="Evaluation (+1.5, −3, M2)">Who is better and by how much, counted in pawns: +1.5 means White is about one and a half pawns ahead, −3 that Black is three pawns ahead. M2 means mate in 2.</Term>
            <Term name="Engine (Stockfish)">The chess program that checks your moves. It runs on your own computer.</Term>
            <Term name="Best line">The moves the engine would play from here – shown as arrows on the board.</Term>
            <Term name="Book move">A well-known opening move. It isn't rated.</Term>
            <Term name="Puzzles (Woodpecker method)">The same set of puzzles solved again and again, a bit faster each time, until the patterns stick.</Term>
            <Term name="Calculate first">A switch in the puzzles: you enter the whole line – your moves and the replies you expect – and only then it is checked. Trains working a line out in your head instead of trying one move at a time.</Term>
            <Term name="Instructive bot (Maia)">A bot trained on millions of human games, so it plays like a real person at the rating you pick.</Term>
            <Term name="Daily goal and streak">Every bit of practice earns points. Reach your daily goal to keep your streak of days going.</Term>
          </dl>
        </Section>

        <Section title="Good to know">
          <ul className="list-disc space-y-1.5 pl-5 text-ink-300">
            <li>Everything runs on your computer. Nothing is uploaded; the app only downloads your games from Chess.com or Lichess.</li>
            <li>Not sure what a button does? Hover over it – most have a short explanation.</li>
            <li><b>Back</b> (top of the sidebar) returns to the page you came from. Alt+← and the back button on your mouse do the same.</li>
            <li>Press <b>Ctrl+K</b> to jump to any page or game.</li>
            <li>Analysis speed and your accounts are under <b>Settings</b> (bottom left).</li>
          </ul>
        </Section>
      </div>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2.5 font-display text-base font-semibold text-ink-100">{title}</h3>
      {children}
    </section>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{n}</span>
      <div><div className="font-semibold text-ink-100">{title}</div><div className="text-ink-300">{children}</div></div>
    </li>
  )
}

function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-semibold text-ink-100">{name}</dt>
      <dd className="text-ink-400">{children}</dd>
    </div>
  )
}
