/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩（抄 whale_craft）：**配置、凭证、报告、日志都放插件自己的家** ——
 * `$DSH_HOME/bili-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，凭证路径是
 * `Path(__file__).parent / "bili_credential.json"` —— 所以**运行时要把脚本拷到家目录里再跑**，
 * 这样凭证才会落在家的目录，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * ⭐ 2026-10-16 改：**去掉"峰谷时段"窗口，改成"每天固定一个时刻跑一轮"**。
 *
 * 为什么改：原来的 WINDOWS 是照 DeepSeek 峰谷定价挑的"便宜时段"，但它有三个毛病 ——
 *   ① 一天最多只跑 2 轮，跟"每天固定量"对不上；
 *   ② 宿主（手机上的 dsha）被杀掉就永久错过，**没有补跑**；
 *   ③ 时区靠 `new Date()` 的本地时间，容器/服务器是 UTC 时窗口全错位。
 * 现在只留一个 `runAt`（本地时间 HH:MM）：到点跑；**当天没跑成，当天之内补跑一次**
 *   （所以"没开 dsh 就错过"这件事没有了 —— 只要你当天再打开一次，它就会补上）。
 */

/** 'HH:MM' → 当天的分钟数；非法返回 null */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 现在是不是"到了今天的运行时刻"（过了就算到，用来做补跑） */
export function pastRunAt(now, runAt) {
  const at = minutesOf(runAt)
  if (at === null) return false
  return now.getHours() * 60 + now.getMinutes() >= at
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 首次运行：把 vendored 的 MCP 脚本和值班章程拷进家里（脚本变了就覆盖，章程不覆盖用户改过的） */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const copies = [
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py'), join(stateDir, 'mcp_server.py'), true],
    [join(pluginDir, 'prompts', 'duty.md'), join(stateDir, 'duty.md'), false],
    [join(pluginDir, 'lib', 'asr.py'), join(stateDir, 'asr.py'), true],
  ]
  for (const [from, to, overwrite] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      if (!overwrite && existsSync(to)) continue
      if (overwrite && existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) continue
      copyFileSync(from, to)
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}
