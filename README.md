# NYCC Photo Hunt

A photo scavenger-hunt bingo game for New York Comic Con. Make a hero profile, start a game, snap photos of what you find, and race your friends.

**Live site:** https://benczerwin.github.io/comic-con-scavenger-hunt/

## Modes

- **Bingo Hunt:** every player gets their own card (3×3 to 7×7). Tap a square, take a photo, and it's marked. Win rules (chosen per game):
  - *First line*: first full row, column or diagonal
  - *Blackout*: first to fill the whole card
  - *Most points*: timed; 1 pt per photo, +3 per line, +10 for a blackout
  - Options: same card for everyone, free center square
- **Showdown:** one shared board, tic-tac-toe style. The first photo claims a square with your emblem. Get N in a row to win (you choose N). If the board fills up, whoever has the most squares wins.
- **Backups:** each player gets 1 (3×3, 4×4), 2 (5×5) or 3 (6×6, 7×7) backup items they can swap into any unmarked square.
- Any number of players (including solo). Anyone can join mid-game with the code or link.

The item bank (`js/data/items.js`) has ~300 ideas tiered easy / medium / hard. Easy ones are thematic (tails, wings, horns…); hard ones are rare or hot-right-now characters.

## How it works

- Static site (no build step): Preact + htm, served from GitHub Pages.
- **Firebase Firestore** for live sync. Photos are compressed on the phone (~360px thumb + ~1280px full) and stored as Firestore docs, so no Firebase Storage or billing is needed.
- Offline-tolerant: Firestore's local cache keeps the board usable on bad Wi-Fi and syncs when back online. (Showdown claims need a connection so two people can't claim the same square.)
- Without a Firebase config the app runs in **demo mode** (localStorage; syncs between tabs on one device only). Add `?local` to the URL to force demo mode.

## Setup

1. Firebase console → create project → **Firestore Database** → create (test mode is fine).
2. Project settings → Your apps → **Web app** → copy the config into `js/firebase-config.js`.
3. Optional: paste `firestore.rules` into Firestore → Rules (open access to this app's collections until Jan 2027).
4. Push to `main`; GitHub Pages serves the repo root.

### Run locally

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123.

## Files

| Path | What |
| --- | --- |
| `js/app.js` | All screens & UI |
| `js/game.js` | Card generation, lines, scoring |
| `js/data/items.js` | The hunt idea bank |
| `js/data/emblems.js` | Player emblems (SVG) |
| `js/store*.js` | Firestore / local-demo backends |
| `js/photo.js` | On-device photo compression |
