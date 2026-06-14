# API 接口文档

> Quinn's Space  ·  Cloudflare Pages Functions  ·  **21 个端点**
> 数据源：Cloudflare D1（关系型 SQLite）
> 鉴权：Bearer Token（支持两种方式：① 账号密码登录的 token = `users.password_hash` ② 系统环境变量 `API_TOKEN`）

---

## 0. 通用约定

### 0.1 请求 / 响应
- Base URL：`https://<your-domain>/api`
- 所有请求与响应均为 `application/json`（`/api/auth/login` 在无 Authorization 时除外）
- 时间字段统一为 ISO 8601 字符串（`new Date().toISOString()`）
- CORS：同源部署，无需 CORS 头

### 0.2 鉴权
- 登录成功后，**token** 是 `SHA-256(password)`，前端需在 `localStorage.setItem('admin_token', token)` 持久化
- 受保护接口必须携带：`Authorization: Bearer <token>`
- 服务端按以下顺序校验：
  1. **优先**检查系统环境变量 `API_TOKEN`
  2. 若未命中，则以 `SELECT COUNT(*) FROM users WHERE password_hash = ?` 比对
- 除 [`POST /api/user/update`](#26-post-apiuserupdate--改用户名--昵称--头像--密码) 外，所有受保护接口均支持 API_TOKEN
- **改密后 token 同步变更**，前端必须用响应里的 `newToken` 覆盖 localStorage
- 改密时 **必须** 同步传 `passwordConfirm` 字段且与 `password` 完全一致，否则 400

### 0.3 通用错误响应
```json
{ "success": false, "error": "错误描述" }
```
| HTTP 状态码 | 含义 |
|---|---|
| 200 | 成功 |
| 400 | 参数缺失 / 业务校验失败（如 slug 重复） |
| 401 | 未带 Authorization / token 不匹配 |
| 403 | 权限被拒（如使用 API_TOKEN 尝试修改账户信息） |
| 404 | 资源不存在 |
| 413 | 单条 SQL 语句 / 单批超过字节上限（`/api/sql/import`） |
| 429 | 登录频次超限（KV 限流，详见 1.1） |
| 500 | 服务端异常 |

### 0.4 分类归一化（写 → 读）
- DB 中 `posts.category` 默认值是 `'未分类'`
- 公开读接口（`/api/list` / `/api/get`）会把**空串** 与 **`'未分类'`** 都归一为 **`null`**
- 前端按 `if (post.category)` 真值判断是否展示分类
- 管理后台（`admin-posts.html` / `admin-edit.html`）继续用 `|| '未分类'` 兜底渲染

### 0.5 内容类型 `type`（文章 vs 推文）⚡
- DB 中 `posts.type` 取值：`'post'`（文章）/ `'tweet'`（推文），默认 `'post'`
- 推文允许 `title` 为 `NULL`（无标题）
- 推文 `slug` 缺失时后端按 `t-<时间戳>-<随机>` 自动生成，保证 UNIQUE 不冲突
- **编辑时不允许 post ↔ tweet 互转**（slug 格式不同，转型会带来迁移成本）
- 公开读接口 / 缓存 payload / KV list 键全部携带 `type` 字段
- `type` 大小写不敏感（`'Tweet'` / `'TWEET'` 都会被归一为 `'tweet'`）；非法值兜底为 `'post'`

---

## 1. 公开端点（无需鉴权）

### 1.0 默认管理员账号
- 系统**没有**注册端点
- 唯一管理员在 `sql.txt` 初始化时**预置**到 `users` 表
- 默认凭证：`admin` / `admin`（密码的 SHA-256 已硬编码进 seed）
- **首次登录后必须**通过 [`POST /api/user/update`](#26-post-apiuserupdate--改用户名--昵称--头像--密码) 修改密码；改密后旧 token 立即失效

---

### 1.1 `POST /api/auth/login` — 登录
请求体：
```json
{ "username": "admin", "password": "admin" }
```
成功响应 200：
```json
{
  "success": true,
  "message": "登录成功",
  "token": "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918",
  "nickname": "Admin",
  "avatar": "https://cdn.example.com/avatar.png"   // 或 null
}
```
错误：
- `401 { success:false, error:"用户名或密码错误" }`
- `429 { success:false, error:"尝试过于频繁，请 N 秒后再试" }`（响应头同步 `Retry-After: N`；5 分钟 10 次失败触发）⚡
- `500 { success:false, error:err.message }`

> ⚡ KV 限流键 `rl:login:<username>`，TTL 6 分钟；登录成功会清除对应键。
> ⚡ 「用户不存在」与「密码错」两条分支耗时一致（dummy hash 假比对），削弱枚举攻击。

---

### 1.2 `GET /api/list` — 文章列表
查询参数：
| 参数 | 必填 | 说明 |
|---|---|---|
| `category` | 否 | 按分类过滤（注意：值为 `null` 的"无分类"文章不命中任何过滤项） |
| `type` | 否 | `post` / `tweet`；不传则全量返回（管理后台 / 主页混合视图） |
| `page` | 否 | 整数 ≥ 1；与 `type` 配合时按 `PAGE_SIZE=10` 分页 |

成功响应 200：
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "...",
      "slug": "...",
      "category": "技术",   // 或 null
      "type": "post",        // post / tweet
      "views": 42,
      "status": "published", // 仅全量请求（无 category/page/type）时返回
      "created_at": "2026-06-11T08:00:00.000Z",
      "excerpt": "前 N 字纯文本摘要，N 由 site_settings.excerpt_length 决定（0 时为空串）",
      "content": "...",      // ⚡ 仅当 type=tweet 时附带（推文列表渲染需要原文）
      "author": {            // ⚡ 仅当 type=tweet 时附带（单用户系统下共用同一 author）
        "nickname": "Admin",
        "avatar": "https://cdn.example.com/avatar.png"   // 或 null
      }
    }
  ],
  "has_more": true   // 仅分页请求时返回
}
```
- 上限：分页请求 `PAGE_SIZE+1 = 11`（探测下一页）；单 type 全量 `LIMIT 100`；管理后台（全量无 type/category/page）无 LIMIT
- 缓存键：
  - `site:posts:list:type:<post|tweet>:page:<n>`（按 type 分页）★ 主流
  - `site:posts:list:type:<post|tweet>:cat:<cat>`（type + 分类）
  - `site:posts:list:v2:type:tweet:cat:<cat>`（推文专用 v2 键，带 author 字段）⚡
  - `site:posts:list:v2:type:tweet:page:<n>`（推文专用 v2 键）⚡
  - `site:posts:list:cat:<cat>`（全量 + 分类）
  - `site:posts:list:cat:<cat>:page:<n>`（分类 + 分页）
  - `site:posts:list:page:<n>`（无 type 无 category 的全量分页，兼容旧版）
  - **管理后台**（无 category / page / type）**绕过 KV**，永远直查 D1
- 缓存头：
  - KV 命中：`Cache-Control: public, max-age=10, s-maxage=60` ⚡
  - D1 直查（无缓存键的管理后台）：`Cache-Control: no-store`
- 摘要：服务端在边缘函数里现场计算，使用时根据 `excerpt_length` 设置做 markdown 剥离 + 词边界截断

---

### 1.3 `GET /api/get` — 单篇文章
查询参数：
| 参数 | 必填 |
|---|---|
| `slug` | 是 |

成功响应 200：
```json
{
  "success": true,
  "data": {
    "title": "...",        // 推文可能为 null
    "content": "（原始 markdown）",
    "category": "技术",   // 或 null
    "type": "post",        // post / tweet
    "views": 43,           // 已 +1
    "created_at": "..."
  }
}
```
副作用：成功后会**异步 +1 浏览量**（`context.waitUntil`，不阻塞响应）。⚡ 高并发场景下 KV 回写走 `UPDATE ... RETURNING views` 拿 trueViews，避免互相覆盖。
错误：
- `400 { success:false, error:"Missing slug parameter" }`
- `404 { success:false, error:"Post not found" }`（包含「文章不存在」与「文章为草稿但调用方非管理员」两种情况）⚡
- 缓存头：已发布 `public, max-age=5`；草稿 `no-store` ⚡

> ⚡ KV 缓存键 `post:content:<normalizedSlug>`，TTL 7 天。
> ⚡ 草稿保护：非管理员（无 Bearer / token 不匹配 / 仅凭 API_TOKEN）访问 `status='draft'` 文章一律 404，避免草稿 slug 泄露。

---

### 1.4 `GET /api/settings` — 读取站点设置
成功响应 200：
```json
{
  "success": true,
  "data": {
    "site_title":     "Quinn's Space",
    "site_subtitle":  "...",
    "show_views":     "1",
    "excerpt_length": "200",
    "home_mode":      "mix"     // ⚡ mix | posts | tweets
  }
}
```
- 缓存键：`site:settings:data`
- 缓存头：KV 命中 `public, max-age=10, s-maxage=60`；D1 直查 `no-store` ⚡
- DB 中不存在的 key 不会出现在 `data` 中

### 1.5 `GET /api/navs` — 读取 header 导航
成功响应 200：
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "label": "文章",
      "href": "/posts",
      "tab_key": "posts",
      "open_in_new_tab": false,
      "is_active": true,
      "sort_order": 10
    }
  ]
}
```
- 仅返回 `is_active = 1` 的项，按 `sort_order` 升序
- 缓存键：`site:navs:list:active`
- 缓存头：`Cache-Control: public, max-age=10, s-maxage=60`
- 加 `?admin=1` 需带 Bearer Token，返回全量（含禁用项，绕过 KV 直查 D1）

