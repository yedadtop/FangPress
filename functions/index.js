// functions/index.js
// 首页 SSR：在边缘将 KV 列表注入到 #ssr-post-list 容器
// 数据契约（与 functions/api/list.js 一致）：
//   env.KV.get('site:posts:list')      -> { success:true, data:[{id,title,slug,category,views,created_at,excerpt}, ...] }
//   env.KV.get('site:settings:data')   -> { success:true, data:{site_title,site_subtitle,show_views,...} }

const KV_LIST_KEY = "site:posts:list";
const KV_SETTINGS_KEY = "site:settings:data";

// ============== Helpers ==============

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y} · ${m} · ${day}`;
}

function renderViewsIcon(views) {
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

function renderPostItem(post, i, showViews) {
    if (!post) return '';
    const slug = post.slug || '';
    const title = escapeHtml(post.title || '未命名');
    const excerpt = post.excerpt
        ? `<p class="mt-2.5 font-serif text-stone-500 text-[0.95rem] leading-relaxed">${escapeHtml(post.excerpt)}</p>`
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

function safeParseKV(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

// ============== Main Handler ==============

export async function onRequestGet(context) {
    const { request, env } = context;

    // 1. 拉取静态模板
    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(request);
    } catch (err) {
        return new Response('Failed to load template', { status: 500 });
    }

    // 2. 并行拉取列表 + 设置（KV 不可用时不阻塞，try 容错）
    const [listRaw, settingsRaw] = await Promise.all([
        env.KV.get(KV_LIST_KEY).catch(() => null),
        env.KV.get(KV_SETTINGS_KEY).catch(() => null)
    ]);

    const listObj = safeParseKV(listRaw);
    const settingsObj = safeParseKV(settingsRaw);
    const posts = (listObj && listObj.success && Array.isArray(listObj.data)) ? listObj.data : [];
    const settings = (settingsObj && settingsObj.data) ? settingsObj.data : {};

    const showViews = String(settings.show_views) === '1';
    const siteTitle = settings.site_title || '';
    const siteSubtitle = settings.site_subtitle || '';
    const description = siteSubtitle || siteTitle || 'My Blog';

    // 3. 构造 HTMLRewriter
    const rewriter = new HTMLRewriter();

    // <title> 与 meta description
    if (siteTitle) {
        rewriter.on('title', { element: el => el.setInnerContent(siteTitle) });
        rewriter.on('meta[name="description"]', { element: el => el.setAttribute('content', description) });
        rewriter.on('#ssr-site-title', {
            element: el => {
                el.setInnerContent(siteTitle);
                el.setAttribute('class', 'font-serif text-4xl md:text-5xl font-medium tracking-tight text-stone-900');
            }
        });
    }
    if (siteSubtitle) {
        rewriter.on('#ssr-site-subtitle', {
            element: el => {
                el.setInnerContent(siteSubtitle);
                el.setAttribute('class', 'mt-3 text-stone-500 text-sm tracking-wide');
            }
        });
    }

    // ⚡️ 修复点：彻底隐藏头部骨架
    rewriter.on('#site-skeleton', { element: el => el.setAttribute('class', 'hidden') });

    // 列表容器
    if (posts.length > 0) {
        const itemsHtml = posts.map((p, i) => renderPostItem(p, i, showViews)).join('');
        rewriter.on('#ssr-post-list', {
            element: el => {
                el.setInnerContent(itemsHtml, { html: true });
                el.setAttribute('class', 'divide-y divide-stone-200/70');
            }
        });
        // ⚡️ 修复点：彻底给文章骨架加上 hidden，而不是单纯清空内容
        rewriter.on('#posts-skeleton', { element: el => el.setAttribute('class', 'hidden') });
    } else {
        // 空数据：显示空状态
        rewriter.on('#ssr-post-list', { element: el => el.setInnerContent('', { html: true }) });
        rewriter.on('#posts-skeleton', { element: el => el.setAttribute('class', 'hidden') });
        // ⚡️ 修复点：保留原有排版类名，去掉 hidden
        rewriter.on('#status-empty', { element: el => el.setAttribute('class', 'py-20 text-center') });
    }

    // 4. 输出
    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    return new Response(response.body, { status: response.status, headers });
}
