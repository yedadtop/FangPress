// functions/api/user.js
// 共享 KV 缓存键：与 settings.js / nav-render.js 风格保持一致
const KV_USER_KEY = "site:user:profile:data";

export async function onRequestGet(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  // 与 push.js / update.js / settings.js / user/update.js 保持一致：正则清洗不区分大小写 + 容忍多空格
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  // 1) KV 优先命中（仅命中「账号密码登录的用户」；API_TOKEN 不进缓存）
  const apiToken = env.API_TOKEN;
  if (!apiToken || clientToken !== apiToken) {
    const cached = await env.KV.get(KV_USER_KEY).catch(() => null);
    if (cached) {
      try {
        const obj = JSON.parse(cached);
        // 仅当 KV 里缓存的就是当前 token 对应的用户时才直接返回，避免 token 切换后命中旧值
        if (obj && obj.success && obj.data && obj.data.password_hash === clientToken) {
          const { password_hash, ...safe } = obj.data;
          return new Response(JSON.stringify({ success: true, data: safe }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
          });
        }
      } catch (_) { /* 损坏就走 D1 */ }
    }
  }

  // 2) API_TOKEN 走「最小返回」分支（不读 D1 用户表，避免泄漏账号体系）
  if (apiToken && clientToken === apiToken) {
    return new Response(JSON.stringify({ success: true, data: { is_api_token: true } }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // 3) D1 兜底
  const user = await env.DB
    .prepare("SELECT id, username, nickname, avatar, password_hash, created_at FROM users WHERE password_hash = ?")
    .bind(clientToken)
    .first();

  if (!user) {
    return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 异步回填 KV（不阻塞响应）；写入整行（含 password_hash），由 1) 处的过滤逻辑保证只能由对应 token 命中
  const put = env.KV.put(KV_USER_KEY, JSON.stringify({ success: true, data: user }))
    .catch(err => console.error('[user] KV 回填失败:', err));
  context.waitUntil(put);

  // 返回前剥离 password_hash
  const { password_hash, ...safe } = user;
  return new Response(JSON.stringify({ success: true, data: safe }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