### 1.6 共享缓存策略说明（`lib/nav-render.js`）

所有读 KV 的代码都统一走两个 helper，三层兜底保证「KV miss 一定查 D1，并异步回填」：

| Helper | 缓存键 | 用途 | 兜底值 |
|---|---|---|---|
| `getActiveNavs(env, context)` | `site:navs:list:active` | SSR 公开页头部导航 | 硬编码「文章 / 推文」 |
| `getSettings(env, context)`   | `site:settings:data`   | SSR 公开页 + 公开 /api/list 摘要长度 | `{}` |
| `GET /api/user` (内联)         | `site:user:profile:data`| 单用户后台「账户信息」面板 + 头像 | 直接 401 让前端重新登录 |

**调用链**：
1. `env.KV.get(key)` —— 命中且 JSON 合法 → 直接返回
2. 命中失败 / 损坏 → `env.DB` 查 D1 → `context.waitUntil(env.KV.put(...))` 异步回填
3. D1 异常 → 硬编码兜底（绝不返回 `null` / `[]` / `{}`）

**调用方**（必传 `context`，否则会同步 `await put`）：
- SSR `functions/index.js` / `posts.js` / `tweets.js` / `post/[slug].js`
- API `functions/api/list.js`（仅 `excerpt_length`）
- API `functions/api/navs.js` GET（直接走自己的 `rebuildAndCacheNavs`）

