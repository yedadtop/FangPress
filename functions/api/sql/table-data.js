// functions/api/sql/table-data.js
// GET /api/sql/table-data?table=<name>&page=<n>&pageSize=<n>
// 鉴权：Bearer Token
// 拉取指定表的数据：列元信息 + 分页行数据

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
// ⚡ 修复 13：删掉空 Set。原代码 const SYSTEM_TABLES = new Set() 永远不会命中任何值，
//   仅靠正则 `^[A-Za-z_][A-Za-z0-9_]*$` 拦截非法字符（sqlite_* 仍会被正则拒绝）即可。

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

  const url = new URL(request.url);
  const table = (url.searchParams.get("table") || "").trim();
  if (!table) {
    return new Response(JSON.stringify({ success: false, error: "缺少 table 参数" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    return new Response(JSON.stringify({ success: false, error: "非法的表名" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  let page = parseInt(url.searchParams.get("page") || "1", 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  let pageSize = parseInt(url.searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  try {
    // 校验表存在并获取列元信息
    const tbl = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).bind(table).first();
    if (!tbl) {
      return new Response(JSON.stringify({ success: false, error: "表不存在" }), {
        status: 404, headers: { "Content-Type": "application/json" }
      });
    }

    const { results: cols } = await env.DB.prepare(`PRAGMA table_info("${table}")`).all();
    const columns = (cols || []).map(c => ({
      name: c.name,
      type: c.type || "",
      notnull: !!c.notnull,
      pk: !!c.pk,
      dflt: c.dflt_value
    }));

    const { results: cntRow } = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).all();
    const total = (cntRow && cntRow[0]) ? cntRow[0].cnt : 0;

    const offset = (page - 1) * pageSize;
    // ⚠️ D1 不支持 LIMIT/OFFSET 用 ? 占位符绑定（会抛 SQLITE_AUTH），
    // 必须字符串插值。pageSize / offset 已在上面被 Number.isInteger 校验过，无注入风险。
    const { results: rows } = await env.DB.prepare(
      `SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT ${pageSize} OFFSET ${offset}`
    ).all();

    return new Response(JSON.stringify({
      success: true,
      data: {
        table,
        columns,
        rows: rows || [],
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
