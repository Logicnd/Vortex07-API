# Vortex07-API

Tiny Cloudflare Worker + D1 API for shared Vortex07 profile likes.

Extension repo stays separate: [Vortex07-Extension](https://github.com/Logicnd/Vortex07-Extension).

## Endpoints

| Method | Path | Body / query | Result |
|--------|------|--------------|--------|
| `GET` | `/health` | — | `{ ok: true }` |
| `GET` | `/v1/likes/:targetId` | `?actorId=123` | `{ count, liked, myVote }` |
| `POST` | `/v1/likes/:targetId` | `{ "actorId": 123 }` | toggle like / unlike |

## Setup

```bash
npm install
npm run db:create
```

Paste the printed `database_id` into `wrangler.jsonc`, then:

```bash
npm run db:migrate
npm run deploy
```

Local:

```bash
npm run db:migrate:local
npm run dev
```

## Note

`actorId` is trusted from the client for now (extension reads the logged-in Vortex user from the page). Harden later if needed (session check / signed token).