---

## 2. 受保护端点（必须带 Bearer Token）

> 所有受保护接口请求头：
> ```
> Authorization: Bearer <token>
> Content-Type:   application/json
> ```
> 鉴权失败统一返回 `401`。

---

### 2.1 `POST /api/settings` — 批量更新站点设置
请求体（**仅以下 key 会被处理**，其他静默丢弃）：
```json
{
  "site_title":     "新标题",
  "site_subtitle":  "新副标题",
  "show_views":     "1",      // "0" 或 "1"，否则跳过
  "excerpt_length": "300",    // 0-1000 整数，0 表示关闭摘要
  "home_mode":      "mix"     // ⚡ mix | posts | tweets；其他值跳过
}
```
- 每个字段独立校验；非法值**静默跳过**，不阻断其他字段写入
- 空字符串也跳过
- 写入采用 `INSERT ... ON CONFLICT(key) DO UPDATE`，可重复保存
- 写完 D1 后**同步** `SELECT` 最新全表并 `await env.KV.put(KV_SETTINGS_KEY, ...)` 覆盖，彻底消除 SSR 白屏窗口期
- 同时**异步**清空 `site:posts:list:page:*` / `site:posts:list:type:*` / `site:posts:list:cat:*` 三类列表缓存

成功响应 200：`{ "success": true, "message": "已更新 N 项配置并联动清空全站缓存。" }` ⚡

---

### 2.2 `POST /api/push` — 新建文章 / 推文
请求体：
```json
{
  "title":    "文章必填；推文可留空",
  "slug":     "文章必填；推文可留空自动生成 t-<stamp>-<rand>",
  "content":  "必填，markdown",
  "category": "可选，默认 '未分类'",
  "type":     "post / tweet（大小写不敏感），可省略。省略时由 title 留空自动判断（推文）"
}
```
- `type` 非法值兜底为 `post`
- 文章必须有 `title`；推文 `title` 为 `null` 入库
- 推文自动生成的 `slug` 形如 `t-lvo8a3-b4c5`（36 进制时间戳 + 4 位随机）
- 写后清空 `site:posts:list:type:*` / `site:posts:list:v2:type:tweet:*` / `site:posts:list:page:*` / `site:posts:list:cat:*` 等所有列表缓存

成功响应 200：`{ "success": true, "message": "Post saved to D1 successfully" }`
错误：
- `400 { success:false, error:"正文不能为空" }`
- `400 { success:false, error:"文章必须填写标题" }`
- `400 { success:false, error:"Slug 必填" }`（非推文未传 slug；推文会自动生成）
- `400 { success:false, error:"The slug already exists" }`（slug 唯一约束冲突）
- `500 { success:false, error:err.message }`

---

### 2.3 `POST /api/update` — 更新文章 / 推文
请求体：
```json
{
  "id":       1,           // 必填
  "title":    "...",       // 文章必填；推文可空
  "slug":     "...",
  "content":  "...",
  "category": "...",
  "status":   "published / draft（默认 published）",
  "type":     "可选；与服务端原 type 不一致 → 400"
}
```
- 编辑时显式传 `type` 与 DB 原值不一致时返回 `400 "不支持在编辑时修改内容类型"` ⚡
- 文章 `title` 不能清空（清空将返回 `400 "文章必须填写标题"`）
- 缺 `id` / `slug` / `content` 任一字段 → `400 "id / 路径 / 正文不能为空"` ⚡
- 草稿（`status='draft'`）**不**回填 `post:content:*` 缓存
- 改名 / 改状态时会**先 delete 旧 slug 缓存**，再按新状态决定是否回填新 slug 缓存
- 编辑后会**异步清理被移除的 R2 图片**：取新旧 content 的 R2 key 差集，删孤儿图（失败不影响主流程）

