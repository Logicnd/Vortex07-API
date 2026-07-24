import { renameAuthor } from "../../../lib/forum.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await renameAuthor({
      authorId: body.authorId,
      authorName: body.authorName,
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("forum rename failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
