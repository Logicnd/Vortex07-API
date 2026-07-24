# Vortex07-API

Shared profile likes API for [Vortex07-Extension](https://github.com/Logicnd/Vortex07-Extension).

Deployed at: https://vortex07-api.vercel.app

## Endpoints

| Method | Path | Body / query | Result |
|--------|------|--------------|--------|
| `GET` | `/health` | — | `{ ok: true }` |
| `GET` | `/v1/likes/:targetId` | `?actorId=123` | `{ count, liked, myVote }` |
| `POST` | `/v1/likes/:targetId` | `{ "actorId": 123 }` | toggle like / unlike |

## Setup (Vercel + Upstash Redis)

1. In the Vercel project, set **Root Directory** to `server`
2. Add storage: **Integrations → Upstash** (or Vercel KV) so these env vars exist:
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN`  
   or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
3. Redeploy

```bash
cd server
npm install
npx vercel --prod
```

## Note

`actorId` is trusted from the extension (reads the logged-in Vortex user from the page). Harden later if needed.