成功响应 200：⚡
```json
{
  "success": true,
  "message": "文章已更新",
  "r2_cleanup": { "keys": 2, "ok": 2, "fail": 0 }
}
```
错误：
- `400 "id / 路径 / 正文不能为空"` 缺字段
- `400 "Slug 已被其他文章占用"` slug 冲突
- `400 "文章必须填写标题"` 文章 title 被清空
- `400 "不支持在编辑时修改内容类型"` 改了 type
- `404 "未找到该文章，可能已被删除"`（id 不存在或 `meta.changes === 0`）

---

### 2.4 `POST /api/delete` — 删除文章（支持单删 / 批量）
请求体（任选其一；`ids` 与 `id` 同时给时以 `ids` 为准）：
```json
{ "id": 1 }                    // 单删
{ "ids": [1, 2, 3] }           // 批量（推荐）
```
- `ids` 元素必须为正整数；非法值会被静默过滤
- 后端用 `IN (...)` 一次性 D1 物理删除 + 一次性遍历清理各文章 `post:content:<slug>` KV
- 四种列表缓存（`site:posts:list:page:*` / `site:posts:list:type:*` / `site:posts:list:cat:*` / `site:posts:list:v2:type:tweet:*`）清空策略保持原样
- 删除后会**异步清理被删文章正文里的 R2 图片**（失败不影响主流程）
- 批量场景下允许部分命中（`deleted < ids.length`），按实际成功数量返回

成功响应 200：⚡
```json
{
  "success": true,
  "message": "已删除 3 篇文章",
  "deleted": 3,
  "r2_cleanup": { "keys": 5, "ok": 5, "fail": 0 }
}
```
错误：
- `400 "缺少文章 id"` 都没传 / 传了非法值
- `404 "未找到任何待删文章"`（`meta.changes === 0`）

---

### 2.5 `GET /api/user` — 取当前账户信息
成功响应 200（账号密码登录的 token）：
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "admin",
    "nickname": "Admin",
    "avatar": "https://cdn.example.com/avatar.png",   // 或 null
    "created_at": "..."
  }
}
```
> 不返回 `password_hash`。
> token 不匹配时返 `401 { success:false, error:"口令失效，请重新登录" }`。

用 **API_TOKEN** 调用时返回（不查 D1 用户表，最小返回避免泄漏账号体系）⚡：
```json
{ "success": true, "data": { "is_api_token": true } }
```

> ⚡ 缓存：KV 键 `site:user:profile:data`，存「整行（含 password_hash）」用于校验 token 是否仍对应缓存里的用户；命中时由 GET 端点的 token 过滤逻辑保证旧 token 不会读到新用户的数据。D1 兜底后会 `context.waitUntil` 异步回填 KV。**API_TOKEN 调用路径不读 / 不写 KV**。

---

### 2.6 `POST /api/user/update` — 改用户名 / 昵称 / 头像 / 密码
请求体（任选）：
```json
{
  "username":        "新用户名（可选）",
  "nickname":        "新昵称（可选，null 表示清空）",
  "avatar":          "https://cdn.example.com/avatar.png",  // 头像直链 URL（http/https），可选；null / "" 表示清空
  "password":        "新密码（可选，传入即触发改密并轮换 token）",
  "passwordConfirm": "再次输入新密码（仅 password 非空时必填，必须等于 password）"   // ⚡
}
```
- 用户名不能为空字符串
- 头像仅接受 `http://` / `https://` 直链；其他协议（`javascript:` / `data:` / `file:` …）一律 400 拒绝；长度上限 2048
- 改密时 **必须** 同步传 `passwordConfirm` 字段且与 `password` 完全相等，否则 400 ⚡
- 改密时 token 会变（`newHash` = `SHA-256(newPassword)`），响应里 `newToken` 字段必须写回 localStorage
- 至少传一个字段，否则返 `400 "没有任何修改"`
- **此接口禁止使用 API_TOKEN**，否则返回 `403`
- ⚡ 写完 D1 后会立刻 `SELECT` 最新整行并 `KV.put('site:user:profile:data', ...)` 覆盖，**任何字段的变更（avatar / nickname / username / password）都会让 GET /api/user 在下一次请求直接命中新值**
- ⚡ 改 username / nickname / avatar 后会**异步清空 `site:posts:list:v2:type:tweet:*`** 推文列表缓存（推文渲染依赖 author 字段）

