// functions/post/[slug].js
// 文章详情页 SSR：KV 优先 → D1 降级回填 → HTMLRewriter 注入
// 数据契约（与 functions/api/get.js 一致）：
//   env.KV.get('post:content:<slug>')  -> { id,status,views,title,content,category,created_at }
// 依赖：marked（边缘 Markdown→HTML）。请确保 package.json 含 "marked" 依赖。

import { marked } from '../lib/marked.esm.js';
import { renderHeaderNav, renderMobileMenu, getActiveNavs, getSettings } from '../lib/nav-render.js';
import { escapeHtml, formatDate, safeParseKV } from '../lib/list-render.js';
import { makeExcerpt } from '../api/helpers.js';

// ============== HTML 工具 ==============
// ⚡ 修复 14：escapeHtml / formatDate / safeParseKV 已在 lib/list-render.js 导出，
//   stripMarkdown / makeExcerpt 已在 api/helpers.js 导出，删掉本地重复定义。

function formatDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    try {
        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        const parts = formatter.formatToParts(d);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        return `${map.year} · ${map.month} · ${map.day} ${map.hour}:${map.minute}`;
    } catch (_) {
        return '';
    }
}

function renderViewsInner(views) {
    return `<svg class="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
</svg>
<span>${views || 0} 次阅读</span>`;
}

// ============== 数据层 ==============

/**
 * 拉取文章：KV 优先（命中即异步 +1 views），未命中走 D1 并回填 KV
 * @returns {Promise<{ok:true, post:object} | {ok:false, status:number, error?:string}>}
 */
async function fetchPost(env, slug, context) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized) return { ok: false, status: 400, error: 'empty slug' };

    const kvKey = `post:content:${normalized}`;

    // 1) KV 命中
    const cached = safeParseKV(await env.KV.get(kvKey).catch(() => null));
    if (cached && cached.id != null && cached.status != null && cached.views != null) {
        if (cached.status !== 'published') return { ok: false, status: 404 };

        const newViews = (Number(cached.views) || 0) + 1; // 仅用于前台立刻显示的乐观数值
        const postType = cached.type || 'post';

        // ⚡ 修复 3：解决高并发竞态条件。让数据库加1，并直接返回真实权威值再塞回 KV
        context.waitUntil((async () => {
            try {
                // 执行自增并立刻取回真值
                const res = await env.DB.prepare('UPDATE posts SET views = views + 1 WHERE id = ? RETURNING views').bind(cached.id).first();
                const trueDbViews = res ? res.views : newViews;
                // 将绝对真实的浏览量盖回 KV
                await env.KV.put(kvKey, JSON.stringify({ ...cached, views: trueDbViews }), { expirationTtl: 604800 });
            } catch (err) {
                console.error('Views sync failed:', err);
            }
        })());

        return {
            ok: true,
            post: {
                id: cached.id, title: cached.title || null, content: cached.content,
                category: cached.category ?? null, type: postType, created_at: cached.created_at,
                views: newViews // 返回给访客依然无延迟
            }
        };
    }

    // 2) D1 降级
    let dbPost;
    try {
        dbPost = await env.DB.prepare('SELECT id, status, views, title, content, category, type, created_at FROM posts WHERE slug = ?').bind(normalized).first();
    } catch (err) {
        return { ok: false, status: 500, error: err.message };
    }

    if (!dbPost || dbPost.status !== 'published') return { ok: false, status: 404 };

    const category = (!dbPost.category || String(dbPost.category).trim() === '') ? null : dbPost.category;
    const newViews = (Number(dbPost.views) || 0) + 1;
    const postType = dbPost.type || 'post';

    // ⚡ 同样处理降级分支
    context.waitUntil((async () => {
        try {
            const res = await env.DB.prepare('UPDATE posts SET views = views + 1 WHERE id = ? RETURNING views').bind(dbPost.id).first();
            const trueDbViews = res ? res.views : newViews;
            await env.KV.put(kvKey, JSON.stringify({
                id: dbPost.id, status: dbPost.status, title: dbPost.title || null,
                content: dbPost.content, category, type: postType, created_at: dbPost.created_at,
                views: trueDbViews // 使用 D1 真实反馈值
            }), { expirationTtl: 604800 });
        } catch (err) {
            console.error('Fallback views sync failed:', err);
        }
    })());

    return {
        ok: true,
        post: {
            id: dbPost.id, title: dbPost.title || null, content: dbPost.content,
            category, type: postType, created_at: dbPost.created_at, views: newViews
        }
    };
}

