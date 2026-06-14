<?php
require_once 'config.php';

// 判断是传统 URL 传参进入的编辑模式，还是直接单页打开
$editId = isset($_GET['id']) ? $_GET['id'] : null;
$isEdit = !empty($editId);

$postId = '';
$postTitle = '';
$postSlug = '';
$postCategory = '';
$postContent = '';

// 工具函数：规范化 API 完整 URL
function getApiUrl($endpoint) {
    $base = rtrim(API_BASE, '/');
    return $base . $endpoint;
}

// 工具函数：在 PHP 服务端发起请求（避开浏览器跨域）
function sendRpcRequest($url, $method = 'GET', $payload = null) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    
    $headers = [
        'Authorization: Bearer ' . API_TOKEN
    ];

    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        $headers[] = 'Content-Type: application/json';
    }

    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($httpCode === 401) {
        return ['success' => false, 'error' => 'Token 鉴权失败，请检查 config.php 配置'];
    }

    return json_decode($response, true) ?: ['success' => false, 'error' => '网络请求异常或后端无响应'];
}

// 【接口代理 1】获取单篇文章详情
if (isset($_GET['action']) && $_GET['action'] === 'get_detail' && isset($_GET['slug'])) {
    header('Content-Type: application/json');
    $slug = $_GET['slug'];
    $contentUrl = getApiUrl('/api/get?slug=' . urlencode($slug)); 
    $contentResult = sendRpcRequest($contentUrl);
    echo json_encode($contentResult);
    exit;
}

// 【接口代理 2】获取全部文章列表
if (isset($_GET['action']) && $_GET['action'] === 'get_list') {
    header('Content-Type: application/json');
    $listResult = sendRpcRequest(getApiUrl('/api/list')); 
    echo json_encode($listResult);
    exit;
}

// 【接口代理 3】执行删除文章
if (isset($_GET['action']) && $_GET['action'] === 'delete' && isset($_GET['id'])) {
    header('Content-Type: application/json');
    $id = intval($_GET['id']);
    $deleteUrl = getApiUrl('/api/delete'); 
    $deleteResult = sendRpcRequest($deleteUrl, 'POST', ['id' => $id]); 
    echo json_encode($deleteResult);
    exit;
}

// 【接口代理 4】处理表单的异步提交（发布与修改）
if (isset($_GET['action']) && $_GET['action'] === 'submit_form' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    header('Content-Type: application/json');
    $rawInput = file_get_contents('php://input');
    $input = json_decode($rawInput, true);

    $id = $input['id'] ?? '';
    $title = trim($input['title'] ?? '');
    $slug = trim($input['slug'] ?? '');
    $category = trim($input['category'] ?? '');
    $content = trim($input['content'] ?? '');
    
    // ⚡ 后端自动判断类型：有标题就是 post，没标题就是 tweet
    $type = !empty($title) ? 'post' : 'tweet';

    if (empty($content)) {
        echo json_encode(['success' => false, 'error' => '正文不能为空']);
        exit;
    }
    if ($type === 'post' && empty($slug)) {
        echo json_encode(['success' => false, 'error' => '长文章的唯一路径 (Slug) 不能为空']);
        exit;
    }

    $currentIsEdit = !empty($id);
    $url = $currentIsEdit ? getApiUrl('/api/update') : getApiUrl('/api/push'); 
    
    $body = [
        'title' => $title,
        'slug' => $slug,
        'category' => $category,
        'content' => $content,
        'type' => $type
    ];
    if ($currentIsEdit) {
        $body['id'] = intval($id);
    }

    $result = sendRpcRequest($url, 'POST', $body);
    echo json_encode($result);
    exit;
}

