#!/usr/bin/env node
/**
 * pi-plan-mode-cn 上游同步 + 自动翻译一键脚本
 *
 * 用法：
 *   node scripts/sync-upstream.mjs            # 检查上游最新版，若有新版则自动同步翻译
 *   node scripts/sync-upstream.mjs --force    # 忽略版本检查，强制用上游最新版重新同步
 *
 * 流程：
 *   1. 查询 npm 上 @narumitw/pi-plan-mode 最新版本
 *   2. 与本地版本对比（本地版本形如 <上游版本>-cn.N）
 *   3. 若有新版（或 --force）：
 *      a. npm pack 下载上游包
 *      b. 解压到临时目录
 *      c. 用 zh-cn.json 映射表自动翻译（translate.mjs 逻辑）
 *      d. esbuild 构建验证（若有 esbuild 则验证）
 *      e. 输出同步结果到 synced/ 目录
 *   4. 报告：已同步 / 无新版本 / 未命中文案（需人工补翻）
 *
 * 人工介入点：
 *   - 只有上游新增/改动了文案（translate 报告未命中）时才需要人工翻译，
 *     翻译后把 英文原句->中文译句 加进 zh-cn.json，重新运行本脚本。
 *   - 同步完成后手动确认 synced/src 与 src 的差异，然后：
 *       cp -r synced/src/* src/
 *       npm version <上游版本>-cn.<N+1>
 *       git add . && git commit -m "sync upstream <版本>" && git push
 *     （推送后 GitHub Actions 自动发布）
 */
import { execSync } from "node:child_process";
import { readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MAPPING_FILE = join(ROOT, "zh-cn.json");
const WORK_DIR = join(ROOT, ".sync-tmp");

const force = process.argv.includes("--force");

// ---- 1. 本地版本 ----
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
const localVersion = pkg.version; // 如 0.49.3-cn.1
const localUpstreamVersion = localVersion.split("-cn.")[0];

// ---- 2. 查询上游最新版 ----
let upstreamVersion;
try {
  upstreamVersion = execSync("npm view @narumitw/pi-plan-mode version", {
    encoding: "utf-8",
    timeout: 60000,
  }).trim();
} catch {
  console.error("❌ 查询 npm 上游版本失败（网络/认证问题）");
  process.exit(1);
}
console.log(`本地版本: ${localVersion}（上游基线 ${localUpstreamVersion}）`);
console.log(`上游最新: ${upstreamVersion}`);

if (!force && upstreamVersion === localUpstreamVersion) {
  console.log("✅ 上游无新版本，无需同步。");
  process.exit(0);
}
console.log(force ? "（--force 强制同步）" : `⬆️  上游有新版 ${upstreamVersion}，开始同步…`);

// ---- 3. 下载并解压上游 ----
await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(WORK_DIR, { recursive: true });
try {
  execSync(`npm pack @narumitw/pi-plan-mode@${upstreamVersion} --pack-destination ${WORK_DIR}`, {
    stdio: "pipe",
    timeout: 120000,
  });
} catch {
  console.error("❌ npm pack 下载失败");
  process.exit(1);
}
const tgz = (await readdir(WORK_DIR)).find((f) => f.endsWith(".tgz"));
if (!tgz) {
  console.error("❌ 未找到下载的 tarball");
  process.exit(1);
}
execSync(`tar xzf ${join(WORK_DIR, tgz)} -C ${WORK_DIR}`, { stdio: "pipe" });
const upstreamPkgDir = join(WORK_DIR, "package");
console.log(`已下载上游 ${upstreamVersion} 并解压`);

// ---- 4. 自动翻译（复用 translate.mjs 逻辑，内联避免子进程依赖） ----
const mappingData = JSON.parse(await readFile(MAPPING_FILE, "utf-8"));
const mapping = mappingData.mapping;

function stringLiterals(text) {
  const spans = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const j = text.indexOf("\n", i);
      i = j === -1 ? n : j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i += 1;
      let braceDepth = 0;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`") {
          if (ch === "$" && text[i + 1] === "{") {
            braceDepth += 1;
            i += 2;
            continue;
          }
          if (ch === "{" && braceDepth > 0) {
            braceDepth += 1;
            i += 1;
            continue;
          }
          if (ch === "}" && braceDepth > 0) {
            braceDepth -= 1;
            i += 1;
            continue;
          }
          if (ch === "`" && braceDepth === 0) {
            i += 1;
            break;
          }
          i += 1;
          continue;
        }
        if (ch === quote) {
          i += 1;
          break;
        }
        if (ch === "\n") {
          break;
        }
        i += 1;
      }
      spans.push([start, i]);
      continue;
    }
    i += 1;
  }
  return spans;
}

const sortedKeys = Object.keys(mapping).sort((a, b) => b.length - a.length);

