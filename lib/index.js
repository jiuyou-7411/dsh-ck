/**
 * dsh-skill-mcp-vault — a repository plugin for skills and MCP servers.
 *
 * Everything the vault stores lives inside this package:
 *
 *   skills/<name>/SKILL.md   one directory per skill (or a flat <name>.md)
 *   mcp/mcp.json             the MCP server catalogue
 *
 * On activation the host half:
 *   1. registers one `ctx.skills` provider that reads `skills/` from disk on
 *      every discovery, so a new or edited skill is live without a reload;
 *   2. replaces the disabled `skill-mcp-vault-mcp` placeholder row with one
 *      `@deepseek-ai/dsh-mcp-client` row per catalogue entry, then drops the
 *      placeholder — the client only accepts servers declared at row creation,
 *      so a catalogue change reloads exactly that one row.
 *
 * Both operations are exposed to the agent through the `skill_vault` and
 * `mcp_vault` tools, and to the Web UI through `/dsh-skill-mcp-vault/api`.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, zipSync } from 'fflate'
import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 技能管理器的宿主原样内置：/api/dsh-skills-manager/* 由本插件挂载，
// 技能页因此不再依赖单独安装的 @michengai/dsh-skills-manager。
import * as skillsManagerHost from '../vendor/skills-manager/index.js'

/** Package root: `lib/` sits one level below it. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILLS_ROOT = join(PACKAGE_ROOT, 'skills')
const MCP_ROOT = join(PACKAGE_ROOT, 'mcp')
const MCP_FILE = join(MCP_ROOT, 'mcp.json')
const MCP_BACKUP_DIR = join(MCP_ROOT, '.backups')
const SKILL_BACKUP_DIR = join(SKILLS_ROOT, '.backups')

const VAULT_ROW_PREFIX = 'skill-mcp-vault-mcp--'
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * Skill roots this vault shows besides its own `skills/` directory. Each is a
 * folder other agents keep their global skills in, so one page can account for
 * every skill on the machine.
 */
const SKILL_SOURCES = [
  { id: 'vault', label: '仓库', file: '', brand: 'vault' },
  { id: 'dsh', label: 'DSH', file: '.dsh/skills', brand: 'dsh' },
  { id: 'agents', label: '公共 Agent', file: '.agents/skills', brand: 'agents' },
  { id: 'claude', label: 'Claude Code', file: '.claude/skills', brand: 'claude' },
  { id: 'codex', label: 'Codex', file: '.codex/skills', brand: 'codex' },
  { id: 'windsurf', label: 'Windsurf', file: '.codeium/windsurf/skills', brand: 'windsurf' },
  { id: 'trae', label: 'Trae', file: '.trae/skills', brand: 'trae' },
  { id: 'trae-cn', label: 'Trae 国内版', file: '.trae-cn/skills', brand: 'trae' },
  { id: 'openclaw', label: 'OpenClaw', file: '.openclaw/skills', brand: 'openclaw' },
  { id: 'workbuddy', label: 'WorkBuddy', file: '.workbuddy/skills', brand: 'workbuddy' },
]

/** Per-workspace skill folders shown under 项目技能. */
const PROJECT_SKILL_DIRS = [
  { id: 'dsh', label: '项目技能', file: join('.dsh', 'skills'), brand: 'dsh' },
  { id: 'skills', label: 'skills/', file: 'skills', brand: 'vault' },
  { id: 'agents', label: '.agents', file: join('.agents', 'skills'), brand: 'agents' },
  { id: 'claude', label: '.claude', file: join('.claude', 'skills'), brand: 'claude' },
]

/** Resolve one source's absolute directory. */
function skillSourceDir(source) {
  return source.id === 'vault' ? SKILLS_ROOT : join(homedir(), source.file)
}

/**
 * One global MCP source: another agent's own configuration file, or the DSH
 * profiles themselves. Reading them is how a server that already exists
 * elsewhere becomes visible in this vault.
 */
const MCP_SOURCES = [
  { id: 'dsh', label: 'DSH', kind: 'dsh', detail: '~/.dsh/profiles/*/cordis.yml' },
  { id: 'claude', label: 'Claude Code', kind: 'json', file: '.claude.json', keys: ['mcpServers'] },
  { id: 'claude-settings', label: 'Claude 设置', kind: 'json', file: '.claude/settings.json', keys: ['mcpServers'] },
  { id: 'cursor', label: 'Cursor', kind: 'json', file: '.cursor/mcp.json', keys: ['mcpServers'] },
  { id: 'gemini', label: 'Gemini CLI', kind: 'json', file: '.gemini/settings.json', keys: ['mcpServers'] },
  { id: 'codex', label: 'Codex', kind: 'toml', file: '.codex/config.toml', keys: ['mcp_servers'] },
  { id: 'windsurf', label: 'Windsurf', kind: 'json', file: '.codeium/windsurf/mcp_config.json', keys: ['mcpServers'] },
  { id: 'trae', label: 'Trae', kind: 'json', file: '.trae/mcp.json', keys: ['mcpServers'] },
  { id: 'trae-cn', label: 'Trae 国内版', kind: 'json', file: '.trae-cn/mcp.json', keys: ['mcpServers'] },
  { id: 'openclaw', label: 'OpenClaw', kind: 'json', file: '.openclaw/mcp.json', keys: ['mcpServers'] },
  { id: 'workbuddy', label: 'WorkBuddy', kind: 'json', file: '.workbuddy/mcp.json', keys: ['mcpServers'] },
  { id: 'agents', label: '公共 Agent', kind: 'json', file: '.agents/mcp.json', keys: ['mcpServers'] },
]

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 1024 * 1024
const MAX_FETCH_BYTES = 1024 * 1024
const MAX_WALK_DEPTH = 6
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 技能上传是 base64 编码，体积约放大 4/3，按 32MB 原文放宽。 */
const UPLOAD_BODY_BYTES = 32 * 1024 * 1024
const PACKAGE_VERSION = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'

export const name = 'dsh-skill-mcp-vault'

/** Services this row cannot run without; Cordis holds activation until they exist. */
export const inject = ['tools', 'skills']
// llm 走可选注入：profile 没挂模型时翻译接口自己降级，不拖垮插件。

export const Config = z.object({
  registerSkills: z.boolean().default(true),
  applyMcp: z.boolean().default(true),
  reloadTimeoutMs: z.number().min(1000).max(120000).default(20000),
})

export function apply(ctx, config = {}) {
  const settings = {
    registerSkills: config?.registerSkills ?? true,
    applyMcp: config?.applyMcp ?? true,
    reloadTimeoutMs: config?.reloadTimeoutMs ?? 20000,
  }
  const vault = new Vault(ctx, settings)
  ctx.effect(() => () => vault.dispose(), 'skill-mcp-vault: watcher')

  vault.installSkillProvider(ctx)
  vault.installTools(ctx)
  // Optional carriers: the Web UI route and the MCP row loader are absent in
  // some profiles, so they wait for their service instead of requiring it.
  ctx.inject(['webServer'], (inner) => { vault.installRoutes(inner) })
  ctx.inject(['loader'], () => {
    void vault.ensureMcpRows().catch((error) => ctx.logger.warn(error))
  })

  // translate 路由自己的 Node 请求/响应小工具
  const readJsonBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
  const replyJson = (res, status, payload) => {
    const text = JSON.stringify(payload ?? {})
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  // 发现页翻译：远程仓库的技能名/描述是英文，交给宿主 llm 一次性翻成中文并落盘缓存。
  // 翻译缓存按用户隔离：写进 ~/.dsh/skill-mcp-vault/，不随插件分发、升级不丢。
  const translationRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'skill-mcp-vault') : join(homedir(), '.dsh', 'skill-mcp-vault')
  const translationFile = join(translationRoot, 'translations.zh.json')
  // 随包发布的预置翻译：只读，命中即用，缺失才联网。
  // 放在 locale-data/ 而不是 locale/：locale/ 里的每个 .json 都会被宿主当成语言字典，
  // 文件名必须是纯语言 ID（如 zh.json），presets.zh.json 这种名字会让包元信息校验直接报错。
  const presetTranslationFile = join(PACKAGE_ROOT, 'locale-data', 'presets.zh.json')
  let translationCache = null
  const readTranslations = async () => {
    if (translationCache) return translationCache
    let preset = {}
    try {
      preset = JSON.parse(await readFile(presetTranslationFile, 'utf8'))
    } catch {
      preset = {}
    }
    try {
      translationCache = Object.assign({}, preset, JSON.parse(await readFile(translationFile, 'utf8')))
    } catch {
      translationCache = Object.assign({}, preset)
    }
    return translationCache
  }
  ctx.inject(['webServer'], (inner) => {
    inner.webServer.register({
      kind: 'prefix',
      path: '/dsh-skill-mcp-vault/api/translate',
      handler: async (req, res) => {
        const blocked = blockedOrigin(req)
        if (blocked !== undefined) return replyJson(res, 403, { error: blocked })
        if (req.method !== 'POST') return replyJson(res, 405, { error: 'POST only' })
        const body = await readJsonBody(req)
        const items = Array.isArray(body?.items) ? body.items.slice(0, 40) : []
        const cache = await readTranslations()
        const pending = []
        for (const item of items) {
          const key = String(item?.key ?? '')
          if (!key) continue
          if (!cache[key]) pending.push({ key, name: String(item?.name ?? ''), description: String(item?.description ?? '') })
        }
        let engine = 'cache'
        if (pending.length > 0) {
          // 免 Key 的公共翻译服务：MyMemory。逐条翻，节流 + 超时，失败保留原文。
          const translateOne = async (text) => {
            const trimmed = String(text ?? '').replace(/\s+/g, ' ').trim()
            if (trimmed === '') return ''
            const url = 'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(trimmed.slice(0, 480))
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 8000)
            try {
              const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-skill-mcp-vault' } })
              if (!response.ok) return ''
              const payload = await response.json()
              const value = payload?.responseData?.translatedText
              return typeof value === 'string' ? value.trim() : ''
            } catch {
              return ''
            } finally {
              clearTimeout(timer)
            }
          }
          let changed = false
          for (const row of pending.slice(0, 20)) {
            const translatedName = row.name ? await translateOne(row.name) : ''
            const translatedDescription = row.description ? await translateOne(row.description) : ''
            // 只收下像中文的结果，避免拿到原文或空串
            // 只翻名字的请求（本地技能兜底）没有描述，有名字就收
            const nameOnly = String(row.description ?? '') === ''
            const usableName = /[\u4e00-\u9fa5]/.test(translatedName) ? translatedName.slice(0, 24) : ''
            const usableDescription = /[\u4e00-\u9fa5]/.test(translatedDescription) ? translatedDescription.slice(0, 160) : ''
            if (usableName || usableDescription || (nameOnly && translatedName)) {
              cache[row.key] = { name: nameOnly && !usableName ? translatedName.slice(0, 24) : usableName, description: usableDescription }
              changed = true
            }
          }
          if (changed) {
            await mkdir(dirname(translationFile), { recursive: true }).catch(() => {})
            await writeFile(translationFile, JSON.stringify(cache, null, 1), 'utf8').catch(() => {})
            engine = 'mymemory'
          }
        }
        const items2 = {}
        for (const item of items) {
          const key = String(item?.key ?? '')
          if (key && cache[key]) items2[key] = cache[key]
        }
        return replyJson(res, 200, { engine, items: items2 })
      },
    })
  })

  // 内置技能管理器宿主：它自己 inject webServer/skills/tools/sessions。
  try {
    ctx.plugin(skillsManagerHost)
  } catch (error) {
    ctx.logger.warn('skill-mcp-vault: embedded skills host failed: ' + String(error?.message ?? error))
  }
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().replaceAll(/[:.]/g, '-')
}

