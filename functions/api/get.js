export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return new Response(JSON.stringify({ success: false, error: 'Missing slug parameter' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const post = await env.DB.prepare(
      "SELECT title, content, category, views, created_at FROM posts WHERE slug = ? AND status = 'published'"
    )
    .bind(slug)
    .first();

    if (!post) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    context.waitUntil(
      env.DB.prepare("UPDATE posts SET views = views + 1 WHERE slug = ?").bind(slug).run()
    );

    post.views += 1;

    return new Response(JSON.stringify({ success: true, data: post }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}