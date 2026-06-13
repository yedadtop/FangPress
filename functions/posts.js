// functions/posts.js
// /posts 列表页 SSR：仅 type='post' 的文章
// 数据契约：env.KV.get('site:posts:list:type:post:page:<n>')

import { makeExcerpt } from './api/helpers.js';
import { renderPostItem, safeParseKV, escapeHtml } from './lib/list-render.js';
import { renderHeaderNav, renderMobileMenu, getActiveNavs, getSettings } from './lib/nav-render.js';

const KV_LIST_KEY_PREFIX = "site:posts:list:type:post:page:";
const PAGE_SIZE = 10;

// 注入一个 posts.html 里没有的特殊属性：当前 tab
const PAGE_TAB = 'posts';

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    let page = parseInt(url.searchParams.get('page') || '1', 10);
    if (isNaN(page) || page < 1) page = 1;
    const currentKvKey = KV_LIST_KEY_PREFIX + page;

    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(new URL('/posts.html', request.url));
    } catch (err) {
        return new Response('Failed to load template', { status: 500 });
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
            const { results } = await env.DB.prepare(
                `SELECT id, title, slug, content, category, type, views, created_at
                 FROM posts
                 WHERE type = 'post' AND status = 'published'
                 ORDER BY created_at DESC
                 LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
            ).all();

            if (results && results.length > 0) {
                hasNextPage = results.length > PAGE_SIZE;
                const excerptLength = settings.excerpt_length ? parseInt(settings.excerpt_length, 10) : 200;
                const pageResults = hasNextPage ? results.slice(0, PAGE_SIZE) : results;

                posts = pageResults.map(p => ({
                    id: p.id,
                    title: p.title || null,
                    slug: p.slug,
                    category: (!p.category || p.category.trim() === '') ? null : p.category,
                    type: p.type || 'post',
                    views: p.views,
                    created_at: p.created_at,
                    excerpt: makeExcerpt(p.content || '', excerptLength)
                }));

                context.waitUntil(
                    env.KV.put(currentKvKey, JSON.stringify({ success: true, data: posts, has_more: hasNextPage }), { expirationTtl: 43200 })
                        .catch(err => console.error('KV 回填失败 (posts.js):', err))
                );
            }
        } catch (err) {
            console.error('D1 降级查询失败 (posts.js):', err);
        }
    }

    const showViews = String(settings.show_views) === '1';
    const siteTitle = settings.site_title || '';
    const siteSubtitle = settings.site_subtitle || '';
    const pageTitle = siteTitle ? `文章 · ${siteTitle}` : '文章';

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
    // 标记当前 tab 供导航高亮
    rewriter.on('body', {
        element: el => el.setAttribute('data-active-tab', PAGE_TAB)
    });

    rewriter.on('#site-skeleton', { element: el => el.setAttribute('class', 'hidden') });

    if (posts.length > 0) {
        const itemsHtml = posts.map((p, i) => renderPostItem(p, i, showViews)).join('');
        rewriter.on('#ssr-post-list', {
            element: el => {
                el.setInnerContent(itemsHtml, { html: true });
                el.setAttribute('class', 'divide-y divide-stone-200/70');
            }
        });
        rewriter.on('#posts-skeleton', { element: el => el.setAttribute('class', 'hidden') });
    } else {
        rewriter.on('#ssr-post-list', { element: el => el.setInnerContent('', { html: true }) });
        rewriter.on('#posts-skeleton', { element: el => el.setAttribute('class', 'hidden') });
        rewriter.on('#status-empty', { element: el => el.setInnerContent('这里还没有文章') });
        rewriter.on('#status-empty', { element: el => el.setAttribute('class', 'py-20 text-center') });
    }

    if (posts.length > 0 && (page > 1 || hasNextPage)) {
        rewriter.on('#ssr-pagination', {
            element: el => el.setAttribute('class', 'flex justify-between items-center mt-12 pt-8 border-t border-stone-200/70 font-serif text-sm')
        });

        if (page > 1) {
            rewriter.on('#ssr-prev-page', {
                element: el => {
                    el.setAttribute('href', `/posts?page=${page - 1}`);
                    el.setAttribute('class', 'text-stone-500 hover:text-stone-900 transition-colors');
                }
            });
        } else {
            rewriter.on('#ssr-prev-page', {
                element: el => el.setAttribute('class', 'hidden text-stone-500 hover:text-stone-900 transition-colors')
            });
        }

        if (hasNextPage) {
            rewriter.on('#ssr-next-page', {
                element: el => {
                    el.setAttribute('href', `/posts?page=${page + 1}`);
                    el.setAttribute('class', 'text-stone-500 hover:text-stone-900 transition-colors ml-auto');
                }
            });
        } else {
            rewriter.on('#ssr-next-page', {
                element: el => el.setAttribute('class', 'hidden text-stone-500 hover:text-stone-900 transition-colors ml-auto')
            });
        }
    } else {
        rewriter.on('#ssr-pagination', { element: el => el.setAttribute('class', 'hidden') });
    }

    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    return new Response(response.body, { status: response.status, headers });
}