async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** 把上传里的相对路径解析到 root 内；越界（../ 或绝对路径）直接丢弃。 */
function containedPath(root, relative) {
  const cleaned = String(relative ?? '').replace(/^[\\/]+/, '')
  if (cleaned === '') return undefined
  const base = resolve(root)
  const target = resolve(base, cleaned)
  if (target === base || !target.startsWith(base + sep)) return undefined
  return target
}

/** 导出目录固定在系统「下载」里，顺便当越界校验的边界。 */
function downloadsRoot() {
  return join(homedir(), 'Downloads')
}

/** 在系统文件管理器里定位到某个文件：Windows 选中它，macOS 在 Finder 里显示，Linux 打开所在目录。 */
function revealInFileManager(target) {
  const platform = process.platform
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/select,', target] : platform === 'darwin' ? ['-R', target] : [dirname(target)]
  return new Promise((resolvePromise) => {
    // explorer.exe 成功时也可能返回非 0，这里只吞掉错误，不影响导出结果。
    execFile(command, args, () => resolvePromise())
  })
}

async function pathKind(path) {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Move an existing file or directory aside under `<parent>/.backups`. */
async function backupPath(target) {
  const exists = await pathKind(target)
  if (exists === undefined) return undefined
  const dir = join(dirname(target), '.backups')
  await mkdir(dir, { recursive: true })
  const destination = join(dir, `${basename(target)}-${stamp()}`)
  await rename(target, destination)
  return destination
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter
// ---------------------------------------------------------------------------

/** Parse the leading `---` YAML block of a skill document (scalars only). */
function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split('\n')
  if (lines[0]?.replace(/\r$/, '') !== '---') return undefined
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      end = index
      break
    }
  }
  if (end < 0) return undefined
  const data = {}
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    let value = rawValue.trim()
    if (value.length >= 2) {
      const quote = value[0]
      if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
        value = value.slice(1, -1)
        if (quote === '"') value = value.replaceAll('\\n', '\n').replaceAll('\\"', '"')
      }
    }
    data[key] = value
  }
  return { data, body: lines.slice(end + 1).join('\n').trim() }
}

function frontmatterBool(value) {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}

function yamlScalar(value) {
  const text = String(value)
  if (text.includes('\n')) return JSON.stringify(text)
  if (/^[A-Za-z0-9 _.,;()/\-]+$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text) && !/^[-\d.]/.test(text)) return text
  return JSON.stringify(text)
}

/** Build a SKILL.md document from the fields a caller supplied. */
function composeSkillFile({ name: skillName, description, whenToUse, body, modelInvocable, userInvocable }) {
  const lines = ['---', `name: ${skillName}`, `description: ${yamlScalar(description)}`]
  if (whenToUse !== undefined && whenToUse !== '') lines.push(`whenToUse: ${yamlScalar(whenToUse)}`)
  if (modelInvocable === false) lines.push('disable-model-invocation: true')
  if (userInvocable === false) lines.push('user-invocable: false')
  lines.push('---', '', String(body ?? '').trim(), '')
  return lines.join('\n')
}

/** One catalogue row per skill document, keyed by its declared name. */
async function scanSkillDirectory(directory, depth = 0) {
  const rows = []
  if (depth > MAX_WALK_DEPTH) return rows
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return rows
    throw error
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const document = join(path, 'SKILL.md')
      const kind = await pathKind(document)
      if (kind === 'file') rows.push({ path: document, directory: path })
      else rows.push(...await scanSkillDirectory(path, depth + 1))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.md')) rows.push({ path, directory })
  }
  return rows
}

async function readSkillDocument(path, directory) {
  const raw = await readFile(path, 'utf8')
  if (raw.length > MAX_SKILL_BYTES) throw new Error(`skill document too large: ${path}`)
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) throw new Error(`missing YAML frontmatter in ${path}`)
  const skillName = parsed.data.name
  const description = parsed.data.description
  if (typeof skillName !== 'string' || !SKILL_NAME.test(skillName)) throw new Error(`invalid skill name ${JSON.stringify(skillName)} in ${path}`)
  if (typeof description !== 'string' || description.trim() === '') throw new Error(`missing description in ${path}`)
  return {
    path,
    directory,
    name: skillName,
    description: description.trim(),
    whenToUse: typeof parsed.data.whenToUse === 'string' ? parsed.data.whenToUse : undefined,
    modelInvocable: frontmatterBool(parsed.data['disable-model-invocation']) !== true,
    userInvocable: frontmatterBool(parsed.data['user-invocable']) !== false,
    content: parsed.body,
    signature: createHash('sha1').update(`${path}\u0000${raw.length}\u0000${raw}`).digest('hex'),
  }
}

/** Trash ids carry their move time; the skill's own folder name follows it. */
function stripTrashStamp(id) {
  return String(id).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '')
}

/** Fetch one small text resource with the same byte ceiling as skills. */
async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { accept: 'text/plain, application/json' } })
  if (!response.ok) throw new Error(`fetching ${url} failed: HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > MAX_FETCH_BYTES) throw new Error(`resource too large: ${url}`)
  return text
}

/**
 * Read a skill document that may not carry complete frontmatter, which is the
 * case while browsing a repository before installing anything.
 */
function parseSkillDocument(text, fallback) {
  const parsed = parseFrontmatter(text)
  const data = parsed?.data ?? {}
  const name = typeof data.name === 'string' && SKILL_NAME.test(data.name)
    ? data.name
    : (typeof fallback?.name === 'string' && fallback.name !== '' ? fallback.name : 'unnamed')
  return {
    name,
    description: typeof data.description === 'string' ? data.description.trim() : '',
    content: parsed?.body ?? text,
  }
}

/**
 * List installable skills inside one GitHub path. Only folders whose own
 * SKILL.md parses are offered, so what the panel shows is what will install.
 */
async function fetchGithubDirectory(url) {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/i.exec(url)
  if (match === null) throw new Error(`不是可识别的 GitHub 地址：${url}`)
  const [, owner, repo, ref = '', subpath = ''] = match
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${subpath}${ref === '' ? '' : `?ref=${ref}`}`
  const listing = JSON.parse(await fetchText(api))
  if (!Array.isArray(listing)) throw new Error('该地址不是目录')
  const items = []
  for (const entry of listing.slice(0, 60)) {
    if (entry.type !== 'dir') continue
    const documentUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref === '' ? 'HEAD' : ref}/${subpath === '' ? '' : `${subpath}/`}${entry.name}/SKILL.md`
    try {
      const parsed = parseSkillDocument(await fetchText(documentUrl), { name: entry.name })
      items.push({
        name: parsed.name,
        description: parsed.description,
        origin: documentUrl,
        kind: 'document',
        folder: entry.name,
      })
    } catch {
      // Folders without a readable SKILL.md are simply not skills.
    }
  }
  return items
}

/** Strip matching single or double quotes from one TOML/JSON-ish scalar. */
function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) return text.slice(1, -1)
  return text
}

/** Parse `["a", "b"]` — the only array form these config files use. */
function parseInlineArray(value) {
  const text = String(value ?? '').trim()
  if (text.startsWith('[') === false) return []
  const inner = text.slice(1, text.lastIndexOf(']')).trim()
  if (inner === '') return []
  const items = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g
  let match
  while ((match = pattern.exec(inner)) !== null) items.push((match[1] ?? match[2]).replace(/\\(.)/g, '$1'))
  return items
}

/**
 * Set one skill's enablement in its own frontmatter, backing the file up first.
 * `disable-model-invocation` and `user-invocable` are the policy bits every
 * provider reads, so this needs no side state and survives a provider change.
 */
async function setSkillPolicy(path, enabled) {
  const original = await readFile(path, 'utf8')
  const parsed = parseFrontmatter(original)
  if (parsed === undefined) throw new Error('missing YAML frontmatter in ' + path)
  const lines = original.replace(/^\uFEFF/, '').split('\n')
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      end = index
      break
    }
  }
  if (end < 0) throw new Error('missing YAML frontmatter in ' + path)
  const kept = lines.slice(1, end).filter((line) => {
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1]
    return key !== 'disable-model-invocation' && key !== 'user-invocable'
  })
  if (!enabled) {
    kept.push('disable-model-invocation: true')
    kept.push('user-invocable: false')
  }
  const next = ['---', ...kept, '---', ...lines.slice(end + 1)].join('\n')
  if (next === original) return { path, enabled, changed: false }
  await mkdir(SKILL_BACKUP_DIR, { recursive: true })
  await writeFile(join(SKILL_BACKUP_DIR, basename(dirname(path)) + '-' + stamp() + '.md'), original)
  await writeFile(path, next)
  return { path, enabled, changed: true }
}

// ---------------------------------------------------------------------------
// MCP catalogue
// ---------------------------------------------------------------------------

function sanitizeServer(input, previous = {}) {
  if (input === null || typeof input !== 'object') throw new Error('an MCP server entry must be an object')
  const serverName = String(input.serverName ?? previous.serverName ?? '').trim()
  if (!SERVER_NAME.test(serverName)) throw new Error(`invalid serverName ${JSON.stringify(serverName)}; use [A-Za-z0-9_-]{1,32}`)
  const transport = String(input.transport ?? previous.transport ?? (input.url === undefined ? 'stdio' : 'streamable-http')).trim()
  if (transport !== 'stdio' && transport !== 'streamable-http') throw new Error(`invalid transport ${JSON.stringify(transport)}; expected stdio or streamable-http`)
  const stringMap = (value, label) => {
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object of strings`)
    const out = {}
    for (const [key, item] of Object.entries(value)) out[String(key)] = String(item)
    return out
  }
  const timeout = input.toolCallTimeoutMs ?? previous.toolCallTimeoutMs
  const entry = {
    serverName,
    transport,
    ...transport === 'stdio' ? {
      command: String(input.command ?? previous.command ?? '').trim(),
      args: (Array.isArray(input.args) ? input.args : previous.args ?? []).map((item) => String(item)),
      env: stringMap(input.env ?? previous.env, 'env'),
      cwd: String(input.cwd ?? previous.cwd ?? ''),
    } : {
      url: String(input.url ?? previous.url ?? '').trim(),
      headers: stringMap(input.headers ?? previous.headers, 'headers'),
    },
    toolCallTimeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 60000,
    failOnStartupError: input.failOnStartupError === undefined ? previous.failOnStartupError === true : input.failOnStartupError === true,
    enabled: input.enabled === undefined ? previous.enabled !== false : input.enabled !== false,
    ...typeof (input.source ?? previous.source) === 'string' ? { source: String(input.source ?? previous.source) } : {},
  }
  if (transport === 'stdio' && entry.command === '') throw new Error(`server ${serverName} needs a command`)
  if (transport === 'streamable-http' && entry.url === '') throw new Error(`server ${serverName} needs a url`)
  return entry
}

/**
 * 别的客户端字段名不一样（VS Code 的 serverUrl、有的写 type 而不是 transport、
 * 甚至直接把值写成 URL 字符串），这里统一成插件自己的字段再交给 sanitizeServer。
 */
