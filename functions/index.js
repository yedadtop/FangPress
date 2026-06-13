// functions/index.js
// 首页 SSR：在边缘将 KV 列表注入到 #ssr-post-list 容器，支持分页（每页 10 篇）
// 数据契约（与 functions/api/list.js 一致）：
//   env.KV.get('site:posts:list:page:<n>')  -> { success:true, data:[{id,title,slug,category,type,views,created_at,excerpt}, ...] }  (最多 10 条)
//   env.KV.get('site:settings:data')       -> { success:true, data:{site_title,site_subtitle,show_views,...} }
//   env.KV.get('site:navs:list:active')     -> { success:true, data:[{id,label,href,tab_key,open_in_new_tab,is_active,sort_order}, ...] }


import { makeExcerpt } from './api/helpers.js';
import { renderPostItem, formatDate, safeParseKV } from './lib/list-render.js';
import { renderHeaderNav, renderMobileMenu, getActiveNavs } from './lib/nav-render.js';
const KV_LIST_KEY_PREFIX = "site:posts:list:page:";
const KV_SETTINGS_KEY = "site:settings:data";
const PAGE_SIZE = 10; // 每页 10 篇；D1 查询时取 PAGE_SIZE+1 用于探测是否有下一页

// ============== Helpers 已抽取到 lib/list-render.js ==============

// ============== Main Handler ==============

export async function onRequestGet(context) {
    const { request, env } = context;

    // 0. 解析分页参数
    const url = new URL(request.url);
    let page = parseInt(url.searchParams.get('page') || '1', 10);
    if (isNaN(page) || page < 1) page = 1;
    const currentKvKey = KV_LIST_KEY_PREFIX + page;

    // 1. 拉取静态模板
    let templateResp;
    try {
        templateResp = await env.ASSETS.fetch(request);
    } catch (err) {
        return new Response('Failed to load template', { status: 500 });
    }

    // 2. 并行拉取当前页列表 + 设置 + 导航（KV 不可用时不阻塞，try 容错）
    const [listRaw, settingsRaw, navs] = await Promise.all([
        env.KV.get(currentKvKey).catch(() => null),
        env.KV.get(KV_SETTINGS_KEY).catch(() => null),
        getActiveNavs(env, context)
    ]);

    const listObj = safeParseKV(listRaw);
    const settingsObj = safeParseKV(settingsRaw);
    let posts = (listObj && listObj.success && Array.isArray(listObj.data)) ? listObj.data : [];
    const settings = (settingsObj && settingsObj.data) ? settingsObj.data : {};

    // ⚡ 默认主页：根据 home_mode 把根路径重定向到 /posts 或 /tweets
    // 缺省/非法值回落到 mix（保持原有行为）
    const homeMode = String(settings.home_mode || 'mix');
    if (homeMode === 'posts' || homeMode === 'tweets') {
        const target = homeMode === 'posts' ? '/posts' : '/tweets';
        return new Response(null, {
            status: 302,
            headers: {
                'Location': target,
                'Cache-Control': 'no-store'
            }
        });
    }

    // ⚡ 修复 1：如果命中缓存，从 KV 缓存对象中读取真正的下一页状态
    let hasNextPage = (listObj && listObj.has_more === true) ? true : false;

    // ⚡ KV 未命中当前页：触发 D1 降级查询（LIMIT 11 探测下一页）并异步回填
    if (posts.length === 0) {
        try {
            const offset = (page - 1) * PAGE_SIZE;
            const { results } = await env.DB.prepare(
                `SELECT id, title, slug, content, category, type, views, created_at
                 FROM posts
                 WHERE status = 'published'
                 ORDER BY created_at DESC
                 LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
            ).all();

            if (results && results.length > 0) {
                hasNextPage = results.length > PAGE_SIZE;

                const excerptLength = settings.excerpt_length ? parseInt(settings.excerpt_length, 10) : 200;

                // 探测到下一页时只保留前 10 条用于渲染与回填
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

                // ⚡ 修复 2：异步回填当前页到 KV 时，必须把 has_more: hasNextPage 存进去
                context.waitUntil(
                    env.KV.put(currentKvKey, JSON.stringify({ success: true, data: posts, has_more: hasNextPage }), { expirationTtl: 43200 })
                        .catch(err => console.error('KV 回填失败:', err))
                );
            }
        } catch (err) {
            console.error('D1 降级查询失败:', err);
        }
    }


    const showViews = String(settings.show_views) === '1';
    const siteTitle = settings.site_title || '';
    const siteSubtitle = settings.site_subtitle || '';
    const description = siteSubtitle || siteTitle || 'My Blog';

    // 3. 构造 HTMLRewriter
    const rewriter = new HTMLRewriter();

    // ⚡️ 注入动态导航：替换 #ssr-header-nav 与 #ssr-mobile-nav 的内部内容
    const headerNavHtml = renderHeaderNav(navs);
    const mobileNavHtml = renderMobileMenu(navs);
    rewriter.on('#ssr-header-nav', {
        element: el => el.setInnerContent(headerNavHtml, { html: true })
    });
    rewriter.on('#ssr-mobile-nav', {
        element: el => el.setInnerContent(mobileNavHtml, { html: true })
    });

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

    // ⚡ 分页控制器：仅当有数据，且（不在第一页 或 有下一页）时，才显示底部分页模块
    if (posts.length > 0 && (page > 1 || hasNextPage)) {
        // 显示外层 nav（去掉 hidden），保留原有排版类
        rewriter.on('#ssr-pagination', {
            element: el => el.setAttribute('class', 'flex justify-between items-center mt-12 pt-8 border-t border-stone-200/70 font-serif text-sm')
        });

        // 上一页
        if (page > 1) {
            rewriter.on('#ssr-prev-page', {
                element: el => {
                    el.setAttribute('href', `/?page=${page - 1}`);
                    el.setAttribute('class', 'text-stone-500 hover:text-stone-900 transition-colors');
                }
            });
        } else {
            rewriter.on('#ssr-prev-page', {
                element: el => el.setAttribute('class', 'hidden text-stone-500 hover:text-stone-900 transition-colors')
            });
        }

        // 下一页
        if (hasNextPage) {
            rewriter.on('#ssr-next-page', {
                element: el => {
                    el.setAttribute('href', `/?page=${page + 1}`);
                    el.setAttribute('class', 'text-stone-500 hover:text-stone-900 transition-colors ml-auto');
                }
            });
        } else {
            rewriter.on('#ssr-next-page', {
                element: el => el.setAttribute('class', 'hidden text-stone-500 hover:text-stone-900 transition-colors ml-auto')
            });
        }
    } else {
        // 隐藏整个分页条
        rewriter.on('#ssr-pagination', { element: el => el.setAttribute('class', 'hidden') });
    }

    // 4. 输出
    const response = rewriter.transform(templateResp);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    return new Response(response.body, { status: response.status, headers });
}
