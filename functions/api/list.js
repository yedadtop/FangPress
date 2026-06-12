// functions/api/list.js

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  try {
    // 1) 告别 content！只拉取已经生成好的 excerpt 摘要和元数据
    let stmt;
    if (categoryParam) {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, category, views, excerpt, created_at
         FROM posts
         WHERE category = ? AND status = 'published'
         ORDER BY_created_at DESC LIMIT 100`
      ).bind(categoryParam);
    } else {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, category, views, excerpt, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY_created_at DESC LIMIT 100`
      );
    }
    const { results } = await stmt.all();
    const posts = results || [];

    // 2) 归一化处理
    const data = posts.map(p => ({
      ...p,
      category: (!p.category || p.category.trim() === '') ? null : p.category
    }));

    return new Response(JSON.stringify({ success: true, data }), {
      headers: {
        "Content-Type": "application/json",
        // 由于没有 CPU 密集型计算和大数据传输，可以开启边缘 CDN 缓存
        "Cache-Control": "public, max-age=10, s-maxage=60"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}