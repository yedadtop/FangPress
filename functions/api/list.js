// ============================================================
//  GET /api/list
//  返回已发布文章列表，按 excerpt_length 设置截取纯文本摘要
//  说明：摘要由后端在 Serverless 边缘生成，避免把全文 markdown
//        下发给浏览器；客户端只拿到标题、slug、浏览量、时间和摘要
// ============================================================

const DEFAULT_EXCERPT_LENGTH = 200;  // 兜底默认
const MAX_EXCERPT_LENGTH     = 1000; // 防御上限

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  try {
    // 1) 拉取设置中的摘要长度（缺省时回退到 200）
    let excerptLength = DEFAULT_EXCERPT_LENGTH;
    try {
      const row = await env.DB
        .prepare("SELECT value FROM site_settings WHERE key = 'excerpt_length'")
        .first();
      if (row && row.value != null) {
        const n = parseInt(String(row.value).trim(), 10);
        if (Number.isInteger(n) && n >= 0 && n <= MAX_EXCERPT_LENGTH) {
          excerptLength = n;
        }
      }
    } catch (_) { /* 设置表可能尚未初始化，忽略 */ }

    // 2) 拉取文章（带 content 字段以便截取摘要）
    let stmt;
    if (categoryParam) {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, category, views, created_at, content
         FROM posts
         WHERE category = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(categoryParam);
    } else {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, category, views, created_at, content
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      );
    }
    const { results } = await stmt.all();
    const posts = results || [];

    // 3) 字段裁剪：把 content 转成纯文本摘要后丢弃原文
    const data = posts.map(p => {
      const { content, category, ...meta } = p;
      return {
        ...meta,
        // 归一化：空串 → null，前端按"无分类"处理
        category: (!category || category.trim() === '') ? null : category,
        excerpt: excerptLength > 0 ? makeExcerpt(content || '', excerptLength) : ''
      };
    });

    return new Response(JSON.stringify({ success: true, data }), {
      headers: {
        "Content-Type": "application/json",
        // 摘要按当前 excerpt_length 现场计算 → 不缓存，确保设置变更后立刻生效
        "Cache-Control": "no-store"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// ------------------------------------------------------------
//  轻量 markdown 剥离：移除代码块、链接、图片、标题标记等，
//  仅保留可阅读的纯文本。注意这是“展示用摘要”，不做语义完整。
// ------------------------------------------------------------
function stripMarkdown(md) {
  if (!md) return '';
  return String(md)
    // 围栏代码块整段丢弃
    .replace(/```[\s\S]*?```/g, '')
    // 行内代码保留内容
    .replace(/`([^`]+)`/g, '$1')
    // 图片 ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 链接 [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 标题前缀 # ## ### ...
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // 加粗 / 斜体
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    // 引用行
    .replace(/^\s*>\s?/gm, '')
    // 无序列表 / 有序列表标记
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // 剩余 HTML 标签
    .replace(/<[^>]+>/g, '')
    // 折叠空白
    .replace(/\s+/g, ' ')
    .trim();
}

// 截取摘要：尽量在最近的词边界断开，超出则加省略号
function makeExcerpt(content, maxLen) {
  const text = stripMarkdown(content);
  if (text.length === 0) return '';
  if (text.length <= maxLen) return text;

  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  // 去掉尾部零碎标点，再加省略号
  return cut.replace(/[\s,，.。!！?？;；:：]+$/, '') + '…';
}
