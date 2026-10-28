# IHX Flow

CodeLibrary's **Open Portal** button calls this API. The backend opens one Chromium window on a Docker virtual desktop, signs in on `provider.ihx.in`, and returns the noVNC address for that window. When the case API settings are present, the click loads the waiting case and uses that portal login. When the mailbox settings are present, the email OTP is typed into that same window. Otherwise the doctor types the 5-digit code. After sign-in, automation stops and the browser stays open for the admission. Other portals are opened and left for the doctor.

Browserless is not used. The session limit is `SESSION_TIMEOUT_MS` (30 minutes by default), not the Browserless free-plan limit of 2 minutes.

## Run

From this folder, with Docker Desktop running and a filled-in `.env`:

```bash
docker compose build
docker compose up
```

The API listens on http://127.0.0.1:3001. CodeLibrary calls `POST /api/ihx/session`, then polls until `liveUrl` is set. The noVNC viewer listens on http://127.0.0.1:6080. The raw VNC port is not published.

```bash
docker compose logs -f
docker compose down
```

## What stays on the server

`IHX_USERNAME`, `IHX_PASSWORD`, `RPA_PASSWORD`, `EMAIL_OTP_SECRET`, and `APP_API_KEY` stay in `.env`. They are not logged. The case and mailbox APIs are the same ones used by the playwright-cli project: `rpa-login`, `rpa-requests`, `tpa-case-data`, and the email OTP service. Set `EMAIL_OTP_FROM` to the sender address on the IHX OTP email before automatic OTP entry can run.

## Local checks without Docker

```bash
npm run check
```

Opening the desktop browser requires Linux tools (`Xvfb`, `fluxbox`, `x11vnc`, noVNC), which the Docker image installs. `npm run dev` on Windows starts the API, and **Open Portal** needs Docker Compose.
