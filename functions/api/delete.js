export async function onRequestPost(context) {
  const { request, env } = context;

  // 同样的 Bearer 鉴权
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const clientToken = authHeader.replace("Bearer ", "");
  const { count } = await env.DB
    .prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?")
    .bind(clientToken)
    .first();
  if (count === 0) {
    return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const { id } = await request.json();

    if (!id) {
      return new Response(JSON.stringify({ success: false, error: "缺少文章 id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const result = await env.DB
      .prepare("DELETE FROM posts WHERE id = ?")
      .bind(id)
      .run();

    // D1 的 result.success 在语句成功执行时永远为 true；要看"是否影响行"必须查 meta.changes
    if (result.meta && result.meta.changes === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: true, message: "文章已删除" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
