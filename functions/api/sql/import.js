// functions/api/sql/import.js
// POST /api/sql/import   Content-Type: application/json
// 鉴权：Bearer Token
// 请求体：{ sqlArray: ["stmt1", "stmt2", ...], isLastChunk: true|false }
// 使用 env.DB.batch() 把整批 SQL 作为单个事务执行；
// 仅当 isLastChunk === true 时才清理全站 KV 缓存。

const MAX_BATCH_SIZE = 200;            // 单批最多语句数
const MAX_STMT_BYTES = 256 * 1024;     // 单条语句最大字节数

async function clearKvByPrefix(env, prefix) {
  let done = false, cursor = undefined;
  while (!done) {
    const list = await env.KV.list({ prefix, cursor });
    for (const k of list.keys) await env.KV.delete(k.name);
    done = list.list_complete; cursor = list.cursor;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ========== 鉴权 ==========
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
    const body = await request.json();
    const sqlArray = body && Array.isArray(body.sqlArray) ? body.sqlArray : null;
    if (!sqlArray || sqlArray.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "sqlArray 为空或格式错误" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }
    if (sqlArray.length > MAX_BATCH_SIZE) {
      return new Response(JSON.stringify({ success: false, error: `单批最多 ${MAX_BATCH_SIZE} 条语句` }), {
        status: 413, headers: { "Content-Type": "application/json" }
      });
    }
    for (let i = 0; i < sqlArray.length; i++) {
      const s = sqlArray[i];
      if (typeof s !== "string" || !s.trim()) {
        return new Response(JSON.stringify({ success: false, error: `第 ${i + 1} 条语句不是有效的非空字符串` }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (s.length > MAX_STMT_BYTES) {
        return new Response(JSON.stringify({ success: false, error: `第 ${i + 1} 条语句超过 ${MAX_STMT_BYTES} 字节` }), {
          status: 413, headers: { "Content-Type": "application/json" }
        });
      }
    }

    const isLastChunk = !!(body && body.isLastChunk === true);

    // ========== 核心：用 D1 batch() 把整批作为一个事务执行 ==========
    const prepared = sqlArray.map(s => env.DB.prepare(s));
    const results = await env.DB.batch(prepared);

    // ========== 仅在最后一个批次清理全站缓存 ==========
    if (isLastChunk) {
      try { await clearKvByPrefix(env, "site:posts:list:page:"); } catch (_) {}
      try { await clearKvByPrefix(env, "site:posts:list:cat:"); } catch (_) {}
      try { await env.KV.delete("site:settings:data"); } catch (_) {}
      try { await clearKvByPrefix(env, "post:content:"); } catch (_) {}
    }

    return new Response(JSON.stringify({
      success: true,
      message: isLastChunk
        ? `已成功执行 ${sqlArray.length} 条语句，全站缓存已清理`
        : `已成功执行 ${sqlArray.length} 条语句`,
      executed: sqlArray.length,
      isLastChunk,
      detail: results || null
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
