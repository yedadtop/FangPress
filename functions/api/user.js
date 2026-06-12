export async function onRequestGet(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  // 修复：与 push.js / update.js / settings.js 保持一致，正则清洗不区分大小写 + 容忍多空格
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  // 修复：直接从环境变量 env 中读取 API_TOKEN
  const apiToken = env.API_TOKEN;
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