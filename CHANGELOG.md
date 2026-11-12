# Changelog

## 1.0.1

Fixes:

- The re-check of Brilliant moves in older reviews crashed for every game, so those moves were never
  confirmed or downgraded. It runs again now (in the background after the start).
- "Drill these positions" in Coach and My mistakes found no puzzles for "Not punishing your opponent's
  mistakes": positions right after an opponent's error were always left out. Drills of chosen positions
  keep them now (the general puzzle sets still don't).
- Drills built only from the 60 newest examples, so most gave just a handful of puzzles. They now pick
  from up to 400 positions of the category. If none makes a clear puzzle, the message says why.
- The summary cache of your reviews is saved right after a reboot too (it waited a minute before).

Downloads and project:

- Building the Windows downloads works on a fresh PC: python-chess is built inside the bundled Python,
  and Inno Setup is found when installed just for you (winget). GitHub Actions use the Node 24 versions.
- New screenshots of the analysis pages.

## 1.0.0 – first public release, as Anne's Chess Kit

The project was developed under the working name "Brilliant". Data from that version (the `userdata` folder)
works unchanged; `BRILLIANT_USERDATA` is still read if `CHESSKIT_USERDATA` isn't set.

- Game review with Stockfish: accuracy, Brilliant / Great / Best … Mistake / Miss / Blunder ratings,
  coach explanations worded for whoever moved, best lines, retry your mistakes, annotated PGN export.
- Import from Chess.com and Lichess (full history, kept locally) or PGN; background batch analysis.
- Analysis to a fixed depth or for a fixed time per move, with adjustable CPU use.
- Progress dashboard, Insights and Coach: your record, rating, accuracy trends, recurring habits,
  repeated mistakes and a training plan.
- Training: opening trainer, Blunder check, Woodpecker puzzle sets (from your own mistakes or the Lichess
  puzzle database) with a calculation mode, Endgames trainer with explanations and a control overlay, and
  the Instructive bot – a human-like opponent (Maia) with live coaching, gambits, XP and a Nightmare mode
  that plays for your weaknesses.
- Board and piece themes (free piece sets can be downloaded in Settings), material difference on every
  board, premoves.
- Windows downloads: installer and portable zip with their own Python and the engines; licences of
  everything included travel with them.
