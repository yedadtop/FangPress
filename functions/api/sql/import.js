// functions/api/sql/import.js
// POST /api/sql/import   Content-Type: application/json
// 鉴权：Bearer Token
// 请求体：{ sqlArray: ["stmt1", "stmt2", ...], isLastChunk: true|false, mode: "overwrite"|"incremental" }
// 使用 env.DB.batch() 把整批 SQL 作为单个事务执行；
// 仅当 isLastChunk === true 时才清理全站 KV 缓存。
//
// 模式说明：
//   - overwrite  （默认）：原样执行所有语句（除 D1 不支持的事务控制语句），
//                         适合从本系统导出的全量备份恢复，会先 DROP 再重建表。
//   - incremental        ：增量合并。跳过 DROP TABLE / CREATE INDEX；
//                         将 INSERT INTO 改写为 INSERT OR IGNORE INTO，
//                         已存在（主键 / 唯一约束冲突）的记录会被保留，仅插入新行。

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

// 增量模式下需要跳过的语句：开头（去掉前置注释）是 DROP TABLE / CREATE [UNIQUE] INDEX
const DROP_TABLE_STMT   = /^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)(?:\s*\.("?[^"]+"?))?\s*;?\s*$/i;
const CREATE_INDEX_STMT = /^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*CREATE\s+(?:UNIQUE\s+)?INDEX\s+/i;
// CREATE TABLE 后面不是 IF NOT EXISTS 的（用否定预查避免误伤已经带 IF NOT EXISTS 的语句）
const CREATE_TABLE_NEEDS_GUARD_RE = /^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*CREATE\s+TABLE(\s+)(?!IF\s+NOT\s+EXISTS)/i;
// 把 INSERT 后面紧跟的 INTO 改写成 INSERT OR IGNORE INTO。
// 用 \bINSERT\s+INTO\b 可以避开 INSERT OR IGNORE INTO / INSERT OR REPLACE INTO。
const INSERT_INTO_RE = /\bINSERT\s+INTO\b/;

function transformForIncremental(sqlArray) {
  const result = [];
  let droppedTables = 0;
  let droppedIndexes = 0;
  let guardedTables = 0;
  let transformedInserts = 0;

  for (let i = 0; i < sqlArray.length; i++) {
    const stmt = sqlArray[i];
    if (DROP_TABLE_STMT.test(stmt))   { droppedTables++;   continue; }
    if (CREATE_INDEX_STMT.test(stmt)) { droppedIndexes++;  continue; }

    if (CREATE_TABLE_NEEDS_GUARD_RE.test(stmt)) {
      // CREATE TABLE → CREATE TABLE IF NOT EXISTS：避免与已存在表冲突
      result.push(stmt.replace(CREATE_TABLE_NEEDS_GUARD_RE, 'CREATE TABLE IF NOT EXISTS$1'));
      guardedTables++;
    } else if (INSERT_INTO_RE.test(stmt)) {
      result.push(stmt.replace(INSERT_INTO_RE, 'INSERT OR IGNORE INTO'));
      transformedInserts++;
    } else {
      result.push(stmt);
    }
  }

  return {
    sqlArray: result,
    droppedTables,
    droppedIndexes,
    guardedTables,
    transformedInserts
  };
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
    const mode = (body && typeof body.mode === "string") ? body.mode.toLowerCase() : "overwrite";
    if (mode !== "overwrite" && mode !== "incremental") {
      return new Response(JSON.stringify({ success: false, error: `不支持的导入模式: ${mode}` }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    // ========== 1) 剥掉 D1 不支持的事务/PRAGMA 语句 ==========
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
        mode,
        detail: null
      }), { headers: { "Content-Type": "application/json" } });
    }

    // ========== 2) 按模式改写 / 过滤 ==========
    let toExecute = compatibleSql;
    let modeStats = { droppedTables: 0, droppedIndexes: 0, guardedTables: 0, transformedInserts: 0 };
    if (mode === "incremental") {
      const t = transformForIncremental(compatibleSql);
      toExecute = t.sqlArray;
      modeStats = { droppedTables: t.droppedTables, droppedIndexes: t.droppedIndexes, guardedTables: t.guardedTables, transformedInserts: t.transformedInserts };
      if (toExecute.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          message: `增量模式下本批 ${compatibleSql.length} 条全部被跳过（${t.droppedTables} 条 DROP TABLE + ${t.droppedIndexes} 条 CREATE INDEX）`,
          executed: 0,
          skipped,
          isLastChunk,
          mode,
          modeStats,
          detail: null
        }), { headers: { "Content-Type": "application/json" } });
      }
    }

    // ========== 3) 用 D1 batch() 把整批作为一个事务执行 ==========
    const prepared = toExecute.map(s => env.DB.prepare(s));
    const results = await env.DB.batch(prepared);

    // ========== 4) 仅在最后一个批次清理全站缓存 ==========
    if (isLastChunk) {
      try { await clearKvByPrefix(env, "site:posts:list:page:"); } catch (_) {}
      try { await clearKvByPrefix(env, "site:posts:list:type:"); } catch (_) {}
      try { await clearKvByPrefix(env, "site:posts:list:cat:"); } catch (_) {}
      try { await env.KV.delete("site:settings:data"); } catch (_) {}
      try { await clearKvByPrefix(env, "post:content:"); } catch (_) {}
    }

    const executed = toExecute.length;
    let message;
    if (mode === "incremental") {
      const parts = [];
      if (modeStats.droppedTables)   parts.push(`跳过 ${modeStats.droppedTables} 条 DROP TABLE`);
      if (modeStats.droppedIndexes)  parts.push(`跳过 ${modeStats.droppedIndexes} 条 CREATE INDEX`);
      if (modeStats.guardedTables)   parts.push(`为 ${modeStats.guardedTables} 条 CREATE TABLE 加 IF NOT EXISTS`);
      if (modeStats.transformedInserts) parts.push(`改写 ${modeStats.transformedInserts} 条 INSERT 为 INSERT OR IGNORE`);
      const tail = skipped ? `（另有 ${skipped} 条 D1 不支持的事务/PRAGMA 已跳过）` : '';
      const cache = isLastChunk ? '，全站缓存已清理' : '';
      message = `增量模式：已执行 ${executed} 条语句${parts.length ? '，' + parts.join('、') : ''}${tail}${cache}`;
    } else {
      message = isLastChunk
        ? `覆盖模式：已成功执行 ${executed} 条语句${skipped ? `（已跳过 ${skipped} 条 D1 不支持的事务/PRAGMA 语句）` : ''}，全站缓存已清理`
        : `覆盖模式：已成功执行 ${executed} 条语句${skipped ? `（已跳过 ${skipped} 条 D1 不支持的语句）` : ''}`;
    }

    return new Response(JSON.stringify({
      success: true,
      message,
      executed,
      skipped,
      isLastChunk,
      mode,
      modeStats,
      detail: results || null
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
