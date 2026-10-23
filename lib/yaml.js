/**
 * 轻量 YAML 解析器 (零依赖)
 *
 * 为什么不用 js-yaml / yaml 包:
 *   青龙面板里装依赖要手动操作, 而配置文件只需要很小的语法子集。
 *   本模块优先尝试用已安装的 js-yaml / yaml (如果青龙里有, 行为更宽松),
 *   没有就用内置解析器, 保证「复制模板改一改就能跑」。
 *
 * 支持的语法 (覆盖 config.yaml 所需的全部写法):
 *   key: value              # 普通键值
 *   key:                    # 嵌套
 *     child: 1
 *   list:
 *     - a                   # 标量列表
 *     - name: x             # 对象列表
 *       age: 1
 *   引号: 'single' / "double" (支持 \n \" \\ 等转义, 单引号内 '' 表示一个 ')
 *   行内: [] / [a, b] / {}
 *   注释: 行首 # 或空白后的 #
 *   类型: true/false/null/~/整数/小数/字符串 自动识别
 *
 * 不支持 (会给出明确报错):
 *   多行文本块 (| 和 >)、锚点 &/*、多文档 ---、Tab 缩进
 */

'use strict';

/** 带行号的错误 */
function yamlError(lineNo, msg) {
  const e = new Error(`第 ${lineNo} 行: ${msg}`);
  e.isYamlError = true;
  return e;
}

/**
 * 去掉行尾注释 (# 前面必须是行首或空白, 引号内的 # 保留)
 */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (quote) {
      if (quote === "'") {
        if (c === "'") {
          if (s[i + 1] === "'") { i++; continue; } // '' → 转义的单引号
          quote = null;
        }
      } else {
        if (c === '\\') { i++; continue; }
        if (c === '"') quote = null;
      }
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

/** 找引号闭合位置, 找不到就报错 */
function findQuoteEnd(s, start, lineNo) {
  const q = s[start];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") { i += 2; continue; }
        return i;
      }
    } else {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') return i;
    }
    i++;
  }
  throw yamlError(lineNo, `引号没有闭合 (${q === "'" ? '单引号' : '双引号'}), 检查这一行是不是少写了一个引号`);
}

const ESCAPES = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0',
  '"': '"', "'": "'", '\\': '\\', '/': '/',
};

function parseQuoted(s, lineNo) {
  const end = findQuoteEnd(s, 0, lineNo);
  if (end !== s.length - 1) {
    throw yamlError(lineNo, `引号字符串后面多了内容: ${s.slice(end + 1).trim()}`);
  }
  const body = s.slice(1, end);

  if (s[0] === "'") return body.replace(/''/g, "'");

  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e) => {
    if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return Object.prototype.hasOwnProperty.call(ESCAPES, e) ? ESCAPES[e] : e;
  });
}

/** 按顶层逗号切分 (尊重引号和嵌套括号) */
function splitTopLevel(s, lineNo) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buf = '';

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (quote) {
      buf += c;
      if (quote === "'" && c === "'") {
        if (s[i + 1] === "'") { buf += s[++i]; continue; }
        quote = null;
      } else if (quote === '"' && c === '\\') {
        buf += s[++i] || '';
      } else if (quote === '"' && c === '"') {
        quote = null;
      }
      continue;
    }

    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    if (c === '[' || c === '{') { depth++; buf += c; continue; }
    if (c === ']' || c === '}') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }

  if (buf.trim()) parts.push(buf);
  return parts.map(p => p.trim()).filter(p => p !== '');
}

function parseFlowSeq(s, lineNo) {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner, lineNo).map(item => parseScalar(item, lineNo));
}

function parseFlowMap(s, lineNo) {
  const inner = s.slice(1, -1).trim();
  if (!inner) return {};
  const obj = {};
  for (const item of splitTopLevel(inner, lineNo)) {
    const m = item.match(/^([^:]+?):\s*([\s\S]*)$/);
    if (!m) throw yamlError(lineNo, `行内对象格式不对: ${item}`);
    obj[m[1].trim()] = parseScalar(m[2], lineNo);
  }
  return obj;
}

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '') return null;

  if (s[0] === '"' || s[0] === "'") return parseQuoted(s, lineNo);

  if (s[0] === '[' && s.endsWith(']')) return parseFlowSeq(s, lineNo);
  if (s[0] === '{' && s.endsWith('}')) return parseFlowMap(s, lineNo);

  if (/^(null|~)$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return parseFloat(s);

  if (s === '|' || s === '>' || /^[|>][+-]?$/.test(s)) {
    throw yamlError(lineNo, '不支持多行文本块 (| 或 >), 请把内容写在同一行的引号里');
  }
  if (s[0] === '&' || s[0] === '*') {
    throw yamlError(lineNo, '不支持锚点 (&) 和引用 (*), 直接重复写一遍即可');
  }

  return s;
}