成功响应 200：
```json
{ "success": true, "message": "账户信息已更新", "newToken": "..." /* 改密时才有 */ }
```
错误：
- `400` 用户名为空 / 头像非法 / 改密未传 `passwordConfirm` / 两次密码不一致 / 无修改 / username 已被占用
- `401` token 失效
- `403` 使用了 API_TOKEN

---

### 2.7 `POST /api/navs` — 新建 header 导航项
请求体：
```json
{
  "label":           "关于",           // 必填，1-20 字
  "href":            "/about",         // 必填，1-500 字符
  "tab_key":         "about",          // 可空；用于高亮当前页面 tab；最长 32 字符
  "open_in_new_tab": 0,                // 0/1
  "is_active":       1                 // 0/1；默认 1
  // sort_order 省略时自动追加在末尾（MAX(sort_order) + 10）
}
```
- `label` / `href` 不能为空字符串

### 2.8 `POST /api/navs?action=update` — 更新 header 导航项
请求体（必传 `id`）：
```json
{
  "id":              1,
  "label":           "...",
  "href":            "...",
  "tab_key":         "...",        // 空串视为 null；超 32 字符会被截断
  "open_in_new_tab": 0,
  "is_active":       1,
  "sort_order":      10
}
```
- 未传的字段保留原值；`tab_key` 传空串视为 null
- `label` / `href` 任何时候都不能为空字符串

### 2.9 `POST /api/navs?action=delete` — 删除 header 导航项
请求体：
```json
{ "id": 1 }
```
- 找不到时返 `404 "未找到该导航项"`

### 2.10 `POST /api/navs?action=reorder` — 批量调整顺序
请求体：
```json
{ "order": [3, 1, 4, 2] }   // id 数组，按数组顺序重新赋 sort_order
```
- 服务端按数组下标自动赋 `sort_order = (idx+1) * 10`，留出插入新项的空间
- 用 `env.DB.batch()` 把整批作为单个事务执行，途中失败会回滚
- 非正整数 id 会被静默过滤；若过滤后数组为空 → `400 "order 数组中没有有效 id"`

> ⚡ 2.7 / 2.8 / 2.9 / 2.10 任一写操作都会**立刻** `await rebuildAndCacheNavs(env)`（DB 全量重查 + KV 覆盖），确保前台 SSR 下次访问立即生效。
> 2.7-2.10 写操作统一响应：`{ "success": true, "message": "导航缓存已同步" }`

---

## 3. 运维端点（鉴权同上，10 个）⚡

