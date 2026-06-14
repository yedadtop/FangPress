// functions/api/search.js

const SELECT_COLS = `id, title, slug, category, type, content, created_at, views`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIKE_ESCAPE_RE = /[\\%_]/g;

// ⚡ 修复 12：转义 LIKE 通配符 % _ \，避免用户输入 `50%` 误命中
function escapeLike(s) {
  return String(s).replace(LIKE_ESCAPE_RE, '\\$&');
}

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
    const keyword = `%${escapeLike(q.trim())}%`;
    // ⚡ 修复 12：使用 ESCAPE 关键字显式声明转义符
    const likeExpr = `LIKE ? ESCAPE '\\'`;
    try {
      const stmt = env.DB.prepare(
        `SELECT ${SELECT_COLS}
         FROM posts
         WHERE status = 'published' AND (title ${likeExpr} OR content ${likeExpr})
         ORDER BY created_at DESC
         LIMIT 15`
      ).bind(keyword, keyword);
      const { results } = await stmt.all();
      return jsonResponse({ success: true, data: results || [] });
    } catch (err) {
      // ⚡ 修复 12：脱敏错误信息，避免泄露内部 SQL/表结构
      console.error('search keyword failed:', err);
      return jsonResponse({ success: false, error: "搜索失败，请稍后重试" }, 500);
    }
  }

  // 日期搜索：created_at 以 YYYY-MM-DD 开头（ISO 8601 文本格式）
  if (dateParam && DATE_RE.test(dateParam)) {
    const datePrefix = dateParam + '%';
    try {
      const stmt = env.DB.prepare(
        `SELECT ${SELECT_COLS}
         FROM posts
         WHERE status = 'published' AND created_at LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT 15`
      ).bind(datePrefix);
      const { results } = await stmt.all();
      return jsonResponse({ success: true, data: results || [] });
    } catch (err) {
      console.error('search date failed:', err);
      return jsonResponse({ success: false, error: "搜索失败，请稍后重试" }, 500);
    }
  }

  return jsonResponse({ success: true, data: [] });
}
