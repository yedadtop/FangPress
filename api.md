# API 接口文档

> Quinn's Space  ·  Cloudflare Pages Functions  ·  **10 个端点**
> 数据源：Cloudflare D1（关系型 SQLite）
> 鉴权：Bearer Token（支持两种方式：① 账号密码登录的 token = `users.password_hash` ② KV 中的 `API_TOKEN`）

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
  1. **优先**检查 Cloudflare KV 中的 `API_TOKEN`
  2. 若未命中，则以 `SELECT COUNT(*) FROM users WHERE password_hash = ?` 比对
- 除 [`POST /api/user/update`](#26-post-apiuserupdate--改用户名--昵称--密码) 外，所有受保护接口均支持 API_TOKEN
- **改密后 token 同步变更**，前端必须用响应里的 `newToken` 覆盖 localStorage

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
| 500 | 服务端异常 |

### 0.4 分类归一化（写 → 读）
- DB 中 `posts.category` 默认值是 `'未分类'`
- 公开读接口（`/api/list` / `/api/get`）会把**空串** 与 **`'未分类'`** 都归一为 **`null`**
- 前端按 `if (post.category)` 真值判断是否展示分类
- 管理后台（`admin-posts.html` / `admin-edit.html`）继续用 `|| '未分类'` 兜底渲染

---

## 1. 公开端点（无需鉴权）

### 1.0 默认管理员账号
- 系统**没有**注册端点
- 唯一管理员在 `sql.txt` 初始化时**预置**到 `users` 表
- 默认凭证：`admin` / `admin`（密码的 SHA-256 已硬编码进 seed）
- **首次登录后必须**通过 [`POST /api/user/update`](#26-post-apiuserupdate--改用户名--昵称--密码) 修改密码；改密后旧 token 立即失效

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
  "nickname": "Admin"
}
```
错误：
- `401 { success:false, error:"用户名或密码错误" }`
- `500 { success:false, error:err.message }`

---

### 1.2 `GET /api/list` — 文章列表
查询参数：
| 参数 | 必填 | 说明 |
|---|---|---|
| `category` | 否 | 按分类过滤（注意：值为 `null` 的"无分类"文章不命中任何过滤项） |

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
      "views": 42,
      "created_at": "2026-06-11T08:00:00.000Z",
      "excerpt": "前 N 字纯文本摘要，N 由 site_settings.excerpt_length 决定（0 时为空串）"
    }
  ]
}
```
- 上限：`LIMIT 100`，按 `created_at DESC`
- 缓存：`Cache-Control: no-store`（写后立即生效）
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
    "title": "...",
    "content": "（原始 markdown）",
    "category": "技术",   // 或 null
    "views": 43,           // 已 +1
    "created_at": "..."
  }
}
```
副作用：成功后会**异步 +1 浏览量**（`context.waitUntil`，不阻塞响应）。
错误：
- `400 { success:false, error:"Missing slug parameter" }`
- `404 { success:false, error:"Post not found" }`
- 缓存：`Cache-Control: public, max-age=2`（轻量缓存，配合后台写入）

---

### 1.4 `GET /api/settings` — 读取站点设置
成功响应 200：
```json
{
  "success": true,
  "data": {
    "site_title":    "Quinn's Space",
    "site_subtitle": "...",
    "show_views":    "1",
    "excerpt_length":"200"
  }
}
```
- 缓存：`Cache-Control: no-store`（保存后立即生效）
- DB 中不存在的 key 不会出现在 `data` 中

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
  "excerpt_length": "300"     // 0-1000 整数，0 表示关闭摘要
}
```
- 每个字段独立校验；非法值**静默跳过**，不阻断其他字段写入
- 空字符串也跳过
- 写入采用 `INSERT ... ON CONFLICT(key) DO UPDATE`，可重复保存

成功响应 200：`{ "success": true, "message": "已更新 N 项配置" }`

---

### 2.2 `POST /api/push` — 新建文章
请求体：
```json
{
  "title":    "必填",
  "slug":     "必填，会被 toLowerCase()",
  "content":  "必填，markdown",
  "category": "可选，默认 '未分类'"
}
```
成功响应 200：`{ "success": true, "message": "Post saved to D1 successfully" }`
错误：
- `400 { success:false, error:"Title, slug and content are required" }`
- `400 { success:false, error:"The slug already exists" }`（slug 唯一约束冲突）
- `500 { success:false, error:err.message }`

---