function normalizeImportedServer(raw, serverName) {
  if (typeof raw === 'string') {
    return { serverName, transport: 'streamable-http', url: raw.trim() }
  }
  const pick = (keys) => {
    for (const key of keys) {
      const value = raw?.[key]
      if (value !== undefined && value !== null && value !== '') return value
    }
    return undefined
  }
  const command = pick(['command', 'cmd', 'exec', 'bin'])
  const url = pick(['url', 'serverUrl', 'endpoint', 'baseUrl', 'address'])
  const declared = String(pick(['transport', 'type', 'protocol']) ?? '').toLowerCase()
  const transport = declared.includes('stdio')
    ? 'stdio'
    : declared.includes('http') || declared.includes('sse')
      ? 'streamable-http'
      : url !== undefined ? 'streamable-http' : 'stdio'
  if (transport === 'stdio' && command === undefined) throw new Error('缺少启动命令（command）')
  if (transport === 'streamable-http' && url === undefined) throw new Error('缺少 URL')
  const args = pick(['args', 'arguments'])
  const env = pick(['env', 'environment'])
  const headers = pick(['headers'])
  return {
    ...raw,
    serverName,
    transport,
    ...transport === 'stdio'
      ? {
        command: String(command),
        args: Array.isArray(args) ? args : typeof args === 'string' ? args.split(/\s+/).filter(Boolean) : [],
        env: env ?? {},
      }
      : { url: String(url), headers: headers ?? {} },
  }
}

// ---------------------------------------------------------------------------
// 开源 MCP 识别：给一个 GitHub 仓库地址，猜出该填的启动命令
// ---------------------------------------------------------------------------

/** 只读 GitHub 自己的域名，免得这个接口变成任意 URL 抓取器。 */
const MCP_SOURCE_HOSTS = new Set(['github.com', 'www.github.com', 'raw.githubusercontent.com', 'api.github.com'])

/** 可以在 README 里当"启动方式"的行首命令。 */
const RUN_HEADS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'uv', 'docker', 'node', 'python', 'python3'])

/** 仓库名 → 合法的 serverName（小写、只留 [a-z0-9_-]、32 位以内）。 */
function sanitizeServerName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/**
 * 认得这几种写法：
 * - `https://github.com/owner/repo`（可带 `/tree/<ref>/<subdir>` 或 `/blob/<ref>/<file>`）
 * - `https://raw.githubusercontent.com/owner/repo/<ref>/<path>`
 * - `git@github.com:owner/repo.git`
 * - `owner/repo`
 */
function parseGithubTarget(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text)
  if (ssh !== null) return { owner: ssh[1], repo: ssh[2], ref: undefined, subdir: '', file: '' }
  if (!text.includes('://') && /^[\w.-]+\/[\w.-]+$/.test(text)) {
    const [owner, repo] = text.split('/')
    return { owner, repo: repo.replace(/\.git$/, ''), ref: undefined, subdir: '', file: '' }
  }
  let url
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    return undefined
  }
  if (!MCP_SOURCE_HOSTS.has(url.hostname)) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  if (url.hostname === 'raw.githubusercontent.com') {
    const rest = parts.slice(3)
    return { owner, repo, ref: parts[2], subdir: rest.slice(0, -1).join('/'), file: rest.join('/') }
  }
  const rest = parts.slice(2)
  if (rest[0] === 'tree' || rest[0] === 'blob') {
    const ref = rest[1]
    const tail = rest.slice(2)
    if (rest[0] === 'blob') return { owner, repo, ref, subdir: tail.slice(0, -1).join('/'), file: tail.join('/') }
    return { owner, repo, ref, subdir: tail.join('/'), file: '' }
  }
  return { owner, repo, ref: undefined, subdir: '', file: '' }
}

/** README 里如果直接贴了 mcpServers 配置，这就是最准的答案。 */
function serverFromJsonText(text) {
  const blocks = [...String(text).matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((match) => match[1])
  for (const chunk of blocks.concat([String(text)])) {
    const start = chunk.indexOf('{')
    const end = chunk.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    let parsed
    try {
      parsed = JSON.parse(chunk.slice(start, end + 1))
    } catch {
      continue
    }
    const list = parsed?.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? Object.entries(parsed.mcpServers).map(([key, value]) => (typeof value === 'string' ? { serverName: key, url: value } : { serverName: key, ...(value ?? {}) }))
      : Array.isArray(parsed?.servers) ? parsed.servers : undefined
    const found = (list ?? []).find((item) => item !== null && typeof item === 'object' && (item.command !== undefined || item.cmd !== undefined || item.url !== undefined || item.serverUrl !== undefined))
    if (found !== undefined) return found
  }
  return undefined
}

/** README 里常见的占位符：`<your-package>`、`your_token`、`/path/to/xxx`。 */
const PLACEHOLDER = /[<>]|your[-_ ]?(path|token|key|dir|url|repo|api)/i

/** 一条命令里"程序"是哪个 token：docker 是最后一个非 flag，其它是第一个非 flag。 */
function programTokenOf(head, rest) {
  if (head === 'docker') {
    const flagsWithValue = new Set(['-e', '--env', '-v', '--volume', '-p', '--port', '--name', '-w', '--workdir', '--network', '-u', '--user', '--entrypoint', '--mount', '--add-host'])
    let last
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]
      if (flagsWithValue.has(token)) {
        index += 1
        continue
      }
      if (token.startsWith('-')) continue
      last = token
    }
    return last
  }
  return rest.find((token) => !token.startsWith('-'))
}

/**
 * 从 README 的代码块里挑一条最像"启动命令"的行。
 * 打分：带 -y 的 npx / uvx 最高，docker run 次之，node/python 只当兜底（还得先 build，本机不一定能跑）。
 */