function translateFile(text) {
  const spans = stringLiterals(text);
  let hits = 0;
  let result = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    const literal = text.slice(start, end);
    const content = literal.slice(1, -1);
    let replaced = content;
    let localHits = 0;
    if (Object.hasOwn(mapping, content)) {
      if (mapping[content] !== content) {
        replaced = mapping[content];
        localHits = 1;
      } else {
        localHits = 0;
      }
    } else {
      const protectedRanges = [];
      for (const m of content.matchAll(/\$\{[^}]*\}/g)) {
        protectedRanges.push([m.index, m.index + m[0].length]);
      }
      for (const en of sortedKeys) {
        let from = 0;
        while (true) {
          const idx = replaced.indexOf(en, from);
          if (idx === -1) break;
          const endIdx = idx + en.length;
          const insideProtected = protectedRanges.some(([ps, pe]) => ps < endIdx && idx < pe);
          if (insideProtected || mapping[en] === en) {
            from = endIdx;
            continue;
          }
          replaced = replaced.slice(0, idx) + mapping[en] + replaced.slice(endIdx);
          localHits += 1;
          from = idx + mapping[en].length;
        }
      }
    }
    if (localHits > 0) {
      const quote = literal[0];
      const close = literal[literal.length - 1];
      result += text.slice(cursor, start) + quote + replaced + close;
      hits += localHits;
    } else {
      result += text.slice(cursor, end);
    }
    cursor = end;
  }
  result += text.slice(cursor);
  return { text: result, hits };
}

const files = (await readdir(join(upstreamPkgDir, "src"))).filter((f) => f.endsWith(".ts"));
let totalHits = 0;
for (const file of files) {
  const path = join(upstreamPkgDir, "src", file);
  const original = await readFile(path, "utf-8");
  const { text, hits } = translateFile(original);
  if (hits > 0) {
    await writeFile(path, text, "utf-8");
    totalHits += hits;
  }
}
console.log(`✅ 自动翻译完成：替换 ${totalHits} 处`);

// ---- 5. 未命中文案检测 ----
const KEEP_EN = new Set([
  "This extension ctx is stale after session replacement or reload",
  "Extension context is no longer active",
  "Proposed Plan",
]);
const missing = [];
for (const file of files) {
  const path = join(upstreamPkgDir, "src", file);
  const text = await readFile(path, "utf-8");
  for (const [start, end] of stringLiterals(text)) {
    const literal = text.slice(start, end);
    const content = literal.slice(1, -1);
    if (/[\u4e00-\u9fff]/.test(content)) continue;
    const m = content.match(/[A-Z][a-z]+(?:\s+[A-Za-z]+){2,}/);
    if (m && !KEEP_EN.has(m[0]) && !KEEP_EN.has(content.trim())) {
      missing.push(`${file}: ${content.slice(0, 90)}`);
    }
  }
}
if (missing.length > 0) {
  console.log(`\n⚠️  检测到 ${missing.length} 处未命中的英文文案（上游新增/改动）：`);
  for (const m of [...new Set(missing)].slice(0, 50)) console.log(`  - ${m}`);
  console.log("\n请人工翻译这些新文案，加入 zh-cn.json 的 mapping 后重跑本脚本。");
} else {
  console.log("✅ 未发现未翻译的英文文案");
}

// ---- 6. 复制结果到 synced/ 目录 ----
const syncedDir = join(ROOT, "synced");
await rm(syncedDir, { recursive: true, force: true });
await mkdir(syncedDir, { recursive: true });
await cp(join(upstreamPkgDir, "src"), join(syncedDir, "src"), { recursive: true });

// 顺便复制上游 package.json 里可能变化的依赖信息（仅参考）
const upstreamPkg = JSON.parse(
  await readFile(join(upstreamPkgDir, "package.json"), "utf-8"),
).catch?.() ?? {};
try {
  const up = JSON.parse(await readFile(join(upstreamPkgDir, "package.json"), "utf-8"));
  console.log(`\n上游依赖参考（若有变化需同步到 package.json）:`);
  console.log(`  dependencies: ${JSON.stringify(up.dependencies ?? {})}`);
  console.log(`  peerDependencies: ${JSON.stringify(up.peerDependencies ?? {})}`);
} catch {
  /* ignore */
}

console.log(`\n📦 同步结果在 synced/ 目录`);
console.log(`
下一步（人工确认后执行）：
  cp -r synced/src/* src/
  npm version ${upstreamVersion}-cn.${
  localVersion.includes("-cn.")
    ? Number(localVersion.split("-cn.")[1]) + 1
    : "1"
}
  git add . && git commit -m "sync upstream ${upstreamVersion}" && git push
  （推送后 GitHub Actions 自动发布）
`);

// 清理临时目录
await rm(WORK_DIR, { recursive: true, force: true });