> 以下端点服务于管理后台的「搜索 / 上传 / 数据库 / KV / R2」工具面板，鉴权与 [§2](#2-受保护端点必须带-bearer-token) 一致。
> 入参示例共用 `Authorization: Bearer <token>` 请求头；除特别注明外，`Content-Type: application/json`。

### 3.1 `GET /api/search` — 关键词 / 日期搜索
查询参数：
| 参数 | 必填 | 说明 |
|---|---|---|
| `q` | 否 | 关键词，模糊匹配 `title` / `content`（LIKE 通配符 `%` `_` `\` 会被转义） |
| `date` | 否 | `YYYY-MM-DD`；匹配 `created_at` 起始日期 |

成功响应 200：
```json
{ "success": true, "data": [/* 最多 15 条 */] }
```
- 内部错误统一返回 `500 { error: "搜索失败，请稍后重试" }`（已脱敏，避免泄露 SQL / 表结构）
- 仅匹配 `status='published'`
- 返回字段：`id, title, slug, category, type, content, created_at, views`

### 3.2 `POST /api/upload` — 上传文件到 R2
请求：`multipart/form-data`，字段名 `file`；最大 **5 MB**。
- 不需要 `Content-Type: application/json`

成功响应 200：
```json
{
  "success": true,
  "url": "https://<R2_PUBLIC_URL>/YYYY/MM/<timestamp>-<rand>.<ext>",
  "message": "上传成功"
}
```
错误：
- `400 "未找到上传文件"` 字段缺失
- `400 "文件大小不能超过 5MB"`
- `500 "R2_BUCKET 未绑定"` / `err.message`

> 鉴权：支持 API_TOKEN 与账号密码登录；上传不依赖 D1 表。

### 3.3 `GET /api/sql/tables` — 列出 D1 业务表与行数
成功响应 200：
```json
{
  "success": true,
  "data": [
    { "name": "posts",         "rows": 42 },
    { "name": "site_settings", "rows":  5 }
  ]
}
```
- 排除 `sqlite_*` 与 `_cf_*` 系统表

### 3.4 `GET /api/sql/table-data?table=<name>&page=<n>&pageSize=<n>` — 拉取单表数据
查询参数：
| 参数 | 必填 | 默认 | 上限 |
|---|---|---|---|
| `table` | 是 | — | — |
| `page` | 否 | 1 | — |
| `pageSize` | 否 | 50 | 200 |

- 表名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，否则 400「非法的表名」

成功响应 200：
```json
{
  "success": true,
  "data": {
    "table": "posts",
    "columns": [{ "name": "id", "type": "INTEGER", "notnull": true, "pk": true, "dflt": null }],
    "rows": [ /* 原始行 */ ],
    "total": 42,
    "page": 1,
    "pageSize": 50,
    "totalPages": 1
  }
}
```
- 错误：`400 缺少 table 参数` / `400 非法的表名` / `404 表不存在` / `500`

### 3.5 `GET /api/sql/export` — 流式导出 D1 整库为 SQL
- 响应：`Content-Type: application/sql; charset=utf-8`，`Content-Disposition: attachment; filename="blog-db-<shanghai_now>.sql"`
- 使用 `ReadableStream` + `LIMIT/OFFSET` 分页流式生成，避免 OOM
- 单批 `BATCH_SIZE = 100`
- 写入内容包含：表 DDL、每行 `INSERT INTO ...`、索引 DDL、`BEGIN` / `COMMIT` 事务
- ⚡ 导出时间与文件名统一用 `nowInShanghai()`，避免时区错位

### 3.6 `POST /api/sql/import` — 导入 SQL
请求体（`Content-Type: application/json`）：
```json
{
  "sqlArray":   ["stmt1", "stmt2", "..."],
  "isLastChunk": true,
  "mode":        "overwrite"   // 或 "incremental"
}
```
- 单批最多 `MAX_BATCH_SIZE = 200` 条；单条 `MAX_STMT_BYTES = 256KB`
- 自动剥掉 D1 不支持的事务控制（`BEGIN` / `COMMIT` / `END` / `ROLLBACK` / `RELEASE` / `SAVEPOINT` / `PRAGMA foreign_keys`）
- `mode = "overwrite"`（默认）：原样执行；适合从本系统导出的全量备份恢复
- `mode = "incremental"`：跳过 `DROP TABLE` / `CREATE INDEX`；`CREATE TABLE` 自动加 `IF NOT EXISTS`；`INSERT INTO` 改写为 `INSERT OR IGNORE INTO`
- 用 `env.DB.batch()` 整批作为单个事务执行；中途失败回滚
- 仅当 `isLastChunk === true` 时清空 `site:posts:list:page:*` / `site:posts:list:type:*` / `site:posts:list:cat:*` / `site:settings:data` / `post:content:*` 等全站缓存

成功响应 200：
```json
{
  "success": true,
  "message": "覆盖模式：已成功执行 12 条语句...，全站缓存已清理",
  "executed": 12,
  "skipped": 0,
  "isLastChunk": true,
  "mode": "overwrite",
  "modeStats": { "droppedTables": 0, "droppedIndexes": 0, "guardedTables": 0, "transformedInserts": 0 },
  "detail": [/* batch() 返回的每条结果 */]
}
```
错误：`400 sqlArray 为空或格式错误` / `413 单批最多 N 条 / 第 N 条语句超过 N 字节` / `400 不支持的导入模式` / `500`

### 3.7 `GET /api/sql/kv/list?prefix=<str>&limit=<n>&cursor=<str>` — 列出 KV 键
- `limit`：默认 100，上限 1000

成功响应 200：
```json
{
  "success": true,
  "data": {
    "keys": [{ "name": "site:settings:data", "expiration": 1735660800, "metadata": null }],
    "list_complete": true,
    "cursor": null,
    "prefix": "site:"
  }
}
```

### 3.8 `GET /api/sql/kv/get?key=<name>&type=json|text` — 读取 KV 单值
- `key` 长度上限 512
- 单次返回不超过 `MAX_VALUE_BYTES = 256KB`（超出截断 + `truncated: true`）
- 命中但 `type=json` 解析失败时，`parsed = null`、`parseError` 填错误信息

成功响应 200：
```json
{
  "success": true,
  "data": {
    "key": "site:settings:data",
    "value": "...",
    "exists": true,
    "size": 1024,
    "truncated": false,
    "parsed": { /* type=json 时尝试 JSON.parse 后的对象；失败则为 null */ },
    "parseError": null
  }
}
```

### 3.9 `GET /api/sql/r2-list?q=<prefix>` — 列出 R2 对象
- `q` 为可选 key 前缀（精确到子目录）
- 内部循环 `R2.list({ limit: 1000 })` 翻页至完

成功响应 200：
```json
{
  "success": true,
  "data": {
    "files": [{
      "key": "2026/06/1234-abcd.png",
      "size": 12345,
      "uploaded": "2026-06-14T08:00:00.000Z",
      "httpMetadata": { "contentType": "image/png" },
      "content_type": "image/png",
      "url": "https://<R2_PUBLIC_URL>/2026/06/1234-abcd.png"
    }],
    "totalSize": 12345
  }
}
```
- 错误：`500 "R2_BUCKET 未绑定"` / `err.message`

### 3.10 `POST /api/sql/r2-delete` — 删除 R2 单个对象
请求体：
```json
{ "key": "2026/06/1234-abcd.png" }
```
- 防御性检查：禁止 `..`、绝对路径 `/`、控制字符 `\x00-\x1f`
- `R2.delete()` 对不存在的 key 是 no-op（不抛错）

成功响应 200：`{ "success": true, "deleted": 1, "key": "..." }`
错误：`400 缺少 key 参数` / `400 非法的 key` / `500 "R2_BUCKET 未绑定"`

---

## 4. 完整 curl 测试脚本

```bash
# 0) API_TOKEN 方式（系统环境变量纯文本密钥，所有受保护接口均可使用，除 /api/user/update）
API_TOKEN="MySecretToken2026"

# 1) 登录拿 token
TOKEN=$(curl -s -X POST https://YOUR-DOMAIN/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2) 公开读
curl -s https://YOUR-DOMAIN/api/list
curl -s "https://YOUR-DOMAIN/api/list?type=post"
curl -s "https://YOUR-DOMAIN/api/list?type=tweet"
curl -s "https://YOUR-DOMAIN/api/list?type=post&page=2"
curl -s "https://YOUR-DOMAIN/api/get?slug=d1-blog-guide"

# 3) 写接口（支持两种鉴权方式）
# 3.1) 使用登录 token
# 3.1.1) 发文章
curl -s -X POST https://YOUR-DOMAIN/api/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"测试","slug":"test-1","content":"# hi","category":"技术","type":"post"}'

# 3.1.2) 发推文（title 和 slug 都可省略，type 可省略让后端自动判断）
curl -s -X POST https://YOUR-DOMAIN/api/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"今天天气不错，随手记一笔。","type":"tweet"}'

# 3.2) 使用 API_TOKEN
curl -s -X POST https://YOUR-DOMAIN/api/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"title":"测试","slug":"test-2","content":"# hi","category":"技术"}'

curl -s -X POST https://YOUR-DOMAIN/api/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"id":1,"title":"已改","slug":"test-1","content":"# hi","category":"技术"}'

curl -s -X POST https://YOUR-DOMAIN/api/delete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"id":1}'

# ⚡ 批量删除
curl -s -X POST https://YOUR-DOMAIN/api/delete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"ids":[1,2,3]}'

# 3.3) /api/user/update 必须用登录 token；改密时同步传 passwordConfirm
curl -s -X POST https://YOUR-DOMAIN/api/user/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"nickname":"新昵称","avatar":"https://cdn.example.com/avatar.png"}'

curl -s -X POST https://YOUR-DOMAIN/api/user/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"password":"newpass","passwordConfirm":"newpass"}'
# 改密后用响应里 newToken 覆盖 localStorage

# 3.4) /api/user/update 禁止使用 API_TOKEN → 403
curl -s -X POST https://YOUR-DOMAIN/api/user/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"nickname":"新昵称"}'  # 返回 403

# 4) 设置（支持 API_TOKEN）
curl -s -X POST https://YOUR-DOMAIN/api/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"site_title":"新标题","excerpt_length":"300","home_mode":"posts"}'

# 5) 账户
curl -s https://YOUR-DOMAIN/api/user -H "Authorization: Bearer $API_TOKEN"
# 预期: { "success": true, "data": { "is_api_token": true } }

# 6) header 导航
curl -s https://YOUR-DOMAIN/api/navs

curl -s -X POST https://YOUR-DOMAIN/api/navs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"label":"关于","href":"/about","tab_key":"about","is_active":1}'

curl -s -X POST https://YOUR-DOMAIN/api/navs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"label":"GitHub","href":"https://github.com/foo","open_in_new_tab":1,"sort_order":99}'

curl -s -X POST "https://YOUR-DOMAIN/api/navs?action=update" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"id":1,"is_active":0}'

curl -s -X POST "https://YOUR-DOMAIN/api/navs?action=reorder" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"order":[2,1,3]}'

