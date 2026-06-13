// functions/tweets.js
// /tweets 列表页 SSR：仅 type='tweet' 的推文
// 数据契约：env.KV.get('site:posts:list:type:tweet:page:<n>')

import { makeExcerpt } from './api/helpers.js';
import { renderPostItem, safeParseKV } from './lib/list-render.js';

const KV_LIST_KEY_PREFIX = "site:posts:list:type:tweet:page:";
const KV_SETTINGS_KEY = "site:settings:data";
const PAGE_SIZE = 10;

const PAGE_TAB = 'tweets';

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    let page = parseInt(url.searchParams.get('page') || '1', 10);
    if (isNaN(page) || page < 1) page = 1;
    const currentKvKey = KV_LIST_KEY_PREFIX + page;

    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(new URL('/tweets.html', request.url));
    } catch (err) {
        return new Response('Failed to load template', { status: 500 });
    }

    const [listRaw, settingsRaw] = await Promise.all([
        env.KV.get(currentKvKey).catch(() => null),
        env.KV.get(KV_SETTINGS_KEY).catch(() => null)
    ]);

    const listObj = safeParseKV(listRaw);
    const settingsObj = safeParseKV(settingsRaw);
    let posts = (listObj && listObj.success && Array.isArray(listObj.data)) ? listObj.data : [];
    const settings = (settingsObj && settingsObj.data) ? settingsObj.data : {};

    let hasNextPage = (listObj && listObj.has_more === true) ? true : false;

    if (posts.length === 0) {
        try {
            const offset = (page - 1) * PAGE_SIZE;
            const { results } = await env.DB.prepare(
                `SELECT id, title, slug, content, category, type, views, created_at
                 FROM posts
                 WHERE type = 'tweet' AND status = 'published'
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
                    type: p.type || 'tweet',
                    views: p.views,
                    created_at: p.created_at,
                    excerpt: makeExcerpt(p.content || '', excerptLength)
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

    // 推文列表不显示阅读量
    const showViews = false;
    const siteTitle = settings.site_title || '';
    const pageTitle = siteTitle ? `推文 · ${siteTitle}` : '推文';

    const rewriter = new HTMLRewriter();

    if (siteTitle) {
        rewriter.on('title', { element: el => el.setInnerContent(pageTitle) });
    }
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
        rewriter.on('#status-empty', { element: el => el.setInnerContent('这里还没有推文') });
        rewriter.on('#status-empty', { element: el => el.setAttribute('class', 'py-20 text-center') });
    }

    if (posts.length > 0 && (page > 1 || hasNextPage)) {
        rewriter.on('#ssr-pagination', {
            element: el => el.setAttribute('class', 'flex justify-between items-center mt-12 pt-8 border-t border-stone-200/70 font-serif text-sm')
        });

        if (page > 1) {
            rewriter.on('#ssr-prev-page', {
                element: el => {
                    el.setAttribute('href', `/tweets?page=${page - 1}`);
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
                    el.setAttribute('href', `/tweets?page=${page + 1}`);
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
