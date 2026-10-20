# Speed Math

A browser car-race game for kids: solve sums fast, your car moves faster.
Friends join a room with a four-letter code, the host presses **Start**, and
everyone races live. No accounts, no saved history.

See [PLAN.md](PLAN.md) for the game design, architecture, hosting options
and build roadmap. Milestones 0–2 of that roadmap are implemented: a full
playable race, mobile numpad, auto-submit, skid penalty, sounds, confetti,
QR join codes, TV mode, reconnect on refresh, host hand-over and room expiry.

## Run it at home (on your Wi-Fi)

You need [Node.js](https://nodejs.org) 20 or newer.

```
git clone <this repo> && cd speed-math
npm install
npm start
```

The server prints two links:

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

Nothing is stored. Restarting the server clears every room.

### Docker

```
docker build -t speed-math .
docker run -p 3000:3000 speed-math
```

### Playing from other houses

Keep the server at home and open a temporary public link with a
[Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/):

```
cloudflared tunnel --url http://localhost:3000
```

Share the `https://….trycloudflare.com` link plus the room code. The join
links and QR codes the game shows adapt to that address automatically. See
PLAN.md § 4 for other hosting options.

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

## Development

```
npm test          # node --test: generator, room state machine, protocol, end-to-end race
npm run dev       # restarts the server on file changes
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
test/                node --test suites
```

Sounds are synthesised in the browser with the Web Audio API, so there are
no audio files to download and everything works offline on the LAN.
