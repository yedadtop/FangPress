// functions/api/update.js
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
    const { id, title, slug, content, category } = await request.json();

    if (!id || !title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "id / 标题 / 路径 / 正文不能为空" }), { status: 400 });
    }

    const newSlug = slug.trim().toLowerCase();
    const targetCategory = category ? (category.trim() || null) : null;

    // 1) 查出旧 slug 和 旧 category，用于精准联动清理分类 KV 缓存
    const oldPost = await env.DB.prepare("SELECT slug, category, created_at FROM posts WHERE id = ?").bind(id).first();

    const now = new Date().toISOString();

    // 💡 优化：移除 D1 中 excerpt 字段的计算和写入，保持字段精炼
    const result = await env.DB
      .prepare(
        `UPDATE posts
         SET title = ?, slug = ?, content = ?, category = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(title.trim(), newSlug, content.trim(), targetCategory, now, id)
      .run();

    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章，可能已被删除" }), { status: 404 });
    }

    // 2) ⚡ 联动清除缓存链条
    if (oldPost && oldPost.slug) {
      try { await env.KV.delete(`post:content:${oldPost.slug.trim().toLowerCase()}`); } catch (_) {}
    }
    try { await env.KV.delete(`post:content:${newSlug}`); } catch (_) {}
    try { await env.KV.delete(KV_LIST_KEY); } catch (_) {}

    // 💡 清理受影响的旧分类和新分类列表 KV 缓存
    if (oldPost && oldPost.category) {
      try { await env.KV.delete(`site:posts:list:cat:${oldPost.category.trim().toLowerCase()}`); } catch (_) {}
    }
    if (targetCategory) {
      try { await env.KV.delete(`site:posts:list:cat:${targetCategory.toLowerCase()}`); } catch (_) {}
    }

    // 3) 主动回填最新正文到 KV
    const updatedCache = {
      title: title.trim(),
      content: content.trim(),
      category: targetCategory,
      created_at: (oldPost && oldPost.created_at) ? oldPost.created_at : now
    };
    try {
      await env.KV.put(`post:content:${newSlug}`, JSON.stringify(updatedCache), { expirationTtl: POST_CACHE_TTL });
    } catch (e) {
      console.error('KV put failed (update.js):', e);
    }

    return new Response(JSON.stringify({ success: true, message: "文章已更新" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "Slug 已被其他文章占用" }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}