// functions/lib/time.js
// 上海时区时间工具（UTC+8）
// 设计目标：仅影响新数据，历史 UTC 时间戳原样不动

/**
 * 返回当前时间，格式为 ISO 8601 + 上海时区偏移
 * 例：new Date("2026-06-13T05:42:21.276Z") → "2026-06-13T13:42:21.276+08:00"
 *
 * 实现思路：取 now + 8h，调用 toISOString() 得到形如 "...Z" 的串，
 *          再把末尾的 Z 替换为 "+08:00"。表达的是"同一瞬间"，
 *          只是把表示时区的 Z 换成了 +08:00。
 */
export function nowInShanghai() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
}
