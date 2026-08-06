#!/usr/bin/env node
/**
 * pi-plan-mode-cn 自动翻译重放脚本（字符串字面量级替换）
 *
 * 用法：
 *   node scripts/translate.mjs <上游包目录> [--out <输出目录>]
 *
 * 流程：
 *   1. 读取 zh-cn.json 映射表（英文原句 -> 中文译句）
 *   2. 对上游每个 .ts 文件做词法扫描，只处理「字符串字面量」（普通/单引号/模板），
 *      对每个字面量内容按映射表整句替换 —— 绝不碰标识符、注释、代码结构
 *   3. 输出结果目录（src/）
 *   4. 报告未命中的英文长句（上游新增/改动，需人工补翻后加进 zh-cn.json）
 *
 * 特点：
 *   - 幂等：对已翻译源码重跑，替换数为 0
 *   - 安全：标识符（PlanModeSettings 等）、保留串（**Proposed Plan** 等）不受影响
 *   - 模板字符串（含 ${var}）整句替换，${...} 插值区域内的标识符绝不替换
 */
import { readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MAPPING_FILE = join(ROOT, "zh-cn.json");

function usage() {
  console.error(`用法:
  node scripts/translate.mjs <上游包目录> [--out <输出目录>]

上游包目录应为 npm pack 解压后的 package/ 目录（含 src/）。`);
  process.exit(1);
}

const args = process.argv.slice(2);
const upIndex = args.findIndex((a) => !a.startsWith("--"));
if (upIndex < 0) usage();
const upstreamDir = args[upIndex];
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;

if (!existsSync(join(upstreamDir, "src"))) {
  console.error(`错误：${upstreamDir} 下没有 src/ 目录，请传入 npm pack 解压后的 package 目录`);
  process.exit(1);
}

const mappingData = JSON.parse(await readFile(MAPPING_FILE, "utf-8"));
const mapping = mappingData.mapping;
console.log(`映射表：${Object.keys(mapping).length} 条（基于 ${mappingData._meta.upstream}@${mappingData._meta.upstream_version}）`);

/**
 * 词法扫描 .ts 文本，返回所有字符串字面量的 [start, end] 区间（含引号）。
 * 正确处理：单双引号、模板字符串、转义、注释跳过（// 与 /* *​/）。
 */
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
          // 模板字符串：处理 ${...} 插值（插值内可含嵌套模板字符串）
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
          // 插值内的字符串字面量（含嵌套反引号）直接消费，不退出外层
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

// 收集所有映射 key 按长度降序，优先长句（避免短句是长句子串时先被替换）
const sortedKeys = Object.keys(mapping).sort((a, b) => b.length - a.length);

function translateFile(text) {
  const spans = stringLiterals(text);
  let hits = 0;
  let result = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    const literal = text.slice(start, end); // 含引号
    const content = literal.slice(1, -1); // 去引号
    let replaced = content;
    let localHits = 0;
    // 1) 整段精确匹配优先（模板字符串含插值也能整体替换，映射表已含插值原文）
    if (Object.hasOwn(mapping, content)) {
      if (mapping[content] !== content) {
        replaced = mapping[content];
        localHits = 1;
      } else {
        // 保留项（value===key）：整段命中即锁定原文，不再做部分匹配，防止被短 key 拆分翻译；不计数
        localHits = 0;
      }
    } else {
      // 2) 部分匹配：只在内容里找映射 key，跳过 ${...} 插值区域（标识符不替换）
      const protectedRanges = [];
      for (const m of content.matchAll(/\$\{[^}]*\}/g)) {
        protectedRanges.push([m.index, m.index + m[0].length]);
      }
      for (const en of sortedKeys) {
        if (en.length < 4) continue; // 极短 key 仅整段匹配，避免拆坏标识符
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

// 输出目录
const targetDir = outDir ?? join(ROOT, ".translate-tmp");
await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(join(upstreamDir, "src"), join(targetDir, "src"), { recursive: true });

const files = (await readdir(join(targetDir, "src"))).filter((f) => f.endsWith(".ts"));
let totalHits = 0;
const missing = [];

for (const file of files) {
  const path = join(targetDir, "src", file);
  const original = await readFile(path, "utf-8");
  const { text, hits } = translateFile(original);
  if (hits > 0) {
    await writeFile(path, text, "utf-8");
    totalHits += hits;
  }
}

// 未命中检测：扫描翻译后文件里仍为英文长句的字面量（排除已知保留串）
const KEEP_EN = new Set([
  "This extension ctx is stale after session replacement or reload",
  "Extension context is no longer active",
  "Proposed Plan",
]);
for (const file of files) {
  const path = join(targetDir, "src", file);
  const text = await readFile(path, "utf-8");
  for (const [start, end] of stringLiterals(text)) {
    const literal = text.slice(start, end);
    const content = literal.slice(1, -1);
    if (/[\u4e00-\u9fff]/.test(content)) continue;
    const m = content.match(/[A-Z][a-z]+(?:\s+[A-Za-z]+){2,}/);
    if (m && !KEEP_EN.has(m[0]) && !KEEP_EN.has(content.trim())) {
      missing.push(`${file}:${content.slice(0, 90)}`);
    }
  }
}

console.log(`完成：替换 ${totalHits} 处，处理 ${files.length} 个文件`);
console.log(`输出目录：${targetDir}`);
if (missing.length > 0) {
  const unique = [...new Set(missing)];
  console.log(`\n⚠️  检测到 ${unique.length} 处可能未翻译的英文文案（上游新增或改动）：`);
  for (const m of unique.slice(0, 50)) console.log(`  - ${m}`);
  if (unique.length > 50) console.log(`  ... 等共 ${unique.length} 条`);
  console.log("\n处理方法：人工翻译后，将英文原句 -> 中文译句 加入 zh-cn.json 的 mapping，重新运行本脚本。");
} else {
  console.log("✅ 未发现未翻译的英文文案");
}