### 2.3 `POST /api/update` — 更新文章
请求体：
```json
{
  "id":       1,           // 必填
  "title":    "...",
  "slug":     "...",
  "content":  "...",
  "category": "..."
}
```
成功响应 200：`{ "success": true, "message": "文章已更新" }`
错误：
- `400` 缺字段 / slug 被占
- `404 { success:false, error:"未找到该文章，可能已被删除" }`（基于 `meta.changes === 0`）

---

### 2.4 `POST /api/delete` — 删除文章
请求体：
```json
{ "id": 1 }
```
成功响应 200：`{ "success": true, "message": "文章已删除" }`
错误：`404 { success:false, error:"未找到该文章" }`（基于 `meta.changes === 0`）

---

### 2.5 `GET /api/user` — 取当前账户信息
成功响应 200：
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "admin",
    "nickname": "Admin",
    "created_at": "..."
  }
}
```
> 不返回 `password_hash`。
> token 不匹配时返 `401 { success:false, error:"口令失效，请重新登录" }`。

---

### 2.6 `POST /api/user/update` — 改用户名 / 昵称 / 密码
请求体（任选）：
```json
{
  "username": "新用户名（可选）",
  "nickname": "新昵称（可选，null 表示清空）",
  "password": "新密码（可选，传入即触发改密并轮换 token）"
}
```
- 用户名不能为空字符串
- 改密时 token 会变（`newHash` = `SHA-256(newPassword)`），响应里 `newToken` 字段必须写回 localStorage
- 至少传一个字段，否则返 `400 "没有任何修改"`
- **此接口禁止使用 API_TOKEN**，否则返回 `403`

成功响应 200：
```json
{ "success": true, "message": "账户信息已更新", "newToken": "..." /* 改密时才有 */ }
```
错误：
- `400` 用户名为空 / 无修改 / username 已被占用
- `401` token 失效
- `403` 使用了 API_TOKEN

---

## 3. 完整 curl 测试脚本

```bash
# 0) API_TOKEN 方式（KV 中存储的纯文本密钥，所有受保护接口均可使用，除 /api/user/update）
API_TOKEN="MySecretToken2026"

# 1) 登录拿 token
TOKEN=$(curl -s -X POST https://YOUR-DOMAIN/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2) 公开读
curl -s https://YOUR-DOMAIN/api/list
curl -s "https://YOUR-DOMAIN/api/get?slug=d1-blog-guide"

# 3) 写接口（支持两种鉴权方式）
# 3.1) 使用登录 token
curl -s -X POST https://YOUR-DOMAIN/api/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"测试","slug":"test-1","content":"# hi","category":"技术"}'

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

# 4) 设置（支持 API_TOKEN）
curl -s -X POST https://YOUR-DOMAIN/api/settings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"site_title":"新标题","excerpt_length":"300"}'

# 5) 账户
curl -s https://YOUR-DOMAIN/api/user -H "Authorization: Bearer $API_TOKEN"
# 注意：修改账户信息禁止使用 API_TOKEN
curl -s -X POST https://YOUR-DOMAIN/api/user/update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"nickname":"新昵称"}'  # 返回 403
```

---

## 4. 数据表速查

```sql
-- 用户
users(id, username UNIQUE, password_hash, nickname, avatar, created_at)

-- 文章
posts(id, title, slug UNIQUE, content, category, views, status, author_id, created_at, updated_at)

-- 站点设置（key-value）
site_settings(key PK, value, updated_at)
```

允许的设置 key：`site_title` / `site_subtitle` / `show_views` / `excerpt_length`

---

## 5. 已知设计取舍

| 项 | 当前设计 | 影响 |
|---|---|---|
| Token = `password_hash` | 单用户系统、零依赖、改密即吊销 | 无过期；DB 脱裤后 token 仍可长期使用（建议未来引入 `sessions` 表） |
| 摘要 = 服务端现场算 | 摘要按当前 `excerpt_length` 实时截取 | `/api/list` 关掉缓存（`no-store`）以保证设置变更立即生效 |
| `category = null` 归一化 | 公开读接口把 `''` / `'未分类'` 都映射成 `null` | 前端只判真值；管理后台仍显示 `未分类` 以便筛未分类文章 |
| 浏览量 +1 异步 | `context.waitUntil` 不阻塞响应 | 极端情况 +1 失败不影响主请求 |

---

> 文档版本：2026-06-11
> 新增：API_TOKEN 鉴权支持（Cloudflare KV）
> 维护者：随源码演进同步更新
