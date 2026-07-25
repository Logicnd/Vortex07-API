# Vortex07-API

Backend for the [Vortex07](https://github.com/Logicnd/Vortex07-Extension) browser extension only
(forum, DMs, likes, ratings, comments). No Discord / Vortality bot logic.

Deployed at: https://vortex07-api.vercel.app  
Vercel project: **vortex07-api** (Root Directory = `server`).

**Deploy only via Git push to `main`.** Do not use truncated MCP/`deploy_to_vercel` file uploads
(they race git and have wiped routes). Hobby plan allows **≤12** serverless functions under `server/api`.

Stability: one shared Redis client (`lib/redis.js`), `lib/**` bundled into functions,
forum write rate limits, soft GET caps on hot routes, `/health` reports `{ redis: true|false }`.
Forum indexes use Redis sorted sets `forum:cat:{category}:threads` — never `FLUSH*` this Redis.

## Endpoints

| Method | Path | Body / query | Result |
|--------|------|--------------|--------|
| `GET` | `/health` | — | `{ ok: true }` |
| `GET` | `/v1/likes/:targetId` | `?actorId=123` | `{ count, liked, myVote }` |
| `POST` | `/v1/likes/:targetId` | `{ "actorId": 123 }` | toggle like / unlike |
| `GET` | `/v1/ratings/:targetId` | `?actorId=123` | `{ likes, dislikes, myVote }` game votes |
| `POST` | `/v1/ratings/:targetId` | `{ "actorId": 123, "vote": "up"\|"down"\|null }` | set / toggle vote |
| `GET` | `/v1/comments/:gameId` | `?limit=&offset=` | place comments (newest first) |
| `POST` | `/v1/comments/:gameId` | `{ "authorId", "authorName", "body" }` | post a comment |
| `DELETE` | `/v1/comments/:gameId/:commentId` | `{ "actorId" }` | delete (author or mods: 1, 15936, 18202, 22795) |
| `GET` | `/v1/forum/categories` | — | category list |
| `GET` | `/v1/forum/threads` | `?category=general` | thread list |
| `POST` | `/v1/forum/threads` | `{ categoryId, title, body, authorId, authorName }` | create thread |
| `GET` | `/v1/forum/threads/:id` | — | thread + posts |
| `DELETE` | `/v1/forum/threads/:id` | `{ actorId }` | delete thread (author or mods: 1, 15936, 18202, 22795) |
| `POST` | `/v1/forum/threads/:id/posts` | `{ body, authorId, authorName }` | reply |
| `PATCH` | `/v1/forum/threads/:id/posts/:postId` | `{ actorId, body, title? }` | edit own post (`title` only for OP) |
| `DELETE` | `/v1/forum/threads/:id/posts/:postId` | `{ actorId }` | delete post (author or same mods) |
| `POST` | `/v1/forum/diagnose` | `{ actorId }` | mod-only: scan `forum:*` key counts (repair hub) |
| `POST` | `/v1/forum/rebuild-index` | `{ actorId }` | mod-only: rebuild category zsets from thread bodies |
| `POST` | `/v1/forum/reseed` | `{ actorId }` | mod-only: seed known thread fragments if missing |
| `POST` | `/v1/forum/repair` | `{ actorId }` | mod-only: repair thread 1 OP if missing |
| `GET` | `/v1/dm/inbox` | `?actorId=` | DM conversation list |
| `GET` | `/v1/dm/unread` | `?actorId=` | unread badge count |
| `GET` | `/v1/dm/threads/:peerId` | `?actorId=` | thread messages (marks read) |
| `POST` | `/v1/dm/threads/:peerId/messages` | `{ actorId, authorName, body }` | send DM (friends UI-gated; muted blocked) |
| `GET` | `/v1/dm/mod/logs` | `?actorId=` | recent chat log (mods: 1, 15936, 18202, 22795) |
| `GET` | `/v1/dm/mod/muted` | `?actorId=` | muted users (mods) |
| `POST` | `/v1/dm/mod/mute` | `{ actorId, targetId, reason? }` | restrict messaging (mods) |
| `POST` | `/v1/dm/mod/unmute` | `{ actorId, targetId }` | lift mute (mods) |

DM handlers live in `api/v1/dm/[op].js` (single dynamic segment). Nested public paths are rewritten in `vercel.json` — catch-all `[...path]` does not work on non-Next Vercel.

## Setup (Vercel + Upstash Redis)

1. In the Vercel project, set **Root Directory** to `server`
2. Add **Upstash Redis** storage and connect it to this project
3. Confirm env var **`REDIS_URL`** is set for Production
4. Redeploy

```bash
cd server
npm install
npx vercel --prod
```

## Note

`actorId` is trusted from the extension (reads the logged-in Vortex user from the page). Harden later if needed.
