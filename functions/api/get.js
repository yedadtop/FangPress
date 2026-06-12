// functions/api/get.js

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
    const kvKey = `post:content:${slug.trim().toLowerCase()}`;
    
    // 1) 优先尝试从全球边缘 KV 命中缓存
    let cachedPost = await env.KV.get(kvKey);
    let post;

    if (cachedPost) {
      post = JSON.parse(cachedPost);
    } else {
      // 2) 缓存未命中，回源 D1 数据库
      post = await env.DB.prepare(
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

      post.category = (!post.category || post.category.trim() === '') ? null : post.category;

      // 3) 异步将正文塞进 KV（缓存 7 天），不阻塞本次请求返回
      context.waitUntil(
        env.KV.put(kvKey, JSON.stringify(post), { expirationTtl: 604800 })
      );
    }

    // 4) 异步增加浏览量计数（保持 D1 views 的数据更新）
    context.waitUntil(
      (async () => {
        try {
          await env.DB.prepare("UPDATE posts SET views = views + 1 WHERE slug = ?").bind(slug).run();
        } catch (_) {}
      })()
    );

    // 内存数据自增 1，使用户体验连贯
    post.views += 1;

    return new Response(JSON.stringify({ success: true, data: post }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=5' // 允许浏览器端进行短时间强缓存
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}