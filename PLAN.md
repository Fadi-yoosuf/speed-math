# Speed Math — Plan

A browser car-race game where kids win by solving arithmetic fast.
Think TypeRacer, but the "text" is a stream of sums, and every correct
answer pushes your car one notch closer to the chequered flag.

No accounts, no history, no database. One kid opens a room, the others
join with a four-letter code, the host presses **Start**, and the race is
live for everyone at once.

---

## 1. How a race feels (the player's view)

1. **Host** opens the site and taps **New race**. A big room code appears
   (e.g. `FROG`), plus a QR code and the link to join.
2. **Players** open the link on their phone, tablet or laptop, type the
   code, pick a nickname and a car (emoji + colour), and choose a
   **level** (so a 6-year-old and a 10-year-old can race in the same room).
3. The **lobby** shows all cars lined up on the start grid. Latecomers
   appear as they join. The host can tweak settings while waiting.
4. Host presses **Start** → everyone sees a **3-2-1-GO** countdown.
5. Each player gets a question like `7 × 8`. Type the answer:
   - **Correct** → *vroom*, the car jumps one segment forward, next
     question appears instantly.
   - **Wrong** → the car *skids* (red flash, short stall), the same
     question stays. Guessing costs more than thinking.
6. Everyone sees all cars moving in real time across the track.
7. First across the line wins. The race ends when everyone finishes or
   20 seconds after the first finisher ("flag timer"), or when the host
   ends it.
8. **Podium** screen: 🥇🥈🥉 with time, accuracy and longest streak.
   Confetti for the winner. Buttons: **Race again** (same room, new
   questions) or **Back to garage** (lobby, change settings).

Nothing is saved. Close the tab and it is gone.

---

## 2. Game design

### 2.1 Rooms and lobby

| Item | Decision |
|---|---|
| Room code | 4-letter word from a curated kid-safe list (`FROG`, `MOON`, `JAZZ` …). Easy to shout across a room, easy to type on a tablet. |
| Join | Code + nickname (≤ 12 chars, profanity-filtered) + car + level. No login. |
| Players per room | 1–12 (one track lane each). Solo play allowed for practice. |
| Host | Whoever created the room. Host badge passes to the longest-connected player if the host drops. |
| Late joiners | Can watch the current race, auto-included in the next one. |
| Reconnect | Player token kept in `sessionStorage`. A refresh or Wi-Fi blip brings you back to your own car. |
| Room lifetime | Deleted after 30 min with nobody connected. |
| TV mode | `/tv/FROG` is a read-only, big-font view of the track for the living-room TV or a projector, while the kids play on their own devices. |

### 2.2 Host settings

- **Operations**: any mix of `+`, `−`, `×` (checkboxes).
- **Race length**: 10 / 20 / 30 questions (default 20).
- **Levels**: free choice per player (default) or locked to one level.
- **Answer entry**: auto-submit (default, see 2.4) or press Enter/GO.
- **Nitro streaks**: on/off (see 2.5).
- **Flag timer**: seconds after the first finisher before the race closes (default 20).

### 2.3 Questions and levels

Every race gets a fresh random seed. All players on the **same level get
the same question sequence**, so the race is fair. Different levels get
different sequences of the same length.

| Level | Name | `+` and `−` | `×` |
|---|---|---|---|
| 1 | 🐣 Rookie | results 0–10, never negative | ×1, ×2, ×10 with 0–5 |
| 2 | 🚗 Driver | results 0–20 | tables 2, 3, 5, 10 |
| 3 | 🏎️ Racer | results 0–100 | tables 1–10 |
| 4 | 🚀 Turbo | up to 3-digit ± 2-digit | up to 12 × 12, and 2-digit × 1-digit |

Generator rules:

- Subtraction never produces a negative answer.
- No question repeats back-to-back; avoid trivial pairs like `0 + 0`.
- Operands are shuffled (`3 × 7` and `7 × 3` both appear).
- Pure function `generate(seed, level, ops, count)` → deterministic, unit-testable.

### 2.4 Answer entry (the TypeRacer feel)

