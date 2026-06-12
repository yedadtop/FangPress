// functions/post/[slug].js
// 文章详情页 SSR：KV 优先 → D1 降级回填 → HTMLRewriter 注入
// 数据契约（与 functions/api/get.js 一致）：
//   env.KV.get('post:content:<slug>')  -> { id,status,views,title,content,category,created_at }
// 依赖：marked（边缘 Markdown→HTML）。请确保 package.json 含 "marked" 依赖。

import { marked } from '../lib/marked.esm.js';

const KV_SETTINGS_KEY = 'site:settings:data';

// ============== HTML 工具 ==============

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

function stripMarkdown(md) {
    if (!md) return '';
    return String(md)
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(\*|_)(.+?)\1/g, '$2')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function makeExcerpt(content, maxLen = 160) {
    const text = stripMarkdown(content);
    if (text.length === 0) return '';
    if (text.length <= maxLen) return text;
    const slice = text.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace > maxLen * 0.6 ? slice.slice(0, lastSpace) : slice;
    return cut.replace(/[\s,，.。!！?？;；:：]+$/, '') + '…';
}

function renderViewsInner(views) {
    return `<svg class="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
</svg>
<span>${views || 0} 次阅读</span>`;
}

function safeParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
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
    const cached = safeParse(await env.KV.get(kvKey).catch(() => null));
    if (cached && cached.id != null && cached.status != null && cached.views != null) {
        if (cached.status !== 'published') return { ok: false, status: 404 };

        // 异步浏览量自增（关键路径外）
        context.waitUntil(
            env.DB.prepare('UPDATE posts SET views = views + 1 WHERE id = ?')
                .bind(cached.id)
                .run()
                .catch(err => console.error('Views increment failed:', err))
        );

        return {
            ok: true,
            post: {
                id: cached.id,
                title: cached.title,
                content: cached.content,
                category: cached.category ?? null,
                created_at: cached.created_at,
                views: cached.views + 1
            }
        };
    }

    // 2) D1 降级
    let dbPost;
    try {
        dbPost = await env.DB.prepare(
            'SELECT id, status, views, title, content, category, created_at FROM posts WHERE slug = ?'
        ).bind(normalized).first();
    } catch (err) {
        console.error('D1 query failed:', err);
        return { ok: false, status: 500, error: err.message };
    }

    if (!dbPost || dbPost.status !== 'published') return { ok: false, status: 404 };

    const category = (!dbPost.category || String(dbPost.category).trim() === '') ? null : dbPost.category;

    // 回填 KV（关键路径外）
    context.waitUntil(
        env.KV.put(kvKey, JSON.stringify({
            id: dbPost.id,
            status: dbPost.status,
            views: dbPost.views,
            title: dbPost.title,
            content: dbPost.content,
            category,
            created_at: dbPost.created_at
        }), { expirationTtl: 604800 }).catch(err => console.error('KV put failed:', err))
    );

    // 异步浏览量自增
    context.waitUntil(
        env.DB.prepare('UPDATE posts SET views = views + 1 WHERE id = ?')
            .bind(dbPost.id)
            .run()
            .catch(err => console.error('Views increment failed:', err))
    );

    return {
        ok: true,
        post: {
            id: dbPost.id,
            title: dbPost.title,
            content: dbPost.content,
            category,
            created_at: dbPost.created_at,
            views: dbPost.views + 1
        }
    };
}

async function fetchSettings(env) {
    const obj = safeParse(await env.KV.get(KV_SETTINGS_KEY).catch(() => null));
    return (obj && obj.data) ? obj.data : {};
}

// ============== 降级页 ==============

/**
 * 用同一个 post.html 模板渲染 404/错误态，避免裸 404 文本
 */
async function renderFallbackPage(env, request, url, type) {
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

    const rewriter = new HTMLRewriter()
        .on('title', { element: el => el.setInnerContent('404 - 文章不存在') })
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
        return renderFallbackPage(env, request, url, 'bad-slug');
    }

    // 2) 拉取文章（KV → D1）
    const result = await fetchPost(env, slug, context);
    if (!result.ok) {
        if (result.status === 404) return renderFallbackPage(env, request, url, 'not-found');
        if (result.status === 400) return renderFallbackPage(env, request, url, 'bad-slug');
        return renderFallbackPage(env, request, url, 'error');
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
    const settings = await fetchSettings(env);

    // 4) 准备渲染数据
    const siteTitle     = settings.site_title || 'Blog';
    const safeTitle     = escapeHtml(post.title || '未命名');
    const fullTitle     = `${post.title || '未命名'} · ${siteTitle}`;
    const safeDesc      = escapeHtml(makeExcerpt(post.content || '', 160));
    const dateStr       = formatDate(post.created_at);
    const showViews     = String(settings.show_views) === '1';

    let contentHtml = '';
    try {
        // 如果文件拉取异常，防崩溃兜底
        if (typeof marked === 'undefined') throw new Error('marked module is missing');
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
        .on('#ssr-post-title',    { element: el => el.setInnerContent(safeTitle) })
        .on('#ssr-post-time',     { element: el => el.setInnerContent(dateStr) })
        .on('#ssr-post-content',  { element: el => el.setInnerContent(contentHtml, { html: true }) })
        .on('#ssr-post-article',  { element: el => el.setAttribute('class', 'mt-12') })
        // ⚡️ 修复点：不要只清空内容，直接把骨架完全隐藏
        .on('#post-skeleton',     { element: el => el.setAttribute('class', 'hidden') });

    // 分类
    if (post.category) {
        rewriter.on('#ssr-post-category', { element: el => el.setInnerContent(escapeHtml(post.category)) });
    } else {
        rewriter.on('#ssr-post-category', { element: el => el.setAttribute('class', 'hidden') });
        rewriter.on('#ssr-post-category-sep', { element: el => el.setAttribute('class', 'hidden') });
    }

    // 阅读量
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
