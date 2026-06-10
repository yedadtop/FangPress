export async function onRequestGet(context) {
  const { env } = context;

  try {
    // 1. 扫描 KV 中所有以 "post:" 开头的键，最多返回 100 条
    const listResult = await env.MY_KV.list({ prefix: "post:", limit: 100 });
    
    // 2. 批量获取具体内容
    const posts = await Promise.all(
      listResult.keys.map(async (key) => {
        const value = await env.MY_KV.get(key.name);
        const parsed = JSON.parse(value);
        return {
          slug: key.name.replace("post:", ""),
          ...parsed
        };
      })
    );

    // 3. 按时间倒序（最新发布的排在最前面）
    posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return new Response(JSON.stringify({ success: true, data: posts }), {
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=10" // 边缘缓存 10 秒，防止高频刷新恶刷 KV 额度
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}