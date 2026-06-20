# MAW Signaling Server

A tiny WebSocket relay that lets MAW hosts and guests find each other and complete
the WebRTC handshake. It is the **only** part of MAW that needs to be reachable on
the public internet.

It never sees your project, audio, or chat. It only forwards connection setup
messages (SDP offers/answers and ICE candidates). Once two peers connect, all real
traffic flows directly peer-to-peer.

---

## Run it locally (for testing on one machine / LAN)

```bash
cd signaling-server
npm install
npm start
```

It listens on `ws://localhost:9000`. The MAW app defaults to this URL, so local
testing works with no extra config.

---

## Deploy it for internet play (free)

You need a public `wss://` URL. Any of these free tiers work. **Render** is the
simplest:

### Render (recommended)

1. Push this repo to GitHub.
2. Go to <https://render.com> → **New** → **Web Service** → connect your repo.
3. Settings:
   - **Root Directory:** `signaling-server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Deploy. Render gives you a URL like `https://maw-signaling-xxxx.onrender.com`.
5. Your signaling URL is the same host with `wss://`:
   `wss://maw-signaling-xxxx.onrender.com`

> Render's free tier sleeps after ~15 min idle and cold-starts in ~30s. The first
> host to connect after a nap may wait a moment. Railway/Fly avoid this; or use a
> paid Render instance for always-on.

### Railway / Fly.io

Same idea: deploy the `signaling-server` folder as a Node service with start
command `npm start`. They auto-assign `$PORT`, which `server.js` already reads.

---

## Point MAW at your deployed server

The app reads its signaling URL from (in order):

1. `localStorage` key `maw.signalingUrl` — set this from DevTools to override
   without editing code:
   ```js
   localStorage.setItem('maw.signalingUrl', 'wss://maw-signaling-xxxx.onrender.com')
   ```
2. Otherwise the default in `renderer/network/config.js` (`ws://localhost:9000`).

For a shipped build, edit the default in `renderer/network/config.js` to your
deployed `wss://` URL so every user gets it automatically.

---

## Health check

Open the deployed URL in a browser — a bare WebSocket server will respond with
"Upgrade Required", which confirms it's running.