// 【接口代理 5】图片上传（multipart 转发到后端 R2 / OSS）
if (isset($_GET['action']) && $_GET['action'] === 'upload_image' && $_SERVER['REQUEST_METHOD'] === 'POST') {

    // ⚡ 关键修复：彻底抑制 PHP 错误/警告的显示输出，否则内网 server
    // 若 display_errors=On，任何 Notice/Warning 都会以 `<br /><b>Warning</b>: ...`
    // 的 HTML 形式污染响应体，前端 res.json() 即报 "Unexpected token '<'"。
    @ini_set('display_errors', '0');
    @ini_set('html_errors', '0');
    @error_reporting(0);

    // 清理所有已存在的输出缓冲 + 开启新缓冲，任何意外输出最后都会被丢弃
    while (ob_get_level() > 0) { ob_end_clean(); }
    ob_start();

    // 统一 JSON 响应出口：先丢缓冲，再输出，避免任何 PHP 警告污染 JSON
    $respond = function ($data) {
        while (ob_get_level() > 0) { ob_end_clean(); }
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    };

    try {
        // 0) 兼容检测：仅做硬性依赖（无 cURL / CURLFile 就完全无法转发）
        if (!class_exists('CURLFile')) {
            $respond(['success' => false, 'error' => '当前 PHP 版本过低（< 5.5），缺少 CURLFile 类，无法转发文件流']);
        }
        if (!function_exists('curl_init')) {
            $respond(['success' => false, 'error' => '服务器未启用 cURL 扩展，无法转发上传']);
        }
        // ⚡ 注意：fileinfo 不再作为硬性依赖；若可用则优先用，不可用则降级到客户端声明的 MIME。

        // 1) 文件是否真的到 PHP 这层了？
        if (empty($_FILES) || empty($_FILES['file'])) {
            $postMax = ini_get('post_max_size');
            $upMax   = ini_get('upload_max_filesize');
            $respond([
                'success' => false,
                'error'   => '未接收到文件，请检查表单字段名是否为 file（也可能是 php.ini 的 post_max_size=' . $postMax . ' / upload_max_filesize=' . $upMax . ' 太小）'
            ]);
        }

        $file = $_FILES['file'];

        if (!isset($file['error']) || $file['error'] !== UPLOAD_ERR_OK) {
            $errCode = isset($file['error']) ? $file['error'] : -1;
            $errMap = [
                UPLOAD_ERR_INI_SIZE   => '超出 php.ini 允许的大小（upload_max_filesize）',
                UPLOAD_ERR_FORM_SIZE  => '超出表单 MAX_FILE_SIZE 允许的大小',
                UPLOAD_ERR_PARTIAL    => '文件只有部分被上传',
                UPLOAD_ERR_NO_FILE    => '没有文件被上传',
                UPLOAD_ERR_NO_TMP_DIR => '服务器缺少临时文件夹',
                UPLOAD_ERR_CANT_WRITE => '服务器写临时文件失败',
                UPLOAD_ERR_EXTENSION  => 'PHP 扩展中止了上传',
            ];
            $msg = isset($errMap[$errCode]) ? $errMap[$errCode] : ('未知上传错误 #' . $errCode);
            $respond(['success' => false, 'error' => $msg]);
        }

        // 2) 临时文件存在性 + is_uploaded_file 二次校验
        if (empty($file['tmp_name']) || !is_uploaded_file($file['tmp_name'])) {
            $respond(['success' => false, 'error' => '上传的临时文件不存在或不可信']);
        }

        // 3) 业务层大小限制（兜底）
        if ((int)$file['size'] > UPLOAD_MAX_SIZE) {
            $respond(['success' => false, 'error' => '文件过大，已超过 ' . round(UPLOAD_MAX_SIZE / 1024 / 1024, 2) . 'MB 上限']);
        }

        // 4) MIME 检测（三级降级，不再硬性要求 fileinfo）：
        //    ① finfo 可用 → 按真实内容嗅探（最可信）
        //    ② finfo 不可用 → 用客户端声明的 $file['type']（不可信但能拦明显非图）
        //    ③ 客户端也未声明 → 直接放行，把校验完全交给后端
        $realMime = null;
        $mimeSource = 'finfo';
        if (function_exists('finfo_open')) {
            $finfo = @finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo !== false) {
                $detected = @finfo_file($finfo, $file['tmp_name']);
                @finfo_close($finfo);
                if (!empty($detected)) {
                    $realMime = $detected;
                }
            }
        }
        if (empty($realMime) && !empty($file['type'])) {
            $realMime = $file['type'];
            $mimeSource = 'client';
        }
        if (empty($realMime)) {
            $realMime = 'application/octet-stream';
            $mimeSource = 'none';
        }

        // 5) 软白名单：只在「finfo 拿到真实类型」时强校验；客户端声明的只做温和拦截
        if ($mimeSource === 'finfo' && !in_array($realMime, $UPLOAD_MIME_WHITELIST, true)) {
            $respond(['success' => false, 'error' => '不支持的文件类型: ' . $realMime]);
        } else if ($mimeSource === 'client' && !in_array($realMime, $UPLOAD_MIME_WHITELIST, true)) {
            // 客户端声明不像图片时，给一个温和提示（仍放行给后端做最终决定）
            // —— 这样 finfo 缺失时也不会让用户卡死
        }

        // 6) 构造安全文件名（按 MIME 给扩展名）
        $extMap = [
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif'  => 'gif',
            'image/webp' => 'webp', 'image/avif'=> 'avif','image/bmp'  => 'bmp',
        ];
        $ext = isset($extMap[$realMime]) ? $extMap[$realMime] : 'bin';
        $safeName = 'upload_' . date('Ymd_His') . '_' . substr(md5(uniqid('', true)), 0, 8) . '.' . $ext;

        // 7) cURL 转发 multipart/form-data 到后端
        $uploadUrl = getApiUrl(UPLOAD_URL);
        $ch = curl_init($uploadUrl);
        if ($ch === false) {
            $respond(['success' => false, 'error' => 'cURL 初始化失败']);
        }
        @curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        @curl_setopt($ch, CURLOPT_TIMEOUT, 60);
        @curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
        @curl_setopt($ch, CURLOPT_POST, true);
        @curl_setopt($ch, CURLOPT_POSTFIELDS, [
            'file' => new CURLFile($file['tmp_name'], $realMime, $safeName)
        ]);
        @curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Authorization: Bearer ' . API_TOKEN,
            'Accept: application/json',
        ]);

        $response  = curl_exec($ch);
        $httpCode  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr   = curl_error($ch);
        @curl_close($ch);

        if ($httpCode === 401) {
            $respond(['success' => false, 'error' => 'Token 鉴权失败，请检查 config.php 中的 API_TOKEN']);
        }
        if ($response === false) {
            $respond(['success' => false, 'error' => '转发到后端失败: ' . ($curlErr ?: '未知 cURL 错误')]);
        }

        $result = json_decode((string)$response, true);
        if (!is_array($result)) {
            $respond([
                'success' => false,
                'error'   => '后端响应不是合法 JSON（HTTP ' . $httpCode . '）：' . substr((string)$response, 0, 200)
            ]);
        }

        // 8) 透传后端结果
        $respond($result);

    } catch (Throwable $e) {
        error_log('[upload_image] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        $respond(['success' => false, 'error' => '上传处理异常: ' . $e->getMessage()]);
    }
}

