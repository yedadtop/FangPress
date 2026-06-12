// functions/api/settings.js
import { makeExcerpt } from "./helpers.js";

const ALLOWED_KEYS = new Set(["site_title", "site_subtitle", "show_views", "excerpt_length"]);

export async function onRequestGet(context) {
  // ... 保持你原本的 GET 获取设置逻辑完全不变 ...
  const { env } = context;
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    const data = {};
    (results || []).forEach(row => { data[row.key] = row.value; });
    return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (err) { return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 }); }
}

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
    const body = await request.json();
    if (!body || typeof body !== "object") {
      return new Response(JSON.stringify({ success: false, error: "请求体不是有效对象" }), { status: 400 });
    }

    const now = new Date().toISOString();
    const upsert = env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );

    let touched = 0;
    let newExcerptLength = null;

    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      let strValue = String(value ?? "").trim();
      if (strValue === "") continue;
      
      if (key === "show_views") {
        if (!["0", "1"].includes(strValue)) continue;
      } else if (key === "excerpt_length") {
        const n = parseInt(strValue, 10);
        if (!Number.isInteger(n) || n < 0 || n > 1000) continue;
        strValue = String(n);
        newExcerptLength = n; // 记录发生变更的摘要新长度
      }
      await upsert.bind(key, strValue, now).run();
      touched++;
    }

    // ⭐ 核心联动逻辑：如果修改了摘要字数，批量重刷历史文章摘要
    if (newExcerptLength !== null) {
      // 查出所有文章的 content 用于重新截取
      const { results } = await env.DB.prepare("SELECT id, content FROM posts").all();
      const posts = results || [];

      // 利用 D1 的 batch 执行原子批量事务，效率极高
      const statements = posts.map(post => {
        const freshExcerpt = makeExcerpt(post.content || '', newExcerptLength);
        return env.DB.prepare("UPDATE posts SET excerpt = ? WHERE id = ?").bind(freshExcerpt, post.id);
      });

      if (statements.length > 0) {
        await env.DB.batch(statements);
      }
    }

    return new Response(JSON.stringify({ success: true, message: `已更新 ${touched} 项配置，并成功重刷历史文章摘要。` }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}