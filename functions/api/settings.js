// functions/api/settings.js
import { makeExcerpt } from "./helpers.js";

const ALLOWED_KEYS = new Set(["site_title", "site_subtitle", "show_views", "excerpt_length"]);
const KV_SETTINGS_KEY = "site:settings:data"; 
const KV_LIST_KEY = "site:posts:list"; // 引入列表缓存键

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const cachedSettings = await env.KV.get(KV_SETTINGS_KEY);
    if (cachedSettings) {
      return new Response(cachedSettings, {
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=10, s-maxage=60"
        }
      });
    }

    const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    const data = {};
    (results || []).forEach(row => { data[row.key] = row.value; });

    const responseData = { success: true, data };
    const responseString = JSON.stringify(responseData);

    context.waitUntil(env.KV.put(KV_SETTINGS_KEY, responseString));

    return new Response(responseString, { 
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } 
    });
  } catch (err) { 
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 }); 
  }
}

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
        newExcerptLength = n; 
      }
      await upsert.bind(key, strValue, now).run();
      touched++;
    }

    if (newExcerptLength !== null) {
      const { results } = await env.DB.prepare("SELECT id, content FROM posts").all();
      const posts = results || [];

      const statements = posts.map(post => {
        const freshExcerpt = makeExcerpt(post.content || '', newExcerptLength);
        return env.DB.prepare("UPDATE posts SET excerpt = ? WHERE id = ?").bind(freshExcerpt, post.id);
      });

      if (statements.length > 0) {
        await env.DB.batch(statements);
      }
    }

    // ⚡ 核心修改点：联动清理配置 KV 和列表 KV（因为列表展示受设置影响）
    await env.KV.delete(KV_SETTINGS_KEY);
    await env.KV.delete(KV_LIST_KEY);

    return new Response(JSON.stringify({ success: true, message: `已更新 ${touched} 项配置并同步清理全站全量缓存。` }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}