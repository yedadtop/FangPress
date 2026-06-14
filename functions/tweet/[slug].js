// functions/tweet/[slug].js
// 推文详情页 SSR：KV 优先 → D1 降级回填 → HTMLRewriter 注入
// 数据契约（与 functions/post/[slug].js 一致）：
//   env.KV.get('post:content:<slug>')  -> { id, status, views, content, type, created_at }
// 配合 template tweet.html
// 关键校验：拒绝 type !== 'tweet' 的访问（让用户去 /post/{slug}）
// 关键校验：拒绝 type !== 'tweet' 的访问（让用户去 /post/{slug}）

import { getSettings } from '../lib/nav-render.js';
import { escapeHtml, safeParseKV, renderTweetContent } from '../lib/list-render.js';

// ============== 工具 ==============

function formatDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    try {
        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
        const parts = formatter.formatToParts(d);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        // ⚡️ 详情页风格:年-月-日 时:分(如 "2026-6-14 13:47"),无前导零,dash 分隔
        const m   = (map.month  || '').replace(/[^0-9]/g, '');
        const day = (map.day    || '').replace(/[^0-9]/g, '');
        const h   = (map.hour   || '').replace(/[^0-9]/g, '');
        const min = (map.minute || '').replace(/[^0-9]/g, '');
        return `${map.year}-${parseInt(m, 10)}-${parseInt(day, 10)} ${parseInt(h, 10)}:${parseInt(min, 10)}`;
    } catch (_) {
        return '';
    }
}

function renderAvatarInner(avatarUrl, nickname) {
    const placeholderPath = 'M12 12c2.7 0 4.875-2.175 4.875-4.875S14.7 2.25 12 2.25 7.125 4.425 7.125 7.125 9.3 12 12 12zm0 2.25c-3.45 0-10.125 1.725-10.125 5.25v2.25h20.25v-2.25c0-3.525-6.675-5.25-10.125-5.25z';
    if (avatarUrl) {
        return `<img class="w-full h-full object-cover" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(nickname || '')}" referrerpolicy="no-referrer" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
<svg class="w-7 h-7 text-stone-300 hidden" fill="currentColor" viewBox="0 0 24 24"><path d="${placeholderPath}"/></svg>`;
    }
    return `<svg class="w-7 h-7 text-stone-300" fill="currentColor" viewBox="0 0 24 24"><path d="${placeholderPath}"/></svg>`;
}

// ============== 数据层 ==============

/**
 * 拉取推文：KV 优先（命中即异步 +1 views），未命中走 D1 并回填 KV
 * @returns {Promise<{ok:true, post:object} | {ok:false, status:number, error?:string}>}
 */
async function fetchTweet(env, slug, context) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized) return { ok: false, status: 400, error: 'empty slug' };

    const kvKey = `post:content:${normalized}`;

    // 1) KV 命中
    const cached = safeParseKV(await env.KV.get(kvKey).catch(() => null));
    if (cached && cached.id != null && cached.status != null && cached.views != null) {
        if (cached.status !== 'published') return { ok: false, status: 404 };
        // ⚡ 关键校验：必须是 tweet 类型，否则让用户去 /post/{slug}
        if (cached.type && cached.type !== 'tweet') return { ok: false, status: 404 };

        const newViews = (Number(cached.views) || 0) + 1;

        // ⚡ 修复：解决高并发竞态。让数据库加1，并直接返回真实权威值再塞回 KV
        context.waitUntil((async () => {
            try {
                const res = await env.DB.prepare(
                    'UPDATE posts SET views = views + 1 WHERE id = ? RETURNING views'
                ).bind(cached.id).first();
                const trueDbViews = res ? res.views : newViews;
                await env.KV.put(kvKey, JSON.stringify({ ...cached, views: trueDbViews }), { expirationTtl: 604800 });
            } catch (err) {
                console.error('Tweet views sync failed:', err);
            }
        })());

        return {
            ok: true,
            post: {
                id: cached.id,
                content: cached.content,
                type: 'tweet',
                created_at: cached.created_at,
                views: newViews
            }
        };
    }

    // 2) D1 降级
    let dbPost;
    try {
        dbPost = await env.DB.prepare(
            `SELECT id, status, views, content, type, created_at
             FROM posts WHERE slug = ?`
        ).bind(normalized).first();
    } catch (err) {
        return { ok: false, status: 500, error: err.message };
    }

    if (!dbPost || dbPost.status !== 'published') return { ok: false, status: 404 };
    // ⚡ 关键校验：D1 路径也必须保证是 tweet
    if (dbPost.type !== 'tweet') return { ok: false, status: 404 };

    const newViews = (Number(dbPost.views) || 0) + 1;
    context.waitUntil((async () => {
        try {
            const res = await env.DB.prepare(
                'UPDATE posts SET views = views + 1 WHERE id = ? RETURNING views'
            ).bind(dbPost.id).first();
            const trueDbViews = res ? res.views : newViews;
            await env.KV.put(kvKey, JSON.stringify({
                id: dbPost.id,
                status: dbPost.status,
                content: dbPost.content,
                type: 'tweet',
                created_at: dbPost.created_at,
                views: trueDbViews
            }), { expirationTtl: 604800 });
        } catch (err) {
            console.error('Fallback tweet views sync failed:', err);
        }
    })());

    return {
        ok: true,
        post: {
            id: dbPost.id,
            content: dbPost.content,
            type: 'tweet',
            created_at: dbPost.created_at,
            views: newViews
        }
    };
}

