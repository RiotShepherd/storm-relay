# STORM Relay

A tiny, always-on relay for STORM multiplayer rooms. It never runs any of
the actual STORM game — the room's host still runs their normal local
STORM server exactly as in solo play. This relay only:

- hands out room codes and tracks who's in each room
- runs the lobby: seat selection, host/Supervisor role, chat
- once a room starts, forwards gameplay requests between everyone else and
  the host's local STORM server, so no player (host included) ever needs
  to open a port or be reachable from the internet — every connection is
  outbound, from each player's game to this relay

## Deploying it (Render, free tier, no credit card)

1. **Push this folder to its own GitHub repo.** Create a new repo (e.g.
   `storm-relay`) and push everything in this folder to it, the same way
   you did for `storm-launcher`.

2. **Sign up / log in at [render.com](https://render.com)** — "Get
   Started for Free", sign in with GitHub is easiest (no card required for
   the free tier).

3. **New + → Blueprint**, and point it at the `storm-relay` repo. Render
   will read `render.yaml` in this folder and pre-fill everything (build
   command, start command, free plan, health check path) — just confirm
   and click **Apply**.

   (If you'd rather set it up by hand instead: **New + → Web Service** →
   pick the repo → Runtime `Node` → Build Command `npm install && npm run
   build` → Start Command `npm start` → Instance Type `Free` → Create.)

4. Render will give you a public URL like `https://storm-relay-xxxx.onrender.com`.
   In STORM, open Settings (the STORM menu in any window) and paste that
   URL into "Multiplayer relay" on every player's machine. Leave it empty
   to use the local relay the game ships with (solo play only).

### Stopping it from falling asleep

Render's free tier spins a service down after 15 minutes with no traffic,
and takes 30-60 seconds to wake back up on the next request — annoying if
a friend tries to join and has to wait. The standard free fix: a free
uptime monitor that pings it more often than that.

1. Sign up free at **[UptimeRobot](https://uptimerobot.com)** (or
   `cron-job.org` / `healthchecks.io` — any of these work the same way).
2. Add a new **HTTP(s)** monitor.
3. URL: `https://<your-render-url>/health`
4. Check interval: **5 minutes** (the shortest the free tier allows —
   comfortably under Render's 15-minute idle timeout).

That's it — between Render's free web service and a free monitor pinging
it every 5 minutes, this costs nothing and stays warm indefinitely.

## Local development

```
npm install
npm run dev
```

Listens on port 4100 by default (Render sets its own `PORT` env var
automatically in production — no changes needed).

## Known limitation

If the host disconnects mid-game, the session ends for everyone — their
local STORM server was the only thing actually running the shared game
state, and there's no migration of that state to another player's machine
(yet). Everyone in the room gets a `room:hostLeft` event so the client can
show a clear message rather than just hanging.
