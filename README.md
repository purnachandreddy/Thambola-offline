# Tambola (Housie) — fully offline, browser-based

No internet needed. No app store. One computer runs a tiny local server; everyone else joins
from their phone's browser over the same Wi-Fi.

## What you need

- **Node.js** installed on ONE computer (the "host" computer). Download it free from
  https://nodejs.org (the "LTS" version). This is the only piece of software to install.
- Everyone else needs nothing installed — they just open a link in their phone's browser
  (Safari, Chrome, whatever they already have).
- All devices (the host computer + every player's phone) must be on the **same Wi-Fi network**,
  or the host computer's own phone hotspot with everyone connected to it.

## How to run it

1. Copy this whole folder onto the host computer.
2. Open a terminal / command prompt in this folder.
3. Run:
   ```
   node server.js
   ```
4. It will print something like:
   ```
   Host, open this on THIS computer:  http://localhost:8189
   Players join on the same Wi-Fi:    http://192.168.1.23:8189
   ```
   It also tries to open the host page in your browser automatically.
5. On the host computer, in the page that opened: tap **"Create a game"**, click through the
   short explainer, adjust settings if you like, then **"Open the lobby"**.
6. The lobby shows a **QR code** and a **4-digit PIN**. Players scan the QR code with their
   phone's camera (or open their own browser to the player link and enter the PIN manually) —
   this is the "scan a QR to join" flow.
7. When everyone's in, tap **"Start game"** on the host screen. Numbers get called from the
   host device; players tap their own ticket to mark numbers and use the Claim buttons to win
   prizes.
8. To stop for the night, close the terminal window (Ctrl+C) or just close the browser tabs.

That's it — nothing is installed on any player's phone, and nothing ever leaves your Wi-Fi.

## If something goes wrong

- **"Can't reach the Tambola server"** on the landing page: the terminal window running
  `node server.js` got closed, or the page was opened before the server finished starting.
  Reopen the terminal, run `node server.js` again, reload the page.
- **A player can't connect**: double-check their phone is on the *same* Wi-Fi network as the
  host computer (not on mobile data). If the host computer has more than one network adapter
  (e.g., Wi-Fi + Ethernet), the lobby screen lets you pick which network address to show in
  the QR code.
- **More than ~8–10 players using a phone hotspot**: phone hotspots usually cap out around
  8–10 connected devices. For bigger games, use a real Wi-Fi router (or a small travel router)
  instead of a phone's hotspot. The settings screen has a note about this and switches its
  recommendation automatically based on player count.
- **Port already in use**: the server automatically tries the next port (8190, 8191, …) up to
  8199, and prints whichever one it actually used.

## What's in this folder

- `server.js` — the local server. Plain Node.js, no install step (`npm install`) required.
- `public/` — the actual app (host page, player page, game engine, styling). You shouldn't need
  to touch these, but they're plain, readable HTML/CSS/JS if you ever want to tweak something.
- `tests/` — automated tests for the game logic, the server, and the UI, in case you want to
  verify changes later:
  - `node --test tests/engine.test.js` — game rules and the state machine
  - `node --test tests/server.test.js` — the relay itself (port fallback, framing, CORS, etc.)
  - `node --test tests/scale.test.js` — a full 90-player stress test: real relay, real game
    engine, 90 real connections joining at once, calling numbers, and racing to claim the same
    prize, confirming the app holds up at its maximum player count
  - `node --test tests/live_ui_walkthrough.test.js` — drives the actual host and player pages
    end to end (real clicks, real WebSocket traffic, real rendered output checked at each step):
    creating a room, joining, dealing a ticket, calling numbers, tapping to mark, and claiming a
    prize, with both screens checked live against each other
