export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  try {
    let stmt;

    if (categoryParam) {
      const query = `SELECT id, title, slug, category, views, created_at 
                     FROM posts 
                     WHERE category = ? AND status = 'published'
                     ORDER BY created_at DESC LIMIT 100`;
      stmt = env.DB.prepare(query).bind(categoryParam);
    } else {
      const query = `SELECT id, title, slug, category, views, created_at 
                     FROM posts 
                     WHERE status = 'published'
                     ORDER BY created_at DESC LIMIT 100`;
      stmt = env.DB.prepare(query);
    }

    const { results } = await stmt.all();

    return new Response(JSON.stringify({ success: true, data: results }), {
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=5"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}