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

    const post = await env.DB.prepare("SELECT slug FROM posts WHERE id = ?").bind(id).first();

    const result = await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();

    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章" }), { status: 404 });
    }

    // ⚡ 核心修改点：同步抹除正文和主页列表 KV
    if (post && post.slug) {
      await env.KV.delete(`post:content:${post.slug.trim().toLowerCase()}`);
    }
    await env.KV.delete(KV_LIST_KEY);

    return new Response(JSON.stringify({ success: true, message: "文章已删除" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}