curl -s -X POST "https://YOUR-DOMAIN/api/navs?action=delete" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"id":1}'

# 7) 搜索
curl -s "https://YOUR-DOMAIN/api/search?q=hello"
curl -s "https://YOUR-DOMAIN/api/search?date=2026-06-14"

# 8) 上传（需把 file 替换为本地文件路径）
curl -s -X POST https://YOUR-DOMAIN/api/upload \
  -H "Authorization: Bearer $API_TOKEN" \
  -F "file=@./photo.png"

# 9) 数据库工具
curl -s https://YOUR-DOMAIN/api/sql/tables -H "Authorization: Bearer $API_TOKEN"
curl -s "https://YOUR-DOMAIN/api/sql/table-data?table=posts&page=1&pageSize=20" \
  -H "Authorization: Bearer $API_TOKEN"
curl -s -o blog-backup.sql https://YOUR-DOMAIN/api/sql/export \
  -H "Authorization: Bearer $API_TOKEN"

# 10) KV 工具
curl -s "https://YOUR-DOMAIN/api/sql/kv/list?prefix=site:&limit=50" \
  -H "Authorization: Bearer $API_TOKEN"
curl -s "https://YOUR-DOMAIN/api/sql/kv/get?key=site:settings:data&type=json" \
  -H "Authorization: Bearer $API_TOKEN"

