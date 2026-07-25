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
| `GET` | `/v1/forum/categories` | — | category list |
| `GET` | `/v1/forum/threads` | `?category=general` | thread list |
| `POST` | `/v1/forum/threads` | `{ categoryId, title, body, authorId, authorName }` | create thread |
| `GET` | `/v1/forum/threads/:id` | — | thread + posts |
| `DELETE` | `/v1/forum/threads/:id` | `{ actorId }` | delete thread (author or mods: 1, 15936, 18202) |
| `POST` | `/v1/forum/threads/:id/posts` | `{ body, authorId, authorName }` | reply |
| `PATCH` | `/v1/forum/threads/:id/posts/:postId` | `{ actorId, body, title? }` | edit own post (`title` only for OP) |
| `DELETE` | `/v1/forum/threads/:id/posts/:postId` | `{ actorId }` | delete post (author or same mods) |

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
