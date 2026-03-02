# Deployment — Coolify + Cloudflare Tunnel

## Architecture

```
Browser (HTTPS) ──► Cloudflare Tunnel ──► Traefik (Coolify host) ──► Container :3000
                     TLS termination        reverse proxy               plain HTTP
```

The app serves plain HTTP.  TLS is handled end-to-end by Cloudflare; Traefik routes
traffic to the container on the internal Docker network.  No TLS configuration is
needed inside the container.

WebSocket connections follow the same path.  Cloudflare Tunnel and Traefik both
pass the `Upgrade: websocket` header through transparently, so the `/` WebSocket
signaling endpoint works without special configuration.

---

## Prerequisites

- A Coolify instance with a running Traefik reverse proxy (default Coolify setup).
- A Cloudflare Tunnel pointed at the Coolify host (or at Traefik's public port).
- A git repository reachable by Coolify (GitHub / GitLab / self-hosted Gitea, etc.).
- `package-lock.json` committed to the repository (already present; run
  `npm install` locally if it ever gets out of sync).

---

## Coolify configuration

### 1 — Create a new resource

1. In Coolify, go to **Projects → New Resource → Application**.
2. Select your git provider and choose this repository.
3. Set **Build Pack** to **Dockerfile** (Coolify auto-detects the `Dockerfile` in the repo root).

### 2 — General settings

| Setting | Value |
|---------|-------|
| Branch | `main` |
| Build Pack | Dockerfile |
| Dockerfile location | `./Dockerfile` (default) |
| Port | `3000` |
| Health check path | `/health` |
| Health check interval | `30s` |

### 3 — Environment variables

Only `PORT` is needed; Coolify injects it automatically when you set the port above.
If you need to override it manually:

| Variable | Value |
|----------|-------|
| `PORT` | `3000` |

> No TURN server credentials are required.  In production the app does not start
> a TURN server; local-network-only P2P is enforced through ICE candidate filtering
> instead (see `LOCALNETWORK.md` / the block comments in `server.js` and
> `public/app.js`).

### 4 — Domain / HTTPS

Set the domain in Coolify to the hostname you configured in Cloudflare Tunnel.
Because Cloudflare terminates TLS you do **not** need to enable Coolify's built-in
Let's Encrypt option for this domain; leave SSL in Coolify set to **None** or
**disabled**.

### 5 — Deploy

Click **Deploy**.  Coolify will:
1. Clone the repository.
2. Build the Docker image (`docker build` using the `Dockerfile`).
3. Start the container and wait for the `/health` endpoint to return 200.
4. Register the service with Traefik.

---

## WebSocket notes

The signaling WebSocket (`wss://your-domain.com/`) is on the same port and path as
the HTTP app.  No separate port or Traefik rule is needed.

Cloudflare Tunnel supports WebSockets out of the box.  The keep-alive ping/pong
(every 30 s) in `server.js` keeps connections alive within Cloudflare's 100 s idle
timeout.

---

## Local development

Local development still uses `npm start` (plain HTTP, no TURN server required since
local-network P2P works without TURN):

```bash
npm install
npm start          # http://localhost:3000
```

To test with the TURN server (only needed if you are debugging ICE on localhost):

```bash
./start.sh         # starts coturn + node server
# or
npm run start:turn # cross-platform (Node.js)
```

---

## Updating the deployment

Push to the tracked branch.  If **Auto-deploy on push** is enabled in Coolify,
the new image is built and rolled out automatically.  Otherwise trigger a manual
redeploy from the Coolify UI.
