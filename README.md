# IHX Flow

A doctor clicks **Open IHX**. The backend opens one Chromium window on a Docker virtual desktop, signs in to the IHX provider portal, and shows that same window in the page through noVNC. The doctor types the email OTP in that window. After sign-in, automation stops and the browser stays open for the admission.

Browserless is not used. The session limit is `SESSION_TIMEOUT_MS` (30 minutes by default), not the Browserless free-plan limit of 2 minutes.

## Run

From this folder, with Docker Desktop running and a filled-in `.env`:

```bash
docker compose build
docker compose up
```

Open http://127.0.0.1:3001 and click **Open IHX**.

The noVNC viewer listens on http://127.0.0.1:6080 and is embedded in the page. The raw VNC port is not published.

```bash
docker compose logs -f
docker compose down
```

## What stays on the server

`IHX_USERNAME`, `IHX_PASSWORD`, and `APP_API_KEY` stay in `.env`. They are not written into the website and are not logged.

## Local checks without Docker

```bash
npm run check
```

Opening the desktop browser requires Linux tools (`Xvfb`, `fluxbox`, `x11vnc`, noVNC), which the Docker image installs. `npm run dev` on Windows can start the website, but **Open IHX** needs Docker Compose.
