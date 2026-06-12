// functions/api/get.js
async function isAuthorizedAdmin(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const clientToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!clientToken) return false;

  if (env.API_TOKEN && clientToken === env.API_TOKEN) return true;

  try {
    const row = await env.DB.prepare(
      "SELECT 1 as one FROM users WHERE password_hash = ? LIMIT 1"
    ).bind(clientToken).first();
    return !!row;
  } catch (_) {
    return false;
  }
}

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

  const normalizedSlug = slug.trim().toLowerCase();
  const kvKey = `post:content:${normalizedSlug}`;
  const isAdmin = await isAuthorizedAdmin(request, env);

  try {
    // ⚡ 1) KV 优先策略:大字段和小字段(id/status/views)一并入缓存,关键路径完全脱离 D1
    const cached = await env.KV.get(kvKey);

    if (cached) {
      const c = JSON.parse(cached);
      // 兼容旧格式缓存:若缺 id/status/views 关键字段则降级回 D1,下次回填时自动升级到新格式
      if (c && c.id != null && c.status != null && c.views != null) {
        // 草稿保护:未发布文章对前台访客 404
        if (c.status !== 'published' && !isAdmin) {
          return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const post = {
          title: c.title,
          content: c.content,
          category: c.category ?? null,
          created_at: c.created_at,
          // 内存补偿 +1,真实写入交给 waitUntil 异步完成
          views: c.views + 1
        };

        // 浏览量自增完全移出关键路径
        if (c.status === 'published') {
          context.waitUntil(
            env.DB.prepare("UPDATE posts SET views = views + 1 WHERE id = ?")
              .bind(c.id)
              .run()
              .catch(err => console.error('Async views increment failed:', err))
          );
        }

        return new Response(JSON.stringify({ success: true, data: post }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': c.status === 'published' ? 'public, max-age=5' : 'no-store'
          }
        });
      }
    }

    // 2) KV miss 或旧格式 → D1 一次性拿全部字段(原本 2 条 SELECT 合并为 1 条)
    const dbPost = await env.DB.prepare(
      "SELECT id, status, views, title, content, category, created_at FROM posts WHERE slug = ?"
    ).bind(normalizedSlug).first();

    if (!dbPost) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (dbPost.status !== 'published' && !isAdmin) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const category = (!dbPost.category || dbPost.category.trim() === '') ? null : dbPost.category;
    const post = {
      title: dbPost.title,
      content: dbPost.content,
      category,
      created_at: dbPost.created_at,
      views: dbPost.views + 1
    };

    if (dbPost.status === 'published') {
      // ⚡ 回填新格式 KV(下次直接命中关键路径,零 D1 等待)
      const cachePayload = {
        id: dbPost.id,
        status: dbPost.status,
        views: dbPost.views,
        title: dbPost.title,
        content: dbPost.content,
        category,
        created_at: dbPost.created_at
      };
      context.waitUntil(
        env.KV.put(kvKey, JSON.stringify(cachePayload), { expirationTtl: 604800 })
          .catch(err => console.error('KV put failed (get.js):', err))
      );
      // 浏览量自增异步化
      context.waitUntil(
        env.DB.prepare("UPDATE posts SET views = views + 1 WHERE id = ?")
          .bind(dbPost.id)
          .run()
          .catch(err => console.error('Async views increment failed:', err))
      );
    }

    return new Response(JSON.stringify({ success: true, data: post }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': dbPost.status === 'published' ? 'public, max-age=5' : 'no-store'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}