# 11) R2 工具
curl -s "https://YOUR-DOMAIN/api/sql/r2-list?q=2026/06" \
  -H "Authorization: Bearer $API_TOKEN"
curl -s -X POST https://YOUR-DOMAIN/api/sql/r2-delete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"key":"2026/06/1234-abcd.png"}'
```

---

## 5. 数据表速查

```sql
-- 用户
users(id, username UNIQUE, password_hash, nickname, avatar, created_at)

-- 文章（含 type 区分 post/tweet）
posts(
  id, title,         -- title 推文可空
  slug UNIQUE,
  content,
  excerpt,
  category,
  type,              -- 'post' | 'tweet'，默认 'post'
  views, status, author_id, created_at, updated_at
)

-- 站点设置（key-value）
site_settings(key PK, value, updated_at)

-- 站点 header 导航
site_navs(
  id, label,                              -- 显示文字，1-20 字
  href,                                   -- 跳转 URL，1-500 字符
  tab_key,                                -- 当前页高亮键，可空
  open_in_new_tab,                        -- 0/1
  is_active,                              -- 0/1，仅启用项进 KV 与前台
  sort_order,                             -- 升序
  created_at, updated_at
)
```

允许的设置 key：`site_title` / `site_subtitle` / `show_views` / `excerpt_length` / **`home_mode`** ⚡

---

## 6. 已知设计取舍

| 项 | 当前设计 | 影响 |
|---|---|---|
| Token = `password_hash` | 单用户系统、零依赖、改密即吊销 | 无过期；DB 脱裤后 token 仍可长期使用（建议未来引入 `sessions` 表） |
| 摘要 = 服务端现场算 | 摘要按当前 `excerpt_length` 实时截取 | `/api/list` 关掉缓存（`no-store`）以保证设置变更立即生效 |
| `category = null` 归一化 | 公开读接口把 `''` / `'未分类'` 都映射成 `null` | 前端只判真值；管理后台仍显示 `未分类` 以便筛未分类文章 |
| 浏览量 +1 异步 | `context.waitUntil` 不阻塞响应 | 极端情况 +1 失败不影响主请求 |
| `type` 字段分流 | post / tweet 共享同一张表 + 同一详情路由 | 缓存键 / 查询参数 / SSR 模板按 type 分流，互转不开放 |
| 推文 slug 自动生成 | `t-<timestamp36>-<rand4>` | 用户无需关心 slug 即可发推；互转成本不可接受，故锁定 type |
| 登录 KV 限流 | 5 分钟 10 次失败 → 429 | 削弱密码爆破；KV 异常时放行（不阻断合法用户）⚡ |
| 推文缓存 v2 双前缀 | type=tweet 同时存在 v1 / v2 缓存键 | 推文 v2 额外带 author 字段；写入 D1 后 /api/user/update 会主动清空 ⚡ |
| 草稿 404 隔离 | 非管理员访问草稿直接 404 | 草稿 slug 不被泄露 ⚡ |
| 头像直链校验 | 仅接受 http/https；上限 2048 字符 | 防 `javascript:` / `data:` XSS；超长 URL 一律拒绝 ⚡ |

---

> 文档版本：2026-06-14
> 本版新增端点（10 个）：`/api/search` · `/api/upload` · `/api/sql/tables` · `/api/sql/table-data` · `/api/sql/export` · `/api/sql/import` · `/api/sql/kv/list` · `/api/sql/kv/get` · `/api/sql/r2-list` · `/api/sql/r2-delete`
> 本版对齐：设置项 `home_mode` · 登录 429 限流 · `passwordConfirm` 改密二次确认 · `r2_cleanup` 响应字段 · `is_api_token` API_TOKEN 返回 · 推文 `content` / `author` 字段 · 推文缓存 v2 前缀 · 草稿 404 隔离 · 缓存头区分（KV 命中 / D1 直查）· `/api/navs` 写操作统一响应 · `/api/navs/reorder` 用 batch 事务
> 维护者：随源码演进同步更新
