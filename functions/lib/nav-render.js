// functions/lib/nav-render.js
// 头部导航渲染共享模块：桌面端 nav + 移动端菜单 共用
// 数据契约：site_navs 行的标准化形态 { id, label, href, tab_key, open_in_new_tab, is_active, sort_order }

import { escapeHtml } from './list-render.js';

const KV_NAVS_KEY = 'site:navs:list:active';

// 硬编码的兜底默认值，用于 KV 命中失败且 D1 也拿不到时（极端兜底，绝不返回空）
const FALLBACK_NAVS = [
    { id: 0, label: '文章', href: '/posts',  tab_key: 'posts',  open_in_new_tab: false, is_active: true, sort_order: 10 },
    { id: 0, label: '推文', href: '/tweets', tab_key: 'tweets', open_in_new_tab: false, is_active: true, sort_order: 20 }
];

// 将 DB 行（0/1 整数）转成前端友好的标准化对象
export function normalizeNavRow(row) {
    if (!row) return null;
    return {
        id:             row.id,
        label:          row.label || '',
        href:           row.href || '',
        tab_key:        row.tab_key || null,
        open_in_new_tab: Number(row.open_in_new_tab) === 1,
        is_active:      Number(row.is_active) === 1,
        sort_order:     Number(row.sort_order || 0),
        created_at:     row.created_at || null,
        updated_at:     row.updated_at || null
    };
}

// 过滤出启用项并按 sort_order 升序
export function sortActiveNavs(list) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(n => n && n.is_active)
        .slice()
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

// SSR 共用：KV 优先 → D1 降级并异步回填 → 硬编码兜底（绝不返回空数组）
//   - context 可选；传入后会用 context.waitUntil 回填 KV（不阻塞响应）
//   - 返回值始终是「启用项」按 sort_order 升序的数组
export async function getActiveNavs(env, context) {
    // 1) 先读 KV
    const raw = await env.KV.get(KV_NAVS_KEY).catch(() => null);
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            if (obj && obj.success && Array.isArray(obj.data) && obj.data.length > 0) {
                return obj.data;
            }
        } catch (_) { /* 损坏就继续走 D1 */ }
    }

    // 2) KV 缺失/空：D1 兜底
    try {
        const { results } = await env.DB.prepare(
            `SELECT id, label, href, tab_key, open_in_new_tab, is_active, sort_order
             FROM site_navs
             WHERE is_active = 1
             ORDER BY sort_order ASC, id ASC`
        ).all();
        const list = (results || []).map(normalizeNavRow);

        if (list.length > 0) {
            // 回填 KV（不阻塞响应）
            const put = env.KV.put(KV_NAVS_KEY, JSON.stringify({ success: true, data: list }))
                .catch(err => console.error('[navs] KV 回填失败:', err));
            if (context && typeof context.waitUntil === 'function') {
                context.waitUntil(put);
            } else {
                await put;
            }
            return list;
        }
    } catch (err) {
        console.error('[navs] D1 降级失败:', err);
    }

    // 3) 终极兜底：硬编码默认值，绝不返回空
    return FALLBACK_NAVS;
}

// 渲染桌面端 <nav> 内的 <a> 列表
// 用于 HTMLRewriter 注入到 <div id="ssr-header-nav"> 容器的 innerHTML
export function renderHeaderNav(navs) {
    if (!Array.isArray(navs) || navs.length === 0) return '';
    return navs.map(n => {
        const href    = escapeHtml(n.href || '#');
        const label   = escapeHtml(n.label || '');
        const tabAttr = n.tab_key ? ` data-tab="${escapeHtml(n.tab_key)}"` : '';
        const target  = n.open_in_new_tab ? ' target="_blank" rel="noopener noreferrer"' : '';
        const cls     = 'tab-link text-stone-500 hover:text-stone-900 transition-colors';
        return `<a href="${href}" class="${cls}"${tabAttr}${target}>${label}</a>`;
    }).join('');
}

// 渲染移动端菜单内的 <a> 列表
// 第一个不加分隔线，其余都加 border-t
export function renderMobileMenu(navs) {
    if (!Array.isArray(navs) || navs.length === 0) return '';
    return navs.map((n, i) => {
        const href    = escapeHtml(n.href || '#');
        const label   = escapeHtml(n.label || '');
        const tabAttr = n.tab_key ? ` data-tab="${escapeHtml(n.tab_key)}"` : '';
        const target  = n.open_in_new_tab ? ' target="_blank" rel="noopener noreferrer"' : '';
        const sep     = i === 0 ? '' : ' border-t border-stone-200/60';
        const cls     = 'mobile-menu-link block px-4 py-2.5 text-stone-600 hover:bg-stone-100/60 hover:text-stone-900 transition-colors' + sep;
        return `<a href="${href}" class="${cls}"${tabAttr}${target}>${label}</a>`;
    }).join('');
}
