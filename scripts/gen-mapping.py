#!/usr/bin/env python3
"""从已翻译源码 + 上游英文源码生成 zh-cn.json 映射表（按字符串字面量位置对齐）。

用法: python3 scripts/gen-mapping.py <上游src目录> <本地src目录> <输出json>
"""
import re
import sys
import json
import glob

def extract_strings(text):
    """提取所有字符串字面量（含模板），返回 (内容, 起始行, 起始列)，跳过注释"""
    strings = []
    i = 0
    n = len(text)
    line = 1
    col = 1
    while i < n:
        c = text[i]
        if c == '\n':
            line += 1; col = 1; i += 1; continue
        if c in ('"', "'", '`'):
            quote = c
            start_line, start_col = line, col
            i += 1; col += 1
            buf = []
            brace_depth = 0
            while i < n:
                ch = text[i]
                if ch == '\n':
                    line += 1; col = 1; i += 1; continue
                if ch == '\\':
                    buf.append(text[i:i+2]); i += 2; col += 2; continue
                if quote == '`':
                    # 模板字符串：处理 ${...} 插值（可含嵌套模板）
                    if ch == '$' and text[i+1] == '{':
                        brace_depth += 1; buf.append(ch); buf.append('{')
                        i += 2; col += 2; continue
                    if ch == '{' and brace_depth > 0:
                        brace_depth += 1; buf.append(ch); i += 1; col += 1; continue
                    if ch == '}' and brace_depth > 0:
                        brace_depth -= 1; buf.append(ch); i += 1; col += 1; continue
                    if ch == '`' and brace_depth == 0:
                        i += 1; col += 1; break
                    buf.append(ch); i += 1; col += 1; continue
                if ch == quote:
                    i += 1; col += 1; break
                buf.append(ch); i += 1; col += 1
            strings.append((''.join(buf), start_line, start_col))
        elif c == '/' and i + 1 < n and text[i+1] == '/':
            j = text.find('\n', i); i = j if j != -1 else n; col = 1
        elif c == '/' and i + 1 < n and text[i+1] == '*':
            j = text.find('*/', i); i = j + 2 if j != -1 else n
        else:
            i += 1; col += 1
    return strings

# 排除「值型」字符串：在逻辑文件中作为状态值/枚举值/标识符参与判断，翻译会破坏功能。
# 这些字符串在 UI label 中可翻译，但无法与逻辑值区分，安全起见整体排除。
BLACKLIST = {
    "Help", "Back", "Idle", "Failed", "Closed", "Running", "Warning", "Starting",
    "Completed", "Cancelled", "Interrupted", "Off", "On", "Always", "Experimental",
    "Unlimited", "None", "Error", "Cancel", "Close", "Save", "Settings", "Goal",
    "goal", "Goals", "Queue", "Start", "Pause", "Resume", "Edit", "Clear",
}

def main():
    up_dir, loc_dir, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
    mapping = {}
    issues = []
    up_files = {f.split('/')[-1] for f in glob.glob(f'{up_dir}/*.ts')}
    loc_files = {f.split('/')[-1] for f in glob.glob(f'{loc_dir}/*.ts')}
    for name in sorted(up_files & loc_files):
        up_text = open(f'{up_dir}/{name}', encoding='utf-8').read()
        loc_text = open(f'{loc_dir}/{name}', encoding='utf-8').read()
        up_strs = extract_strings(up_text)
        loc_strs = extract_strings(loc_text)
        if len(up_strs) != len(loc_strs):
            issues.append(f"{name}: 字符串数量不一致 上游{len(up_strs)} vs 本地{len(loc_strs)}")
            continue
        for (us, ul, uc), (ls, ll, lc) in zip(up_strs, loc_strs):
            has_cn = bool(re.search(r'[\u4e00-\u9fff]', ls))
            if has_cn and us != ls:
                if re.search(r'[\u4e00-\u9fff]', us):
                    continue
                # 跳过黑名单值型字符串（逻辑值不可翻译）
                if us.strip() in BLACKLIST:
                    continue
                mapping[us] = ls
    print(f"生成 {len(mapping)} 条映射")
    for m in issues:
        print("⚠️", m)
    out = {'_meta': {'note': '英文原句 -> 中文译句 映射表。translate.mjs 用其重放翻译。'}, 'mapping': mapping}
    with open(out_file, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    print(f"已写入 {out_file}")

if __name__ == '__main__':
    main()
