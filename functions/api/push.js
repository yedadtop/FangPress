export async function onRequestPost(context) {
  const { request, env } = context;

  // 鉴权：Bearer Token 优先检查 KV 中的 API_TOKEN
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  const clientToken = authHeader.replace("Bearer ", "");

  const apiToken = await env.KV.get("API_TOKEN");
  if (apiToken && clientToken === apiToken) {
    // API_TOKEN 鉴权通过
  } else {
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
  }

  try {
    const { title, slug, content, category } = await request.json();

    if (!title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "Title, slug and content are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const currentTime = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO posts (title, slug, content, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      title.trim(),
      slug.trim().toLowerCase(),
      content.trim(),
      category ? category.trim() : '未分类',
      currentTime,
      currentTime
    )
    .run();

    return new Response(JSON.stringify({ success: true, message: "Post saved to D1 successfully" }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "The slug already exists" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}