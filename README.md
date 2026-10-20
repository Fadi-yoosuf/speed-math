# Speed Math

A browser car-race game for kids: solve sums fast, your car moves faster.
Friends join a room with a four-letter code, the host presses **Start**, and
everyone races live. No accounts, no saved history.

See [PLAN.md](PLAN.md) for the game design, architecture, hosting options
and build roadmap. All four milestones of that roadmap are implemented: a full
playable race, mobile numpad, auto-submit, skid penalty, sounds, confetti,
QR join codes, TV mode, reconnect on refresh, host hand-over, room expiry,
the hosting options below (Wi-Fi, Cloudflare Quick Tunnel, Render, Docker),
and the extras: nitro streaks, sprint mode, division, themes, head starts,
a fastest-answer stat and a solo practice mode.

## Hosting

Start with the Wi-Fi option; add a tunnel for play dates with other
families; move to Render only if you want it reachable all the time.
PLAN.md § 4 has the reasoning and the alternatives.

### 1. At home on the Wi-Fi (free, zero latency)

You need [Node.js](https://nodejs.org) 20 or newer on any laptop, desktop
or Raspberry Pi that stays on during play.

```
git clone <this repo> && cd speed-math
npm install
npm start
```

```
Speed Math is running.
  Local:  http://localhost:3000
  Wi-Fi:  http://192.168.1.42:3000   ← open this on phones and tablets on this Wi-Fi
```

1. Open the Wi-Fi link on any device, type a nickname, pick a car and a level,
   and tap **New race**. A four-letter room code, a QR code and a join link
   appear.
2. Other kids open the link (or scan the QR code), pick their car and level,
   and join with the code. Everyone can pick their own level, so a 6-year-old
   and a 10-year-old can race in the same room.
3. The host tweaks the race settings (which sums, how many, auto-submit or
   press-GO) and presses **Start race**.
4. Open `http://<wifi-ip>:3000/tv/CODE` on a TV or projector for a big
   read-only view of the track with the QR code on it.

Tips: give the host machine a fixed IP in your router (DHCP reservation) so
the link stays the same week to week. The game works with the internet down;
nothing leaves the house. Nothing is stored, and restarting the server
clears every room.

### 2. Friends in other houses: Cloudflare Quick Tunnel (free, no account)

Keep the server at home and open a temporary public door.

1. Install `cloudflared` once:
   macOS `brew install cloudflared` · Windows `winget install Cloudflare.cloudflared`
   · Linux: packages at [pkg.cloudflare.com](https://pkg.cloudflare.com) or the
   binary from [GitHub releases](https://github.com/cloudflare/cloudflared/releases).
2. Run:

   ```
   npm run tunnel
   ```

   This starts the tunnel, then the server, and prints the public link with a
   QR code in the terminal:

   ```
   🌍  Friends elsewhere can join at:
       https://quiet-river-1234.trycloudflare.com
   ```

3. Share that link plus the room code in the parents' group chat. The host
   screen now shows two join blocks: **On this Wi-Fi** (faster, for kids in the
   house) and **From anywhere** (the tunnel link), each with its own QR code.
   The TV view shows the public one.

Prefer to run the pieces yourself? `cloudflared tunnel --url http://localhost:3000`
in one terminal, then `PUBLIC_URL=https://<your>.trycloudflare.com npm start`
in another. Or simply open the game through the tunnel link yourself: join
links and QR codes always follow the address the page was opened from, and the
WebSocket switches to `wss://` automatically on https pages.

What to know about Quick Tunnels (from Cloudflare's docs):

- The URL changes every time you restart the tunnel. Fine for a play date.
- They are a testing tool with no uptime promise and a cap of 200 in-flight
  requests per tunnel (a dozen kids use about a dozen). Server-Sent Events are
  not supported; the game does not use them.
- WebSockets ride over ordinary https and Cloudflare proxies them without
  configuration. **First time you use the tunnel, do a 10-minute check**: open
  the public link on a phone with Wi-Fi off (mobile data only), join, and race.
  The green dot next to the speaker icon means the socket is up; if it goes
  red and stays red the tunnel is not passing WebSockets and you should fall
  back to a named tunnel (below) or Render.
- Upgrade path: a free Cloudflare account plus a cheap domain gives a
  **named tunnel** with a permanent address like `race.yourfamily.com` and
  none of the Quick Tunnel limits. Point it at `http://localhost:3000` and set
  `PUBLIC_URL=https://race.yourfamily.com` when you start the server.

### 3. Always reachable: Render free tier

[Render](https://render.com) runs the game from this repository with no
machine switched on at home. The included `render.yaml` is a Blueprint:

1. Fork this repository on GitHub.
2. In Render: **New → Blueprint**, pick the fork, and accept the defaults
   from `render.yaml` (a free web service, `npm ci --omit=dev`, `npm start`,
   health check on `/healthz`, Node 20).
3. Open `https://<your-service>.onrender.com`. Join links, QR codes and
   `wss://` are picked up from Render's forwarded headers; no `PUBLIC_URL`
   needed.

Free-tier behaviour to plan around (Render docs, checked October 2026):

- The service spins down after 15 minutes without an HTTP request or a
  WebSocket message, and takes up to a minute to wake. **Open the site a
  minute before the kids arrive.**
- While anyone is in a room, the page sends a tiny keepalive message every
  25 seconds, so a lobby or race never goes to sleep mid-game.
- 750 free instance-hours a month: enough for one always-on free service.

Any other Node host works the same way: run `npm ci --omit=dev && npm start`,
honour the `PORT` the platform gives you, and make sure WebSockets are passed
through (Render, Fly.io and Railway all do).

### 4. Docker (home server, NAS, or any cloud)

```
docker build -t speed-math .
docker run -p 3000:3000 speed-math
```

The image is `node:20-alpine` plus production dependencies, runs as the
unprivileged `node` user, and listens on `PORT` (default 3000). If Docker Hub
rate-limits you, build from a mirror:
`docker build --build-arg BASE=mirror.gcr.io/library/node:20-alpine -t speed-math .`

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on. Hosts such as Render set this for you. |
| `PUBLIC_URL` | unset | A second, public address to show on the host screen and TV (e.g. a tunnel). Origin only, no path. |
| `CLOUDFLARED` | `cloudflared` | Path to the cloudflared binary for `npm run tunnel`. |

## How it plays

- **Levels:** 🐣 Rookie (sums to 10, ×1 ×2 ×10), 🚗 Driver (sums to 20,
  tables 2 3 5 10), 🏎️ Racer (sums to 100, tables 1–10), 🚀 Turbo (3-digit ±
  2-digit, up to 12 × 12).
- **Auto-submit:** as soon as the typed digits match the answer's length they
  are checked. No Enter key. The host can switch to press-GO for a stricter race.
- **Wrong answer:** the car skids, the input locks for 1.5 s and the same
  question stays. Guessing costs more than thinking.
- **Finish:** first across the line wins. The race closes when everyone is
  done or 20 s after the first finisher (host-adjustable), or when the host
  ends it.
- **Refresh-proof:** a page refresh or a Wi-Fi blip brings you back to your
  own car. If the host drops, the badge passes to the longest-connected
  player. Empty rooms vanish after 30 minutes.
- Answers are checked on the server; the page never receives them.

### Extras (host settings)

- **🔥 Nitro streaks** (on by default): every 5 correct in a row lights a
  flame on your car and jumps it one extra segment. Switch it off for a
  pure-skill race.
- **⏱ Sprint mode:** instead of first to the flag, most correct answers in
  30, 60, 90 or 120 seconds. Cars lap the track and the podium ranks by
  correct answers (ties go to fewer mistakes). Good for mixed ages.
- **÷ Division** as a fourth kind of sum, opt-in. Always exact, built from
  the multiplication tables of the player's level (`40 ÷ 10`, `36 ÷ 3`).
- **Themes:** cars, rockets, horses or boats. A pure sprite and track swap;
  each player's pick maps to the matching sprite in the new theme.
- **Head starts:** the host can put any car up to 5 segments ahead for the
  next race (race mode only). Shown as `+2` next to the name.
- **⚡ Fastest answer:** the podium shows everyone's quickest correct answer
  and who had the fastest of the race.
- **🎯 Practice alone:** from the home screen, a 20-sum solo run at your
  level with no room and no code. It runs entirely in the browser, so it
  works even before anyone else has joined.

## Development

```
npm test          # node --test: generator, room state machine, protocol, hosting headers, end-to-end race
npm run dev       # restarts the server on file changes
npm run tunnel    # start a Cloudflare Quick Tunnel + the server (needs cloudflared)
```

Layout:

```
server/index.js      http + ws wiring, static files, LAN URL printout
server/room.js       Room class: players, phase, settings, timers
server/rooms.js      in-memory registry: codes, caps, expiry sweep
server/questions.js  generate(seed, level, ops, count)
server/words.js      kid-safe room-code words, nickname filter
server/protocol.js   message validation
public/              index.html, tv.html, app.js, tv.js, shared.js, styles.css
scripts/tunnel.js    npm run tunnel helper
test/                node --test suites
render.yaml          Render Blueprint (free web service)
Dockerfile           node:20-alpine image
```

Sounds are synthesised in the browser with the Web Audio API, so there are
no audio files to download and everything works offline on the LAN.
