// functions/api/settings.js
import { makeExcerpt } from "./helpers.js";

const ALLOWED_KEYS = new Set(["site_title", "site_subtitle", "show_views", "excerpt_length"]);
const KV_SETTINGS_KEY = "site:settings:data"; // 统一的配置项 KV 缓存键名

export async function onRequestGet(context) {
  const { env } = context;
  try {
    // 🚀 1) 优先尝试从全球边缘 KV 命中缓存
    const cachedSettings = await env.KV.get(KV_SETTINGS_KEY);
    if (cachedSettings) {
      return new Response(cachedSettings, {
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=10, s-maxage=60" // 允许短时间边缘强缓存
        }
      });
    }

    // 2) 缓存未命中，回源到 D1 关系型数据库查询
    const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    const data = {};
    (results || []).forEach(row => { data[row.key] = row.value; });

    const responseData = { success: true, data };
    const responseString = JSON.stringify(responseData);

    // 3) 异步将最新配置写回 KV 挡住后续流量（设置不限时永久缓存，直到后台修改时被清空）
    context.waitUntil(
      env.KV.put(KV_SETTINGS_KEY, responseString)
    );

    return new Response(responseString, { 
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } 
    });
  } catch (err) { 
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 }); 
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ... 鉴权逻辑保持绝对不变 ...
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

    // 核心联动逻辑：如果修改了摘要字数，批量重刷历史文章摘要
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

    // ⚡ 核心提速修改点：保存成功后，立刻将 KV 里的配置项脏缓存抹除
    // 这样下次前台不管是访问主页还是单页，都会触发全新的回源，动态获取最新配置并重新生成无缝的 KV 缓存
    await env.KV.delete(KV_SETTINGS_KEY);

    return new Response(JSON.stringify({ success: true, message: `已更新 ${touched} 项配置，完成全站摘要及 KV 缓存刷新。` }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}