/**
 * 拉取首条用户（单用户系统下作为推文作者）
 * @returns {Promise<{nickname:string|null, avatar:string|null} | null>}
 */
async function fetchAuthor(env) {
    try {
        const u = await env.DB.prepare(
            `SELECT nickname, avatar FROM users ORDER BY id ASC LIMIT 1`
        ).first();
        if (u) return { nickname: u.nickname || null, avatar: u.avatar || null };
    } catch (_) {}
    return null;
}

// ============== 降级页 ==============

async function renderFallbackPage(env, request, statusType) {
    const statusMap = {
        'bad-slug':  { id: 'status-bad-slug' },
        'not-found': { id: 'status-not-found' },
        'error':     { id: 'status-error' }
    };
    const fallback = statusMap[statusType] || statusMap['not-found'];

    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(new URL('/tweet.html', request.url));
    } catch (_) {
        return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const rewriter = new HTMLRewriter()
        .on('title', { element: el => el.setInnerContent('推文不存在') })
        .on(`#${fallback.id}`, { element: el => el.removeAttribute('class') })
        .on('#ssr-tweet-article', { element: el => el.setAttribute('class', 'hidden') });

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
        return renderFallbackPage(env, request, 'bad-slug');
    }

    // 2) 拉取推文（KV → D1）
    const result = await fetchTweet(env, slug, context);
    if (!result.ok) {
        if (result.status === 404) return renderFallbackPage(env, request, 'not-found');
        if (result.status === 400) return renderFallbackPage(env, request, 'bad-slug');
        return renderFallbackPage(env, request, 'error');
    }
    const post = result.post;

    // 3) 拉取模板（防止 ASSETS 异常导致白屏）
    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(new URL('/tweet.html', request.url));
    } catch (err) {
        return new Response('Internal Server Error: Missing Template', { status: 500 });
    }

    // 4) 并行拉取设置 + 作者
    const [settings, author] = await Promise.all([
        getSettings(env, context),
        fetchAuthor(env)
    ]);
    const siteTitle = settings.site_title || 'Blog';
    const nickname = (author && author.nickname) ? author.nickname : 'Admin';
    const avatar = (author && author.avatar) ? author.avatar : null;
    const dateStr = formatDateTime(post.created_at);
    // ⚡️ 推文正文先 escapeHtml,再让 renderTweetContent 把 ![alt](url) 还原成 <img class="tweet-img">
    const safeContent = renderTweetContent(escapeHtml(post.content || ''));
    const safeDesc = escapeHtml(post.content || '').slice(0, 160);

    // 5) HTMLRewriter 注入
    const rewriter = new HTMLRewriter()
        .on('title', { element: el => el.setInnerContent(`推文 · ${siteTitle}`) })
        .on('meta[name="description"]', { element: el => el.setAttribute('content', safeDesc) })
        .on('meta[property="og:title"]', { element: el => el.setAttribute('content', `${nickname} · ${siteTitle}`) })
        .on('meta[property="og:description"]', { element: el => el.setAttribute('content', safeDesc) })
        .on('#ssr-tweet-avatar', { element: el => el.setInnerContent(renderAvatarInner(avatar, nickname), { html: true }) })
        .on('#ssr-tweet-nickname', { element: el => el.setInnerContent(escapeHtml(nickname)) })
        .on('#ssr-tweet-time', { element: el => el.setInnerContent(dateStr) })
        .on('#ssr-tweet-content', { element: el => el.setInnerContent(safeContent) })
        .on('#ssr-tweet-article', { element: el => el.removeAttribute('class') });

    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    return new Response(response.body, { status: 200, headers });
}
