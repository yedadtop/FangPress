// ui-common.js
// 站点公共 UI 行为（被所有公开页共用）
//   - 顶部 tab 高亮（基于 body[data-active-tab]）
//   - 移动端汉堡菜单 toggle
//   - 站点标题同步到 header
//   - 共享工具函数（escapeHTML/formatDate）挂到 window.UI
//     供 search-overlay.js 等兄弟脚本复用，避免在多个 IIFE 内重复实现
// 设计前提:
//   - 自动检测节点是否存在,缺失则静默跳过对应逻辑
//   - 与原 HTML 内联行为完全一致
(function () {
    'use strict';

    // === tab 高亮 + 站点标题同步 ===
    var active = document.body.getAttribute('data-active-tab');
    if (active) {
        document.querySelectorAll('.tab-link, .mobile-menu-link').forEach(function (el) {
            if (el.getAttribute('data-tab') === active) {
                el.setAttribute('data-active', 'true');
                el.classList.remove('text-stone-500', 'text-stone-600');
                el.classList.add('text-stone-900', 'font-medium');
            }
        });
    }

    var titleEl = document.getElementById('ssr-header-title');
    if (titleEl) {
        var raw = (document.title || '').split('·')[0].split('|')[0].trim();
        if (raw) titleEl.textContent = raw;
    }

    // === 移动端菜单 ===
    var menuToggle = document.getElementById('menu-toggle');
    var mobileMenu = document.getElementById('mobile-menu');
    if (menuToggle && mobileMenu) {
        menuToggle.addEventListener('click', function (e) {
            e.stopPropagation();
            mobileMenu.classList.toggle('hidden');
        });
        document.addEventListener('click', function (e) {
            if (!mobileMenu.classList.contains('hidden') &&
                !mobileMenu.contains(e.target) &&
                !menuToggle.contains(e.target)) {
                mobileMenu.classList.add('hidden');
            }
        });
    }

    // === 共享工具函数(供兄弟 IIFE 脚本使用) ===
    // 不放进 ES module:ui-common.js 走 <script>(非 module)加载,无法 import
    // 挂到 window.UI 既避免污染全局,也方便管理依赖关系
    window.UI = window.UI || {};
    window.UI.escapeHTML = function (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };
    // 浏览器端:使用原生 Date 方法(无 Intl 依赖);按用户本地时区显示
    // 与 SSR 端的 list-render.js#formatDate(强制 Asia/Shanghai)行为不同
    // 搜索结果是面向用户个人的,本地时区更符合预期
    window.UI.formatDate = function (ts) {
        var d = new Date(ts);
        if (isNaN(d)) return '';
        return (d.getMonth() + 1) + '-' + d.getDate();
    };
})();
