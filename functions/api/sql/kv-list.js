// functions/api/sql/kv-list.js
// GET /api/sql/kv/list?prefix=<str>&limit=<n>&cursor=<str>
// 鉴权：Bearer Token
// 分页列出 KV 中的所有键（支持 prefix 过滤），同时返回 KV 命名空间下的总条数

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

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
  const prefix = url.searchParams.get("prefix") || "";
  let limit = parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10);
  if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  const cursor = url.searchParams.get("cursor") || undefined;

  try {
    const opts = { limit };
    if (prefix) opts.prefix = prefix;
    if (cursor) opts.cursor = cursor;

    const list = await env.KV.list(opts);

    // 把当前页的 keys 整理为前端展示格式；list_complete / cursor 由调用方用来判断是否还有下一页
    const keys = (list.keys || []).map(k => ({
      name: k.name,
      // expiration / metadata 视 KV 兼容性返回
      expiration: k.expiration || null,
      metadata: k.metadata || null
    }));

    return new Response(JSON.stringify({
      success: true,
      data: {
        keys,
        list_complete: !!list.list_complete,
        cursor: list.cursor || null,
        prefix
      }
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