- Big on-screen **numpad** for touch devices; physical keyboard also works.
- **Auto-submit**: as soon as the typed digits match the answer, it's
  accepted. No Enter key, no button. If the typed digits reach the
  answer's length and don't match, it counts as wrong.
  - Trade-off: this reveals how many digits the answer has. For kids
    that's fine, and it makes the game feel fast. Host can switch to
    Enter-to-submit for a stricter race.
- Backspace works while typing.
- Wrong answer → input cleared and locked for 1.5 s, car skids, same
  question stays.

### 2.5 Fun extras (ordered by value)

1. **Nitro streak** — 5 correct in a row lights a flame on your car and
   jumps it one extra segment. Host can turn it off for pure-skill races.
2. **Sounds** — engine rev on correct, skid on wrong, crowd cheer at the
   finish. Mute button, remembered per device.
3. **Confetti** on the podium; crown on the winner's car in the next lobby.
4. **Sprint mode** — instead of "first to N questions", "most correct in
   60 seconds". Good for mixed ages.
5. **Themes** — cars by default; rockets, horses, boats as alternative
   sprites. Pure CSS/emoji swap.
6. **Division** as a fourth operation (exact division only, from the
   multiplication tables of the player's level).
7. **Handicap** — host can give a player a head start of X segments.

---

## 3. Architecture

```
  phones / tablets / laptops               home PC, Raspberry Pi, or a free cloud host
 ┌──────────────┐  WebSocket (JSON)        ┌────────────────────────────────────────┐
 │ index.html   │ ◄──────────────────────► │ Node.js                                │
 │ app.js       │                          │  ├─ http: serves /public (static)      │
 │ styles.css   │  GET / (static files)    │  ├─ ws:   one connection per player    │
 └──────────────┘ ◄──────────────────────  │  └─ rooms: Map<code, Room> in memory   │
                                           └────────────────────────────────────────┘
```

### 3.1 Stack and why

| Layer | Choice | Why |
|---|---|---|
| Server | **Node.js 20+**, `express` for static files, `ws` for WebSockets | One small process, one language, tiny dependency list. `npm start` and it runs. |
| State | In-memory `Map` of rooms | "No history" is a requirement, so a database would be dead weight. Restarting the server simply clears all rooms. |
| Front-end | **Vanilla HTML/CSS/JS**, no build step | Easy to host anywhere, easy to tweak, loads instantly on old tablets. Screens (home → lobby → race → podium) are `<section>`s toggled by JS. |
| Car animation | CSS `transform: translateX()` with a transition | Smooth at 60 fps on a phone, zero libraries. |
| Sounds | Short `.mp3`/`.ogg` files in `public/sounds`, Web Audio | Works offline on the LAN. |
| QR code | `qrcode` npm package, rendered server-side to a data URL | No external calls, works without internet. |
| Tests | Node's built-in `node --test` | No test framework to install. |
| Packaging | `Dockerfile` (`node:20-alpine`) | Same image runs at home or on any cloud host. |

Not chosen: React/Next (build step, overkill for four screens),
Socket.IO (nice reconnect, but `ws` plus 20 lines of reconnect code is
enough), Python (fine, but Node keeps client and server in one language).

### 3.2 Server-authoritative answers

The client **never receives the answer**, only the question text and the
answer's digit count. The client sends what the kid typed, the server
checks it and broadcasts the new car position. A tech-savvy kid opening
DevTools can't read the answers out of the page.

Latency cost per answer: ~1–5 ms on home Wi-Fi, ~50–150 ms over the
internet. Both are far below the time it takes to work out `7 × 8`.

### 3.3 Room state machine

```
  lobby ──start──► countdown (3 s) ──► racing ──all done / flag timer / host end──► finished
    ▲                                                                                  │
    └───────────────── back to garage ◄────────── race again (new seed) ◄──────────────┘
```

### 3.4 WebSocket protocol (JSON messages)

Client → server

| Type | Payload |
|---|---|
| `create_room` | `{ name, car, level, settings }` |
| `join_room` | `{ code, name, car, level, token? }` |
| `update_settings` | `{ settings }` (host only) |
| `set_level` | `{ level }` (lobby only) |
| `start_race` | — (host only) |
| `answer` | `{ questionIndex, value }` |
| `end_race` | — (host only) |
| `race_again` / `back_to_lobby` | — (host only) |

Server → client

| Type | Payload |
|---|---|
| `room_state` | `{ code, phase, settings, players: [{ id, name, car, level, progress, finishedAt, isHost, connected }], you }` — sent on any change |
| `countdown` | `{ secondsLeft }` |
| `question` | `{ index, text, answerLength }` — per player, per level |
| `answer_result` | `{ index, correct, stallMs }` |
| `progress` | `{ playerId, progress, streak }` — broadcast, drives the cars |
| `race_finished` | `{ ranking: [{ playerId, timeMs, accuracy, bestStreak }] }` |
| `error` | `{ message }` |

Guards: max 12 players/room, max 200 rooms/server, join rate-limit per
IP, answers accepted only for the player's current question index.

### 3.5 Repository layout

```
speed-math/
├─ server/
│  ├─ index.js        # http + ws wiring, static serving, LAN URL printout
│  ├─ room.js         # Room class: players, phase, settings, timers
│  ├─ questions.js    # generate(seed, level, ops, count)
│  ├─ words.js        # kid-safe 4-letter room-code list, nickname filter
│  └─ protocol.js     # message validation
├─ public/
│  ├─ index.html      # home / join / lobby / race / podium screens
│  ├─ tv.html         # big-screen spectator view
│  ├─ app.js
│  ├─ styles.css
│  └─ sounds/
├─ test/
│  ├─ questions.test.js
│  └─ room.test.js
├─ Dockerfile
├─ package.json
├─ PLAN.md            # this file
└─ README.md
```

---

## 4. Hosting

### 4.1 Start here: a machine at home on the Wi-Fi (free, zero latency)

Any laptop, desktop or Raspberry Pi that's on during play:

```
git clone <repo> && cd speed-math
npm install
npm start          # prints: Open http://192.168.1.42:3000 on this Wi-Fi
```

- The server prints the LAN URL and shows it with a QR code on the host
  screen, so kids just point a camera at it.
- Give the host machine a fixed IP (DHCP reservation in the router) so
  the link stays the same week to week.
- Works with the internet down. Nothing leaves the house.
- Or run it in Docker: `docker run -p 3000:3000 speed-math`.

### 4.2 Friends joining from their own homes

Keep the server at home and open a temporary public door with
**Cloudflare Quick Tunnel** — free, no account, one command:

```
cloudflared tunnel --url http://localhost:3000
# → https://quiet-river-1234.trycloudflare.com
```

Share that link (plus the room code) in the parents' group chat. You get
HTTPS for free, so the WebSocket runs as `wss://` with no certificate work.

Caveats to plan around:

- The URL changes every time you restart `cloudflared`. Fine for an
  occasional play date.
- Cloudflare documents Quick Tunnels as a testing tool with a 200
  concurrent-request limit (plenty for a dozen kids) and no promise about
  WebSockets. Third-party reports say WebSockets work; **Milestone 3
  includes a 10-minute test** to confirm before relying on it.
- Upgrade path: a free Cloudflare account plus a cheap domain (~$10/yr)
  gives a **named tunnel** with a permanent address like
  `race.yourfamily.com` and none of the Quick Tunnel limits.

Not recommended: router port-forwarding (exposes your home IP, needs
dynamic DNS) and Tailscale (free and secure, but every friend's device
needs the app and an invite, which is a hassle for other parents).

### 4.3 If you don't want a home machine switched on

| Host | Free tier (checked Oct 2026) | Verdict |
|---|---|---|
| **Render** (web service) | 750 free instance-hours/month. Spins down after 15 min idle, ~1 min cold start. Since Feb 2026, WebSocket messages keep it awake. | **Best free option.** Open the site a minute before the kids arrive to warm it up. |
| Fly.io | No free tier for new accounts (short trial, then pay-as-you-go). Smallest always-on machine ≈ $2–3/month. | Cheap and no cold start, but not free. |
| Cloudflare Workers + Durable Objects | Free plan with daily request/duration limits; one Durable Object per room fits the game perfectly; no cold-start issue. | **Best long-term free option**, but it means rewriting the server as a Durable Object (different programming model). Keep as a later milestone if remote play becomes regular. |
| Oracle Cloud "Always Free" VM | A permanently free small VM. | Free, but a fiddly sign-up and you maintain a Linux box yourself. |

**Recommendation:** LAN at home → Quick Tunnel for play dates → Render
free tier if you want it always reachable → Durable Objects only if it
becomes a weekly thing with many families.

Sources: [Render free tier docs](https://render.com/docs/free),
[Render changelog on WebSocket idle](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages),
[Fly.io discontinued plans](https://fly.io/docs/about/discontinued-plans/),
[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing).

---

## 5. Kid safety and privacy

- No accounts, emails, or personal data. Nicknames only, filtered against
  a small bad-word list, and they vanish with the room.
- Rooms are unlisted; you need the code. Codes come from a curated word
  list, never random letters that could spell something rude.
- No chat feature, so nothing to moderate.
- Answers checked on the server (no cheating via DevTools).
- Rate limits on joins and answers; caps on players and rooms.
- Everything served from the host itself: no third-party scripts,
  trackers or ads. Works fully offline on the LAN.

---

## 6. Build roadmap

Each milestone is sized for roughly one Claude Code session.

### Milestone 0 — Scaffold (small)
`package.json`, server skeleton serving `public/`, empty `index.html`,
`Dockerfile`, `README.md` with run instructions, `node --test` wired up.
**Done when:** `npm start` prints the LAN URL and serves a page; `npm test` passes.

### Milestone 1 — Playable race (MVP)
Create/join room, lobby with car list, host settings (ops + length),
countdown, question generator (all 4 levels), server-checked answers,
live car movement, flag timer, podium, race again.
Keyboard entry only, one theme, no sound.
**Done when:** three browser tabs on one laptop can race to the finish
and the podium shows the right order. Unit tests cover the generator and
the room state machine.

### Milestone 2 — Made for kids
On-screen numpad and mobile layout, auto-submit entry, skid penalty,
sounds + mute, confetti, QR code + LAN URL on the host screen, TV mode,
reconnect on refresh, host hand-over, room expiry.
**Done when:** a race on two phones + the TV view feels smooth, and a
page refresh mid-race keeps your car.

### Milestone 3 — Play with friends remotely
Verify Quick Tunnel + WebSockets, `wss://` auto-detection in the client,
Docker image tested, Render deploy instructions (and optional one-click
`render.yaml`), README section for each hosting option.
**Done when:** a friend outside the house joins a race via the tunnel
link, and the same image runs on Render.

### Milestone 4 — Extras (pick as the kids ask)
Nitro streaks, sprint mode, division, themes, handicaps, per-race
"fastest answer" stat, a solo practice mode with no room.

### Milestone 5 — Season night (added once 0–4 had shipped)
Season points across the races played in a room (3/2/1 for the top three,
host can start a new season), host can remove a player, mystery-number
sums (`7 + ? = 12`), a personal best for practice (kept on the device),
an installable app (web manifest + service worker; practice works
offline), graceful shutdown for hosted deploys, and a CI workflow.
**Done when:** standings carry across three races and reset on demand,
a removed player lands back on the home screen, the app installs to a
phone home screen, and CI runs the tests and the Docker build.

---

## 7. Decisions to confirm (defaults in bold)

1. Answer entry: **auto-submit** vs Enter-to-submit. (Host toggle either way.)
2. Wrong answer: **1.5 s stall, same question** vs move on and mark it wrong.
3. Mixed levels in one race: **allowed** vs host-locked.
4. Max players: **12**.
5. Name: **Speed Math** (matches the repo).

If none of these bother you, the next session can start Milestone 0 and 1
straight away with the command: *"Implement Milestones 0 and 1 from PLAN.md."*
