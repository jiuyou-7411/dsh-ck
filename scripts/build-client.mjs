// 从 src 构建仓库插件的客户端产物：技能页沿用 dsh-skills-manager，MCP 页是同一套结构的 MCP 版本。
// 用法：node scripts/build-client.mjs（需要 esbuild，经 ESBUILD_PATH 或本地 node_modules 解析）
import { build } from "esbuild";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "lib", "client.js");
const staging = join(root, "lib", "client.staging.js");
const backup = join(root, "lib", "client.previous.js");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await build({
  entryPoints: [join(root, "src", "entry.ts")],
  outfile: staging,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@deepseek-ai/dsh-client-ui-primitives"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
  },
  footer: { js: "return module.exports;\n} });" },
  logLevel: "error",
});

// 校验产物能被解析，再替换正式文件。
const text = await readFile(staging, "utf8");
if (!text.startsWith("window.__ModuleLoader__.load(")) throw new Error("bundle banner missing");
if (!text.trimEnd().endsWith("} });")) throw new Error("bundle footer missing");

await rm(backup, { force: true });
await rename(target, backup).catch(() => {});
await rename(staging, target);
await writeFile(join(root, "lib", ".client-build.json"), JSON.stringify({ bytes: text.length, at: new Date().toISOString() }, null, 2) + "\n");
console.log("[dsh-skill-mcp-vault] client built:", text.length, "bytes");
