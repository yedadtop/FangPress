// ui-common.js
// 站点公共 UI 行为（被所有公开页共用）
//   - 顶部 tab 高亮（基于 body[data-active-tab]）
//   - 移动端汉堡菜单 toggle
//   - 站点标题同步到 header
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
})();
