// functions/api/update.js
import { makeExcerpt } from "./helpers.js";

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
    const { id, title, slug, content, category } = await request.json();

    if (!id || !title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "id / 标题 / 路径 / 正文不能为空" }), { status: 400 });
    }

    const newSlug = slug.trim().toLowerCase();

    // 1) 找出修改前的旧 slug，用来精准定点清除 KV
    const oldPost = await env.DB.prepare("SELECT slug FROM posts WHERE id = ?").bind(id).first();

    // 2) 动态获取当前摘要字数配置
    let excerptLength = 200;
    try {
      const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'excerpt_length'").first();
      if (row && row.value != null) {
        excerptLength = parseInt(String(row.value).trim(), 10);
      }
    } catch (_) {}

    // 3) 重新计算摘要
    const excerptText = makeExcerpt(content.trim(), excerptLength);
    const now = new Date().toISOString();

    const result = await env.DB
      .prepare(
        `UPDATE posts
         SET title = ?, slug = ?, content = ?, excerpt = ?, category = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(title.trim(), newSlug, content.trim(), excerptText, category ? (category.trim() || null) : null, now, id)
      .run();

    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章，可能已被删除" }), { status: 404 });
    }

    // 4) 成功更新数据库后，清除 KV 旧脏数据（使用 context.waitUntil 异步清除，不卡响应速度）
    context.waitUntil((async () => {
      if (oldPost && oldPost.slug) {
        await env.KV.delete(`post:content:${oldPost.slug.trim().toLowerCase()}`);
      }
      await env.KV.delete(`post:content:${newSlug}`);
    })());

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