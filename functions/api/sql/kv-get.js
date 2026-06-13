// functions/api/sql/kv-get.js
// GET /api/sql/kv/get?key=<name>&type=<json|text>
// 鉴权：Bearer Token
// 读取 KV 某个键的原始值，type=json 时尝试解析（仅展示用途，原值原样返回）

const MAX_VALUE_BYTES = 256 * 1024; // 单次返回不超过 256KB，避免前端卡死

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
  const key = url.searchParams.get("key") || "";
  if (!key) {
    return new Response(JSON.stringify({ success: false, error: "缺少 key 参数" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  if (key.length > 512) {
    return new Response(JSON.stringify({ success: false, error: "key 长度超限" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }

  const type = (url.searchParams.get("type") || "text").toLowerCase();

  try {
    const value = await env.KV.get(key);
    if (value === null) {
      return new Response(JSON.stringify({ success: true, data: { key, value: null, exists: false } }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const truncated = value.length > MAX_VALUE_BYTES;
    const slice = truncated ? value.slice(0, MAX_VALUE_BYTES) : value;

    let parsed = null;
    let parseError = null;
    if (type === "json") {
      try { parsed = JSON.parse(slice); } catch (e) { parseError = e.message; }
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        key,
        value: slice,
        exists: true,
        size: value.length,
        truncated,
        parsed,
        parseError
      }
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
