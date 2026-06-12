// functions/api/delete.js

const KV_LIST_KEY = "site:posts:list";

export async function onRequestPost(context) {
  const { request, env } = context;

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

    // 1) 先从 D1 拿到 slug（这是后面抹 KV 用的 key）
    const post = await env.DB.prepare("SELECT slug FROM posts WHERE id = ?").bind(id).first();

    // 2) ⚡ 顺序修正：先抹 KV 缓存 → 再删 D1。
    //    旧代码先删 D1 再删 KV，会在两步之间让并发请求从 KV 读到"已从 D1 删除"的幽灵文章。
    //    现在 KV 先清掉，并发请求会回源 D1，再走到第 3 步后看到 404，不会再泄漏。
    if (post && post.slug) {
      try {
        await env.KV.delete(`post:content:${post.slug.trim().toLowerCase()}`);
      } catch (e) {
        console.error('KV delete slug failed (delete.js):', e);
      }
    }
    try {
      await env.KV.delete(KV_LIST_KEY);
    } catch (e) {
      console.error('KV delete list failed (delete.js):', e);
    }

    // 3) 最后才动 D1
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