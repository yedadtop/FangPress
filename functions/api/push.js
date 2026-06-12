// functions/api/push.js
const KV_LIST_KEY = "site:posts:list";
const POST_CACHE_TTL = 604800;

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ success: false, error: "未授权" }), { status: 401 });
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiToken = env.API_TOKEN;
  if (apiToken && clientToken === apiToken) {
  } else {
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?").bind(clientToken).first();
    if (count === 0) return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), { status: 401 });
  }

  try {
    const { title, slug, content, category } = await request.json();

    if (!title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "Title, slug and content are required" }), { status: 400 });
    }

    const formattedSlug = slug.trim().toLowerCase();
    const targetCategory = category ? (category.trim() || null) : null;
    const currentTime = new Date().toISOString();

    // 💡 优化：移除对并不需要的字段 excerpt 的计算与存储
    // 💡 进阶：使用 RETURNING 一次性拿到 id/status/views,让 get.js 的关键路径完全脱离 D1
    const inserted = await env.DB.prepare(
      `INSERT INTO posts (title, slug, content, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, status, views`
    )
    .bind(
      title.trim(),
      formattedSlug,
      content.trim(),
      targetCategory,
      currentTime,
      currentTime
    )
    .first();

    const newPostCache = {
      id: inserted.id,
      status: inserted.status,
      views: inserted.views,
      title: title.trim(),
      content: content.trim(),
      category: targetCategory,
      created_at: currentTime
    };

    try {
      await env.KV.put(`post:content:${formattedSlug}`, JSON.stringify(newPostCache), { expirationTtl: POST_CACHE_TTL });
    } catch (e) {
      console.error('KV put failed (push.js):', e);
    }

    // ⚡ 批量清除所有分页的首页列表缓存，防止漏网之鱼导致错位
    try {
      const listKeys = await env.KV.list({ prefix: "site:posts:list:page:" });
      for (const k of listKeys.keys) {
        await env.KV.delete(k.name);
      }
    } catch (_) {}
    if (targetCategory) {
      try { await env.KV.delete(`site:posts:list:cat:${targetCategory.toLowerCase()}`); } catch (_) {}
    }

    return new Response(JSON.stringify({ success: true, message: "Post saved to D1 successfully" }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "The slug already exists" }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}