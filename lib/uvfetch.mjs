/**
 * lib/uvfetch.mjs —— 「机器上连 uv 和 Python 都没有」时，**插件自己把 uv 弄到手**
 * ============================================================================
 * 为什么值得单独做：uv 是**单个可执行文件**（Windows 上 ~32MB 的 uv.exe ✓），
 * **解压就能用、不用管理员、不用进 PATH** ✓，而且它还能自己把 Python 拉下来 ✓
 * ⇒ 只要拿到它，"首次安装"就从「先去装个 Python」变成「点一下就好」✓
 *
 * 两个源，按顺序试：
 *   ① **GitHub 官方 release**（`uv-x86_64-pc-windows-msvc.zip`）—— 有加速器时最快 ✓
 *   ② ⭐ **PyPI 清华镜像的 uv wheel** —— wheel 本身就是个 zip，里面装着 `uv.exe` ✓
 *      （国内速度快、不依赖 GitHub ✓）
 *
 * 解压：优先用 **系统自带的 `tar`**（Windows 10+ 的 bsdtar 能直接读 zip ✓），
 *       再退到 `unzip`；然后**在解压出来的整棵树里按文件名找** ✓
 *       —— 不管官方把它放在哪一层都能找着 ✓
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * uv 官方 release 的资产名 —— ⭐ 必须按 **架构** 选，不能写死 x86_64。
 *
 * 🔴 2026-10-16 修的坑（在 arm64 手机上实测）：
 *   原来 `linux` 只有一条 `uv-x86_64-unknown-linux-gnu.tar.gz`，于是在 aarch64 上会
 *   下一个 x86_64 的二进制；文件能下、能解压、**但根本跑不起来**
 *   （`cannot execute: required file not found`，因为内核找不到 x86_64 的加载器）。
 *   更糟的是下面的"版本检查"只打日志、不拦 ⇒ ensureUv 照样返回那个跑不起来的路径，
 *   后面每一步都拿它失败，还跳过了 `python -m venv` 的兜底。
 *   ⇒ 现在：① 按 process.arch 选对资产；② **跑不起来就换下一个源**，绝不返回废文件。
 *
 * 架构名映射：process.arch → uv 的 target triple 片段
 *   x64   → x86_64       arm64 → aarch64
 *   arm   → armv7        ia32  → i686（uv 对 32 位 Windows 没有资产）
 */
const LINUX_TARGETS = {
  x64: 'x86_64-unknown-linux-gnu',
  arm64: 'aarch64-unknown-linux-gnu',
  arm: 'armv7-unknown-linux-gnueabihf',
  ia32: 'i686-unknown-linux-gnu',
  ppc64: 'powerpc64le-unknown-linux-gnu',
  s390x: 's390x-unknown-linux-gnu',
  riscv64: 'riscv64gc-unknown-linux-gnu',
}
const DARWIN_TARGETS = { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' }

/** 按平台+架构挑 uv 的资产名；挑不到返回 null（调用方会退到 PyPI 兜底） */
export function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    // uv 在 Windows 上只发 x86_64 与 aarch64（32 位没有）
    if (arch === 'arm64') return { name: 'uv-aarch64-pc-windows-msvc.zip', bin: 'uv.exe' }
    if (arch === 'x64' || arch === 'ia32') return { name: 'uv-x86_64-pc-windows-msvc.zip', bin: 'uv.exe' }
    return null
  }
  if (platform === 'darwin') {
    const t = DARWIN_TARGETS[arch]
    return t ? { name: `uv-${t}.tar.gz`, bin: 'uv' } : null
  }
  // 其它都按 linux 处理（含 android/proot 这种报 linux 的）
  const t = LINUX_TARGETS[arch] || LINUX_TARGETS.x64
  return { name: `uv-${t}.tar.gz`, bin: 'uv' }
}

/**
 * 从 wheel 文件名判断它是不是当前架构能用的。
 *
 * ⚠️ 不能只做"结尾匹配"：uv 的 wheel 常带**多个平台标签**，例如
 *   uv-0.2.33-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl
 *   结尾是 musllinux_1_1_aarch64 —— 只认 manylinux…aarch64$ 会漏掉它（2026-10-16 实测踩到）。
 * 现在改成：必须 .whl 结尾 + 含该架构 token + 含该系统特征串。
 *   linux  → 名字里要有 linux（manylinux / musllinux 都含）
 *   darwin → 名字里要有 macosx
 *   win32  → 名字里要有 win_amd64 / win_arm64
 */
const ARCH_TOKEN = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7l', ia32: 'i686', ppc64: 'ppc64le', s390x: 's390x', riscv64: 'riscv64' }

