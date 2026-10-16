/**
 * selfcheck.mjs —— 插件的"预检"：**两个半端都在本地真跑一遍**，不靠"重启一次才知道错哪"
 *
 * 为什么要有它（2026-10-14 连栽两次，都是重启后翻 `.dsh-web.err.log` 才发现）：
 *   ① `config` 的值是对象 ⇒ 定时器里 TypeError ⇒ **把整个 dsh 带走**；
 *   ② `parameters.patch` 是 `{ type:'object' }` ⇒ `defineTool` 抛 JsonSchemaError ⇒ **插件整条不激活**。
 *
 * 用法：`node --import ./tools/register.mjs selfcheck.mjs`（解析钩子见 tools/host-resolver.mjs）
 * 退出码：0 = 两个半端都正常；1 = 有问题（宿主里就会 "entry did not activate" / 设置页空白）
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX_HOME = join(tmpdir(), 'dsh-bili-duty-selfcheck')
const fail = (msg, e) => {
  console.error(`\n✗ ${msg}`)
  if (e) console.error(`  ${e?.name}: ${e?.message}`)
  const frame = String(e?.stack ?? '').split('\n').slice(1, 4).join('\n')
  if (frame) console.error(frame)
  process.exit(1)
}

/* ────────────── ① host 半端：假 ctx 上真跑 apply() ────────────── */

let mod
try {
  mod = await import('./index.js')
} catch (e) {
  fail('连 import index.js 都失败（依赖没解析？检查 tools/host-resolver.mjs）', e)
}

const registered = []
const fakeCtx = {
  // ⭐ 宿主给的是**函数**（`dshHomePath(...segments)`），这里照样给函数 —— 别用字符串
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(SANDBOX_HOME, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => { registered.push(t?.name ?? String(t)); return t } },
  webServer: { register: () => ({ dispose() {} }) },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}

try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉就留着 */ }
mkdirSync(SANDBOX_HOME, { recursive: true })

try {
  mod.apply(fakeCtx, {})
} catch (e) {
  fail('host 半端 apply() 抛错了 —— 宿主里就是那句 `warning: 1 entry did not activate`', e)
}
console.log(`✓ host 半端 OK：name=${mod.name}  inject=${JSON.stringify(mod.inject)}  工具 ${registered.length} 个`)
for (const n of registered) console.log(`    - ${n}`)

/* ────────────── ② client 半端：假 window.__ModuleLoader__ 上真跑 factory() ────────────── */

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
let loaded = null
const prevWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
try {
  await import(`./client.js?selfcheck=${Date.now()}`)
} catch (e) {
  globalThis.window = prevWindow
  fail('client.js 一 import 就抛错（浏览器里会是一片空白）', e)
}
globalThis.window = prevWindow

if (!loaded) fail('client.js 没有调用 window.__ModuleLoader__.load({...}) —— 那它不会被挂上')
if (loaded.id !== pkg.name) fail(`client.js 的 id（${loaded.id}）必须等于 package.json 的 name（${pkg.name}）`)
if (typeof loaded.factory !== 'function') fail('client.js 的 load({...}) 里没有 factory 函数')

/**
 * ⚠️ 2026-10-16 教训：这个假 React 原来**什么都不校验**，于是放过了一个真 bug ——
 *   我往 `h('input', { style: 'width:200px' })` 里传了**字符串**，而 React 的
 *   `createElement` 会直接抛错（生产构建里就是 `if (r.style != null && typeof r.style != "object")
 *   throw Error(...)`）。后果是**整个设置页空白**，而 selfcheck 却是绿的 ✗。
 * ⇒ 现在把 React 真正会拒绝的几条**照抄进来**（style 必须是对象、key 要能是字符串…），
 *   让这类错误在预检阶段就现形，不用等重启进浏览器看。
 */
