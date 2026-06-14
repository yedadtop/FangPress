// functions/lib/time.js
// 强锁定东八区（上海时区）时间工具
// 设计目标：仅影响新数据，历史 UTC 时间戳原样不动

/**
 * 返回当前东八区标准时间字符串
 * 格式：2026-06-13T16:44:21.276+08:00
 * 无论边缘节点处于哪个国家，或者请求源自哪个时区的访客，结果均不受影响
 *
 * 修复点：
 *  1. locale 用 'en-CA'（永远只输出 ASCII 数字 0-9）
 *  2. 显式 hourCycle: 'h23'，锁死 00-23，避免 'zh-CN' 在 hour12:false
 *     时的潜在 24:00 输出
 *  3. try-catch 兜底，Intl 异常时退回到 +8h 偏移
 */
export function nowInShanghai() {
  const now = new Date();

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      hourCycle: 'h23'  // 显式锁定 00-23，避免 '24:00' 边界 bug
    });

    const parts = formatter.formatToParts(now);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));

    // 防御：如果 V8 没返回某个分量，直接抛错走兜底
    if (!map.year || !map.month || !map.day || !map.hour || !map.minute || !map.second) {
      throw new Error(`Incomplete Intl parts: ${JSON.stringify(map)}`);
    }

    // 毫秒分量 Intl 无法直接出，用 Date.getMilliseconds() 即可（时区无关）
    const ms = String(now.getMilliseconds()).padStart(3, '0');

    const out = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}.${ms}+08:00`;

    // ⚡ 修复：移除生产环境 console.log，避免 Cloudflare Workers 按量计费的日志里
    //   被这条调试信息刷屏（settings / navs / site_settings 每次写入都会调用一次）。
    return out;
  } catch (err) {
    // 兜底：Intl 不可用时退回到简单的 +8h 偏移，保证写入不中断
    console.error('[time] Intl failed, fallback to +8h shift:', err);
    return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
  }
}
