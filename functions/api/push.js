export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${env.API_TOKEN}`) {
    return new Response(JSON.stringify({ error: "Unauthorized: Invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
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