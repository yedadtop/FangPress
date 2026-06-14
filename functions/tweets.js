// functions/tweets.js
// /tweets 列表页 SSR：仅 type='tweet' 的推文
// 数据契约：env.KV.get('site:posts:list:type:tweet:page:<n>')
//
// 渲染策略：
//  - 首屏 SSR 出前 10 条推文（完整正文 + 无「推文」小标）
//  - 不再输出传统分页 <nav>，而是在 #ssr-post-list 上挂 data-has-more / data-next-page
//  - 客户端通过 IntersectionObserver 触发 /api/list?type=tweet&page=N+1 实现懒加载
//  - KV 缓存机制无需调整：list.js 与本页使用同一份键 'site:posts:list:type:tweet:page:<n>'

import { makeExcerpt } from './api/helpers.js';
import { renderTweetItem, safeParseKV, escapeHtml } from './lib/list-render.js';
import { renderHeaderNav, renderMobileMenu, getActiveNavs, getSettings } from './lib/nav-render.js';

// ⚡️ v2：新增 author 字段（昵称 + 头像），老缓存（无 author）自动失效
const KV_LIST_KEY_PREFIX = "site:posts:list:v2:type:tweet:page:";
const PAGE_SIZE = 10;

const PAGE_TAB = 'tweets';

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    // 推文页 SSR 始终先渲染第 1 页（前端 IntersectionObserver 懒加载翻页）
    // 这里仍然按 page 取 KV 缓存键,便于预热/直接访问 /tweets?page=N
    let page = parseInt(url.searchParams.get('page') || '1', 10);
    if (isNaN(page) || page < 1) page = 1;
    const currentKvKey = KV_LIST_KEY_PREFIX + page;

    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(new URL('/tweets.html', request.url));
    } catch (err) {
        return new Response('Failed to load template', { status: 500 });
    }

    // ⚡ 修复 26：模板 404 时不要继续走 SSR
    if (templateResp.status === 404) {
        return new Response(null, { status: 404 });
    }

    const [listRaw, settings, navs] = await Promise.all([
        env.KV.get(currentKvKey).catch(() => null),
        getSettings(env, context),
        getActiveNavs(env, context)
    ]);

    const listObj = safeParseKV(listRaw);
    let posts = (listObj && listObj.success && Array.isArray(listObj.data)) ? listObj.data : [];

    let hasNextPage = (listObj && listObj.has_more === true) ? true : false;

    if (posts.length === 0) {
        try {
            const offset = (page - 1) * PAGE_SIZE;
            // ⚡ 与首条用户并行查询,单用户系统下作为所有推文的 author 回退
            const [postsResult, userRow] = await Promise.all([
                env.DB.prepare(
                    `SELECT id, title, slug, content, category, type, views, created_at
                     FROM posts
                     WHERE type = 'tweet' AND status = 'published'
                     ORDER BY created_at DESC
                     LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
                ).all(),
                env.DB.prepare(
                    `SELECT nickname, avatar FROM users ORDER BY id ASC LIMIT 1`
                ).first().catch(() => null)
            ]);
            const results = postsResult.results || [];
            const author = userRow
                ? { nickname: userRow.nickname || null, avatar: userRow.avatar || null }
                : null;

            if (results.length > 0) {
                hasNextPage = results.length > PAGE_SIZE;
                const excerptLength = settings.excerpt_length ? parseInt(settings.excerpt_length, 10) : 200;
                const pageResults = hasNextPage ? results.slice(0, PAGE_SIZE) : results;

                posts = pageResults.map(p => ({
                    id: p.id,
                    title: p.title || null,
                    slug: p.slug,
                    category: (!p.category || p.category.trim() === '') ? null : p.category,
                    type: p.type || 'tweet',
                    views: p.views,
                    created_at: p.created_at,
                    // 推文列表需要完整正文（前端懒加载同样依赖此字段）
                    content: p.content || '',
                    excerpt: makeExcerpt(p.content || '', excerptLength),
                    // ⚡ 推特式样所需: 头像 + 昵称(单用户系统下全部沿用首条用户)
                    author
                }));

                context.waitUntil(
                    env.KV.put(currentKvKey, JSON.stringify({ success: true, data: posts, has_more: hasNextPage }), { expirationTtl: 43200 })
                        .catch(err => console.error('KV 回填失败 (tweets.js):', err))
                );
            }
        } catch (err) {
            console.error('D1 降级查询失败 (tweets.js):', err);
        }
    }

    const siteTitle = settings.site_title || '';
    const pageTitle = siteTitle ? `推文 · ${siteTitle}` : '推文';

    const rewriter = new HTMLRewriter();

    // ⚡️ 注入动态导航：替换 #ssr-header-nav 与 #ssr-mobile-nav 的内部内容
    rewriter.on('#ssr-header-nav', {
        element: el => el.setInnerContent(renderHeaderNav(navs), { html: true })
    });
    rewriter.on('#ssr-mobile-nav', {
        element: el => el.setInnerContent(renderMobileMenu(navs), { html: true })
    });

    if (siteTitle) {
        rewriter.on('title', { element: el => el.setInnerContent(pageTitle) });
        // ⚡ 头部 logo 同步为站点主标题
        rewriter.on('#ssr-header-title', { element: el => el.setInnerContent(escapeHtml(siteTitle)) });
    }
    rewriter.on('body', {
        element: el => el.setAttribute('data-active-tab', PAGE_TAB)
    });

    rewriter.on('#site-skeleton', { element: el => el.setAttribute('class', 'hidden') });

    if (posts.length > 0) {
        const itemsHtml = posts.map((p, i) => renderTweetItem(p, i)).join('');
        rewriter.on('#ssr-post-list', {
            element: el => {
                el.setInnerContent(itemsHtml, { html: true });
                el.setAttribute('class', 'divide-y divide-stone-200/70');
                // 懒加载状态：告诉前端是否还有下一页、下次请求的 page 编号
                el.setAttribute('data-has-more', hasNextPage ? 'true' : 'false');
                el.setAttribute('data-next-page', String(page + 1));
            }
        });
        rewriter.on('#posts-skeleton', { element: el => el.setAttribute('class', 'hidden') });
    } else {
        rewriter.on('#ssr-post-list', { element: el => el.setInnerContent('', { html: true }) });
        rewriter.on('#posts-skeleton', { element: el => el.setAttribute('class', 'hidden') });
        rewriter.on('#status-empty', { element: el => el.setInnerContent('这里还没有推文') });
        rewriter.on('#status-empty', { element: el => el.setAttribute('class', 'py-20 text-center') });
    }

    // ⚡️ 推文页不再需要 #ssr-pagination 容器：懒加载逻辑已迁移到 #tweet-load-more-sentinel
    //    保留隐藏操作以兼容可能的旧模板残留
    rewriter.on('#ssr-pagination', { element: el => el.setAttribute('class', 'hidden') });

    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    return new Response(response.body, { status: response.status, headers });
}
