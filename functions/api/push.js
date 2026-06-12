// functions/api/push.js
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
    const { title, slug, content, category } = await request.json();

    if (!title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "Title, slug and content are required" }), { status: 400 });
    }

    const formattedSlug = slug.trim().toLowerCase();

    // 1) 动态拉取设置中的摘要字数
    let excerptLength = 200; 
    try {
      const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'excerpt_length'").first();
      if (row && row.value != null) {
        excerptLength = parseInt(String(row.value).trim(), 10);
      }
    } catch (_) {}

    // 2) 提前计算好纯文本摘要
    const excerptText = makeExcerpt(content.trim(), excerptLength);
    const currentTime = new Date().toISOString();

    // 3) 存入 D1 数据库（包含 excerpt 字段）
    await env.DB.prepare(
      `INSERT INTO posts (title, slug, content, excerpt, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      title.trim(),
      formattedSlug,
      content.trim(),
      excerptText,
      category ? (category.trim() || null) : null,
      currentTime,
      currentTime
    )
    .run();

    // 提示：发布新文章不需要主动写入 KV，交给 get.js 动态按需懒加载缓存即可，减轻写入锁压力。

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