/**
 * 假 React（能驱动 hooks 的最小实现）。
 *
 * ⚠️ 2026-10-16 连栽两次的教训：
 *   ① 原来 `createElement` 只是 `({tag, props})` 打包返回，**从不校验** ⇒
 *      漏掉了「style 传字符串」这个真 bug（React 会 `throw Error`，后果是整页空白）。
 *   ② 改完①还是漏 —— 因为 `Panel` 里 `if (!cfg) return '读设置中…'` 会**提前返回**，
 *      而 cfg 来自 useStatus 的 useEffect；假 useEffect 不跑 ⇒ cfg 永远 null ⇒
 *      整个 UI 树根本没渲染过，后面的 style 也就没机会报错 ✗✗。
 *   ⇒ 现在：`createElement` 照抄 React 的 style 校验；useState 存真值、useEffect 立刻执行
 *      （并喂一份假的 /status 数据），保证渲染走到真正的 UI 树。
 */
let hookCursor = 0
let hookStore = []
const fakeReact = {
  createElement: (...a) => {
    const [tag, props] = a
    if (props && props.style != null && typeof props.style !== 'object') {
      throw new Error(`React 会拒绝这种 style（必须是对象，不能是字符串）：tag=${String(tag)} style=${JSON.stringify(props.style)}`)
    }
    // 像 React 那样：tag 是函数 ⇒ 当成函数组件**真的调用**（组件内部的 h() 才会执行）
    if (typeof tag === 'function') return tag(props || {})
    return { tag, props, children: a.slice(2) }
  },
  useState: (init) => {
    const i = hookCursor++
    // ⭐ 预设值优先：这样 useStatus 那个 hook 能直接拿到假的 /status ⇒ cfg 有值
    //    ⇒ Panel 走过 `if (!cfg)` 的早退，真正的 UI 树才会被渲染出来（bug 才藏不住）
    if (useStatePresets[i] !== undefined) return [useStatePresets[i], () => {}]
    if (hookStore[i] === undefined) hookStore[i] = typeof init === 'function' ? init() : init
    return [hookStore[i], (v) => { hookStore[i] = typeof v === 'function' ? v(hookStore[i]) : v }]
  },
  useEffect: (fn) => { const i = hookCursor++; pendingEffects.push([i, fn]) },
  useRef: (v) => { const i = hookCursor++; if (hookStore[i] === undefined) hookStore[i] = { current: v }; return hookStore[i] },
  useMemo: (f) => f(),
  useCallback: (f) => f,
  Fragment: 'Fragment',
}
const pendingEffects = []
/** 按 hook 下标预设 useState 的返回值（第 0 个 = useStatus 的 st） */
const useStatePresets = {}
/** 重置 hooks（每次重新渲染一个组件前调用） */
const resetHooks = () => { hookCursor = 0; hookStore = []; pendingEffects.length = 0 }
let clientMod
try {
  clientMod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`client.js require 了没预料到的包：${name}`)
  })
} catch (e) {
  fail('client.js 的 factory(require) 抛错', e)
}
if (typeof clientMod?.apply !== 'function') fail('client.js 的 factory 必须返回带 apply() 的对象')

// 真调一次 apply（假 DOM + 假 slots），把拼错的名字、漏掉的 ctx 方法都逼出来
const slotsReg = []
const styleNodes = []
const prevDoc = globalThis.document
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild: (n) => styleNodes.push(n) },
}
try {
  clientMod.apply({
    effect: (fn) => { try { return fn() } catch { return undefined } },
    slots: {
      inject: (name, fn) => { fn() },
      register: (opts, Component) => { slotsReg.push({ ...opts, hasComponent: typeof Component === 'function', Component }); return {} },
    },
  })
} catch (e) {
  globalThis.document = prevDoc
  fail('client.js 的 apply(ctx) 抛错', e)
}
globalThis.document = prevDoc

if (!slotsReg.length) fail('client.js 的 apply 没有往任何 slot 注册组件')
if (!styleNodes.length) fail('client.js 的 apply 没有把样式挂上（页面会没样子）')

