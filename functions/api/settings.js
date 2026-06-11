// ============================================================
//  GET  /api/settings   公开：读取站点设置
//  POST /api/settings   鉴权：批量更新设置项
//  表结构：site_settings (key TEXT PK, value TEXT, updated_at TEXT)
// ============================================================

const ALLOWED_KEYS = new Set(["site_title", "site_subtitle", "show_views", "excerpt_length"]);

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const { results } = await env.DB
      .prepare("SELECT key, value FROM site_settings")
      .all();

    const data = {};
    (results || []).forEach(row => { data[row.key] = row.value; });

    return new Response(JSON.stringify({ success: true, data }), {
      headers: {
        "Content-Type": "application/json",
        // 设置项需在管理员保存后立刻反映到前台 / 后台表单，关掉缓存
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // 鉴权：Bearer Token 必须在 users 表里能对上
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const clientToken = authHeader.replace("Bearer ", "");

  // 优先检查 KV 中的 API_TOKEN
  const apiToken = await env.KV.get("API_TOKEN");
  if (apiToken && clientToken === apiToken) {
    // API_TOKEN 鉴权通过，继续处理请求
  } else {
    const { count } = await env.DB
      .prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?")
      .bind(clientToken)
      .first();
    if (count === 0) {
      return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      return new Response(JSON.stringify({ success: false, error: "请求体不是有效对象" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const now = new Date().toISOString();
    const upsert = env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    );

    let touched = 0;
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      let strValue = String(value ?? "").trim();
      if (strValue === "") continue;
      // show_views 强约束为 0/1
      if (key === "show_views") {
        if (!["0", "1"].includes(strValue)) continue;
      } else if (key === "excerpt_length") {
        // 0 - 1000 之间的整数；0 表示关闭摘要
        const n = parseInt(strValue, 10);
        if (!Number.isInteger(n) || n < 0 || n > 1000) continue;
        strValue = String(n);
      }
      await upsert.bind(key, strValue, now).run();
      touched++;
    }

    return new Response(JSON.stringify({ success: true, message: `已更新 ${touched} 项配置` }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
