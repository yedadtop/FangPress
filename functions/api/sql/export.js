// functions/api/sql/export.js
// GET /api/sql/export
// 鉴权：Bearer Token
// 流式导出整个数据库为可下载的 .sql 文件
// 使用 ReadableStream + 分页 LIMIT/OFFSET，避免在内存中拼大字符串导致 OOM

const BATCH_SIZE = 100;

import { nowInShanghai } from "../../lib/time.js";

function sqlEscape(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildInsert(tableName, cols, row) {
  const values = cols.map(c => sqlEscape(row[c])).join(", ");
  const colList = cols.map(c => `"${c}"`).join(", ");
  return `INSERT INTO "${tableName}" (${colList}) VALUES (${values});`;
}

export async function onRequestGet(context) {
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

  // ========== 元数据（数据量小，可放内存） ==========
  let tables = [];
  let indexes = [];
  try {
    const tRes = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    ).all();
    tables = tRes.results || [];
    const iRes = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY name"
    ).all();
    indexes = iRes.results || [];
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  // ⚡ 修复 23：filename 也要用上海时区，与 head 段里的导出时间保持一致
  const now = nowInShanghai();
  const filenameSafe = now.replace(/[:.]/g, "-").replace(/[+\u00A0-\uFFFF]/g, ''); // 去掉 : . +
  const filename = `blog-db-${filenameSafe}.sql`;

  // ========== 构造流式响应 ==========
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1) 文件头 + 事务开始
        // ⚡ 修复 23：与外层 filename 用同一个 now 变量，避免出现「filename 一份时间、head 一份时间」的错位
        let head = "";
        head += `-- Quinn's Space 数据库导出\n`;
        head += `-- 导出时间: ${now}\n`;
        head += `-- 表数量: ${tables.length}, 索引数量: ${indexes.length}\n`;
        head += "\n";
        head += "PRAGMA foreign_keys = OFF;\n";
        head += "BEGIN TRANSACTION;\n\n";
        controller.enqueue(encoder.encode(head));
        head = null;

        // 2) 逐表导出：先写 DDL，再分页流式写 INSERT
        for (const t of tables) {
          // —— 写 DDL ——
          let ddl = "";
          ddl += `-- ============== 表: ${t.name} ==============\n`;
          ddl += `DROP TABLE IF EXISTS "${t.name}";\n`;
          ddl += `${t.sql};\n\n`;
          controller.enqueue(encoder.encode(ddl));
          ddl = null;

          // —— 取列名（PRAGMA 方式，空表也能拿到） ——
          const { results: colInfo } = await env.DB.prepare(
            `PRAGMA table_info("${t.name}")`
          ).all();
          if (!colInfo || colInfo.length === 0) {
            controller.enqueue(encoder.encode("\n"));
            continue;
          }
          const cols = colInfo.map(c => c.name);

          // —— 分页读取 INSERT 并立即推送 ——
          let offset = 0;
          while (true) {
            // ⚠️ D1 不支持 LIMIT/OFFSET 用 ? 占位符绑定（会抛 SQLITE_AUTH），
            // 必须字符串插值。BATCH_SIZE 是常量、offset 是数字，安全。
            const { results } = await env.DB.prepare(
              `SELECT * FROM "${t.name}" LIMIT ${BATCH_SIZE} OFFSET ${offset}`
            ).all();

            if (!results || results.length === 0) break;

            // 把当前批次的 INSERT 拼成 chunk
            let chunk = "";
            for (const r of results) {
              chunk += buildInsert(t.name, cols, r) + "\n";
            }
            // 立刻推送给客户端，并清空 chunk 让 GC 释放
            controller.enqueue(encoder.encode(chunk));
            chunk = null;

            offset += BATCH_SIZE;
            if (results.length < BATCH_SIZE) break;
          }

          controller.enqueue(encoder.encode("\n"));
        }

        // 3) 重建索引
        for (const idx of indexes) {
          if (idx.sql) {
            controller.enqueue(encoder.encode(`${idx.sql};\n`));
          }
        }

        // 4) 事务提交 + 恢复外键
        controller.enqueue(encoder.encode("COMMIT;\nPRAGMA foreign_keys = ON;\n"));

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}
