export async function onRequestPost(context) {
  const { request, env } = context;

// 修改 functions/api/push.js 的安全校验部分
const authHeader = request.headers.get("Authorization");
if (!authHeader) return new Response("Unauthorized", { status: 401 });

const clientToken = authHeader.replace("Bearer ", "");
// 去数据库数一下，有没有哪个用户的 password_hash 能对上这个 Token
const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?").bind(clientToken).first();
if (count === 0) {
  return new Response(JSON.stringify({ error: "口令失效，请重新登录" }), { status: 401 });
}

  try {
    const { title, slug, content, category } = await request.json();
    
    if (!title || !slug || !content) {
      return new Response(JSON.stringify({ error: "Title, slug and content are required" }), { 
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
    if (err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ error: "The slug already exists" }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}