// ⭐ 2026-10-16 加：**真把注册的组件渲染一遍**。
//    原来只检查 `typeof Component === 'function'`，从不调用 —— 于是
//    「组件一渲染就抛错（整页空白）」这类问题预检完全看不见 ✗。
//    这里真调一次，把 createElement 层面的错误（比如 style 传字符串）逼出来。
// 假 /status：让 Panel 走过 `if (!cfg)` 那道早退，真正渲染出 UI 树
const fakeStatus = {
  ok: true, home: '/tmp/fake-home', today: '2026-10-16', ranToday: false, perDay: 5,
  // ⚠️ 2026-10-16：这些开关**必须全开**，否则折叠分支（`sw(k) ? … : null`）不渲染，
  //    藏在里面的错误就抓不到 —— 我就是这么漏掉「style 传字符串」那个 bug 的。
  autoRun: true, runAt: '09:00', autoComment: true, transcribe: true, loggedIn: true,
  replyToComments: true,
  venvReady: false, installing: false, version: '0.0.0', report: '/tmp/fake-home/out/x.md',
  log: '/tmp/fake-home/duty.log', installLog: '/tmp/fake-home/install.log',
  installTail: 'some log tail', asrTail: 'asr tail', installing: false, asrInstalling: false,
  config: {
    perDay: 5, autoRun: true, runAt: '09:00', autoComment: true, transcribe: true, asrModel: 'small',
    commentPerRound: 1, mentionName: '某人', keywords: ['a'], pythonPath: 'python', dshBin: '',
    headlessProfile: 'headless', llmProvider: 'p', llmModel: 'm', llmReasoningEffort: 'high',
    overlayMcp: true, workspace: '', reportLevel: 'full', replyToComments: true, replyPerRound: 1,
  },
}
const prevFetch = globalThis.fetch
const prevSetInterval = globalThis.setInterval
globalThis.fetch = async () => ({ json: async () => fakeStatus })
// 组件里有 5 秒轮询；真 setInterval 会让 node 一直挂着不退出 ⇒ 预检时换成 no-op
globalThis.setInterval = () => 0

for (const s of slotsReg) {
  if (typeof s.Component !== 'function') continue
  try {
    // 第 1 遍：跑 useState/useEffect（effect 会 fetch /status 把 cfg 填上）
    resetHooks()
    s.Component({})
    for (const [, fn] of pendingEffects) { try { fn() } catch { /* effect 里的错不拦 */ } }
    await new Promise((r) => setTimeout(r, 0))

    // ⭐ 第 2 遍：**把 st 预设成假 /status**，让 cfg 有值 ⇒ 走过 `if (!cfg)` 早退，
    //    真正渲染出完整 UI 树。这是唯一能让「组件一渲染就抛错」现形的办法 ——
    //    之前两版漏掉这个 bug，就是因为 cfg 一直是 null、UI 树压根没渲染 ✗✗。
    useStatePresets[0] = fakeStatus
    resetHooks()
    const tree = s.Component({})
    if (tree === undefined) fail(`slot ${s.name} 的组件渲染返回 undefined —— 界面会是空的`)

    // ⭐ 第 3 遍：把折叠开关**全打开**再渲染一次（style 那种错误常常藏在
    //    `sw(k) ? … : null` 的分支里，开关关着就永远走不到）
    useStatePresets[0] = { ...fakeStatus, autoRun: true, autoComment: true, transcribe: true, replyToComments: true, loggedIn: true, venvReady: true,
      config: { ...fakeStatus.config, autoRun: true, autoComment: true, transcribe: true, replyToComments: true, mentionName: '某人', llmProvider: 'p', llmModel: 'm', llmReasoningEffort: 'high' } }
    resetHooks()
    const tree2 = s.Component({})
    if (tree2 === undefined) fail(`slot ${s.name} 的组件（开关全开）渲染返回 undefined`)
    delete useStatePresets[0]
  } catch (e) {
    fail(`slot ${s.name} 的组件一渲染就抛错（浏览器里就是整页空白）`, e)
  }
}
globalThis.fetch = prevFetch
globalThis.setInterval = prevSetInterval
console.log(`✓ client 半端 OK：id=${loaded.id}  注入=${JSON.stringify(clientMod.inject)}`)
for (const s of slotsReg) console.log(`    slot ${s.name}  id=${s.id}  order=${s.order}  组件=${s.hasComponent ? '有' : '无 ✗'}`)

try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 留着也无所谓 */ }
console.log(`\n（预检不碰真家目录：host 用 ${SANDBOX_HOME}）`)
