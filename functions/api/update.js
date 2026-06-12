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
    // ⚡ 引入 status 变量解析
    const { id, title, slug, content, category, status } = await request.json();

    if (!id || !title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "id / 标题 / 路径 / 正文不能为空" }), { status: 400 });
    }

    const newSlug = slug.trim().toLowerCase();
    const targetCategory = category ? (category.trim() || null) : null;
    // 规范化状态值，默认发布
    const targetStatus = (status && status.trim() === 'draft') ? 'draft' : 'published';

    const oldPost = await env.DB.prepare("SELECT slug, category, created_at FROM posts WHERE id = ?").bind(id).first();
    const now = new Date().toISOString();

    const result = await env.DB
      .prepare(
        `UPDATE posts
         SET title = ?, slug = ?, content = ?, category = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(title.trim(), newSlug, content.trim(), targetCategory, targetStatus, now, id)
      .run();

    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章，可能已被删除" }), { status: 404 });
    }

    // ⚡ 强力清除可能影响的旧缓存，防止改名/改状态后的幽灵脏数据
    if (oldPost && oldPost.slug) {
      try { await env.KV.delete(`post:content:${oldPost.slug.trim().toLowerCase()}`); } catch (_) {}
    }
    try { await env.KV.delete(`post:content:${newSlug}`); } catch (_) {}
    try { await env.KV.delete(KV_LIST_KEY); } catch (_) {}

    if (oldPost && oldPost.category) {
      try { await env.KV.delete(`site:posts:list:cat:${oldPost.category.trim().toLowerCase()}`); } catch (_) {}
    }
    if (targetCategory) {
      try { await env.KV.delete(`site:posts:list:cat:${targetCategory.toLowerCase()}`); } catch (_) {}
    }

    // ⚡ 核心修改：只有状态依旧是 published 的文章才允许主动回填 KV；
    // 如果是 draft，上面已经全面 delete 干净了，这就完美了！
    if (targetStatus === 'published') {
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