export function wheelMatches(filename, platform = process.platform, arch = process.arch) {
  const n = String(filename)
  if (!n.endsWith('.whl')) return false
  if (platform === 'win32') return n.includes(arch === 'arm64' ? 'win_arm64' : 'win_amd64')
  const token = ARCH_TOKEN[arch]
  if (!token) return false
  if (platform === 'darwin') {
    const want = arch === 'arm64' ? 'arm64' : token      // macOS 的 arm64 标签就叫 arm64
    return n.includes('macosx') && n.includes(want)
  }
  return n.includes('linux') && n.includes(token)         // manylinux / musllinux 都含 linux
}

/** 从 PyPI 的 uv json 里挑出**当前架构**的最新 wheel（挑不到返回 null） */
export function pypiWheelFor(j, platform = process.platform, arch = process.arch) {
  const verOf = (name) => {
    const m = /-([0-9][0-9A-Za-z.+-]*?)-py3-none-/.exec(String(name))
    return m ? m[1] : '0.0.0'
  }
  const cmpVer = (x, y) => {
    const A = verOf(x).split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
    const B = verOf(y).split(/[.+-]/).map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < 4; i++) { if ((A[i] || 0) !== (B[i] || 0)) return (B[i] || 0) - (A[i] || 0) }
    return 0
  }
  // ⚠️ PyPI 的 urls 顺序**不保证最新在前** ⇒ 必须按版本号自己排序挑最新（踩过：取到了 0.2.33 的老版本 ✗）
  return (j.urls || [])
    .filter((u) => wheelMatches(u.filename, platform, arch))
    .sort((x, y) => cmpVer(x.filename, y.filename))[0] || null
}

/** 算一个文件的 sha256 */
function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 取"官方期望的 sha256"：
 *   · PyPI wheel：JSON 里自带 `digests.sha256` ✓
 *   · GitHub 资产：同目录下有一份 `<文件名>.sha256` ✓（代理会一起转 ✓）
 * 取不到就返回 null（那时只记一句"未校验"，不拦着）
 */
async function expectedSha(source) {
  if (source.sha) return String(source.sha).toLowerCase()
  try {
    const r = await fetch(source.url + '.sha256')
    if (!r.ok) return null
    const m = /([0-9a-f]{64})/i.exec(await r.text())
    return m ? m[1].toLowerCase() : null
  } catch { return null }
}

/** 在目录树里按文件名找可执行文件（递归） */
export function findBin(name, dir) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { const hit = findBin(name, p); if (hit) return hit }
    else if (e.name === name) return p
  }
  return null
}

/**
 * 解压一个压缩包并找出目标文件。
 *
 * 🔴 2026-10-16 修的坑：原版只试 `tar` 和 `unzip`。
 *   · Windows 10+ 的 bsdtar 能读 zip ✓
 *   · 但 **Linux 上的 GNU tar 读不了 zip**，而很多精简系统（包括手机上的这个容器）
 *     **没有 unzip** ⇒ PyPI 兜底给的那个 `.whl`（本质是 zip）**根本解不开** ✗
 *   现在补两条兜底：`python3 -m zipfile`（有 Python 就一定有）和 `busybox unzip`。
 *   顺序仍然让 `tar` 打头（Windows 上它最快、也最稳）。
 */
