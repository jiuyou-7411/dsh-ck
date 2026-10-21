// 验证「打出来的 tgz 装上去真能用」：把 tgz 当成真实 npm 包装进空目录，再按宿主的方式 boot 一遍。
//
// 用法：npm run verify:pack（会先 npm run pack，再跑这个）
// 产物目录 .tmp-verify/ 每次重建，跑完自动删。
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = join(root, '.tmp-verify', 'app')

const tarballs = (await readdir(root)).filter((name) => name.endsWith('.tgz')).sort()
const tgz = tarballs.pop()
if (tgz === undefined) throw new Error('没有找到 .tgz，先 npm run pack')
if (tarballs.length > 0) console.log(`[verify] 目录里有多个 tgz，只验最新的 ${tgz}`)

await rm(join(root, '.tmp-verify'), { recursive: true, force: true })
await mkdir(sandbox, { recursive: true })
await writeFile(join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox', private: true, type: 'module' }, null, 2))

console.log(`[verify] 安装 ${tgz} …`)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['install', join(root, tgz), '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: sandbox,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

const installed = join(sandbox, 'node_modules', 'dsh-skill-mcp-vault')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// —— 1. 包结构 ——
const files = await readdir(installed, { recursive: true })
const has = (suffix) => files.some((path) => path.split('\\').join('/').endsWith(suffix))
check('lib/index.js 存在', has('lib/index.js'))
check('lib/client.js 存在', has('lib/client.js'))
check('mcp/mcp.json 存在', has('mcp/mcp.json'))
check('cordis.patch.yml 存在', has('cordis.patch.yml'))
check('没有 src/ 与 scripts/', !files.some((path) => /(^|[\\/])(src|scripts)[\\/]/.test(path)))
check('没有 .trash / .backups', !files.some((path) => /(^|[\\/])\.(trash|backups)([\\/]|$)/.test(path)))

// —— 2. 包元信息 ——
const pkg = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
check('version 与文件名一致', tgz.includes(pkg.version), `${pkg.name}@${pkg.version}`)
check('没有 devDependencies', pkg.devDependencies === undefined)
check('fflate 是运行依赖', Boolean(pkg.dependencies?.fflate))
check('primitives 是 optional peer', pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-client-ui-primitives']?.optional === true)

// —— 3. 分发的 MCP 清单是空的（不夹带作者自己的服务）——
const shipped = JSON.parse(await readFile(join(installed, 'mcp', 'mcp.json'), 'utf8'))
check('分发的 mcp.json 为空仓库', Array.isArray(shipped.servers) && shipped.servers.length === 0, `servers=${shipped.servers?.length}`)

// —— 4. client.js 是 ModuleLoader 产物 ——
const client = await readFile(join(installed, 'lib', 'client.js'), 'utf8')
check('client.js 带 ModuleLoader banner', client.startsWith('window.__ModuleLoader__.load('), `${client.length} bytes`)

// —— 5. 真 boot 一次 ——
const mod = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
check('导出 name', mod.name === 'dsh-skill-mcp-vault')
check('导出 apply', typeof mod.apply === 'function')
check('inject 含 tools/skills', Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('skills'))

const routes = []
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  effect(fn) { disposers.push(fn()) },
  inject(deps, cb) {
    if (deps.includes('webServer')) cb({ webServer: { register(route) { routes.push(route) } } })
    // loader 故意不给：模拟「没有 MCP 行」的 profile，确认不炸
  },
  // 宿主的 ctx.get 永远存在；refreshRowStatus() 用它查 tools 来算「连上了没」
  get(service) {
    if (service === 'tools') return { schemas: () => [] }
    return undefined
  },
  tools: { register() {} },
  skills: { registerProvider() {} },
  on() {},
}
mod.apply(ctx, {})

const route = routes.find((item) => item.path === '/dsh-skill-mcp-vault/api')
check('注册了 web 路由', route !== undefined, `routes=${routes.map((item) => item.path).join(',')}`)
if (route === undefined) {
  console.log('\n[verify] 没有 web 路由，后面的接口检查跳过')
  process.exit(1)
}

const handler = route.handler
async function call(path, method = 'GET', body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: `/dsh-skill-mcp-vault/api/${path}`,
    headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
    on(event, fn) {
      if (event === 'data') fn(Buffer.from(payload))
      if (event === 'end') fn()
    },
    destroy() {},
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { text = chunk === undefined ? '' : chunk.toString() },
  }
  await handler(req, res)
  return { status, json: text === '' ? null : JSON.parse(text) }
}

const skills = await call('skills')
check('GET /skills 200', skills.status === 200, `status=${skills.status}`)

const info = await call('info')
check('GET /info 200', info.status === 200 && info.json?.version === pkg.version, `status=${info.status} version=${info.json?.version}`)

const mcpList = await call('mcp')
check('GET /mcp 200 且仓库为空', mcpList.status === 200 && Array.isArray(mcpList.json?.servers) && mcpList.json.servers.length === 0, `status=${mcpList.status} servers=${mcpList.json?.servers?.length}`)

// 这条要联网抓 GitHub；断网时会失败，属于环境问题
const inspect = await call('mcp/inspect', 'POST', { url: 'modelcontextprotocol/servers' })
check('POST /mcp/inspect 能识别仓库', inspect.status === 200 && typeof inspect.json?.command === 'string', `status=${inspect.status} ${inspect.json?.command ?? inspect.json?.error}`)

// 新建技能：确认包目录可写、会自动建 skills/
const created = await call('skill', 'POST', { name: 'verify-skill', description: '装完就能写', content: '# verify\n\n装完就能写。\n' })
check('POST /skill 能新建（自动建目录）', created.status === 200 && created.json?.ok !== false, `status=${created.status}`)
const skillFile = join(installed, 'skills', 'verify-skill', 'SKILL.md')
check('技能文件真的落盘', await stat(skillFile).then(() => true).catch(() => false), 'skills/verify-skill/SKILL.md')

for (const dispose of disposers) { try { dispose?.() } catch {} }
await rm(join(root, '.tmp-verify'), { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log('')
console.log(`[verify] ${results.length - failed.length}/${results.length} PASS`)
if (failed.length > 0) {
  console.log('[verify] 失败：', failed.map((item) => item.name).join(' | '))
  process.exit(1)
}