// 逻辑处理：如果是从传统页面带 ?id=xx 进来的，做服务端初始化拉取
if ($isEdit) {
    $listResult = sendRpcRequest(getApiUrl('/api/list')); 
    if ($listResult && isset($listResult['success']) && $listResult['success']) {
        $post = null;
        foreach ($listResult['data'] as $p) {
            if (strval($p['id']) === strval($editId)) {
                $post = $p;
                break;
            }
        }
        if ($post) {
            $postId = $post['id'];
            $postTitle = $post['title'] ?? '';
            $postSlug = $post['slug'] ?? '';
            $postCategory = $post['category'] ?? ''; 

            $contentUrl = getApiUrl('/api/get?slug=' . urlencode($postSlug)); 
            $contentResult = sendRpcRequest($contentUrl);
            if ($contentResult && $contentResult['success'] && isset($contentResult['data'])) {
                $postContent = $contentResult['data']['content'] ?? '';
            }
        }
    }
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文章撰写与修改 · 创作中心</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css">
    <script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.min.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&display=swap');
        :root {
            --font-serif: 'Newsreader', 'Songti SC', 'STSong', serif;
            --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        body { font-family: var(--font-sans); }
        .font-serif { font-family: var(--font-serif); }
        .word-count { font-variant-numeric: tabular-nums; }

        .editor-container { display: flex; flex-direction: column; border: 1px solid #d6d3d1; border-radius: 0.375rem; overflow: hidden; background: white; }
        @media (min-width: 768px) { .editor-container { flex-direction: row; } }

        .toolbar { display: flex; flex-wrap: wrap; gap: 2px; padding: 8px; border-bottom: 1px solid #e7e5e4; background: #fafaf9; }
        @media (min-width: 768px) { .toolbar { flex-direction: column; border-bottom: none; border-right: 1px solid #e7e5e4; width: 44px; } }

        .toolbar-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; background: transparent; border-radius: 4px; color: #78716c; cursor: pointer; transition: all .15s ease; }
        .toolbar-btn:hover { background: #e7e5e4; color: #1c1917; }
        .toolbar-btn:active { background: #d6d3d1; }
        .toolbar-divider { width: 1px; height: 20px; background: #d6d3d1; margin: 0 4px; align-self: center; }
        @media (min-width: 768px) { .toolbar-divider { width: 20px; height: 1px; margin: 4px 0; } }

        .editor-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .editor-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #a8a29e; border-bottom: 1px solid #e7e5e4; background: #fafaf9; }
        .editor-textarea { flex: 1; width: 100%; min-height: 400px; padding: 16px; border: none; resize: none; font-family: ui-monospace, monospace; font-size: 14px; line-height: 1.7; color: #1c1917; background: white; outline: none; }

        .preview-pane { flex: 1; min-width: 0; border-top: 1px solid #e7e5e4; background: white; display: flex; flex-direction: column; }
        @media (min-width: 768px) { .preview-pane { border-top: none; border-left: 1px solid #e7e5e4; } }
        .preview-content { flex: 1; padding: 16px 20px; min-height: 400px; overflow-y: auto; }

        .preview-content h1 { font-family: var(--font-serif); font-size: 1.875rem; font-weight: 600; color: #1c1917; margin: 0 0 1rem 0; line-height: 1.3; }
        .preview-content h2 { font-family: var(--font-serif); font-size: 1.5rem; font-weight: 600; color: #1c1917; margin: 1.5rem 0 0.75rem 0; }
        .preview-content h3 { font-family: var(--font-serif); font-size: 1.25rem; font-weight: 600; color: #292524; margin: 1.25rem 0 0.5rem 0; }
        .preview-content p { margin: 0 0 1rem 0; line-height: 1.8; color: #292524; }
        .preview-content ul, .preview-content ol { margin: 0 0 1rem 0; padding-left: 1.5rem; }
        .preview-content li { margin: 0.25rem 0; line-height: 1.7; }
        .preview-content blockquote { margin: 1rem 0; padding: 0.5rem 1rem; border-left: 3px solid #d6d3d1; background: #fafaf9; color: #57534e; font-style: italic; }
        .preview-content code { font-family: ui-monospace, monospace; font-size: 0.875em; background: #f5f5f4; padding: 0.125rem 0.375rem; border-radius: 3px; color: #b45309; }
        .preview-content pre { margin: 1rem 0; padding: 1rem; background: #f5f5f4; border-radius: 6px; overflow-x: auto; }
        .preview-content a { color: #2563eb; text-decoration: underline; }
        .preview-content img { max-width: 100%; height: auto; border-radius: 6px; margin: 1rem 0; display: block; }
        .preview-content hr { border: none; border-top: 1px solid #e7e5e4; margin: 1.5rem 0; }
        .preview-content table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
        .preview-content th, .preview-content td { border: 1px solid #e7e5e4; padding: 0.5rem 0.75rem; text-align: left; }
        .preview-content th { background: #fafaf9; font-weight: 600; }
        .preview-content input[type="checkbox"] { margin-right: 0.5rem; }
        .preview-empty { display: flex; align-items: center; justify-content: center; height: 100%; min-height: 400px; color: #a8a29e; font-family: var(--font-serif); font-style: italic; }

        .fullscreen-mode { position: fixed; inset: 0; z-index: 9999; background: #fafaf9; padding: 16px; display: flex; flex-direction: column; }
        .fullscreen-mode .editor-container { flex: 1; border-radius: 8px; }
        .fullscreen-mode .editor-textarea, .fullscreen-mode .preview-content, .fullscreen-mode .preview-empty { min-height: calc(100vh - 80px); }
        .fullscreen-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; margin-bottom: 12px; }
        .exit-fullscreen-btn { display: none; }
        .fullscreen-mode .exit-fullscreen-btn { display: flex; }
        .fullscreen-mode .enter-fullscreen-btn { display: none; }

        /* === 上传中浮动提示（屏幕正中） === */
        .upload-toast {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 70;
            display: none;
            align-items: center;
            gap: 10px;
            padding: 12px 20px;
            background: #ffffff;
            border: 1px solid #d6d3d1;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
            font-size: 14px;
            color: #44403c;
            transition: opacity 0.2s ease, transform 0.2s ease;
        }
        .upload-toast.show { display: flex; }
        .upload-toast.error   { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
        .upload-toast.success { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }

        .upload-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid currentColor;
            border-top-color: transparent;
            border-radius: 50%;
            animation: upload-spin 0.8s linear infinite;
            flex-shrink: 0;
        }
        @keyframes upload-spin { to { transform: rotate(360deg); } }

        .toolbar-btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
    </style>
</head>
<body class="bg-[#fafaf9] text-stone-800">

    <!-- ⚡ 上传中浮动提示：压缩 / 上传 / 完成 / 失败 全程可见 -->
    <div id="upload-toast" class="upload-toast" role="status" aria-live="polite">
        <span class="upload-spinner" id="upload-toast-spinner"></span>
        <span id="upload-toast-text">正在上传图片...</span>
    </div>

    <div id="normal-mode">
        <div class="max-w-6xl mx-auto px-6 md:px-10 py-10 md:py-14">

            <header class="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 id="main-title" class="font-serif text-3xl md:text-[2rem] font-medium text-stone-900">
                        <?php echo ($isEdit) ? '编辑内容' : '撰写新内容'; ?>
                    </h1>
                    <p id="main-subtitle" class="text-sm text-stone-500 mt-2">
                        <?php echo ($isEdit) ? '修改并保存到边缘数据库' : '分享一段新的思考'; ?>
                    </p>
                </div>
                
                <div class="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                    <select id="quick-load-select" class="text-xs px-3 py-2 bg-white border border-stone-200 rounded-md text-stone-600 focus:outline-none focus:border-stone-400 transition-colors h-9 shadow-2xs cursor-pointer">
                        <option value="">载入内容列表...</option>
                    </select>
                    
                    <button type="button" id="quick-delete-btn" onclick="executeDeletePost()" 
                            class="hidden text-xs px-3 py-2 border border-stone-200 hover:border-red-300 bg-white hover:bg-stone-50 text-red-500 transition-all h-9 rounded-md shadow-2xs cursor-pointer font-medium">
                        删除此文
                    </button>

                    <button type="button" class="enter-fullscreen-btn px-3 py-2 text-xs text-stone-500 hover:text-stone-900 border border-stone-200 rounded-md transition-colors h-9 shadow-2xs flex items-center gap-1.5" onclick="enterFullscreen()">
                        全屏编辑
                    </button>
                </div>
            </header>

            <form id="post-form" onsubmit="executeSubmitPost(event)" class="space-y-6">
                <input type="hidden" id="post-id" value="<?php echo htmlspecialchars($postId); ?>">

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-[10px] uppercase tracking-widest text-stone-400 mb-1.5">标题 (可选)</label>
                        <input type="text" id="post-title"
                               value="<?php echo htmlspecialchars($postTitle); ?>"
                               class="w-full px-3 py-2.5 bg-white border border-stone-200 rounded-md text-base font-serif focus:outline-none focus:border-stone-500"
                               placeholder="输入标题即为长文章 (Post)，留空则为短推文 (Tweet)">
                    </div>
                    <div>
                        <label class="block text-[10px] uppercase tracking-widest text-stone-400 mb-1.5">唯一路径 (Slug)</label>
                        <input type="text" id="post-slug"
                               value="<?php echo htmlspecialchars($postSlug); ?>"
                               class="w-full px-3 py-2.5 bg-white border border-stone-200 rounded-md text-sm font-mono focus:outline-none focus:border-stone-500"
                               placeholder="长文章必填，推文留空将自动生成" <?php echo !empty($postId) ? 'readonly' : ''; ?>>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div class="md:col-span-1">
                        <label class="block text-[10px] uppercase tracking-widest text-stone-400 mb-1.5">分类</label>
                        <input type="text" id="post-category" value="<?php echo htmlspecialchars($postCategory); ?>"
                               class="w-full px-3 py-2.5 bg-white border border-stone-200 rounded-md text-sm focus:outline-none focus:border-stone-500"
                               placeholder="技术 / 随笔 / 未分类">
                    </div>
                    <div class="md:col-span-2">
                        <label class="block text-[10px] uppercase tracking-widest text-stone-400 mb-1.5">导入 JSON (可选)</label>
                        <input type="text" id="json-import-input" oninput="handleJsonImport(this)"
                               placeholder="粘贴原始配置格式的 JSON 文本结构，将瞬间完成数据流回填映射" 
                               class="w-full px-3 py-2.5 bg-white border border-stone-200 rounded-md text-xs font-sans focus:outline-none focus:border-stone-400 transition-colors shadow-2xs text-stone-600">
                    </div>
                </div>

                <div>
                    <div class="flex items-baseline justify-between mb-1.5">
                        <label class="block text-[10px] uppercase tracking-widest text-stone-400">正文</label>
                        <span class="text-[11px] text-stone-400 word-count">
                            <span id="word-count">0</span> 字
                        </span>
                    </div>

                    <div class="editor-container">
                        <div class="toolbar">
                            <button type="button" class="toolbar-btn" onclick="insertFormat('**', '**')" title="粗体 (Ctrl+B)">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z"></path><path stroke-linecap="round" stroke-linejoin="round" d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertFormat('*', '*')" title="斜体 (Ctrl+I)">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 4h-9M14 20H5M15 4L9 20"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertFormat('~~', '~~')" title="删除线">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12h12M6 4v8M18 20v-8"></path></svg>
                            </button>
                            <div class="toolbar-divider"></div>
                            <button type="button" class="toolbar-btn" onclick="insertLine('# ')" title="一级标题">
                                <span class="font-bold text-xs">H1</span>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertLine('## ')" title="二级标题">
                                <span class="font-bold text-xs">H2</span>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertLine('### ')" title="三级标题">
                                <span class="font-bold text-xs">H3</span>
                            </button>
                            <div class="toolbar-divider"></div>
                            <button type="button" class="toolbar-btn" onclick="insertFormat('`', '`')" title="行内代码">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertCodeBlock()" title="代码块">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path stroke-linecap="round" d="M8 10l-2 2 2 2M16 10l2 2-2 2M10 14l-2-2 2-2"></path></svg>
                            </button>
                            <div class="toolbar-divider"></div>
                            <button type="button" class="toolbar-btn" onclick="insertLine('> ')" title="引用">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertLine('- ')" title="无序列表">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertLine('1. ')" title="有序列表">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 20h14M7 12h14M7 4h14M3 20h.01M3 12h.01M3 4h.01"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertTaskList()" title="任务列表">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path></svg>
                            </button>
                            <div class="toolbar-divider"></div>
                            <button type="button" class="toolbar-btn" onclick="insertLink()" title="链接">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertLine('![alt](url)')" title="图片">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="uploadImage()" title="上传图片（插入到光标位置）">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertTable()" title="表格">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M3 14h18M10 3v18M14 3v18M3 3h18v18H3z"></path></svg>
                            </button>
                            <button type="button" class="toolbar-btn" onclick="insertLine('---')" title="分隔线">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"></path></svg>
                            </button>
                        </div>

                        <div class="editor-pane">
                            <div class="editor-header">Markdown</div>
                            <textarea id="post-content" name="content" class="editor-textarea"
                                      placeholder="开始写下你的思考..." required><?php echo htmlspecialchars($postContent); ?></textarea>
                        </div>

                        <div class="preview-pane">
                            <div class="editor-header">预览</div>
                            <div id="preview-content" class="preview-content">
                                <div class="preview-empty">预览区域</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="flex items-center gap-3 pt-2 border-t border-stone-200/60">
                    <button type="submit" id="submit-btn"
                            class="px-5 py-2.5 bg-stone-900 hover:bg-stone-800 text-white rounded-md text-sm font-medium transition-colors cursor-pointer">
                        <span id="btn-text"><?php echo !empty($postId) ? '保存修改' : '发布到边缘网络'; ?></span>
                    </button>
                    <span id="status-text" class="ml-auto text-xs italic font-serif hidden"></span>
                </div>

                <input type="file" id="image-upload-input" accept="image/*" class="hidden" onchange="handleImageUpload(event)">
            </form>
        </div>
    </div>

    <div id="fullscreen-mode" class="fullscreen-mode" style="display: none;">
        <div class="fullscreen-header">
            <div class="header-left">
                <button type="button" class="exit-fullscreen-btn px-3 py-2 text-xs text-stone-500 hover:text-stone-900 border border-stone-200 rounded-md transition-colors flex items-center gap-1.5" onclick="exitEditorFullscreen()">
                    退出全屏
                </button>
                <span class="text-sm text-stone-500">全屏编辑模式</span>
            </div>
            <div class="header-right">
                <span class="text-[11px] text-stone-400 word-count"><span id="word-count-fs">0</span> 字</span>
            </div>
        </div>
        <div class="editor-container">
            <div class="editor-pane">
                <div class="editor-header">Markdown</div>
                <textarea id="post-content-fs" class="editor-textarea" placeholder="开始写下你的思考..."></textarea>
            </div>
            <div class="preview-pane">
                <div class="editor-header">预览</div>
                <div id="preview-content-fs" class="preview-content">
                    <div class="preview-empty">预览区域</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let isFullscreen = false;

        function getTextarea() { return isFullscreen ? document.getElementById('post-content-fs') : document.getElementById('post-content'); }
        function getPreview() { return isFullscreen ? document.getElementById('preview-content-fs') : document.getElementById('preview-content'); }
        function getWordCount() { return isFullscreen ? document.getElementById('word-count-fs') : document.getElementById('word-count'); }

        function updateWordCount() {
            const len = getTextarea().value.length;
            getWordCount().textContent = len;
            updatePreview();
        }

        function updatePreview() {
            const content = getTextarea().value;
            const preview = getPreview();
            if (!content.trim()) { preview.innerHTML = '<div class="preview-empty">预览区域</div>'; return; }

            marked.setOptions({
                highlight: function(code, lang) {
                    if (lang && hljs.getLanguage(lang)) { return hljs.highlight(code, { language: lang }).value; }
                    return hljs.highlightAuto(code).value;
                },
                breaks: true, gfm: true
            });
            try { preview.innerHTML = marked.parse(content); } catch (e) { preview.innerHTML = '<p class="text-red-500">解析错误: ' + e.message + '</p>'; }
        }

        function insertFormat(before, after) {
            const ta = getTextarea(); const start = ta.selectionStart; const end = ta.selectionEnd; const selected = ta.value.substring(start, end);
            ta.value = ta.value.substring(0, start) + before + selected + after + ta.value.substring(end);
            ta.selectionStart = start + before.length; ta.selectionEnd = start + before.length + selected.length;
            ta.focus(); updateWordCount();
        }

        function insertLine(prefix) {
            const ta = getTextarea(); const start = ta.selectionStart; const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
            ta.value = ta.value.substring(0, lineStart) + prefix + ta.value.substring(lineStart);
            ta.selectionStart = ta.selectionEnd = lineStart + prefix.length;
            ta.focus(); updateWordCount();
        }

        function insertCodeBlock() {
            const ta = getTextarea(); const start = ta.selectionStart; const end = ta.selectionEnd; const selected = ta.value.substring(start, end) || '代码';
            const block = '\n```\n' + selected + '\n```\n';
            ta.value = ta.value.substring(0, start) + block + ta.value.substring(end);
            ta.selectionStart = start + 5; ta.selectionEnd = start + 5 + selected.length;
            ta.focus(); updateWordCount();
        }

        function insertLink() {
            const ta = getTextarea(); const start = ta.selectionStart; const end = ta.selectionEnd; const selected = ta.value.substring(start, end) || '链接文字';
            const link = '[' + selected + '](url)';
            ta.value = ta.value.substring(0, start) + link + ta.value.substring(end);
            ta.selectionStart = start + link.length - 4; ta.selectionEnd = start + link.length - 1;
            ta.focus(); updateWordCount();
        }

        function insertTable() {
            const ta = getTextarea(); const start = ta.selectionStart;
            const table = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n';
            ta.value = ta.value.substring(0, start) + table + ta.value.substring(start);
            ta.selectionStart = ta.selectionEnd = start + table.length;
            ta.focus(); updateWordCount();
        }

        function insertTaskList() {
            const ta = getTextarea(); const start = ta.selectionStart;
            const task = '\n- [ ] 待办事项1\n- [ ] 待办事项2\n- [x] 已完成事项\n';
            ta.value = ta.value.substring(0, start) + task + ta.value.substring(start);
            ta.selectionStart = ta.selectionEnd = start + task.length;
            ta.focus(); updateWordCount();
        }

        // ⚡ 上传图片：触发文件选择
        function uploadImage() {
            const input = document.getElementById('image-upload-input');
            if (input) input.click();
        }

        // ⚡ 上传图片：把返回的外链以 Markdown 形式插入到光标位置
        async function handleImageUpload(event) {
            const file = event.target.files && event.target.files[0];
            // 无论成功失败都先清空 value，允许重复上传同一文件
            event.target.value = '';
            if (!file) return;

            // 客户端预校验：>5MB 直接拒绝（压缩前的原图上限，避免给浏览器造成过大压力）
            if (file.size > 5 * 1024 * 1024) {
                showUploadToast('图片不能超过 5MB', 'error');
                setTimeout(() => {
                    const t = document.getElementById('upload-toast');
                    if (t) t.classList.remove('show');
                }, 2400);
                return;
            }

            const ta = getTextarea();
            // 记住光标位置（用户可能在选完文件前移动过光标）
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const selected = ta.value.substring(start, end);

            // ⚡️ 锁定上传按钮，避免重复触发；显示「压缩中」spinner
            setUploadButtonsDisabled(true);
            showUploadToast('正在压缩图片...', 'loading');

            // ⚡ 客户端压缩：转 WebP + 1600px + 0.85 画质 + 500KB 兜底
            let compressedFile = file;
            try {
                compressedFile = await imageCompression(file, {
                    fileType: 'image/webp',
                    maxWidthOrHeight: 1600,
                    initialQuality: 0.85,
                    maxSizeMB: 0.5,
                    useWebWorker: true
                });
            } catch (compressErr) {
                // 压缩失败不阻塞上传，兜底使用原图
                console.warn('图片压缩失败，将按原图上传:', compressErr);
                compressedFile = file;
            }

            const formData = new FormData();
            // ⚡ 修正：压缩后的 File.name 仍可能是原后缀（如 .png），必须按实际 MIME 修正后缀，
            //   否则后端 upload.js 会按原扩展名生成 R2 key，导致浏览器收到 image/webp 却无法正确识别
            let finalName = compressedFile.name || file.name;
            if (compressedFile.type === 'image/webp' && !/\.webp$/i.test(finalName)) {
                const lastDot = finalName.lastIndexOf('.');
                finalName = (lastDot > 0 ? finalName.substring(0, lastDot) : finalName) + '.webp';
            }
            formData.append('file', compressedFile, finalName);

            // ⚡️ 切换为「上传中」spinner
            showUploadToast('正在上传图片...', 'loading');

            try {
                const res = await fetch('?action=upload_image', {
                    method: 'POST',
                    body: formData
                });
                const result = await res.json();

                if (res.ok && result.success && result.url) {
                    // 以选中文字作为 alt；若没有选中则用「图片」
                    const altText = (selected && selected.trim()) ? selected.trim() : '图片';
                    const imageMd = `![${altText}](${result.url})`;
                    ta.value = ta.value.substring(0, start) + imageMd + ta.value.substring(end);
                    const cursor = start + imageMd.length;
                    ta.selectionStart = ta.selectionEnd = cursor;
                    ta.focus();
                    updatePreview();
                    updateWordCount();
                    showUploadToast('图片已插入', 'success');
                } else {
                    showUploadToast('上传失败: ' + (result.error || `HTTP ${res.status}`), 'error');
                    setTimeout(() => {
                        const t = document.getElementById('upload-toast');
                        if (t) t.classList.remove('show');
                    }, 3000);
                }
            } catch (err) {
                showUploadToast('上传失败: ' + err.message, 'error');
                setTimeout(() => {
                    const t = document.getElementById('upload-toast');
                    if (t) t.classList.remove('show');
                }, 3000);
            } finally {
                // ⚡️ 无论成功失败都解锁按钮
                setUploadButtonsDisabled(false);
            }
        }

        // ⚡️ 上传中浮动提示：loading（spinner）/ success / error
        function showUploadToast(msg, kind) {
            const toast = document.getElementById('upload-toast');
            const text  = document.getElementById('upload-toast-text');
            const spin  = document.getElementById('upload-toast-spinner');
            if (!toast || !text) return;

            text.textContent = msg;
            toast.className = 'upload-toast show';
            if (kind === 'error') {
                toast.classList.add('error');
            } else if (kind === 'success') {
                toast.classList.add('success');
            }
            // 成功 / 失败不显示 spinner
            if (spin) spin.style.display = (kind === 'error' || kind === 'success') ? 'none' : 'inline-block';

            // 成功 1.6s 后自动隐藏，错误由调用方控制隐藏时机
            if (kind === 'success') {
                setTimeout(() => toast.classList.remove('show'), 1600);
            }
        }

        // ⚡️ 锁定/解锁工具栏上的「上传图片」按钮，避免重复触发
        function setUploadButtonsDisabled(disabled) {
            document.querySelectorAll('button[onclick="uploadImage()"]').forEach(function (btn) {
                btn.disabled = disabled;
            });
        }

        function enterFullscreen() {
            document.getElementById('post-content-fs').value = document.getElementById('post-content').value;
            document.getElementById('normal-mode').style.display = 'none';
            document.getElementById('fullscreen-mode').style.display = 'flex';
            isFullscreen = true;
            if (window.top !== window) window.top.postMessage({ type: 'hide-sidebar' }, '*');
            updateWordCount(); getTextarea().focus();
        }

        function exitEditorFullscreen() {
            document.getElementById('post-content').value = document.getElementById('post-content-fs').value;
            document.getElementById('fullscreen-mode').style.display = 'none';
            document.getElementById('normal-mode').style.display = 'block';
            isFullscreen = false;
            if (window.top !== window) window.top.postMessage({ type: 'exit-fullscreen' }, '*');
            updateWordCount();
        }

        function autoSlugify() {
            if (document.getElementById('post-id').value) return;
            const titleEl = document.getElementById('post-title');
            const slugEl = document.getElementById('post-slug');
            
            if (slugEl.dataset.touched === '1') return;
            const raw = titleEl.value.trim();
            
            // 如果标题被清空，同时清空自动生成的 slug
            if (!raw) {
                slugEl.value = '';
                return;
            }
            
            if (/[^\x00-\x7F]/.test(raw)) { 
                slugEl.value = ''; 
                slugEl.placeholder = '请手动输入英文/数字路径'; 
                return; 
            }
            slugEl.value = raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
        }

        function showStatusNotification(msg, type) {
            const statusText = document.getElementById('status-text');
            statusText.innerText = msg;
            statusText.classList.remove('hidden');
            if (type === 'error') {
                statusText.className = 'ml-auto text-xs italic font-serif text-red-500';
            } else if (type === 'ok') {
                statusText.className = 'ml-auto text-xs italic font-serif text-emerald-600';
            } else {
                statusText.className = 'ml-auto text-xs italic font-serif text-stone-400';
            }
        }

        function handleJsonImport(inputEl) {
            const rawValue = inputEl.value.trim();
            if (!rawValue) return;
            try {
                const jsonObj = JSON.parse(rawValue);
                if (jsonObj.title !== undefined || jsonObj.content !== undefined || jsonObj.slug !== undefined) {
                    document.getElementById('post-title').value = jsonObj.title || '';
                    document.getElementById('post-slug').value = jsonObj.slug || '';
                    document.getElementById('post-category').value = (jsonObj.category === null || jsonObj.category === undefined) ? '' : jsonObj.category;
                    document.getElementById('post-content').value = jsonObj.content || '';
                    document.getElementById('post-slug').dataset.touched = '1';
                    showStatusNotification('已成功解析并导入文本数据结构', 'ok');
                    updateWordCount();
                    inputEl.value = '';
                    setTimeout(() => document.getElementById('status-text').classList.add('hidden'), 2000);
                }
            } catch (e) {
                showStatusNotification('正在等待输入合法的 JSON 文本结构...', 'loading');
            }
        }

        async function loadQuickLoadTitles() {
            try {
                const res = await fetch('?action=get_list');
                const result = await res.json();
                if (result.success && Array.isArray(result.data)) {
                    const select = document.getElementById('quick-load-select');
                    select.innerHTML = '<option value="">载入内容列表...</option>';
                    result.data.forEach(post => {
                        const opt = document.createElement('option');
                        opt.value = post.slug;
                        opt.dataset.id = post.id;
                        opt.dataset.title = post.title || '';
                        opt.dataset.category = post.category || ''; 
                        
                        const typeLabel = post.type === 'tweet' ? '推文' : '文章';
                        const displayTitle = post.title ? post.title : (post.excerpt ? post.excerpt.substring(0, 15) + '...' : '无标题内容');
                        opt.textContent = `[${typeLabel}] ${displayTitle} (${post.category || '未分类'})`;
                        
                        select.appendChild(opt);
                    });
                }
            } catch (e) { console.error('获取列表失败', e); }
        }

        async function executeSubmitPost(event) {
            event.preventDefault();
            const id = document.getElementById('post-id').value;
            const title = document.getElementById('post-title').value.trim();
            const slug = document.getElementById('post-slug').value.trim();
            const category = document.getElementById('post-category').value.trim();
            const content = document.getElementById('post-content').value.trim();

            // ⚡ 前端根据标题是否为空，自动推断类型
            const type = title ? 'post' : 'tweet';

            if (!content) {
                alert('提示：正文不能为空！');
                return;
            }
            if (type === 'post' && !slug) {
                alert('提示：长文章必须填写路径 (Slug)！');
                return;
            }

            const btn = document.getElementById('submit-btn');
            btn.disabled = true;
            btn.classList.add('opacity-60', 'cursor-wait');
            showStatusNotification('正在同步并推送数据至边缘网络...', 'loading');

            try {
                // 携带推断出的 type 给后端
                const res = await fetch('?action=submit_form', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, title, slug, category, content, type })
                });
                const result = await res.json();

                if (result.success) {
                    if (id) {
                        alert(`成功提示：${type === 'post' ? '长文章' : '推文'}已成功修改并同步至边缘网络。`);
                    } else {
                        alert(`成功提示：新${type === 'post' ? '长文章' : '推文'}已成功发布到边缘网络。`);
                    }
                    resetFormToNew();
                    loadQuickLoadTitles();
                    document.getElementById('status-text').classList.add('hidden');
                } else {
                    alert('操作失败，错误原因: ' + (result.error || '未知错误'));
                }
            } catch (e) {
                alert('通信故障：未能成功连接到本地服务器。');
            } finally {
                btn.disabled = false;
                btn.classList.remove('opacity-60', 'cursor-wait');
            }
        }

        async function executeDeletePost() {
            const id = document.getElementById('post-id').value;
            const title = document.getElementById('post-title').value || '无标题推文';
            if (!id) return;

            if (!confirm(`确定要彻底删除「${title}」吗？\n该操作将直接从边缘数据库中永久移除数据且不可恢复。`)) {
                return;
            }

            showStatusNotification('正在从边缘网络中移除数据...', 'loading');

            try {
                const res = await fetch(`?action=delete&id=${id}`);
                const result = await res.json();

                if (result.success) {
                    alert('成功提示：内容已顺利从边缘数据库中彻底移除。');
                    resetFormToNew();
                    loadQuickLoadTitles();
                    document.getElementById('status-text').classList.add('hidden');
                } else {
                    alert('删除失败，原因: ' + (result.error || '未知错误'));
                }
            } catch (e) {
                alert('网络通信异常，删除失败。');
            }
        }

        function resetFormToNew() {
            document.getElementById('post-id').value = '';
            document.getElementById('post-title').value = '';
            document.getElementById('post-slug').value = '';
            document.getElementById('post-slug').removeAttribute('readonly');
            document.getElementById('post-category').value = '';
            document.getElementById('post-content').value = '';
            document.getElementById('quick-load-select').value = '';
            document.getElementById('json-import-input').value = '';
            
            document.getElementById('btn-text').innerText = '发布到边缘网络';
            document.getElementById('main-title').innerText = '撰写新内容';
            document.getElementById('main-subtitle').innerText = '分享一段新的思考';
            document.getElementById('quick-delete-btn').classList.add('hidden');
            updateWordCount();
        }

        document.addEventListener('DOMContentLoaded', () => {
            const slugEl = document.getElementById('post-slug');
            const titleEl = document.getElementById('post-title');
            const contentEl = document.getElementById('post-content');
            const contentElFs = document.getElementById('post-content-fs');
            const selectEl = document.getElementById('quick-load-select');
            const deleteBtn = document.getElementById('quick-delete-btn');

            if(slugEl) slugEl.addEventListener('input', () => slugEl.dataset.touched = '1');
            if(titleEl) titleEl.addEventListener('input', autoSlugify);

            contentEl.addEventListener('input', () => { if (isFullscreen) document.getElementById('post-content-fs').value = contentEl.value; updateWordCount(); });
            contentElFs.addEventListener('input', () => { if (isFullscreen) document.getElementById('post-content').value = contentElFs.value; updateWordCount(); });

            if (document.getElementById('post-id').value) {
                deleteBtn.classList.remove('hidden');
                document.getElementById('main-title').innerText = '编辑内容';
            }

            selectEl.addEventListener('change', async function() {
                const selectedOpt = this.options[this.selectedIndex];
                if (!selectedOpt.value) {
                    resetFormToNew();
                    return;
                }

                document.getElementById('post-id').value = selectedOpt.dataset.id;
                document.getElementById('post-title').value = selectedOpt.dataset.title;
                document.getElementById('post-slug').value = selectedOpt.value;
                document.getElementById('post-slug').setAttribute('readonly', 'true');
                document.getElementById('post-category').value = selectedOpt.dataset.category;
                
                document.getElementById('btn-text').innerText = '保存修改';
                document.getElementById('main-title').innerText = '编辑内容';
                document.getElementById('main-subtitle').innerText = '修改并保存到边缘数据库';
                deleteBtn.classList.remove('hidden');

                document.getElementById('post-content').value = '正在加载正文...';
                updateWordCount();

                try {
                    const res = await fetch(`?action=get_detail&slug=${encodeURIComponent(selectedOpt.value)}`);
                    const result = await res.json();
                    if (result.success && result.data) {
                        document.getElementById('post-content').value = result.data.content || '';
                    } else {
                        document.getElementById('post-content').value = '正文载入失败，请刷新重试。';
                    }
                } catch(e) {
                    document.getElementById('post-content').value = '网络请求异常，正文载入失败。';
                }
                updateWordCount();
            });

            loadQuickLoadTitles();
            updateWordCount();
        });
    </script>
</body>
</html>