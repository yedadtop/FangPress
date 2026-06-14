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

    // 推文渲染(混合列表场景,如首页 mix 模式):
    //  - 采用 float 布局：日期靠右浮动，正文环绕，确保文字自然换行并包裹在日期下方
    if (type === 'tweet') {
        const dateStr = formatDate(post.created_at);
        
        // 日期标签：设置为 float-right，加左边距让文字不紧贴，顶部微调对齐首行
        const meta = dateStr
            ? `<time class="float-right ml-4 mt-1 text-xs text-stone-400 tabular-nums tracking-wider font-sans whitespace-nowrap">${dateStr}</time>`
            : '';

        // 正文容器：将 meta 直接塞入内部，使用 div 替换 p
        const excerpt = post.excerpt
            ? `<div class="font-serif text-stone-500 text-[0.95rem] leading-relaxed text-justify md:text-left" style="text-justify: inter-ideograph;">
                 ${meta}
                 ${escapeHtml(post.excerpt)}
               </div>`
            : meta;

        return `
            <article class="fade-up py-7 group" style="animation-delay: ${i * 40}ms" data-ssr-item>
                <a href="/post/${encodeURIComponent(slug)}" class="block pl-4 border-l-2 border-stone-300 hover:border-stone-500 transition-colors">
                    ${excerpt}
                </a>
            </article>
        `;
    }

    // 文章渲染：标题 + 日期(右侧同行) + 摘要
    const title = escapeHtml(post.title || '未命名');
    const excerpt = post.excerpt
        ? `<p class="mt-2.5 font-serif text-stone-500 text-[0.95rem] leading-relaxed text-justify md:text-left" style="text-justify: inter-ideograph;">${escapeHtml(post.excerpt)}</p>`
        : '';
    const viewsHtml = showViews ? renderViewsIcon(post.views) : '';
    return `
        <article class="fade-up py-7 group" style="animation-delay: ${i * 40}ms" data-ssr-item>
            <a href="/post/${encodeURIComponent(slug)}" class="block">
                <div class="flex flex-col md:flex-row md:items-baseline justify-between gap-2 md:gap-6">
                    <h2 class="font-serif text-xl md:text-[1.35rem] leading-snug text-stone-900 group-hover:text-stone-600 transition-colors">
                        <span class="link-underline pb-0.5">${title}</span>
                    </h2>
                    <div class="flex items-center gap-3 text-xs text-stone-400 tabular-nums tracking-wider pt-1 md:pt-1.5">
                        ${viewsHtml}
                        <time class="font-sans">${formatDate(post.created_at)}</time>
                    </div>
                </div>
                ${excerpt}
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