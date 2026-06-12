// functions/api/delete.js

export async function onRequestPost(context) {
  const { request, env } = context;

  // ... 你的原有鉴权代码保持不变 ...
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ success: false, error: "未授权" }), { status: 401 });
  const clientToken = authHeader.replace("Bearer ", "");
  const apiToken = env.API_TOKEN;
  if (apiToken && clientToken === apiToken) {
  } else {
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?").bind(clientToken).first();
    if (count === 0) return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), { status: 401 });
  }

  try {
    const { id } = await request.json();

    if (!id) {
      return new Response(JSON.stringify({ success: false, error: "缺少文章 id" }), { status: 400 });
    }

    // 1) 查出要删除的文章 slug
    const post = await env.DB.prepare("SELECT slug FROM posts WHERE id = ?").bind(id).first();

    // 2) 执行数据库物理删除
    const result = await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();

    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章" }), { status: 404 });
    }

    // 3) 异步清除 KV 缓存
    if (post && post.slug) {
      context.waitUntil(
        env.KV.delete(`post:content:${post.slug.trim().toLowerCase()}`)
      );
    }

    return new Response(JSON.stringify({ success: true, message: "文章已删除" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}