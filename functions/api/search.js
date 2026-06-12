// functions/api/search.js

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q');

  if (!q || !q.trim()) {
    return new Response(JSON.stringify({ success: true, data: [] }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }

  const keyword = `%${q.trim()}%`;

  try {
    const stmt = env.DB.prepare(
      `SELECT id, title, slug, category, created_at, views
       FROM posts
       WHERE status = 'published' AND (title LIKE ? OR content LIKE ?)
       ORDER BY created_at DESC
       LIMIT 15`
    ).bind(keyword, keyword);

    const { results } = await stmt.all();
    const data = results || [];

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
}
