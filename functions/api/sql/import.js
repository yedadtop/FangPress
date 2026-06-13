// functions/api/sql/import.js
// POST /api/sql/import   Content-Type: application/json
// 鉴权：Bearer Token
// 请求体：{ sqlArray: ["stmt1", "stmt2", ...], isLastChunk: true|false }
// 使用 env.DB.batch() 把整批 SQL 作为单个事务执行；
// 仅当 isLastChunk === true 时才清理全站 KV 缓存。

const MAX_BATCH_SIZE = 200;            // 单批最多语句数
const MAX_STMT_BYTES = 256 * 1024;     // 单条语句最大字节数

// ⚡ D1 不接受 SQL 语法的事务控制语句，必须用 env.DB.batch() 的 JS API 表达事务。
//   而 export.js 为了让 SQL 文件对标准 SQLite 工具保持可移植，仍会写入 BEGIN/COMMIT/SAVEPOINT 等，
//   所以在 import 时需要把它们以及 D1 不支持的 PRAGMA foreign_keys 静默剥掉。
//   匹配规则：去掉首尾空白 + 注释后，匹配 D1 明确禁止的语句前缀。
const D1_BLOCKED_STMT = /^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*(?:BEGIN(?:\s+TRANSACTION|\s+DEFERRED|\s+IMMEDIATE|\s+EXCLUSIVE)?|COMMIT|END|ROLLBACK(?:\s+TO\s+\w+|\s+TRANSACTION)?|RELEASE\s+\w+|SAVEPOINT\s+\w+|PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON))\s*;?\s*$/i;

function filterD1Incompatible(sqlArray) {
  const filtered = [];
  for (let i = 0; i < sqlArray.length; i++) {
    const stmt = sqlArray[i];
    // 把整条 SQL 里的 /* */ 与 -- 注释临时剥掉，便于精确判断主语句
    const stripped = stmt
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .trim();
    if (D1_BLOCKED_STMT.test(stripped)) {
      // 静默跳过，不计入 executed 数量
      continue;
    }
    filtered.push(stmt);
  }
  return filtered;
}

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
    // 先剥掉 D1 不支持的事务/PRAGMA 语句（详见 filterD1Incompatible）
    const compatibleSql = filterD1Incompatible(sqlArray);
    const skipped = sqlArray.length - compatibleSql.length;
    // 极端情况：本批全是被过滤的事务控制语句，视为无害空批
    if (compatibleSql.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: `本批 ${sqlArray.length} 条全部为 D1 不支持的事务控制语句，已跳过`,
        executed: 0,
        skipped,
        isLastChunk,
        detail: null
      }), { headers: { "Content-Type": "application/json" } });
    }
    const prepared = compatibleSql.map(s => env.DB.prepare(s));
    const results = await env.DB.batch(prepared);

    // ========== 仅在最后一个批次清理全站缓存 ==========
    if (isLastChunk) {
      try { await clearKvByPrefix(env, "site:posts:list:page:"); } catch (_) {}
      try { await clearKvByPrefix(env, "site:posts:list:type:"); } catch (_) {}
      try { await clearKvByPrefix(env, "site:posts:list:cat:"); } catch (_) {}
      try { await env.KV.delete("site:settings:data"); } catch (_) {}
      try { await clearKvByPrefix(env, "post:content:"); } catch (_) {}
    }

    return new Response(JSON.stringify({
      success: true,
      message: isLastChunk
        ? `已成功执行 ${compatibleSql.length} 条语句${skipped ? `（已跳过 ${skipped} 条 D1 不支持的事务/PRAGMA 语句）` : ''}，全站缓存已清理`
        : `已成功执行 ${compatibleSql.length} 条语句${skipped ? `（已跳过 ${skipped} 条 D1 不支持的语句）` : ''}`,
      executed: compatibleSql.length,
      skipped,
      isLastChunk,
      detail: results || null
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
