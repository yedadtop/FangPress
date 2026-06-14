// functions/lib/list-render.js
// 列表渲染共享模块：主页 / posts 列表 / tweets 列表 共用

export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    try {
        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const parts = formatter.formatToParts(d);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        return `${map.year} · ${map.month} · ${map.day}`;
    } catch (_) {
        return '';
    }
}

export function renderViewsIcon(views) {
    return `
        <span class="flex items-center gap-1 font-sans">
            <svg class="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            ${views || 0}
        </span>
        <span>·</span>
    `;
}

export function safeParseKV(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

export function renderPostItem(post, i, showViews) {
    if (!post) return '';
    const slug = post.slug || '';
    const type = post.type || 'post';
    const isTweet = type === 'tweet';

    // === 统一结构：推文与文章共用同一布局，唯一区别是文章渲染标题 ===
    const title = !isTweet && post.title ? escapeHtml(post.title) : null;
    const excerpt = post.excerpt || '';
    const dateStr = formatDate(post.created_at);
    const viewsHtml = (showViews && !isTweet) ? renderViewsIcon(post.views) : '';

    // 标题(仅文章)
    const titleHtml = title
        ? `<h2 class="font-serif text-xl md:text-[1.35rem] leading-snug text-stone-900 group-hover:text-stone-600 transition-colors mb-2.5">
             <span class="link-underline pb-0.5">${title}</span>
           </h2>`
        : '';

    // 摘要
    const excerptHtml = excerpt
        ? `<p class="font-serif text-stone-500 text-[0.95rem] leading-relaxed text-justify md:text-left" style="text-justify: inter-ideograph;">${escapeHtml(excerpt)}</p>`
        : '';

    // 元数据(日期 + 浏览量) 统一靠右下角展示
    const metaParts = [];
    if (viewsHtml) metaParts.push(viewsHtml);
    if (dateStr)   metaParts.push(`<time class="font-sans">${dateStr}</time>`);
    const metaLine = metaParts.length > 0
        ? `<div class="flex items-center justify-end gap-3 text-xs text-stone-400 tabular-nums tracking-wider mt-2.5">${metaParts.join('')}</div>`
        : '';

    return `
        <article class="fade-up py-7 group" style="animation-delay: ${i * 40}ms" data-ssr-item>
            <a href="/post/${encodeURIComponent(slug)}" class="block pl-4 border-l-2 border-stone-300 hover:border-stone-500 transition-colors">
                ${titleHtml}
                ${excerptHtml}
                ${metaLine}
            </a>
        </article>
    `;
}

/**
 * 推文专用渲染器(用于 /tweets 页面)
 * - 展示完整正文(优先 post.content,缺失时回退 excerpt)
 * - 同样应用了 float-right 布局，保持推文展现形式的全局统一
 */
export function renderTweetItem(post, i) {
    if (!post) return '';
    const slug = post.slug || '';
    const raw = (post.content != null && post.content !== '') ? post.content : (post.excerpt || '');
    const dateStr = formatDate(post.created_at);

    // 日期：放在右上角,独立一行,不再用 float,避免短文本贴着日期右侧显示
    const meta = dateStr
        ? `<div class="flex justify-end mb-1.5"><time class="text-xs text-stone-400 tabular-nums tracking-wider font-sans whitespace-nowrap">${dateStr}</time></div>`
        : '';

    // 正文：始终从新行开始左对齐
    const body = raw
        ? `<div class="font-serif text-stone-700 text-base leading-relaxed whitespace-pre-wrap break-words">${escapeHtml(raw)}</div>`
        : '';

    return `
        <article class="fade-up py-5 group" style="animation-delay: ${i * 40}ms" data-ssr-item>
            <a href="/post/${encodeURIComponent(slug)}" class="block pl-4 border-l-2 border-stone-300 hover:border-stone-500 transition-colors">
                ${meta}
                ${body}
            </a>
        </article>
    `;
}