/** 拆出 "键: 值" */
function splitKey(s, lineNo) {
  if (s[0] === '"' || s[0] === "'") {
    const end = findQuoteEnd(s, 0, lineNo);
    const key = parseQuoted(s.slice(0, end + 1), lineNo);
    const after = s.slice(end + 1).trim();
    if (!after.startsWith(':')) throw yamlError(lineNo, '键名后面缺少冒号');
    return { key, rest: after.slice(1).trim() };
  }

  const m = s.match(/^([^:]+?):(\s+|$)/);
  if (!m) {
    throw yamlError(
      lineNo,
      `不是合法的 "键: 值" 格式 (是不是忘了冒号后的空格?) → ${s}`
    );
  }
  return { key: m[1].trim(), rest: s.slice(m[0].length).trim() };
}

/**
 * 解析 YAML 文本
 * @param {string} text
 * @returns {object}
 */
function parseYaml(text) {
  const rawLines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = [];

  for (let n = 0; n < rawLines.length; n++) {
    const raw = rawLines[n];
    const lineNo = n + 1;

    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (/^\.\.\.\s*$/.test(raw)) continue;
    if (/^---\s*$/.test(raw)) {
      if (lines.length) throw yamlError(lineNo, '不支持多文档 (---), 一个文件只能有一份配置');
      continue;
    }
    if (/^---\s/.test(raw)) throw yamlError(lineNo, '不支持多文档 (---), 一个文件只能有一份配置');

    const indentMatch = raw.match(/^[ \t]*/);
    const indentStr = indentMatch[0];
    if (indentStr.includes('\t')) {
      throw yamlError(lineNo, '缩进不能用 Tab, 请改成空格 (建议 2 个空格一级)');
    }

    const content = stripComment(raw.slice(indentStr.length)).replace(/\s+$/, '');
    if (!content.trim()) continue;

    lines.push({ indent: indentStr.length, content, lineNo });
  }

  if (!lines.length) return {};

  let idx = 0;

  function parseNode(minIndent) {
    if (idx >= lines.length) return null;
    const first = lines[idx];
    if (first.indent < minIndent) return null;
    if (/^-(\s|$)/.test(first.content)) return parseSeq(first.indent);
    return parseMap(first.indent);
  }

  function parseSeq(indent) {
    const arr = [];
    while (idx < lines.length) {
      const ln = lines[idx];
      if (ln.indent < indent) break;
      if (ln.indent > indent) {
        throw yamlError(ln.lineNo, `缩进不一致 (同级列表项应为 ${indent} 个空格, 这一行是 ${ln.indent} 个)`);
      }
      if (!/^-(\s|$)/.test(ln.content)) break;

      const m = ln.content.match(/^-\s+/);
      const rest = m ? ln.content.slice(m[0].length).trim() : '';

      if (!rest) {
        idx++;
        arr.push(parseNode(indent + 1));
        continue;
      }

      // "- key: value" → 当成缩进了 (indent + "- ".length) 的对象
      if (!/^["']/.test(rest) && /^[^:]+?:(\s+|$)/.test(rest)) {
        ln.indent = indent + (m ? m[0].length : 2);
        ln.content = rest;
        arr.push(parseMap(ln.indent));
        continue;
      }

      // "- - a" → 嵌套列表
      if (/^-(\s|$)/.test(rest)) {
        ln.indent = indent + (m ? m[0].length : 2);
        ln.content = rest;
        arr.push(parseSeq(ln.indent));
        continue;
      }

      arr.push(parseScalar(rest, ln.lineNo));
      idx++;
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (idx < lines.length) {
      const ln = lines[idx];
      if (ln.indent < indent) break;
      if (ln.indent > indent) {
        throw yamlError(ln.lineNo, `缩进不一致 (同级键应为 ${indent} 个空格, 这一行是 ${ln.indent} 个)`);
      }
      if (/^-(\s|$)/.test(ln.content)) break;

      const { key, rest } = splitKey(ln.content, ln.lineNo);

      if (rest === '') {
        idx++;
        const child = parseNode(indent + 1);
        obj[key] = child === null ? null : child;
        continue;
      }

      obj[key] = parseScalar(rest, ln.lineNo);
      idx++;
    }
    return obj;
  }

  const root = parseNode(0);
  if (idx < lines.length) {
    throw yamlError(lines[idx].lineNo, `无法解析的内容: ${lines[idx].content}`);
  }
  if (root === null) return {};
  if (typeof root !== 'object' || Array.isArray(root)) {
    throw yamlError(lines[0].lineNo, '最外层必须是键值对, 例如 isvoro: / telegram:');
  }
  return root;
}

/**
 * 解析 YAML: 优先用已安装的 js-yaml / yaml, 没有就用内置解析器
 * @param {string} text
 * @returns {object}
 */
function loadYaml(text) {
  for (const name of ['js-yaml', 'yaml']) {
    let lib;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      lib = require(name);
    } catch (e) {
      continue;
    }
    try {
      if (name === 'js-yaml' && typeof lib.load === 'function') return lib.load(text) || {};
      if (name === 'yaml' && typeof lib.parse === 'function') return lib.parse(text) || {};
    } catch (e) {
      // 外部库解析失败时, 用内置解析器再试一次, 报错更贴近本项目语法
      break;
    }
  }
  return parseYaml(text);
}

module.exports = { parseYaml, loadYaml, yamlError };
