# Vortex07-API

Shared profile likes API for [Vortex07-Extension](https://github.com/Logicnd/Vortex07-Extension).

Deployed at: https://vortex07-api.vercel.app

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