function commandFromReadme(text) {
  const blocks = [...String(text).matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1])
  let best
  const consider = (line) => {
    const cleaned = line.replace(/^\s*[$#>]\s*/, '').trim()
    if (cleaned === '') return
    const tokens = cleaned.split(/\s+/)
    const head = tokens[0]
    if (!RUN_HEADS.has(head)) return
    if (head === 'docker' && tokens[1] !== 'run') return
    if (head === 'uv' && !['run', 'x', 'tool'].includes(tokens[1])) return
    const rest = tokens.slice(1)
    if (rest.includes('--help') || rest.includes('-h')) return
    // 程序名本身是占位符（`npx -y <your-package>`）说明这条命令不能直接用；
    // 只有参数里带占位符（token、路径）则保留，提交前提醒用户替换。
    const program = programTokenOf(head, rest)
    if (program === undefined || PLACEHOLDER.test(program)) return
    const placeholderArgs = rest.some((token) => token !== program && PLACEHOLDER.test(token))
    let score
    if (head === 'npx' || head === 'pnpx' || head === 'bunx') score = tokens.includes('-y') || tokens.includes('--yes') ? 4 : 3
    else if (head === 'uvx') score = 4
    else if (head === 'docker') score = 3
    else score = 1
    // `npx xxx setup` / `install` 这类是安装器，不是启动服务的那条命令，降权后仍可作为参考
    const installer = rest.some((token) => /^(setup|install|init|login|auth|remove|uninstall|config|update)$/i.test(token))
    if (installer) score -= 2
    if (best === undefined || score > best.score) best = { command: head, args: rest, score, installer, placeholderArgs, line: cleaned }
  }
  for (const block of blocks) {
    // 先把反斜杠续行接起来，否则 `docker run -i --rm \` 会被截成半条命令
    for (const line of block.replace(/\\\s*\n\s*/g, ' ').split('\n')) consider(line)
  }
  return best
}

function rowIdOf(serverName) {
  return `skill-mcp-vault-mcp--${serverName}`
}

function rowConfigOf(entry) {
  return {
    serverName: entry.serverName,
    transport: entry.transport,
    ...entry.transport === 'stdio' ? {
      command: entry.command,
      args: entry.args,
      env: entry.env,
      ...entry.cwd === '' ? {} : { cwd: entry.cwd },
    } : {
      url: entry.url,
      headers: entry.headers,
    },
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    failOnStartupError: entry.failOnStartupError,
  }
}

/** Compare only the fields the vault owns, so an unrelated edit does not reload. */
function sameRowConfig(left, right) {
  if (left === undefined) return false
  const keys = ['serverName', 'transport', 'command', 'url', 'toolCallTimeoutMs', 'failOnStartupError']
  for (const key of keys) if (left[key] !== right[key]) return false
  return JSON.stringify(left.args ?? []) === JSON.stringify(right.args ?? [])
    && JSON.stringify(left.env ?? {}) === JSON.stringify(right.env ?? {})
    && JSON.stringify(left.headers ?? {}) === JSON.stringify(right.headers ?? {})
    && (left.cwd ?? '') === (right.cwd ?? '')
}

/** Reject browser requests that did not originate from the local page. */
function blockedOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const parsed = new URL(origin)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return 'cross-origin request rejected'
    } catch {
      return 'malformed origin'
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

class Vault {
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    this.skillSignatures = new Map()
    this.skillMarker = undefined
    this.mcpState = { servers: [], rows: {}, status: {} }
    this.appliedSignature = undefined
    this.applying = undefined
    this.reloading = false
    this.refreshingRows = false
    this.ready = Promise.resolve()
    this.poll = setInterval(() => void this.tick().catch((error) => ctx.logger.warn(error)), 2000)
    this.poll.unref?.()
  }

  dispose() {
    clearInterval(this.poll)
  }

  // -- skills --------------------------------------------------------------

  installSkillProvider(target = this.ctx) {
    target.skills.registerProvider((control) => ({
      name: 'skill-vault',
      list: async () => {
        const candidates = await this.readSkills()
        const complete = await this.observeSkills(candidates, control)
        return { candidates, complete }
      },
      get: async (candidate) => {
        const document = await readSkillDocument(candidate.path, candidate.directory)
        return {
          name: document.name,
          description: document.description,
          ...document.whenToUse === undefined ? {} : { whenToUse: document.whenToUse },
          invocation: { modelInvocable: document.modelInvocable, userInvocable: document.userInvocable },
          provider: 'skill-vault',
          source: 'custom',
          resourceBase: { kind: 'directory', path: document.directory },
          path: document.path,
          content: document.content,
        }
      },
    }))
  }

  async readSkills() {
    const rows = await scanSkillDirectory(SKILLS_ROOT)
    const candidates = []
    const seen = new Set()
    for (const row of rows) {
      let document
      try {
        document = await readSkillDocument(row.path, row.directory)
      } catch (error) {
        this.ctx.logger.warn(`skill-vault: ignored ${row.path}: ${error.message}`)
        continue
      }
      if (seen.has(document.name)) {
        this.ctx.logger.warn(`skill-vault: duplicate skill name ${document.name} at ${row.path}; keeping the first`)
        continue
      }
      seen.add(document.name)
      candidates.push({
        name: document.name,
        description: document.description,
        ...document.whenToUse === undefined ? {} : { whenToUse: document.whenToUse },
        invocation: { modelInvocable: document.modelInvocable, userInvocable: document.userInvocable },
        provider: 'skill-vault',
        source: 'custom',
        resourceBase: { kind: 'directory', path: document.directory },
        path: document.path,
        rank: 300,
        locator: { path: document.path, directory: document.directory },
      })
    }
    return candidates
  }

  /**
   * Record each document's identity and invalidate the registry when one
   * changed. The filesystem provider's watcher owns this normally; this vault
   * reads its own directory, so it reports changes itself.
   */
  async observeSkills(candidates, control) {
    const next = new Map()
    let complete = true
    for (const candidate of candidates) {
      try {
        const document = await readSkillDocument(candidate.path, candidate.directory)
        next.set(document.path, document.signature)
      } catch {
        complete = false
      }
    }
    const changed = this.skillMarker !== undefined && (
      next.size !== this.skillSignatures.size
      || [...next].some(([path, signature]) => this.skillSignatures.get(path) !== signature)
    )
    this.skillSignatures = next
    this.skillMarker = true
    if (changed) control.invalidate()
    return complete
  }

  // -- MCP catalogue -------------------------------------------------------


  async readCatalogue() {
    const text = await readTextIfPresent(MCP_FILE)
    if (text === undefined) return { version: 1, servers: [] }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`mcp/mcp.json is not valid JSON: ${error.message}`)
    }
    const servers = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : []
    const sanitized = []
    const rejected = []
    for (const raw of servers) {
      try {
        sanitized.push(sanitizeServer(raw))
      } catch (error) {
        rejected.push({ entry: raw, reason: error.message })
      }
    }
    return { version: 1, servers: sanitized, rejected }
  }

  async writeCatalogue(catalogue) {
    await mkdir(MCP_ROOT, { recursive: true })
    const text = await readTextIfPresent(MCP_FILE)
    if (text !== undefined) {
      await mkdir(MCP_BACKUP_DIR, { recursive: true })
      await writeFile(join(MCP_BACKUP_DIR, `mcp.json-${stamp()}`), text)
    }
    const payload = { version: 1, servers: catalogue.servers }
    await writeFile(MCP_FILE, `${JSON.stringify(payload, null, 2)}\n`)
    return payload
  }

  loader() {
    const loader = this.ctx.get('loader')
    if (loader === undefined) throw new Error('the Loader is not available in this profile')
    return loader
  }

  loaderEntries() {
    if (this._entries !== undefined) return this._entries
    const loader = this.ctx.get('loader')
    if (loader === undefined) return []
    this._entries = [...loader.entries()]
    return this._entries
  }

  /** Rows this vault owns: they carry the reserved id prefix. */
  vaultRows() {
    return this.loaderEntries().filter((entry) => String(entry.options?.id ?? '').startsWith(VAULT_ROW_PREFIX))
  }

  findEntry(id) {
    return this.loaderEntries().find((entry) => entry.options?.id === id)
  }

  /** One `dsh-mcp-client` row per enabled catalogue entry. */
  async ensureMcpRows(options = {}) {
    if (!this.settings.applyMcp) return { applied: false, reason: 'disabled by config' }
    if (this.applying !== undefined) return this.applying
    this.applying = this.applyRows(options).finally(() => {
      this.applying = undefined
    })
    return this.applying
  }

  async applyRows({ force = false } = {}) {
    const catalogue = await this.readCatalogue()
    const signature = JSON.stringify(catalogue.servers.filter((entry) => entry.enabled !== false))
    const rows = {}
    const wanted = []
    for (const entry of catalogue.servers) {
      const id = rowIdOf(entry.serverName)
      const row = this.findEntry(id)
      rows[entry.serverName] = {
        row: id,
        present: row !== undefined,
        enabled: entry.enabled !== false,
        config: rowConfigOf(entry),
      }
      if (entry.enabled !== false) wanted.push({ entry, id, row })
    }
    const known = new Set(catalogue.servers.map((entry) => entry.serverName))
    // Enabled state lives only in mcp/mcp.json: a row is recreated from the
    // catalogue, so every row the catalogue does not want is removed.
    const orphans = this.vaultRows()
      .filter((entry) => !known.has(String(entry.options?.id ?? '').slice(VAULT_ROW_PREFIX.length)))
    const stale = wanted.filter(({ entry, row }) => row !== undefined && (
      !row.disabled && !sameRowConfig(row.options?.config, rowConfigOf(entry))
    ))
    const missing = wanted.filter(({ row }) => row === undefined || row.disabled)
    const clean = !force && this.appliedSignature === signature
      && missing.length === 0 && orphans.length === 0 && stale.length === 0

    this.mcpState.servers = catalogue.servers
    this.mcpState.rejected = catalogue.rejected ?? []
    this.mcpState.rows = rows
    if (clean) {
      this.refreshRowStatus()
      return { applied: true, changed: false, servers: catalogue.servers.length }
    }

    this._entries = undefined
    const touched = []
    for (const { entry, id } of missing) {
      const created = await this.loader().create({ id, name: MCP_CLIENT_PACKAGE, config: rowConfigOf(entry) })
      touched.push(typeof created === 'string' ? created : id)
    }
    for (const { entry, row } of stale) {
      await row.update({ config: rowConfigOf(entry) })
      touched.push(row.options.id)
    }
    // The Loader keeps plain options in memory only; a row the catalogue no
    // longer wants is stopped and removed, and the next boot rebuilds it from
    // the catalogue file.
    const keep = new Set(wanted.map(({ id }) => id))
    for (const entry of this.vaultRows()) {
      if (keep.has(entry.options.id)) continue
      await this.dropRow(entry)
    }
    // A removed row stops asynchronously; let the Loader finish before the
    // catalogue is read again, so a following pass cannot resurrect it.
    await new Promise((done) => setTimeout(done, 150))
    this._entries = undefined
    this.appliedSignature = signature
    await this.settleRows(touched)
    this.refreshRowStatus()
    return { applied: true, changed: true, servers: catalogue.servers.length, rows: touched }
  }

  /** Stop a row this vault owns, then remove it when the Loader can address it. */
  async dropRow(entry) {
    const id = entry.options.id
    try {
      this.loader().remove(id)
      return 'removed'
    } catch {
      await entry.update({ disabled: true })
      return 'disabled'
    }
  }

  /** Give freshly created or updated rows a bounded window to reach the tool registry. */
  async settleRows(ids) {
    if (ids.length === 0) return
    const deadline = Date.now() + this.settings.reloadTimeoutMs
    while (Date.now() < deadline) {
      const pending = ids.filter((id) => !this.rowHasTools(String(id).replace('skill-mcp-vault-mcp--', '')))
      if (pending.length === 0) return
      await new Promise((done) => setTimeout(done, 250))
    }
  }

  rowHasTools(serverName) {
    const row = this.findEntry(rowIdOf(serverName))
    if (row === undefined || row.disabled) return true
    const tools = this.ctx.get('tools')
    if (tools === undefined) return true
    try {
      return tools.schemas().some((schema) => schema.name.startsWith(`mcp__${serverName}__`))
    } catch {
      return true
    }
  }

  /**
   * Derive per-server state from the tool registry: an MCP client publishes
   * its tools only after a successful connect, so presence is the observable
   * signal this plugin has access to.
   */
  refreshRowStatus() {
    const status = {}
    const tools = this.ctx.get('tools')
    const live = (() => {
      try {
        return tools === undefined ? [] : tools.schemas().map((schema) => schema.name)
      } catch {
        return []
      }
    })()
    for (const entry of this.mcpState.servers ?? []) {
      const row = this.findEntry(rowIdOf(entry.serverName))
      const names = live.filter((toolName) => toolName.startsWith(`mcp__${entry.serverName}__`))
      const connected = names.length > 0
      status[entry.serverName] = {
        row: rowIdOf(entry.serverName),
        present: row !== undefined,
        enabled: row === undefined ? false : !row.disabled,
        state: row === undefined ? 'not-loaded' : row.disabled ? 'disabled' : connected ? 'connected' : 'connecting-or-failed',
        tools: names.map((toolName) => toolName.slice(`mcp__${entry.serverName}__`.length)),
      }
    }
    this.mcpState.status = status
  }

  // -- operations shared by tools and HTTP --------------------------------

  async info() {
    this.refreshRowStatus()
    const skills = await this.readSkills()
    return {
      version: PACKAGE_VERSION,
      packageRoot: PACKAGE_ROOT,
      skillsRoot: SKILLS_ROOT,
      mcpFile: MCP_FILE,
      skills: skills.map(({ locator, rank, ...rest }) => rest),
      mcp: {
        servers: this.mcpState.servers ?? [],
        rejected: this.mcpState.rejected ?? [],
        status: this.mcpState.status ?? {},
        appliedSignature: this.appliedSignature,
      },
      config: this.settings,
    }
  }

  async addSkill(input) {
    let document
    if (typeof input.document === 'string' && input.document.trim() !== '') {
      document = input.document
    } else if (typeof input.source === 'string' && input.source.trim() !== '') {
      document = await this.loadSkillSource(input.source.trim())
    } else {
      const skillName = String(input.name ?? '').trim()
      if (!SKILL_NAME.test(skillName)) throw new Error(`invalid skill name ${JSON.stringify(skillName)}; use lowercase words joined by hyphens`)
      const description = String(input.description ?? '').trim()
      if (description === '') throw new Error('description is required: the model routes on it')
      document = composeSkillFile({
        name: skillName,
        description,
        whenToUse: input.whenToUse,
        body: input.body,
        modelInvocable: input.modelInvocable,
        userInvocable: input.userInvocable,
      })
    }
    const parsed = parseFrontmatter(document)
    if (parsed === undefined) throw new Error('the skill document needs a leading YAML frontmatter block')
    const skillName = String(parsed.data.name ?? '').trim()
    if (!SKILL_NAME.test(skillName)) throw new Error(`invalid skill name ${JSON.stringify(skillName)} in the document`)
    if (String(parsed.data.description ?? '').trim() === '') throw new Error('the document frontmatter needs a description')
    const directory = join(SKILLS_ROOT, skillName)
    const target = join(directory, 'SKILL.md')
    await mkdir(directory, { recursive: true })
    const previous = await readTextIfPresent(target)
    if (previous !== undefined) {
      await mkdir(SKILL_BACKUP_DIR, { recursive: true })
      await writeFile(join(SKILL_BACKUP_DIR, `${skillName}-${stamp()}.md`), previous)
    }
    await writeFile(target, document.endsWith('\n') ? document : `${document}\n`)
    this.skillSignatures.clear()
    return { skill: skillName, path: target, replaced: previous !== undefined }
  }

  async loadSkillSource(source) {
    if (/^data:/i.test(source)) {
      const comma = source.indexOf(',')
      if (comma < 0) throw new Error('malformed data: URL')
      const header = source.slice(5, comma)
      const payload = source.slice(comma + 1)
      const text = /;base64$/i.test(header)
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload)
      if (text.length > MAX_SKILL_BYTES) throw new Error(`skill document too large: ${text.length} bytes`)
      return text
    }
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { redirect: 'follow' })
      if (!response.ok) throw new Error(`fetching ${source} failed: HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > MAX_SKILL_BYTES) throw new Error(`skill document too large: ${text.length} bytes`)
      return text
    }
    const path = isAbsolute(source) ? source : resolve(process.cwd(), source)
    const kind = await pathKind(path)
    if (kind === 'directory') {
      const document = join(path, 'SKILL.md')
      if (await pathKind(document) !== 'file') throw new Error(`no SKILL.md in ${path}`)
      return readFile(document, 'utf8')
    }
    if (kind === 'file') {
      const text = await readFile(path, 'utf8')
      if (text.length > MAX_SKILL_BYTES) throw new Error(`skill document too large: ${path}`)
      return text
    }
    throw new Error(`skill source not found: ${path}`)
  }

  async importSkill(input) {
    const source = String(input.source ?? '').trim()
    if (source === '') throw new Error('source is required')
    const path = isAbsolute(source) ? source : resolve(process.cwd(), source)
    const kind = await pathKind(path)
    if (kind === undefined) throw new Error(`not found: ${path}`)
    const directory = kind === 'directory' ? path : dirname(path)
    const document = join(directory, 'SKILL.md')
    if (await pathKind(document) !== 'file') throw new Error(`no SKILL.md in ${directory}`)
    const text = await readFile(document, 'utf8')
    const parsed = parseFrontmatter(text)
    if (parsed === undefined) throw new Error(`${document} has no YAML frontmatter`)
    const skillName = String(input.name ?? parsed.data.name ?? '').trim()
    if (!SKILL_NAME.test(skillName)) throw new Error(`invalid skill name ${JSON.stringify(skillName)}`)
    const target = join(SKILLS_ROOT, skillName)
    const backedUp = await backupPath(target)
    await mkdir(dirname(target), { recursive: true })
    await cp(directory, target, { recursive: true })
    if (kind === 'file' || basename(directory) !== skillName) {
      // Copying a directory keeps its own name; normalize the document in place.
      const copied = join(target, 'SKILL.md')
      if (await pathKind(copied) !== 'file') await cp(document, copied)
    }
    this.skillSignatures.clear()
    return { skill: skillName, path: join(target, 'SKILL.md'), replaced: backedUp !== undefined, backup: backedUp }
  }

  /**
   * 上传导入：接收技能管理器 /upload 的同一种负载（entries 或 zip），落到临时目录后
   * 复用 importSkill 写进插件仓库，所以命名、frontmatter、备份规则和本地导入完全一致。
   */
  async uploadSkill(input) {
    const staged = await mkdtemp(join(tmpdir(), 'dsh-vault-upload-'))
    try {
      const contentRoot = join(staged, 'content')
      await mkdir(contentRoot, { recursive: true })
      if (typeof input?.zip === 'string' && input.zip !== '') {
        const files = unzipSync(new Uint8Array(Buffer.from(input.zip, 'base64')))
        for (const [name, bytes] of Object.entries(files)) {
          if (name.endsWith('/')) continue
          const target = containedPath(contentRoot, name)
          if (target === undefined) continue
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, Buffer.from(bytes))
        }
      } else if (Array.isArray(input?.entries)) {
        for (const entry of input.entries) {
          const target = containedPath(contentRoot, String(entry?.path ?? ''))
          if (target === undefined) continue
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, Buffer.from(String(entry?.data ?? ''), 'base64'))
        }
      }
      const directories = []
      if (await pathKind(join(contentRoot, 'SKILL.md')) === 'file') {
        directories.push(contentRoot)
      } else {
        for (const row of await readdir(contentRoot, { withFileTypes: true })) {
          if (!row.isDirectory()) continue
          if (await pathKind(join(contentRoot, row.name, 'SKILL.md')) === 'file') directories.push(join(contentRoot, row.name))
        }
      }
      if (directories.length === 0) throw new Error('压缩包或文件夹里没有找到 SKILL.md')
      const imported = []
      const failed = []
      for (const directory of directories) {
        try {
          const result = await this.importSkill({ source: directory })
          imported.push({ name: result.skill, replaced: result.replaced })
        } catch (error) {
          failed.push({ name: basename(directory), error: String(error?.message ?? error) })
        }
      }
      if (imported.length === 0) throw new Error(failed.map((item) => item.error).join('；') || '导入失败')
      return { imported, failed }
    } finally {
      await rm(staged, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 把插件里的一个技能打包成 zip。顶层目录就是技能名，解压后能直接再导入，
   * 也能直接发给别人丢进自己的 skills 目录。
   */
  async exportSkillZip(input) {
    const name = String(input?.name ?? '').trim()
    if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name ${JSON.stringify(name)}`)
    const directory = join(SKILLS_ROOT, name)
    if (await pathKind(directory) !== 'directory') throw new Error(`skill not found: ${name}`)
    const files = {}
    const collect = async (current, prefix, depth) => {
      if (depth > MAX_WALK_DEPTH) return
      for (const row of await readdir(current, { withFileTypes: true })) {
        if (row.name === '.trash' || row.name === '.backups') continue
        const absolute = join(current, row.name)
        const relative = prefix === '' ? row.name : `${prefix}/${row.name}`
        if (row.isDirectory()) await collect(absolute, relative, depth + 1)
        else if (row.isFile()) files[relative] = new Uint8Array(await readFile(absolute))
      }
    }
    await collect(directory, name, 0)
    if (Object.keys(files).length === 0) throw new Error(`skill has no files: ${name}`)
    return { name, buffer: Buffer.from(zipSync(files, { level: 6 })) }
  }

  /**
   * 导出到系统下载目录。桌面端浏览器不一定允许 <a download> 落盘，
   * 直接由插件写文件更可靠，写完把绝对路径回报给界面。
   */
  async exportSkillToDownloads(input) {
    const archive = await this.exportSkillZip(input)
    const directory = downloadsRoot()
    await mkdir(directory, { recursive: true })
    const target = join(directory, `${archive.name}.zip`)
    await writeFile(target, archive.buffer)
    return { name: archive.name, path: target, directory }
  }

  /** 导出后把文件管理器定位到那个 zip，省得用户自己翻目录。 */
  async revealExport(input) {
    const raw = String(input?.path ?? '').trim()
    if (raw === '') throw new Error('path is required')
    const directory = resolve(downloadsRoot())
    const target = resolve(raw)
    // 只允许定位到下载目录里的东西，别让接口变成"打开任意路径"。
    if (target !== directory && !target.startsWith(directory + sep)) throw new Error('path outside downloads')
    if (await pathKind(target) === undefined) throw new Error(`not found: ${target}`)
    await revealInFileManager(target)
    return { ok: true, path: target }
  }

  async syncUserSkills(input = {}) {
    const sourceRoot = resolve(String(input.source ?? join(homedir(), '.dsh', 'skills')))
    const rows = await scanSkillDirectory(sourceRoot)
    const imported = []
    const skipped = []
    for (const row of rows) {
      try {
        const document = await readSkillDocument(row.path, row.directory)
        const target = join(SKILLS_ROOT, document.name)
        if (await pathKind(target) !== undefined && input.overwrite !== true) {
          skipped.push({ name: document.name, reason: 'already in the vault' })
          continue
        }
        const backedUp = await backupPath(target)
        await mkdir(dirname(target), { recursive: true })
        await cp(row.directory, target, { recursive: true })
        const copied = join(target, 'SKILL.md')
        if (await pathKind(copied) !== 'file') await cp(row.path, copied)
        imported.push({ name: document.name, from: row.directory, ...backedUp === undefined ? {} : { backup: backedUp } })
      } catch (error) {
        skipped.push({ name: basename(row.directory), reason: error.message })
      }
    }
    this.skillSignatures.clear()
    return { source: sourceRoot, imported, skipped }
  }

  async removeSkill(input) {
    const skillName = String(input.name ?? '').trim()
    if (!SKILL_NAME.test(skillName)) throw new Error(`invalid skill name ${JSON.stringify(skillName)}`)
    const directory = join(SKILLS_ROOT, skillName)
    if (await pathKind(directory) !== undefined) {
      const id = await this.moveToTrash(directory)
      this.skillSignatures.clear()
      return { removed: skillName, trash: id }
    }
    const target = join(SKILLS_ROOT, `${skillName}.md`)
    const backedUp = await backupPath(target)
    if (backedUp === undefined) throw new Error(`skill ${skillName} is not in the vault`)
    this.skillSignatures.clear()
    return { removed: skillName, backup: backedUp }
  }

  async listSkills() {
    const found = await this.readSkills()
    const rows = await scanSkillDirectory(SKILLS_ROOT)
    return {
      root: SKILLS_ROOT,
      skills: found.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
      })),
      invalid: rows
        .filter((row) => !found.some((skill) => skill.path === row.path))
        .map((row) => row.path),
    }
  }

  /** The exact SKILL.md bytes, for an editor that must round-trip every field. */
  async rawSkill(input) {
    const wanted = String(input.name ?? '').trim()
    const rows = await scanSkillDirectory(SKILLS_ROOT)
    for (const row of rows) {
      const document = await readSkillDocument(row.path, row.directory)
      if (document.name !== wanted) continue
      return { name: document.name, path: row.path, text: await readFile(row.path, 'utf8') }
    }
    throw new Error(`skill ${wanted} is not in the vault`)
  }

  async getSkill(input) {
    const rows = await scanSkillDirectory(SKILLS_ROOT)
    const wanted = String(input.name ?? '').trim()
    for (const row of rows) {
      const document = await readSkillDocument(row.path, row.directory)
      if (document.name !== wanted) continue
      return { ...document, signature: undefined }
    }
    throw new Error(`skill ${wanted} is not in the vault`)
  }

  async addMcp(input) {
    const catalogue = await this.readCatalogue()
    const servers = catalogue.servers.filter((entry) => entry.serverName !== String(input.serverName ?? '').trim())
    const previous = catalogue.servers.find((entry) => entry.serverName === String(input.serverName ?? '').trim())
    const entry = sanitizeServer(input, previous ?? {})
    servers.push(entry)
    await this.writeCatalogue({ version: 1, servers })
    const applied = await this.ensureMcpRows({ force: true })
    return { server: entry, applied }
  }

  async removeMcp(input) {
    const serverName = String(input.serverName ?? '').trim()
    const catalogue = await this.readCatalogue()
    const servers = catalogue.servers.filter((entry) => entry.serverName !== serverName)
    if (servers.length === catalogue.servers.length) throw new Error(`server ${serverName} is not in the vault`)
    await this.writeCatalogue({ version: 1, servers })
    this._entries = undefined
    const row = this.findEntry(rowIdOf(serverName))
    if (row !== undefined) await row.update({ config: row.options?.config })
    const applied = await this.ensureMcpRows({ force: true })
    return { removed: serverName, applied }
  }

  async toggleMcp(input, enabled) {
    const serverName = String(input.serverName ?? '').trim()
    const catalogue = await this.readCatalogue()
    const entry = catalogue.servers.find((item) => item.serverName === serverName)
    if (entry === undefined) throw new Error(`server ${serverName} is not in the vault`)
    entry.enabled = enabled
    await this.writeCatalogue(catalogue)
    this._entries = undefined
    this.appliedSignature = undefined
    const applied = await this.ensureMcpRows({ force: true })
    return { server: serverName, enabled, applied }
  }

  async reloadMcp() {
    this.appliedSignature = undefined
    return this.ensureMcpRows({ force: true })
  }

  async listMcp() {
    const catalogue = await this.readCatalogue()
    this.refreshRowStatus()
    return {
      file: MCP_FILE,
      servers: catalogue.servers.map((entry) => ({
        ...entry,
        ...this.mcpState.status?.[entry.serverName] === undefined ? {} : { status: this.mcpState.status[entry.serverName] },
      })),
      rejected: catalogue.rejected ?? [],
    }
  }

  // -- 插件 MCP 仓库：导入 / 导出 ------------------------------------------

  /** 导出成和 mcp/mcp.json 同构的 JSON，拿到别处（或别的机器）直接能再导入。 */
  async exportMcp(input = {}) {
    const catalogue = await this.readCatalogue()
    const name = String(input.serverName ?? '').trim()
    const servers = name === '' ? catalogue.servers : catalogue.servers.filter((entry) => entry.serverName === name)
    if (servers.length === 0) throw new Error(name === '' ? '插件 MCP 仓库里还没有服务' : `server ${name} is not in the vault`)
    const directory = downloadsRoot()
    await mkdir(directory, { recursive: true })
    const file = join(directory, `${name === '' ? 'plugin-mcp' : name}.mcp.json`)
    await writeFile(file, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`)
    return { file, directory, count: servers.length }
  }

  /**
   * 导入 MCP 配置。认得三种写法：插件的 {version,servers:[]}、服务器数组、
   * 以及 Claude/Cursor 的 {mcpServers:{name:{...}}}；同名条目按覆盖处理。
   */
  async importMcp(input = {}) {
    const text = typeof input.json === 'string' ? input.json : JSON.stringify(input.servers ?? input)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('不是合法的 JSON')
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.servers)
        ? parsed.servers
        : parsed?.mcpServers && typeof parsed.mcpServers === 'object'
          ? Object.entries(parsed.mcpServers).map(([key, value]) => typeof value === 'string' ? { serverName: key, url: value } : { serverName: key, ...(value ?? {}) })
          : parsed && typeof parsed === 'object'
            ? [parsed]
            : []
    if (list.length === 0) throw new Error('没有找到 MCP 服务条目')
    const catalogue = await this.readCatalogue()
    const byName = new Map(catalogue.servers.map((entry) => [entry.serverName, entry]))
    const added = []
    const updated = []
    const failed = []
    for (const raw of list) {
      try {
        if (raw === null || typeof raw !== 'object') throw new Error('条目不是对象')
        const rawName = String(raw.serverName ?? raw.name ?? raw.id ?? '').trim()
        // 别的 Agent 允许带点号之类的名字，这里统一换成连字符，免得整条被拒。
        const name = rawName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
        if (name === '') throw new Error('缺少服务名')
        const previous = byName.get(name)
        const entry = sanitizeServer(normalizeImportedServer(raw, name), previous ?? {})
        byName.set(name, entry)
        if (previous === undefined) added.push(name)
        else updated.push(name)
      } catch (error) {
        failed.push({ name: String(raw?.serverName ?? raw?.name ?? '?'), error: String(error?.message ?? error) })
      }
    }
    if (added.length === 0 && updated.length === 0) throw new Error(failed.map((item) => `${item.name}: ${item.error}`).join('；') || '没有可导入的服务')
    await this.writeCatalogue({ version: 1, servers: [...byName.values()] })
    this._entries = undefined
    const applied = await this.ensureMcpRows({ force: true })
    return { added, updated, failed, applied }
  }

  /**
   * 给一个 GitHub 仓库地址，猜出「新增 MCP 服务」该填什么。
   * 优先级：仓库里直接给了 mcpServers 配置 > README 里的启动命令 > package.json 的包名。
   * 只是**建议**，前端会把结果填进表单让用户确认，不直接落盘。
   */
  async inspectMcpSource(input = {}) {
    const raw = String(input.url ?? '').trim()
    if (raw === '') throw new Error('先填一个仓库地址')
    const target = parseGithubTarget(raw)
    if (target === undefined) {
      throw new Error('只支持 GitHub 仓库地址（github.com/owner/repo），或 raw.githubusercontent.com 上的 .json')
    }
    const notes = []
    let branch = target.ref
    if (branch === undefined) {
      try {
        const meta = JSON.parse(await fetchText(`https://api.github.com/repos/${target.owner}/${target.repo}`))
        if (typeof meta?.default_branch === 'string' && meta.default_branch !== '') branch = meta.default_branch
      } catch {
        notes.push('没读到仓库信息（可能被限流），按 main / master 试')
      }
    }
    const branches = branch === undefined ? ['main', 'master'] : [branch]
    const readRaw = async (path) => {
      for (const candidate of branches) {
        try {
          return await fetchText(`https://raw.githubusercontent.com/${target.owner}/${target.repo}/${candidate}/${path}`)
        } catch {
          // 这个分支没有就换下一个
        }
      }
      return undefined
    }
    const finish = (entry, confidence, evidence) => {
      const serverName = sanitizeServerName(entry.serverName ?? entry.name ?? target.repo) || 'mcp-server'
      const normalized = sanitizeServer(normalizeImportedServer(entry, serverName), {})
      return {
        serverName: normalized.serverName,
        transport: normalized.transport,
        command: normalized.command ?? '',
        args: normalized.args ?? [],
        url: normalized.url ?? '',
        confidence,
        evidence,
        source: `https://github.com/${target.owner}/${target.repo}`,
        notes,
      }
    }

    // 1) 地址直接指向一个 .json 配置文件
    if (target.file !== '' && target.file.toLowerCase().endsWith('.json')) {
      const text = await readRaw(target.file)
      if (text === undefined) throw new Error(`读不到 ${target.file}`)
      const entry = serverFromJsonText(text)
      if (entry === undefined) throw new Error(`${target.file} 里没有找到 MCP 服务条目`)
      return finish(entry, 'high', `${target.file} 里的配置`)
    }

    // 2) README：先看有没有现成的 mcpServers 片段，再看启动命令
    let readme
    for (const name of ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README.rst', 'README']) {
      readme = await readRaw(name)
      if (readme !== undefined) break
    }
    const jsonEntry = readme === undefined ? undefined : serverFromJsonText(readme)
    if (jsonEntry !== undefined) return finish(jsonEntry, 'high', 'README 里贴的 mcpServers 配置')
    const candidate = readme === undefined ? undefined : commandFromReadme(readme)
    if (candidate !== undefined) {
      if (candidate.installer) notes.push('这行更像安装/初始化命令，不一定是启动命令，提交前确认一下')
      if (candidate.placeholderArgs) notes.push('参数里有占位符（token / 路径），记得换成你自己的')
      return finish(
        { serverName: target.repo, transport: 'stdio', command: candidate.command, args: candidate.args },
        candidate.score >= 3 ? 'high' : candidate.score === 2 ? 'medium' : 'low',
        `README 示例：${candidate.line}`,
      )
    }

    // 3) package.json 的包名：MCP 服务大多发在 npm 上，npx 是最通用的跑法
    const pkgText = await readRaw('package.json')
    if (pkgText !== undefined) {
      let pkg
      try {
        pkg = JSON.parse(pkgText)
      } catch {
        pkg = undefined
      }
      if (pkg !== undefined && typeof pkg.name === 'string' && pkg.name !== '') {
        const looksMcp = /mcp/i.test(pkg.name)
          || (Array.isArray(pkg.keywords) && pkg.keywords.some((keyword) => /mcp/i.test(String(keyword))))
          || pkg.bin !== undefined
        if (looksMcp) {
          return finish(
            { serverName: target.repo, transport: 'stdio', command: 'npx', args: ['-y', pkg.name] },
            'medium',
            `package.json 的 name：${pkg.name}（按 npx 试）`,
          )
        }
      }
    }

    throw new Error(`没能从 ${target.owner}/${target.repo} 认出启动命令。到它的 README 里找 npx / uvx / docker run 那一行，手动填到下面。`)
  }

  // -- skill sources -------------------------------------------------------

  /**
   * Every skill root this page accounts for: the vault, the machine-wide
   * folders other agents keep their skills in, and the per-workspace folders
   * that make project skills project-scoped.
   */
  async skillRoots() {
    const roots = SKILL_SOURCES.map((source) => ({
      id: source.id,
      label: source.label,
      brand: source.brand ?? source.id,
      kind: source.kind ?? 'global',
      path: skillSourceDir(source),
    }))
    const workspaces = this.workspaceDirectories()
    for (const entry of workspaces) {
      for (const relative of PROJECT_SKILL_DIRS) {
        roots.push({
          id: 'project:' + entry.name + ':' + relative.id,
          label: entry.name + ' · ' + relative.label,
          brand: relative.brand,
          kind: 'project',
          path: join(entry.path, relative.file),
        })
      }
    }
    return roots
  }

  /** Workspace roots known to this Host, without failing when none are registered. */
  workspaceDirectories() {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return []
      return registry.list().map((workspace) => ({
        name: workspace.title || basename(workspace.path),
        path: workspace.path,
      }))
    } catch {
      return []
    }
  }

  /**
   * Every skill on this machine grouped by its declaring folder. Enablement
   * comes from the SKILL.md policy bits, and `overridden` marks a name an
   * earlier root already claims — the same shadowing the loader applies.
   */
  async skillSourceView() {
    const groups = []
    const claimed = new Map()
    const counts = { total: 0, enabled: 0, disabled: 0, overridden: 0, invalid: 0, projects: 0, sources: 0 }
    for (const root of await this.skillRoots()) {
      const exists = await pathKind(root.path) !== undefined
      const group = {
        id: root.id,
        label: root.label,
        brand: root.brand,
        kind: root.kind,
        path: root.path,
        exists,
        skills: [],
        total: 0,
        enabled: 0,
        disabled: 0,
        overridden: 0,
        invalid: 0,
      }
      if (exists) {
        for (const row of await scanSkillDirectory(root.path)) {
          let document
          try {
            document = await readSkillDocument(row.path, row.directory)
          } catch (error) {
            group.invalid += 1
            group.skills.push({
              name: basename(row.directory),
              path: row.path,
              directory: row.directory,
              source: root.id,
              kind: root.kind,
              invalid: true,
              enabled: false,
              reason: String(error?.message ?? error),
            })
            continue
          }
          const on = document.modelInvocable || document.userInvocable
          const shadow = claimed.get(document.name)
          if (shadow === undefined) claimed.set(document.name, root.id)
          if (on) group.enabled += 1
          else group.disabled += 1
          if (shadow !== undefined) group.overridden += 1
          group.skills.push({
            name: document.name,
            description: document.description,
            path: row.path,
            directory: row.directory,
            source: root.id,
            kind: root.kind,
            enabled: on,
            overridden: shadow !== undefined,
            overriddenBy: shadow,
            invalid: false,
          })
        }
        group.total = group.skills.length
      }
      group.disabled = Math.max(0, group.total - group.enabled - group.invalid)
      counts.total += group.total
      counts.enabled += group.enabled
      counts.disabled += group.disabled
      counts.overridden += group.overridden
      counts.invalid += group.invalid
      if (group.total > 0) counts.sources += 1
      if (group.kind === 'project' && group.total > 0) counts.projects += 1
      groups.push(group)
    }
    return { groups, counts, trash: await this.listTrash().then((view) => view.items.length) }
  }

  /** Turn one skill, or a whole root, on or off through its policy bits. */
  async toggleSkillSource(input) {
    const enabled = input.enabled !== false
    const targets = []
    if (typeof input.path === 'string' && input.path.trim() !== '') {
      targets.push(input.path.trim())
    } else {
      const sourceId = String(input.sourceId ?? '').trim()
      const root = (await this.skillRoots()).find((item) => item.id === sourceId)
      if (root === undefined) throw new Error('unknown skill source ' + sourceId)
      for (const row of await scanSkillDirectory(root.path)) {
        let document
        try {
          document = await readSkillDocument(row.path, row.directory)
        } catch {
          continue
        }
        const on = document.modelInvocable || document.userInvocable
        if (on !== enabled) targets.push(row.path)
      }
    }
    const changed = []
    for (const path of targets) changed.push(await setSkillPolicy(path, enabled))
    this.skillSignatures.clear()
    return { enabled, changed }
  }

  /** Create a template skill directly inside one root (the row's "+"). */
  async addSkillToSource(input) {
    const sourceId = String(input.sourceId ?? '').trim()
    const name = String(input.name ?? '').trim()
    if (!SKILL_NAME.test(name)) throw new Error('invalid skill name ' + JSON.stringify(name))
    const root = (await this.skillRoots()).find((item) => item.id === sourceId)
    if (root === undefined) throw new Error('unknown skill source ' + sourceId)
    const directory = join(root.path, name)
    if (await pathKind(directory) !== undefined) throw new Error(name + ' already exists in ' + root.path)
    const document = input.document === undefined
      ? ['---', 'name: ' + name, 'description: ' + (String(input.description ?? '').trim() || '一句话说明什么时候该用它'), '---', '', '## 步骤', '', '1. ', ''].join('\n')
      : String(input.document)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), document)
    this.skillSignatures.clear()
    return { created: name, path: join(directory, 'SKILL.md'), source: sourceId }
  }

  // -- trash ---------------------------------------------------------------

  trashRoot() {
    return join(SKILLS_ROOT, '.trash')
  }

  /** Move a skill folder into the vault trash instead of deleting it. */
  async moveToTrash(directory) {
    const root = this.trashRoot()
    await mkdir(root, { recursive: true })
    const id = stamp() + '-' + basename(directory)
    await rename(directory, join(root, id)).catch(async (error) => {
      throw new Error('move to trash failed: ' + error.message)
    })
    return id
  }

  async listTrash() {
    const root = this.trashRoot()
    const names = await readdir(root).catch(() => [])
    const items = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      const directory = join(root, name)
      const document = join(directory, 'SKILL.md')
      let description
      let title = stripTrashStamp(name)
      try {
        const parsed = await readSkillDocument(document, directory)
        title = parsed.name
        description = parsed.description
      } catch {
        // A trashed entry without readable frontmatter still lists by folder name.
      }
      items.push({ id: name, name: title, description, path: directory })
    }
    items.sort((left, right) => right.id.localeCompare(left.id))
    return { root, items }
  }

  async restoreTrash(input) {
    const id = String(input.id ?? '').trim()
    if (id === '' || id.includes('/') || id.includes('\\')) throw new Error('invalid trash id')
    const source = join(this.trashRoot(), id)
    if (await pathKind(source) === undefined) throw new Error(id + ' is not in the trash')
    const name = stripTrashStamp(id)
    let target = join(SKILLS_ROOT, name)
    if (await pathKind(target) !== undefined) target = join(SKILLS_ROOT, name + '-' + stamp())
    await rename(source, target)
    this.skillSignatures.clear()
    return { restored: basename(target) }
  }

  async emptyTrash() {
    const root = this.trashRoot()
    const names = await readdir(root).catch(() => [])
    let removed = 0
    for (const name of names) {
      if (name.startsWith('.')) continue
      await rm(join(root, name), { recursive: true, force: true })
      removed += 1
    }
    return { removed }
  }

  // -- discovery -----------------------------------------------------------

  /**
   * Look inside a folder, a link, or a git repository for skills that are not
   * in the vault yet. Nothing is installed until `installDiscovered` runs.
   */
  async discoverSkills(input) {
    const source = String(input.source ?? '').trim()
    if (source === '') throw new Error('source is required')
    const items = []
    if (/^https?:\/\//i.test(source)) {
      if (/\.md(\?|#|$)/i.test(source)) {
        const text = await fetchText(source)
        const document = parseSkillDocument(text, { name: undefined, directory: source })
        items.push({ name: document.name, description: document.description, origin: source, kind: 'document' })
      } else {
        const listing = await fetchGithubDirectory(source)
        items.push(...listing)
      }
      return { source, kind: 'remote', items }
    }
    const absolute = isAbsolute(source) ? source : resolve(this.workspaceRoot() ?? PACKAGE_ROOT, source)
    if (await pathKind(absolute) === undefined) throw new Error('not found: ' + absolute)
    const direct = join(absolute, 'SKILL.md')
    if (await pathKind(direct) !== undefined) {
      const document = await readSkillDocument(direct, absolute)
      items.push({ name: document.name, description: document.description, origin: absolute, kind: 'directory' })
      return { source: absolute, kind: 'local', items }
    }
    for (const row of await scanSkillDirectory(absolute)) {
      try {
        const document = await readSkillDocument(row.path, row.directory)
        items.push({ name: document.name, description: document.description, origin: row.directory, kind: 'directory' })
      } catch {
        // Skip entries that are not usable skills.
      }
    }
    return { source: absolute, kind: 'local', items }
  }

  /** Copy discovered skills into the vault. */
  async installDiscovered(input) {
    const origins = Array.isArray(input.origins) ? input.origins.map(String) : []
    if (origins.length === 0) throw new Error('nothing selected')
    const installed = []
    for (const origin of origins) {
      if (/^https?:\/\//i.test(origin)) {
        const text = await fetchText(origin)
        const document = parseSkillDocument(text, { name: undefined, directory: origin })
        if (!SKILL_NAME.test(document.name)) throw new Error('invalid skill name in ' + origin)
        const directory = join(SKILLS_ROOT, document.name)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'SKILL.md'), text)
        installed.push(document.name)
        continue
      }
      const name = basename(origin)
      const target = join(SKILLS_ROOT, name)
      if (await pathKind(target) !== undefined) throw new Error(name + ' already exists in the vault')
      await cp(origin, target, { recursive: true })
      installed.push(name)
    }
    this.skillSignatures.clear()
    return { installed }
  }

  /** Where relative discovery paths resolve from. */
  workspaceRoot() {
    const directories = this.workspaceDirectories()
    return directories.length > 0 ? directories[0].path : PACKAGE_ROOT
  }

  // -- global sources ------------------------------------------------------

  /**
   * Read every configured global source and normalise what it declares into
   * the same server shape this vault stores, so a server can be adopted
   * without hand-copying it.
   */
  async scanGlobalSources() {
    const groups = []
    for (const source of MCP_SOURCES) {
      const group = {
        id: source.id,
        label: source.label,
        kind: source.kind,
        detail: source.kind === 'dsh' ? source.detail : '',
        paths: [],
        servers: [],
        error: undefined,
      }
      try {
        if (source.kind === 'dsh') await this.collectDshServers(group)
        else if (source.kind === 'json') await this.collectJsonServers(source, group)
        else if (source.kind === 'toml') await this.collectTomlServers(source, group)
      } catch (error) {
        group.error = String(error?.message ?? error)
      }
      groups.push(group)
    }
    return groups
  }

  async collectDshServers(group) {
    const profilesDir = join(homedir(), '.dsh', 'profiles')
    const names = await readdir(profilesDir).catch(() => [])
    for (const name of names) {
      if (name.startsWith('.')) continue
      const file = join(profilesDir, name, 'cordis.yml')
      const text = await readTextIfPresent(file)
      if (text === undefined) continue
      group.paths.push(file)
      const rows = text.split(/\n(?=- id: )/)
      for (const row of rows) {
        if (!row.includes(MCP_CLIENT_PACKAGE)) continue
        const id = /^- id:\s*(\S+)/.exec(row)?.[1]
        const serverName = /serverName:\s*['"]?([A-Za-z0-9_-]{1,32})/.exec(row)?.[1]
        if (serverName === undefined) continue
        const disabled = /disabled:\s*true/.test(row)
        const command = /command:\s*(.+)/.exec(row)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
        const url = /url:\s*(\S+)/.exec(row)?.[1]
        group.servers.push({
          name: serverName,
          transport: command === undefined && url !== undefined ? 'streamable-http' : 'stdio',
          command,
          url,
          from: 'profile:' + name,
          rowId: id,
          enabled: disabled !== true,
          raw: { disabled },
        })
      }
    }
  }

  async collectJsonServers(source, group) {
    const file = join(homedir(), source.file)
    const text = await readTextIfPresent(file)
    if (text === undefined) return
    group.paths.push(file)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      group.error = source.file + ' 不是合法 JSON：' + error.message
      return
    }
    const table = source.keys.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), parsed)
    if (table === undefined || typeof table !== 'object') return
    for (const [name, entry] of Object.entries(table)) {
      if (!SERVER_NAME.test(name)) continue
      const isHttp = typeof entry?.url === 'string'
      group.servers.push({
        name,
        transport: isHttp ? 'streamable-http' : 'stdio',
        command: typeof entry?.command === 'string' ? entry.command : undefined,
        url: typeof entry?.url === 'string' ? entry.url : undefined,
        args: Array.isArray(entry?.args) ? entry.args.map(String) : [],
        env: entry?.env !== null && typeof entry?.env === 'object' ? entry.env : {},
        from: source.id,
        enabled: entry?.disabled !== true,
        raw: { disabled: entry?.disabled === true },
      })
    }
  }

  async collectTomlServers(source, group) {
    const file = join(homedir(), source.file)
    const text = await readTextIfPresent(file)
    if (text === undefined) return
    group.paths.push(file)
    let current
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#')) continue
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header !== null) {
        const path = header[1].split('.')
        if (path[0] === source.keys[0] && path.length === 2) {
          const name = path[1].replace(/^["']|["']$/g, '')
          if (SERVER_NAME.test(name)) {
            current = { name }
            group.servers.push({
              name,
              transport: 'stdio',
              command: undefined,
              url: undefined,
              args: [],
              env: {},
              from: source.id,
              enabled: true,
              raw: {},
            })
          } else {
            current = undefined
          }
        } else if (path[0] === source.keys[0] && path[2] === 'env' && current !== undefined) {
          current = { name: current.name, inEnv: true }
        } else {
          current = undefined
        }
        continue
      }
      if (current === undefined) continue
      const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
      if (pair === null) continue
      const key = pair[1]
      const value = pair[2].replace(/\s*#.*$/, '').trim()
      const server = group.servers.find((item) => item.name === current.name)
      if (server === undefined) continue
      if (current.inEnv === true) {
        if (key !== 'env') server.env[key] = unquote(value)
        continue
      }
      if (key === 'command') server.command = unquote(value)
      else if (key === 'url') {
        server.url = unquote(value)
        server.transport = 'streamable-http'
      } else if (key === 'args') server.args = parseInlineArray(value)
      else if (key === 'enabled') server.enabled = value !== 'false'
    }
  }

  /**
   * The global view the panel renders: every source, its servers, and whether
   * this vault already carries each one.
   */
  async globalView() {
    const groups = await this.scanGlobalSources()
    const catalogue = await this.readCatalogue()
    const known = new Map(catalogue.servers.map((entry) => [entry.serverName, entry]))
    let total = 0
    let adopted = 0
    for (const group of groups) {
      for (const server of group.servers) {
        total += 1
        const entry = known.get(server.name)
        server.inVault = entry !== undefined
        server.vaultEnabled = entry === undefined ? false : entry.enabled !== false
        if (server.inVault) adopted += 1
      }
      // One row can be declared by both the home patch and a profile patch;
      // the name is the identity a server is adopted under.
      const seen = new Set()
      group.servers = group.servers.filter((server) => {
        if (seen.has(server.name)) return false
        seen.add(server.name)
        return true
      })
      group.total = group.servers.length
      group.adopted = group.servers.filter((server) => server.inVault).length
      group.enabled = group.servers.some((server) => server.vaultEnabled)
    }
    return {
      groups,
      counts: {
        sources: groups.length,
        total,
        adopted,
        pending: total - adopted,
        vault: catalogue.servers.length,
      },
      vault: catalogue.servers.map((entry) => entry.serverName),
    }
  }

  /** Adopt one scanned server into the catalogue, keeping its origin. */
  async adoptGlobal(input) {
    const name = String(input.serverName ?? '').trim()
    if (!SERVER_NAME.test(name)) throw new Error('invalid serverName ' + JSON.stringify(name))
    const groups = await this.scanGlobalSources()
    const server = groups.flatMap((group) => group.servers).find((item) => item.name === name)
    if (server === undefined) throw new Error(name + ' 不在任何全局配置里')
    return this.adoptServers([server])
  }

  async adoptServers(list) {
    const catalogue = await this.readCatalogue()
    const names = new Set(list.map((server) => server.name))
    const servers = catalogue.servers.filter((entry) => !names.has(entry.serverName))
    const adopted = []
    const unique = new Map()
    for (const server of list) if (!unique.has(server.name)) unique.set(server.name, server)
    for (const server of unique.values()) {
      if (server.command === undefined && server.url === undefined) continue
      const entry = sanitizeServer({
        serverName: server.name,
        transport: server.transport,
        ...server.transport === 'stdio'
          ? { command: server.command, args: server.args ?? [], env: server.env ?? {} }
          : { url: server.url },
        enabled: server.enabled !== false,
      })
      entry.source = server.from
      servers.push(entry)
      adopted.push(server.name)
    }
    await this.writeCatalogue({ version: 1, servers })
    this._entries = undefined
    const applied = await this.ensureMcpRows({ force: true })
    return { adopted, applied }
  }

  /** Adopt or drop every server one source declares. */
  async toggleGlobalSource(input) {
    const sourceId = String(input.sourceId ?? '').trim()
    const groups = await this.scanGlobalSources()
    const group = groups.find((item) => item.id === sourceId)
    if (group === undefined) throw new Error('unknown source ' + sourceId)
    if (input.enabled === false) {
      const catalogue = await this.readCatalogue()
      const names = new Set(group.servers.map((server) => server.name))
      const servers = catalogue.servers.filter((entry) => !names.has(entry.serverName))
      await this.writeCatalogue({ version: 1, servers })
      this._entries = undefined
      const applied = await this.ensureMcpRows({ force: true })
      return { source: sourceId, enabled: false, applied }
    }
    const result = await this.adoptServers(group.servers)
    return { source: sourceId, enabled: true, ...result }
  }

  // -- watching ------------------------------------------------------------

  async tick() {
    if (this.reloading) return
    this.reloading = true
    try {
      const catalogue = await this.readCatalogue()
      const signature = JSON.stringify(catalogue.servers.filter((entry) => entry.enabled !== false))
      if (signature !== this.appliedSignature) await this.ensureMcpRows()
      else this.refreshRowStatus()
    } catch (error) {
      this.ctx.logger.warn(`skill-mcp-vault: ${error.message}`)
    } finally {
      this.reloading = false
    }
  }

  // -- tools ---------------------------------------------------------------

  installTools(target = this.ctx) {
    const ctx = target
    const run = (action, input, domain) => this.runAction(action, input, domain)

    ctx.tools.register(defineTool({
      name: 'skill_vault',
      description: 'Manage the skill repository stored inside the dsh-skill-mcp-vault plugin. The skills it holds are registered with this session automatically, so adding one makes it loadable through the `skill` tool without a restart. Actions: list, get, add_skill (name/description/body, or source as a URL, SKILL.md path, or skill directory), import_skill (copy a directory or SKILL.md into the vault), sync_user_skills (copy ~/.dsh/skills into the vault), remove_skill, info.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'add_skill', 'import_skill', 'sync_user_skills', 'remove_skill', 'info', 'scan_skills', 'toggle_skill', 'add_skill_to_source', 'list_trash', 'restore_trash', 'empty_trash', 'discover_skills', 'install_discovered'],
            description: 'Operation to perform on the skill repository.',
          },
          name: { type: 'string', description: 'Skill name (lowercase words joined by hyphens).' },
          description: { type: 'string', description: 'Routing description shown in the skill catalog.' },
          whenToUse: { type: 'string', description: 'Optional narrower usage note.' },
          body: { type: 'string', description: 'Skill body Markdown; a full SKILL.md with frontmatter is also accepted.' },
          source: { type: 'string', description: 'URL, absolute/local SKILL.md path, skill directory, or source root for sync_user_skills.' },
          overwrite: { type: 'boolean', description: 'sync_user_skills: replace vault skills of the same name.' },
          sourceId: { type: 'string', description: 'toggle_skill: skill source id from scan_skills, such as dsh, codex or vault.' },
          enabled: { type: 'boolean', description: 'toggle_skill: whether the skill or source stays available.' },
          id: { type: 'string', description: 'restore_trash: trash id from list_trash.' },
          source: { type: 'string', description: 'discover_skills: local folder, https skill link, or GitHub repository address.' },
          origins: { type: 'array', items: { type: 'string' }, description: 'install_discovered: origins returned by discover_skills.' },
          modelInvocable: { type: 'boolean', description: 'add_skill: allow model invocation (default true).' },
          userInvocable: { type: 'boolean', description: 'add_skill: allow user invocation (default true).' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return run(args.action, args, 'skill')
      },
      presentCall(args) {
        return { card: 'generic', title: `skill_vault · ${args.action}`, kind: 'other', rawInput: args.name ?? args.action }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'mcp_vault',
      description: 'Manage the MCP server catalogue stored inside the dsh-skill-mcp-vault plugin (mcp/mcp.json). Each enabled entry becomes one MCP client row, and a catalogue change reloads only that row, so a running session is not interrupted. Actions: list, add, remove, enable, disable, reload, info. Servers added here appear as mcp__<serverName>__<tool> once connected.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'remove', 'enable', 'disable', 'reload', 'info', 'scan_globals', 'adopt_global', 'toggle_global_source'],
            description: 'Operation to perform on the MCP catalogue. scan_globals lists every MCP server declared by this machine\u2019s other agents; adopt_global brings one into the vault; toggle_global_source adopts or drops a whole source.',
          },
          serverName: { type: 'string', description: 'Server name, [A-Za-z0-9_-]{1,32}; also the tool prefix.' },
          transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Transport; inferred from url when omitted.' },
          command: { type: 'string', description: 'stdio: executable.' },
          args: { type: 'array', items: { type: 'string' }, description: 'stdio: arguments.' },
          env: { type: 'object', additionalProperties: true, description: 'stdio: environment variables.' },
          cwd: { type: 'string', description: 'stdio: working directory.' },
          url: { type: 'string', description: 'streamable-http: endpoint URL.' },
          headers: { type: 'object', additionalProperties: true, description: 'streamable-http: request headers.' },
          toolCallTimeoutMs: { type: 'number', description: 'Per-tool-call timeout, default 60000.' },
          failOnStartupError: { type: 'boolean', description: 'Fail the row when the server cannot start.' },
          enabled: { type: 'boolean', description: 'Whether this server should be connected.' },
          sourceId: { type: 'string', description: 'toggle_global_source: source id from scan_globals, such as codex or claude.' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return run(args.action, args, 'mcp')
      },
      presentCall(args) {
        return { card: 'generic', title: `mcp_vault · ${args.action}`, kind: 'other', rawInput: args.serverName ?? args.action }
      },
    }))
  }

  async runAction(action, input = {}, domain = 'skill') {
    switch (action) {
      case 'info': return this.info()
      case 'list': return domain === 'mcp' ? this.listMcp() : this.listSkills()
      case 'get': return this.getSkill(input)
      case 'add_skill': return this.addSkill(input)
      case 'import_skill': return this.importSkill(input)
      case 'sync_user_skills': return this.syncUserSkills(input)
      case 'scan_skills': return this.skillSourceView()
      case 'toggle_skill': return this.toggleSkillSource(input)
      case 'add_skill_to_source': return this.addSkillToSource(input)
      case 'list_trash': return this.listTrash()
      case 'restore_trash': return this.restoreTrash(input)
      case 'empty_trash': return this.emptyTrash()
      case 'discover_skills': return this.discoverSkills(input)
      case 'install_discovered': return this.installDiscovered(input)
      case 'remove_skill': return this.removeSkill(input)
      case 'add': return this.addMcp(input)
      case 'remove': return this.removeMcp(input)
      case 'enable': return this.toggleMcp(input, true)
      case 'disable': return this.toggleMcp(input, false)
      case 'reload': return this.reloadMcp()
      case 'scan_globals': return this.globalView()
      case 'adopt_global': return this.adoptGlobal(input)
      case 'toggle_global_source': return this.toggleGlobalSource(input)
      default: throw new Error(`unknown action ${JSON.stringify(action)}`)
    }
  }

  // -- HTTP routes for the panel ------------------------------------------

  installRoutes(target = this.ctx) {
    const ctx = target
    // The Web carrier is Node's HTTP server: handlers own (req, res).
    const readBody = (req, limit = MAX_BODY_BYTES) => new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
    const send = (res, status, payload) => {
      const text = JSON.stringify(payload ?? {})
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      })
      res.end(text)
    }
    // 导出技能是二进制 zip，不能走 send 的 JSON 通道。
    const sendBinary = (res, status, buffer, filename) => {
      res.writeHead(status, {
        'content-type': 'application/zip',
        'content-length': buffer.length,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      })
      res.end(buffer)
    }
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-skill-mcp-vault/api',
      handler: async (req, res) => {
        try {
          const denied = blockedOrigin(req)
          if (denied !== undefined) return send(res, 403, { error: denied })
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const route = url.pathname.replace(/^\/dsh-skill-mcp-vault\/api\/?/, '').replace(/\/+$/, '')
          const method = (req.method ?? 'GET').toUpperCase()
          let body = {}
          if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
            // 上传是 base64 的 zip 或文件清单，体积远大于普通请求，单独放宽上限。
            const text = await readBody(req, route === 'upload' ? UPLOAD_BODY_BYTES : MAX_BODY_BYTES)
            if (text.trim() !== '') {
              try {
                body = JSON.parse(text)
              } catch {
                return send(res, 400, { error: 'invalid JSON body' })
              }
            }
          }
          if (route === 'skills' && method === 'GET') return send(res, 200, await this.listSkills())
          if (route === 'skills/global' && method === 'GET') return send(res, 200, await this.skillSourceView())
          if (route === 'skills/toggle' && method === 'POST') return send(res, 200, await this.toggleSkillSource(body))
          if (route === 'skills/add' && method === 'POST') return send(res, 200, await this.addSkillToSource(body))
          if (route === 'skills/trash' && method === 'GET') return send(res, 200, await this.listTrash())
          if (route === 'skills/trash/restore' && method === 'POST') return send(res, 200, await this.restoreTrash(body))
          if (route === 'skills/trash/empty' && method === 'POST') return send(res, 200, await this.emptyTrash())
          if (route === 'skills/discover' && method === 'POST') return send(res, 200, await this.discoverSkills(body))
          if (route === 'skills/install' && method === 'POST') return send(res, 200, await this.installDiscovered(body))
          if (route === 'skill' && method === 'GET') return send(res, 200, await this.getSkill({ name: url.searchParams.get('name') }))
          if (route === 'skill/raw' && method === 'GET') return send(res, 200, await this.rawSkill({ name: url.searchParams.get('name') }))
          if (route === 'skill/zip' && method === 'GET') {
            const archive = await this.exportSkillZip({ name: url.searchParams.get('name') })
            return sendBinary(res, 200, archive.buffer, `${archive.name}.zip`)
          }
          if (route === 'skill' && method === 'POST') return send(res, 200, await this.addSkill(body))
          if (route === 'skill' && method === 'DELETE') return send(res, 200, await this.removeSkill(body))
          if (route === 'import' && method === 'POST') return send(res, 200, await this.importSkill(body))
          if (route === 'upload' && method === 'POST') return send(res, 200, await this.uploadSkill(body))
          if (route === 'export' && method === 'POST') return send(res, 200, await this.exportSkillToDownloads(body))
          if (route === 'reveal' && method === 'POST') return send(res, 200, await this.revealExport(body))
          if (route === 'sync' && method === 'POST') return send(res, 200, await this.syncUserSkills(body))
          if (route === 'mcp' && method === 'GET') return send(res, 200, await this.listMcp())
          if (route === 'mcp' && method === 'POST') return send(res, 200, await this.addMcp(body))
          if (route === 'mcp' && method === 'DELETE') return send(res, 200, await this.removeMcp(body))
          if (route === 'mcp/export' && method === 'POST') return send(res, 200, await this.exportMcp(body))
          if (route === 'mcp/inspect' && method === 'POST') return send(res, 200, await this.inspectMcpSource(body))
          if (route === 'mcp/import' && method === 'POST') return send(res, 200, await this.importMcp(body))
          if (route === 'mcp/toggle' && method === 'POST') return send(res, 200, await this.toggleMcp(body, body.enabled !== false))
          if (route === 'mcp/reload' && method === 'POST') return send(res, 200, await this.reloadMcp())
          if (route === 'global' && method === 'GET') return send(res, 200, await this.globalView())
          if (route === 'global/adopt' && method === 'POST') return send(res, 200, await this.adoptGlobal(body))
          if (route === 'global/toggle' && method === 'POST') return send(res, 200, await this.toggleGlobalSource(body))
          if (route === 'info' && method === 'GET') return send(res, 200, await this.info())
          return send(res, 404, { error: 'unknown route ' + method + ' ' + route })
        } catch (error) {
          return send(res, 400, { error: String(error?.message ?? error) })
        }
      },
    })
  }
}