async function fetchSettings(env, context) {
    // 复用 nav-render.js 的 getSettings，自动走 KV → D1 → 回填链路
    return await getSettings(env, context);
}

// ============== 降级页 ==============

/**
 * 用同一个 post.html 模板渲染 404/错误态，避免裸 404 文本
 */
async function renderFallbackPage(env, request, url, type, context) {
    const statusMap = {
        'bad-slug':  { id: 'status-bad-slug', cls: 'py-24 text-center' },
        'not-found': { id: 'status-not-found', cls: 'py-24 text-center' },
        'error':     { id: 'status-error', cls: 'py-24 text-stone-400 text-sm tracking-wider' }
    };
    const fallback = statusMap[type] || statusMap['not-found'];

    let templateResp;
    try {
        // ⚡️ 修复点：白屏杀手。不再复用原始 request，纯净拉取内部静态资源
        templateResp = await env.ASSETS.fetch(new URL('/post.html', request.url));
    } catch (_) {
        return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const settings404 = await fetchSettings(env, context);
    const siteTitle404 = (settings404 && settings404.site_title) ? settings404.site_title : 'Blog';
    const navs404 = await getActiveNavs(env, context);
    const headerNavHtml404 = renderHeaderNav(navs404);
    const mobileNavHtml404 = renderMobileMenu(navs404);

    const rewriter = new HTMLRewriter()
        .on('title', { element: el => el.setInnerContent('404 - 文章不存在') })
        // ⚡ 头部 logo 同步为站点主标题
        .on('#ssr-header-title', { element: el => el.setInnerContent(escapeHtml(siteTitle404)) })
        // ⚡ 注入动态导航
        .on('#ssr-header-nav', { element: el => el.setInnerContent(headerNavHtml404, { html: true }) })
        .on('#ssr-mobile-nav',  { element: el => el.setInnerContent(mobileNavHtml404, { html: true }) })
        // ⚡️ 修复点：保留 Tailwind 排版类名
        .on(`#${fallback.id}`, { element: el => el.setAttribute('class', fallback.cls) })
        .on('#ssr-post-article', { element: el => el.setAttribute('class', 'hidden') })
        .on('#post-skeleton',    { element: el => el.setAttribute('class', 'hidden') });

    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: 404, headers });
}

// ============== 主路由 ==============

