// ============================================================
//  GET /api/user   鉴权：取当前账户信息（不含密码哈希）
//  POST 改密改用户名请见 ./user/update.js
// ============================================================

export async function onRequestGet(context) {
  const { request, env } = context;

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
    return new Response(JSON.stringify({ success: true, data: { is_api_token: true } }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const user = await env.DB
    .prepare("SELECT id, username, nickname, created_at FROM users WHERE password_hash = ?")
    .bind(clientToken)
    .first();

  if (!user) {
    return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ success: true, data: user }), {
    headers: { "Content-Type": "application/json" }
  });
}
