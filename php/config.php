<?php
/**
 * 本地后台 PHP 配置文件
 * ----------------------------------------------------------------------------
 * 集中维护接口、Token、以及本地文件路由映射
 */

// 后端 API 基础路径，末尾不带'/'
define('API_BASE', 'https://xxxxxx.xxx');

// API 鉴权 Token
define('API_TOKEN', 'your API_TOKEN your API_TOKEN your API_TOKEN your API_TOKEN');

// 统一本地路径跳转（确保在不同环境下，表单提交后能准确跳回列表页）
define('POSTS_LIST_URL', 'index.php');

// 上传接口路径（用于图片上传代理）
define('UPLOAD_URL', '/api/upload');

// 上传白名单（MIME 校验）
$UPLOAD_MIME_WHITELIST = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'
];

// 上传大小上限（字节，默认 5MB）
define('UPLOAD_MAX_SIZE', 5 * 1024 * 1024);