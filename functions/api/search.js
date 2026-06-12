// functions/api/search.js

const SELECT_COLS = `id, title, slug, category, created_at, views`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  const dateParam = url.searchParams.get('date');

  // 关键词搜索：模糊匹配 title / content
  if (q && q.trim()) {
    const keyword = `%${q.trim()}%`;
    try {
      const stmt = env.DB.prepare(
        `SELECT ${SELECT_COLS}
         FROM posts
         WHERE status = 'published' AND (title LIKE ? OR content LIKE ?)
         ORDER BY created_at DESC
         LIMIT 15`
      ).bind(keyword, keyword);
      const { results } = await stmt.all();
      return jsonResponse({ success: true, data: results || [] });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // 日期搜索：created_at 以 YYYY-MM-DD 开头（ISO 8601 文本格式）
  if (dateParam && DATE_RE.test(dateParam)) {
    const datePrefix = dateParam + '%';
    try {
      const stmt = env.DB.prepare(
        `SELECT ${SELECT_COLS}
         FROM posts
         WHERE status = 'published' AND created_at LIKE ?
         ORDER BY created_at DESC
         LIMIT 15`
      ).bind(datePrefix);
      const { results } = await stmt.all();
      return jsonResponse({ success: true, data: results || [] });
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  return jsonResponse({ success: true, data: [] });
}
