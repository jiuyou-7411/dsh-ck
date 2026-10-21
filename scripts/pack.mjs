// 把插件打成可以 `npm install` 的 tarball。
//
// 为什么不直接用 `npm pack`：package.json 的 files 一旦列了 `skills/`、`mcp/` 这种"运行时会写东西"
// 的目录，npm 会把整个目录原样装进包 —— `.trash`（回收站）和 `.backups`（每次写入的备份）也会跟着走，
// 而 `.npmignore` 对 files 里列出的目录**不生效**（实测：trash 和 backups 照样出现在清单里）。
// 所以这里先复制出一份干净的暂存目录，再在暂存目录里打包。
//
// 用法：
//   node scripts/pack.mjs          打包，产物在项目根目录
//   node scripts/pack.mjs --guard  npm publish 时用：直接拦下来，避免把脏目录发出去
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "fflate";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, ".pack");

/** 运行时状态目录：绝不进包。 */
const EXCLUDED_NAMES = new Set([".trash", ".backups", ".pack", "node_modules"]);

if (process.argv.includes("--guard")) {
  console.error("[pack] 不要直接 npm publish 源码目录：skills/ 与 mcp/ 里可能带回收站和备份。");
  console.error("[pack] 正确流程：npm run pack  →  npm publish ./dsh-skill-mcp-vault-<version>.tgz");
  process.exit(1);
}

/**
 * 列出 .tgz 里的文件。npm 包是 gzip + tar（不是 zip），fflate 只解 gzip，
 * 所以这里手写一个够用的 tar 头解析（512 字节头，name 0..100，size 124..136 八进制）。
 */
function listTarball(buffer) {
  const tar = Buffer.from(gunzipSync(new Uint8Array(buffer)));
  const names = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0[\s\S]*$/, "").trim();
    const name = field(0, 100);
    const prefix = field(345, 500);
    const size = parseInt(field(124, 136), 8) || 0;
    if (name !== "") names.push(prefix === "" ? name : `${prefix}/${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) await collect(absolute, base, out);
    else if (entry.isFile()) out.push(absolute.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

async function main() {
  // 1) 先重建客户端产物，保证包里是最新的 UI
  console.log("[pack] build client …");
  execFileSync(process.execPath, [join(root, "scripts", "build-client.mjs")], { stdio: "inherit", cwd: root });

  // 2) 干净暂存目录
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // 3) 按白名单复制（package.json 的 files 就是这份清单）
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const patterns = pkg.files ?? [];
  const copied = new Set();
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      // 只用到 locale/*.json 这种一层通配
      const [dir, mask] = pattern.split("/");
      if (mask !== "*.json") throw new Error(`不支持的 files 通配：${pattern}`);
      for (const name of await readdir(join(root, dir))) {
        if (!name.endsWith(".json")) continue;
        await cp(join(root, dir, name), join(staging, dir, name));
        copied.add(`${dir}/${name}`);
      }
      continue;
    }
    const source = join(root, pattern);
    if (!(await exists(source))) continue;
    const info = await stat(source);
    if (info.isDirectory()) {
      await cp(source, join(staging, pattern), {
        recursive: true,
        filter: (from) => !EXCLUDED_NAMES.has(from.split(/[\\/]/).pop()),
      });
      for (const relative of await collect(source, source)) copied.add(`${pattern}/${relative}`);
    } else {
      await mkdir(dirname(join(staging, pattern)), { recursive: true });
      await cp(source, join(staging, pattern));
      copied.add(pattern);
    }
  }

  // 4) 暂存目录里的 package.json：
  //    - scripts 清空，否则暂存目录里再跑一次 npm pack 会重复触发构建
  //    - devDependencies 删掉，那是源码目录的构建工具，装包的人用不上
  const stagedPkg = { ...pkg, scripts: {} };
  delete stagedPkg.devDependencies;
  await writeFile(join(staging, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);

  // 4.5) mcp/mcp.json 是"作者自己的服务清单"，不能跟着包发出去，
  //      否则每个装包的人都会凭空多出一堆别人的 MCP 服务。发空仓库，让用户自己加。
  if (copied.has("mcp/mcp.json")) {
    const local = JSON.parse(await readFile(join(root, "mcp", "mcp.json"), "utf8"));
    const mine = Array.isArray(local.servers) ? local.servers.length : 0;
    await writeFile(join(staging, "mcp", "mcp.json"), `${JSON.stringify({ version: 1, servers: [] }, null, 2)}\n`);
    if (mine > 0) console.log(`[pack] mcp/mcp.json 已清空（本地 ${mine} 个服务不随包分发）`);
  }

  // 4.6) skills/ 是用户自己的技能库，如果里面有东西就提醒一声
  const skillEntries = (await readdir(join(root, "skills")).catch(() => [])).filter((name) => !name.startsWith("."));
  if (skillEntries.length > 0) {
    console.log(`[pack] 注意：skills/ 里有 ${skillEntries.length} 个技能会一起打进包：${skillEntries.slice(0, 5).join(", ")}`);
  }

  // 5) 打包
  // Windows 上 npm 是 npm.cmd，直接 spawn "npm" 会 ENOENT
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Node 20+ 在 Windows 上不允许直接 spawn .cmd（EINVAL），必须过一层 shell
  const output = execFileSync(npm, ["pack", "--json"], { cwd: staging, encoding: "utf8", shell: process.platform === "win32" });
  const result = JSON.parse(output.slice(output.indexOf("[")))[0];
  const tarball = join(staging, result.filename);
  const target = join(root, result.filename);
  await rm(target, { force: true });
  await cp(tarball, target);

  const buffer = await readFile(target);

  // 6) 自查：包里不能出现这些（用 fflate 解包，免得依赖系统 tar）
  const listing = listTarball(buffer);
  const problems = listing.filter((path) => /(^|\/)(\.trash|\.backups|node_modules|src|scripts)\//.test(path) || /client\.previous\.js|client\.build\.json/.test(path));
  if (problems.length > 0) {
    console.error("[pack] 包里有不该发布的东西：");
    for (const path of problems.slice(0, 20)) console.error("  -", path);
    process.exit(1);
  }

  // 仓库文件必须进包（插件靠它找 MCP 清单），但内容要是空的
  if (copied.has("mcp/mcp.json") && !listing.includes("package/mcp/mcp.json")) {
    console.error("[pack] 包里缺 mcp/mcp.json，装好后 MCP 面板会读不到仓库文件。");
    process.exit(1);
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  await writeFile(`${target}.sha256`, `${sha256}  ${result.filename}\n`);

  await rm(staging, { recursive: true, force: true });

  console.log("");
  console.log("[pack] 产物：", target);
  console.log("[pack] 大小：", (buffer.length / 1024).toFixed(1), "kB，", listing.length, "个文件");
  console.log("[pack] sha256：", sha256);
  console.log("[pack] 安装： npm install", result.filename);
  console.log("[pack] 发布： npm publish", result.filename);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