export async function onRequestGet(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);
    const slug = (params.slug || '').toString();

    // 1) slug 缺失
    if (!slug || !slug.trim()) {
        return renderFallbackPage(env, request, url, 'bad-slug', context);
    }

    // 2) 拉取文章（KV → D1）
    const result = await fetchPost(env, slug, context);
    if (!result.ok) {
        if (result.status === 404) return renderFallbackPage(env, request, url, 'not-found', context);
        if (result.status === 400) return renderFallbackPage(env, request, url, 'bad-slug', context);
        return renderFallbackPage(env, request, url, 'error', context);
    }
    const post = result.post;

    // 3) 并行拉取模板 + 设置
    // ⚡️ 修复点：防止 ASSETS fetch 异常导致的白屏死机
    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(new URL('/post.html', request.url));
    } catch (err) {
        return new Response('Internal Server Error: Missing Template', { status: 500 });
    }
    const settings = await fetchSettings(env, context);
    const navs = await getActiveNavs(env, context);
    const headerNavHtml = renderHeaderNav(navs);
    const mobileNavHtml = renderMobileMenu(navs);

    // 4) 准备渲染数据
    const siteTitle     = settings.site_title || 'Blog';
    const postType      = post.type || 'post';
    const isTweet       = postType === 'tweet';
    const rawTitle      = isTweet ? siteTitle : (post.title || '未命名');
    const safeTitle     = escapeHtml(rawTitle);
    // ⚡ 修复 6：推文不重复显示两次站点主标题
    const fullTitle     = isTweet ? siteTitle : `${rawTitle} · ${siteTitle}`;
    const safeDesc      = escapeHtml(makeExcerpt(post.content || '', 160));
    const dateStr       = isTweet ? formatDateTime(post.created_at) : formatDate(post.created_at);
    const showViews     = !isTweet && String(settings.show_views) === '1';
    // ⚡ 头部 logo 始终显示站点主标题（不受文章标题影响）
    const headerTitle   = escapeHtml(siteTitle);

    let contentHtml = '';
    try {
        // ⚡ 修复 14：删除 typeof === 'undefined' 的死代码——ESM 模块导入时若 marked 缺失会直接抛错，根本走不到这里
        contentHtml = marked.parse(post.content || '');
    } catch (e) {
        console.error('Markdown parse failed:', e);
        contentHtml = `<pre class="whitespace-pre-wrap">${escapeHtml(post.content || '')}</pre>`;
    }

    // 5) HTMLRewriter
    const rewriter = new HTMLRewriter()
        .on('title',                          { element: el => el.setInnerContent(fullTitle) })
        .on('meta[name="description"]',       { element: el => el.setAttribute('content', safeDesc) })
        .on('meta[property="og:title"]',      { element: el => el.setAttribute('content', safeTitle) })
        .on('meta[property="og:description"]',{ element: el => el.setAttribute('content', safeDesc) })
        // ⚡ 头部 logo 同步为站点主标题
        .on('#ssr-header-title',              { element: el => el.setInnerContent(headerTitle) })
        // ⚡ 注入动态导航
        .on('#ssr-header-nav',                { element: el => el.setInnerContent(headerNavHtml, { html: true }) })
        .on('#ssr-mobile-nav',                { element: el => el.setInnerContent(mobileNavHtml, { html: true }) })
        .on('#ssr-post-time',     { element: el => el.setInnerContent(dateStr) })
        .on('#ssr-post-content',  { element: el => el.setInnerContent(contentHtml, { html: true }) })
        .on('#ssr-post-article',  { element: el => el.setAttribute('class', 'mt-12') })
        // ⚡️ 修复点：不要只清空内容，直接把骨架完全隐藏
        .on('#post-skeleton',     { element: el => el.setAttribute('class', 'hidden') });

    if (isTweet) {
        // 推文：整个 header（标题、分类、阅读量）全部隐藏；容器缩窄
        rewriter.on('#ssr-post-title', { element: el => el.setInnerContent('') });
        rewriter.on('#ssr-post-header', { element: el => el.setAttribute('class', 'hidden') });
        rewriter.on('#ssr-post-type-badge', {
            element: el => {
                el.setInnerContent('推文');
                el.setAttribute('class', 'inline-flex items-center px-2 py-0.5 rounded-xs text-stone-500 bg-stone-200/60 text-[10px] tracking-widest uppercase font-sans');
            }
        });
        rewriter.on('#ssr-post-time', {
            element: el => el.setAttribute('class', 'text-stone-400 text-xs tracking-wider font-sans tabular-nums')
        });
        rewriter.on('#ssr-post-article', {
            element: el => el.setAttribute('class', 'mt-2 max-w-[36rem] mx-auto')
        });
        rewriter.on('meta[property="og:type"]', { element: el => el.setAttribute('content', 'article') });
    } else {
        rewriter.on('#ssr-post-title', { element: el => el.setInnerContent(safeTitle) });
        rewriter.on('#ssr-post-type-badge', { element: el => el.setAttribute('class', 'hidden') });
    }

    // 分类
    if (post.category) {
        rewriter.on('#ssr-post-category', { element: el => el.setInnerContent(escapeHtml(post.category)) });
    } else {
        rewriter.on('#ssr-post-category', { element: el => el.setAttribute('class', 'hidden') });
        rewriter.on('#ssr-post-category-sep', { element: el => el.setAttribute('class', 'hidden') });
    }

    // 阅读量（推文不显示）
    if (showViews) {
        rewriter.on('#ssr-post-views', {
            element: el => el.setInnerContent(renderViewsInner(post.views), { html: true })
        });
    } else {
        rewriter.on('#ssr-post-views-group', { element: el => el.setAttribute('class', 'hidden') });
    }

    // 6) 输出
    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    return new Response(response.body, { status: 200, headers });
}
