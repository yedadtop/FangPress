// functions/api/delete.js

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
    const { id } = await request.json();
    if (!id) return new Response(JSON.stringify({ success: false, error: "缺少文章 id" }), { status: 400 });

    // 1) 先从 D1 拿到 slug 和 category 用于清理相关 KV 链条
    const post = await env.DB.prepare("SELECT slug, category FROM posts WHERE id = ?").bind(id).first();

    // 2) ⚡ 顺序安全擦除全套边缘缓存
    if (post && post.slug) {
      try { await env.KV.delete(`post:content:${post.slug.trim().toLowerCase()}`); } catch (_) {}
    }

    // ⚡ 批量清除所有分页的首页列表缓存，防止漏网之鱼导致错位
    try {
      const listKeys = await env.KV.list({ prefix: "site:posts:list:page:" });
      for (const k of listKeys.keys) {
        await env.KV.delete(k.name);
      }
    } catch (_) {}

    // 💡 清理该文章归属的分类页列表缓存，防止分类页出现幽灵文章数据
    if (post && post.category) {
      try { await env.KV.delete(`site:posts:list:cat:${post.category.trim().toLowerCase()}`); } catch (_) {}
    }

    // 3) 最后执行 D1 的物理删除
    const result = await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();

    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章" }), { status: 404 });
    }

    return new Response(JSON.stringify({ success: true, message: "文章已删除" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}