// functions/api/settings.js
const ALLOWED_KEYS = new Set(["site_title", "site_subtitle", "show_views", "excerpt_length"]);
const KV_SETTINGS_KEY = "site:settings:data"; 
const KV_LIST_KEY = "site:posts:list"; 

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
  // 修复：不区分大小写的 Bearer 清洗
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
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
      }
      await upsert.bind(key, strValue, now).run();
      touched++;
    }

    // ⚡ 核心移除：这里彻底删除了原先消耗海量 CPU 的 D1 `posts` 表批量 UPDATE
    // 由于我们在 list.js 实现了动态裁剪，这里只需精准让 KV 失效：
    await env.KV.delete(KV_SETTINGS_KEY);
    await env.KV.delete(KV_LIST_KEY);

    // 💡 进阶联动优化：因为修改设置可能导致全站的分类列表布局也发生变动，
    // 我们利用 KV 的 list 机制把带有特定分类前缀的列表缓存一口气全部扫除清除
    try {
      const kvKeys = await env.KV.list({ prefix: "site:posts:list:cat:" });
      for (const k of kvKeys.keys) {
        await env.KV.delete(k.name);
      }
    } catch (_) {}

    // 主动把更新后的最新配置回填到 KV（异步，不阻塞响应；与 GET 路径、list.js 风格一致）
    const { results: freshSettings } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    const freshData = {};
    (freshSettings || []).forEach(row => { freshData[row.key] = row.value; });
    context.waitUntil(
      env.KV.put(KV_SETTINGS_KEY, JSON.stringify({ success: true, data: freshData }))
    );

    return new Response(JSON.stringify({ success: true, message: `已更新 ${touched} 项配置并联动清空全站缓存。` }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}