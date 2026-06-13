// functions/api/sql/tables.js
// GET /api/sql/tables
// 鉴权：Bearer Token（API_TOKEN 或 users.password_hash）
// 列出数据库中所有业务表（排除 sqlite_* 系统表）及其行数

export async function onRequestGet(context) {
  const { request, env } = context;

  // 鉴权
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiToken = env.API_TOKEN;
  if (!apiToken || clientToken !== apiToken) {
    const { count } = await env.DB
      .prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?")
      .bind(clientToken)
      .first();
    if (count === 0) {
      return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }
  }

  try {
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    ).all();

    // 逐个表统计行数
    const data = [];
    for (const t of (tables || [])) {
      const row = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).first();
      data.push({ name: t.name, rows: row ? row.cnt : 0 });
    }

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
