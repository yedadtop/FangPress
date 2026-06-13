// functions/lib/nav-render.js
// 头部导航渲染共享模块：桌面端 nav + 移动端菜单 共用
// 数据契约：site_navs 行的标准化形态 { id, label, href, tab_key, open_in_new_tab, is_active, sort_order }

import { escapeHtml } from './list-render.js';

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
