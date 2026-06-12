// functions/api/push.js
import { makeExcerpt } from "./helpers.js";

const KV_LIST_KEY = "site:posts:list";
const POST_CACHE_TTL = 604800; // 7 天，与 get.js 保持一致

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
    const { title, slug, content, category } = await request.json();

    if (!title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "Title, slug and content are required" }), { status: 400 });
    }

    const formattedSlug = slug.trim().toLowerCase();

    let excerptLength = 200; 
    try {
      const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'excerpt_length'").first();
      if (row && row.value != null) {
        excerptLength = parseInt(String(row.value).trim(), 10);
      }
    } catch (_) {}

    const excerptText = makeExcerpt(content.trim(), excerptLength);
    const currentTime = new Date().toISOString();

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

    // ⚡ 核心修改点：写库的同时主动把新文章大字段灌入 KV。
    //    不缓存 views（views 是高频变化字段，交给 get.js 每次实时读 D1）。
    const newPostCache = {
      title: title.trim(),
      content: content.trim(),
      category: category ? (category.trim() || null) : null,
      created_at: currentTime
    };
    // 缓存写入失败不能让接口 500；D1 已经是 source of truth，下次读会回源并重新回填
    try {
      await env.KV.put(
        `post:content:${formattedSlug}`,
        JSON.stringify(newPostCache),
        { expirationTtl: POST_CACHE_TTL }
      );
    } catch (e) {
      console.error('KV put failed (push.js):', e);
    }

    // 清理公开列表的 KV 缓存，确保主页更新（同样容错）
    try {
      await env.KV.delete(KV_LIST_KEY);
    } catch (e) {
      console.error('KV delete list failed (push.js):', e);
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