// functions/api/helpers.js

/**
 * 剥离 Markdown 标签，仅保留纯文本
 */
export function stripMarkdown(md) {
  if (!md) return '';
  return String(md)
    .replace(/```[\s\S]*?```/g, '') // 丢弃代码块
    .replace(/`([^`]+)`/g, '$1')   // 行内代码
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // 图片
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // 链接
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // 标题
    .replace(/(\*\*|__)(.+?)\1/g, '$2')       // 加粗
    .replace(/(\*|_)(.+?)\1/g, '$2')          // 斜体
    .replace(/^\s*>\s?/gm, '')                // 引用
    .replace(/^\s*[-*+]\s+/gm, '')            // 无序列表
    .replace(/^\s*\d+\.\s+/gm, '')            // 有序列表
    .replace(/<[^>]+>/g, '')                  // HTML 标签
    .replace(/\s+/g, ' ')                     // 折叠空白
    .trim();
}

/**
 * 生成指定长度的摘要
 */
export function makeExcerpt(content, maxLen = 200) {
  const text = stripMarkdown(content);
  if (text.length === 0) return '';
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,，.。!！?？;；:：]+$/, '') + '…';
}

/**
 * 推文专用的摘要生成:与 makeExcerpt 行为一致,但保留 ![alt](url) 完整形态
 * 用途:首页混合列表里,推文需要把图片 markdown 留给前端转 <img>
 * 长度截断仍然按字符数计算;截断位置正好落在 markdown 中间时,会包含到行末
 */
export function makeExcerptKeepMedia(content, maxLen = 200) {
  if (!content) return '';
  // 仅去除代码块、行内代码、链接、标题、加粗、斜体、引用、列表、HTML,保留 ![alt](url)
  const text = String(content)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')  // 普通链接转纯文本
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return '';
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,，.。!！?？;；:：]+$/, '') + '…';
}