export function extractArchive(binName, archive, into) {
  const attempts = [
    ['tar', ['-xf', archive, '-C', into]],
    ['unzip', ['-o', archive, '-d', into]],
    ['busybox', ['unzip', '-o', archive, '-d', into]],
    // ⭐ Python 的 zipfile 是 zip/wheel 的万能兜底（wheel 就是 zip）
    [process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipfile', '-e', archive, into]],
    ['python', ['-m', 'zipfile', '-e', archive, into]],
  ]
  for (const [cmd, args] of attempts) {
    try {
      const r = spawnSync(cmd, args, { stdio: 'ignore' })
      if (r.status === 0) { const hit = findBin(binName, into); if (hit) return hit }
    } catch { /* 换下一个工具 */ }
  }
  return null
}

/**
 * 确保家目录里有一份可用的 uv，返回它的路径（拿不到就返回 null）。
 * @param {{ dir: string, log?: (m: string) => void }} opts
 */
export async function ensureUv({ dir, log = () => {} }) {
  const a = assetFor()
  const bin = a?.bin || (process.platform === 'win32' ? 'uv.exe' : 'uv')
  const target = join(dir, bin)
  // ⭐ 已存在也要**验一下能不能跑**：不能因为文件在就直接信它。
  //    （2026-10-16：老版本会先下一个架构不对的 uv，修好之后如果还认那个废文件，
  //     用户的机器就永远卡在"装依赖失败"上 ⇒ 坏的就删掉、重新下。）
  if (existsSync(target)) {
    let usable = false
    try { usable = spawnSync(target, ['--version'], { stdio: 'ignore' }).status === 0 } catch { usable = false }
    if (usable) return target
    log(`家目录里那份 uv 跑不起来（大概是以前下错的架构）⇒ 删掉重下：${target}`)
    try { rmSync(target, { force: true }) } catch { /* 删不掉就走下面的下载，最后会覆盖 */ }
  }

  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '_tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  log(`准备 uv：${process.platform}/${process.arch}` + (a ? ` → ${a.name}` : '（没有对应的官方资产，只用 PyPI 兜底）'))

  // 源按顺序试：直连 → 两个国内能用的 GitHub 加速代理 → PyPI 镜像的 uv wheel 兜底
  const sources = []
  if (a) {
    const asset = `https://github.com/astral-sh/uv/releases/latest/download/${a.name}`
    sources.push(
      { label: 'GitHub 直连', url: asset, file: join(tmp, a.name) },
      { label: 'GitHub 加速代理 gh-proxy.com', url: `https://gh-proxy.com/${asset}`, file: join(tmp, a.name) },
      { label: 'GitHub 加速代理 ghproxy.net', url: `https://ghproxy.net/${asset}`, file: join(tmp, a.name) },
    )
  }
  // ⭐ PyPI 兜底：**所有平台**都加（原来只在 Windows 上加 ⇒ 别的平台少一条路）。
  //    它停在 0.2.33，但 wheel 里就是官方编译的 uv，能用。
  try {
    const r = await fetch('https://pypi.tuna.tsinghua.edu.cn/pypi/uv/json')
    const j = await r.json()
    const w = pypiWheelFor(j)
    if (w?.url) {
      sources.push({ label: 'PyPI 清华镜像（uv wheel）', url: w.url, file: join(tmp, String(w.filename)), sha: w.digests?.sha256 })
      log(`  （PyPI 兜底已就绪：${w.filename}）`)
    } else {
      log('  （PyPI 上没有这个架构的 uv wheel）')
    }
  } catch (e) {
    log(`  列 PyPI 版本时出错（不影响，继续试别的源）：${e?.message ?? e}`)
  }

  if (!sources.length) { rmSync(tmp, { recursive: true, force: true }); return null }

  for (const s of sources) {
    try {
      log(`正在下载 uv —— ${s.label}`)
      const res = await fetch(s.url)
      if (!res.ok) { log(`  → 返回 ${res.status}，换下一个源`); continue }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(s.file))
      const mb = (statSync(s.file).size / 1048576).toFixed(1)
      log(`  → 下载完成 ${mb} MB`)
      // ⭐ 完整性校验：下载下来是要**被执行**的，必须跟官方 sha256 对上（防的是第三方代理动过包 ✗）
      const want = await expectedSha(s)
      if (want) {
        const gotSha = sha256Of(s.file)
        if (gotSha !== want) {
          log(`  → ⚠️ sha256 校验不过（期望 ${want.slice(0, 12)}… 实际 ${gotSha.slice(0, 12)}…）⇒ 丢弃这个源`)
          continue
        }
        log('  → 官方 sha256 校验通过 ✓')
      } else {
        log('  → 没取到官方 sha256，跳过校验（下载来自 HTTPS 的官方地址时风险很小）')
      }
      log('  → 开始解压')
      const hit = extractArchive(bin, s.file, tmp)
      if (!hit) { log('  → 解压后没找到可执行文件，换下一个源'); continue }
      copyFileSync(hit, target)
      try { chmodSync(target, 0o755) } catch { /* Windows 上不需要 */ }
      // 🔴 这里是原版的漏洞：以前只**打日志**，跑不起来也照样 return target
      //    ⇒ 后面每一步都拿着一个废二进制失败。现在：跑不起来就换下一个源。
      let ok = false
      try {
        const r = spawnSync(target, ['--version'], { stdio: 'ignore' })
        ok = r.status === 0
      } catch { ok = false }
      if (!ok) {
        log('  → ⚠️ 版本检查：跑不起来 ✗（架构不对？）⇒ 丢弃这个源，换下一个')
        try { rmSync(target, { force: true }) } catch { /* 删不掉也无所谓 */ }
        continue
      }
      log('  → 版本检查：能跑 ✓')
      rmSync(tmp, { recursive: true, force: true })
      log(`  → uv 已就位：${target}`)
      return target
    } catch (e) {
      log(`  → ${s.label} 失败：${e?.message ?? e}`)
    }
  }

  rmSync(tmp, { recursive: true, force: true })
  log('所有源都拿不到能跑的 uv（大概是网络到不了 GitHub / PyPI 镜像）')
  return null
}
