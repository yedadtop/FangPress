// functions/lib/time.js
// 强锁定东八区（上海时区）时间工具

/**
 * 返回当前东八区标准时间字符串
 * 格式：2026-06-13T16:44:21.276+08:00
 * 无论边缘节点处于哪个国家，或者请求源自哪个时区的访客，结果均不受影响
 */
export function nowInShanghai() {
  const now = new Date();

  // 使用 V8 原生国际化能力，强行提取目标时区的时间分量
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const ms = String(now.getMilliseconds()).padStart(3, '0');

  // 拼装出对 SQLite 检索极其友好的标准时区字面量
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}.${ms}+08:00`;
}
