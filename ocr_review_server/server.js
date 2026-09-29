/*
 * OCR 校对编辑器 - 服务端
 * 数据目录默认: ./data（服务器）
 *   imgs/<doc>/page-NNN.png        页面整图
 *   JsonOCR/<doc>/page_NNN.json    OCR 结果
 * 修改存档目录: <数据目录>/修改日志
 *   edits.json    覆盖文本(键: doc|page|index)
 *   log.jsonl     逐条修改日志(追加)
 *   修改日志.md   可读日志存档(每次修改后重新生成)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// 环境变量可覆盖默认值：OCR_DATA_DIR=数据目录  OCR_PORT=端口
//   服务器(默认): 直接 node server.js 即用下方默认值
//   本机开发: OCR_DATA_DIR=D:/your-ocr-data OCR_PORT=8321 node server.js
const DATA_DIR = process.env.OCR_DATA_DIR || './data';
const IMG_DIR = path.join(DATA_DIR, 'imgs');
const OCR_DIR = path.join(DATA_DIR, 'JsonOCR');
const LOG_DIR = path.join(DATA_DIR, '修改日志');
const EDITS_FILE = path.join(LOG_DIR, 'edits.json');
const LOG_FILE = path.join(LOG_DIR, 'log.jsonl');
const MD_FILE = path.join(LOG_DIR, '修改日志.md');
const ORIGINS_FILE = path.join(LOG_DIR, 'origins.json'); // 各块「最初导入内容」快照(键: doc|page|index)
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.OCR_PORT || '1105', 10);
const HOST = '0.0.0.0'; // 监听所有网卡，允许局域网访问（localhost 仍可用）

/* ---------------- 存档 ---------------- */
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

let edits = {};
if (fs.existsSync(EDITS_FILE)) {
  try { edits = JSON.parse(fs.readFileSync(EDITS_FILE, 'utf-8')); } catch (e) { edits = {}; }
}
function saveEdits() {
  fs.writeFileSync(EDITS_FILE, JSON.stringify(edits, null, 2), 'utf-8');
}

// 各块「最初导入内容」快照：只在首次出现时记录，后续重新导入/修改都不会覆盖它，
// 计算「未修改文字数量」时始终以它作为比对基准（而非与最新一次导入内容比对）。
let origins = {};
let originsDirty = false;
if (fs.existsSync(ORIGINS_FILE)) {
  try { origins = JSON.parse(fs.readFileSync(ORIGINS_FILE, 'utf-8')); } catch (e) { origins = {}; }
}
function saveOrigins() {
  if (!originsDirty) return;
  fs.writeFileSync(ORIGINS_FILE, JSON.stringify(origins), 'utf-8');
  originsDirty = false;
}
function ensureOrigin(key, text) {
  if (!Object.prototype.hasOwnProperty.call(origins, key)) {
    origins[key] = text;
    originsDirty = true;
  }
}
function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  regenerateMd();
}
function readLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf-8').split('\n')
    .filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function regenerateMd() {
  const log = readLog();
  const lines = ['# 修改日志存档', '',
    `- 数据目录：\`${DATA_DIR}\``,
    `- 修改总次数：${log.length}`,
    `- 最后修改：${log.length ? log[log.length - 1].time : '无'}`, '',
    '| # | 时间 | 文档 | 页 | 块 | 类型 | 原文(字符) | 修改后(字符) |',
    '|---|------|------|----|----|------|------------|--------------|'];
  log.forEach((e, i) => {
    const short = s => (s || '').replace(/\s+/g, ' ').slice(0, 30) + ((s || '').length > 30 ? '…' : '');
    lines.push(`| ${i + 1} | ${e.time} | ${esc(short(e.docName))} | ${e.page} | ${e.block} | ${e.blockType} | ${esc(short(e.oldText))} (${e.oldCount}) | ${esc(short(e.newText))} (${e.newCount}) |`);
  });
  fs.writeFileSync(MD_FILE, lines.join('\n'), 'utf-8');
}

/* ---------------- 数据解析 ---------------- */
function charCount(s) {
  return String(s || '').replace(/\s/g, '').length;
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}
// 未修改文字数量：原文与修改后文本逐字核对（最长公共子序列长度，去空白后比较）
function lcsLen(a, b) {
  a = String(a || '').replace(/\s/g, '');
  b = String(b || '').replace(/\s/g, '');
  if (a === b) return a.length;            // 未修改，直接返回
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0);
  let cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) cur[j] = prev[j - 1] + 1;
      else cur[j] = prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

function listDocs() {
  // 取 imgs/ 与 JsonOCR/ 两个目录的并集作为资源列表，
  // 这样只导入图片（imgs/<doc>）或只导入 json（JsonOCR/<doc>）都能在左侧显示
  const set = new Set();
  for (const base of [IMG_DIR, OCR_DIR]) {
    let names;
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const d of names) {
      if (!fs.statSync(path.join(base, d)).isDirectory()) continue;
      // 过滤掉单页残余目录（如 page-001），避免被误识别为文档
      if (/^page-\d+$/i.test(d)) continue;
      set.add(d);
    }
  }
  return Array.from(set).sort();
}

function docName(doc) {
  // 显示名直接用资源目录名（已经是干净的资源编号），避免 JSON 中 file_name 为 page-001 这类异常值
  return doc;
}

function pageFiles(doc) {
  const dir = path.join(OCR_DIR, doc);
  try {
    return fs.readdirSync(dir).filter(f => /^page_\d+\.json$/.test(f)).sort();
  } catch { return []; }
}

function pageNum(f) { return parseInt(f.match(/\d+/)[0], 10); }

/* ---------- 方案C混合：越界 bbox 用 preproc_blocks 校正 ---------- */
// 读取图片真实像素尺寸（PNG 读 IHDR，JPEG 扫 SOF 段；图片扩展名虽为 .png 但实际可能是 JPEG）
function getImageSize(file) {
  let fd, buf;
  try {
    fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf[0] === 0x89 && buf[1] === 0x50) { // PNG
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) {  // JPEG
      const hdr = Buffer.alloc(65536);
      const n = fs.readSync(fd, hdr, 0, 65536, 0);
      let pos = 2;
      while (pos + 9 < n) {
        if (hdr[pos] !== 0xFF) { pos++; continue; }
        const marker = hdr[pos + 1];
        if (marker === 0xDA) break; // SOS 开始，前面没有 SOF
        const len = hdr.readUInt16BE(pos + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { w: hdr.readUInt16BE(pos + 7), h: hdr.readUInt16BE(pos + 5) };
        }
        pos += 2 + len;
      }
    }
  } catch (e) {}
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
  return null;
}

// 递归提取节点内所有文本（content 优先，html 兜底）
function extractNodeText(node) {
  let t = '';
  for (const l of (node && node.lines) || [])
    for (const s of (l && l.spans) || []) t += s.content || s.html || '';
  for (const sub of (node && node.blocks) || []) t += extractNodeText(sub);
  return t;
}

// 收集 preproc 树中所有带 bbox 的节点（顶层块、子块、lines）
function collectLeafs(node, list) {
  if (node && node.bbox) list.push({ bbox: node.bbox, text: extractNodeText(node) });
  for (const sub of (node && node.blocks) || []) collectLeafs(sub, list);
  for (const l of (node && node.lines) || [])
    if (l && l.bbox) list.push({ bbox: l.bbox, text: extractNodeText(l) });
}

// bbox 可信度：剔除越界、过扁/过窄、高度过矮、占图过大的异常框
function isBboxReliable(bbox, W, H) {
  if (!bbox || bbox.length !== 4) return false;
  const [x1, y1, x2, y2] = bbox;
  if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) return false;
  if (W && H && (x2 > W || y2 > H)) return false;
  const w = x2 - x1, h = y2 - y1;
  if (h < 12 || w < 4) return false;          // 太矮/太窄
  const ratio = w / h;
  if (ratio > 30 || ratio < 0.03) return false; // 极扁/极竖
  if (W && H) {
    const areaImg = W * H;
    const areaBox = w * h;
    if (areaImg && areaBox / areaImg > 0.30) return false; // 占图超过30%认为太粗
    // 横跨图片大部分宽度且高度很矮：通常是跨列合并的错误框
    if (w / W > 0.80 && h < 80) return false;
  }
  return true;
}

// 多个 bbox 的并集
function unionBbox(list) {
  if (!list || !list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const bb of list) {
    if (!bb || bb.length !== 4) continue;
    x1 = Math.min(x1, bb[0]);
    y1 = Math.min(y1, bb[1]);
    x2 = Math.max(x2, bb[2]);
    y2 = Math.max(y2, bb[3]);
  }
  if (x1 === Infinity) return null;
  return [x1, y1, x2, y2];
}

// 从一个 para 块中提取各级 bbox：优先用 spans 并集，其次 line，最后块级
function extractBlockBbox(b) {
  const spanBboxes = [];
  const lineBboxes = [];
  for (const l of b.lines || []) {
    if (l.bbox) lineBboxes.push(l.bbox);
    for (const s of l.spans || []) {
      if (s.bbox) spanBboxes.push(s.bbox);
    }
  }
  for (const blk of b.blocks || []) {
    for (const l of blk.lines || []) {
      if (l.bbox) lineBboxes.push(l.bbox);
      for (const s of l.spans || []) {
        if (s.bbox) spanBboxes.push(s.bbox);
      }
    }
  }
  return unionBbox(spanBboxes) || unionBbox(lineBboxes) || b.bbox || null;
}

// 字符集合重叠率：交集中字符数 / 两文本去重后较小字符数
function charSetOverlap(a, b) {
  const norm = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const sa = new Set(norm(a));
  const sb = new Set(norm(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

// 解析一页：返回块数组 [{index,type,text,isTable,bbox}]
// 数据源: para_blocks —— OCR 引擎的最终识别结果（段落级、阅读顺序、表格已拆成逐格 text 块）
// 结构: lines 在块级（个别情况嵌套在 blocks[] 里，做兼容）
// bbox: 默认取 para_blocks；若越界/无效，则按文本重叠在 preproc_blocks 中找对应块校正（方案C混合）
function parsePage(doc, page) {
  const file = path.join(OCR_DIR, doc, `page_${String(page).padStart(3, '0')}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
  // 图片真实尺寸（用于越界判断）
  const imgFile = path.join(IMG_DIR, doc, `page-${String(page).padStart(3, '0')}.png`);
  const sz = getImageSize(imgFile);
  const W = sz ? sz.w : 0, H = sz ? sz.h : 0;
  // preproc 叶子块（bbox 校正候选）
  const leafs = [];
  for (const b of (d.page_info.preproc_blocks || [])) collectLeafs(b, leafs);
  const paraBlocks = d.page_info.para_blocks || [];
  // 预收集所有显式 index，防止缺 index 的块在 fallback 时与显式 index 冲突。
  // 注意：para_blocks 里夹着 image 块，它们占据数组位置但被跳过，
  // 若直接用数组下标 fallback，会导致后面缺 index 的块与前面块的显式 index 撞号。
  const usedIndices = new Set();
  for (const b of paraBlocks) {
    if (typeof b.index === 'number') usedIndices.add(b.index);
  }
  function nextUnusedIndex(preferred) {
    if (typeof preferred === 'number' && !usedIndices.has(preferred)) {
      usedIndices.add(preferred);
      return preferred;
    }
    let i = 0;
    while (usedIndices.has(i)) i++;
    usedIndices.add(i);
    return i;
  }
  const blocks = [];
  paraBlocks.forEach((b) => {
    let index;
    if (typeof b.index === 'number') {
      // 显式 index 也可能在 JSON 中重复，重复时重新分配到最小未占用整数
      index = nextUnusedIndex(b.index);
    } else {
      // 缺 index 字段：优先用第一个 span 的 sort 作为编号，已被占用则取最小未占用整数，保证块编号唯一
      const sort = (b.lines && b.lines[0] && b.lines[0].spans && b.lines[0].spans[0] && b.lines[0].spans[0].sort);
      index = nextUnusedIndex(sort);
    }
    // 图片/印章区域：不在编辑区显示，也不参与字数统计
    if (b.type === 'image') return;
    // 优先用 spans/lines 的并集作为 bbox（块级 bbox 在复杂页常出现跨列合并错误）
    let bbox = extractBlockBbox(b);
    if (b.type === 'table') {
      // 兼容：para_blocks 极少出现 table，按 HTML 处理
      let html = '';
      for (const blk of b.blocks || [])
        for (const l of blk.lines || [])
          for (const s of l.spans || []) html += s.html || s.content || '';
      blocks.push({ index, type: 'table', text: html, isTable: true, bbox });
      return;
    }
    // text / title / list：lines 在块级（para_blocks 标准结构）
    let t = '';
    for (const l of b.lines || [])
      for (const s of l.spans || []) t += s.content || '';
    // 兼容嵌套在 blocks[] 的情况
    for (const blk of b.blocks || [])
      for (const l of blk.lines || [])
        for (const s of l.spans || []) t += s.content || '';
    // bbox 不可信（越界、过扁/过窄、高度过矮）→ 用 preproc_blocks 按文本重叠校正；仍不可信则隐藏
    if (bbox && W && H && !isBboxReliable(bbox, W, H)) {
      let best = null, bestOv = 0;
      for (const lf of leafs) {
        const ov = charSetOverlap(t, lf.text);
        if (ov > bestOv) { bestOv = ov; best = lf; }
      }
      const fallback = (best && bestOv >= 0.4) ? best.bbox : null;
      bbox = isBboxReliable(fallback, W, H) ? fallback : null;
    }
    blocks.push({ index, type: b.type || 'text', text: t, isTable: false, bbox });
  });
  return blocks;
}

function blockKey(doc, page, index) { return `${doc}|${page}|${index}`; }

// 当前文本(应用覆盖) 与 统计（未修改文字数量 = 与「最初导入内容」逐字核对相同字符数）
function pageWithEdits(doc, page) {
  const blocks = parsePage(doc, page);
  let orig = 0, unmod = 0;
  const out = blocks.map(b => {
    const key = blockKey(doc, page, b.index);
    const current = Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : b.text;
    // 冻结该块的「最初导入内容」，作为未修改比对的基准（只记录一次，不被重新导入/修改覆盖）
    ensureOrigin(key, b.text);
    const base = Object.prototype.hasOwnProperty.call(origins, key) ? origins[key] : b.text;
    const origText = b.isTable ? stripHtml(base) : base;
    const curText = b.isTable ? stripHtml(current) : current;
    const o = charCount(origText);
    const u = lcsLen(origText, curText);
    // 当前显示为空的块不在编辑区展示，也不参与统计
    if (!charCount(curText)) return null;
    orig += o; unmod += u;
    return { index: b.index, type: b.type, original: base, current, isTable: b.isTable, bbox: b.bbox, origCount: o, unmodCount: u };
  }).filter(Boolean);
  return { blocks: out, origCount: orig, unmodCount: unmod };
}

function globalStats() {
  let orig = 0, unmod = 0;
  for (const doc of listDocs())
    for (const f of pageFiles(doc)) {
      const p = pageNum(f);
      const s = pageWithEdits(doc, p);
      orig += s.origCount; unmod += s.unmodCount;
    }
  return { origCount: orig, unmodCount: unmod };
}

/* ---------------- API ---------------- */
function send(res, code, data, type) {
  saveOrigins(); // 若有新冻结的「最初导入内容」基准，随本次响应一并落盘（每请求最多写一次）
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function handleApi(req, res, url) {
  if (url.pathname === '/api/tree') {
    const docs = listDocs().map(doc => {
      const name = docName(doc);
      const pages = pageFiles(doc).map(f => {
        const p = pageNum(f);
        const s = pageWithEdits(doc, p);
        return { page: p, origCount: s.origCount, unmodCount: s.unmodCount };
      });
      const orig = pages.reduce((a, b) => a + b.origCount, 0);
      const unmod = pages.reduce((a, b) => a + b.unmodCount, 0);
      return { id: doc, name, pages, origCount: orig, unmodCount: unmod };
    });
    return send(res, 200, { docs });
  }
  if (url.pathname === '/api/page') {
    const doc = url.searchParams.get('doc');
    const page = parseInt(url.searchParams.get('page'), 10);
    if (!doc || (!fs.existsSync(path.join(OCR_DIR, doc)) && !fs.existsSync(path.join(IMG_DIR, doc)))) return send(res, 404, { error: 'doc not found' });
    const info = pageWithEdits(doc, page);
    const img = `/data/imgs/${doc}/page-${String(page).padStart(3, '0')}.png`;
    const name = docName(doc);
    return send(res, 200, { doc, docName: name, page, image: img, ...info });
  }
  if (url.pathname === '/api/import' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { doc, files } = JSON.parse(body);
        if (!doc || !Array.isArray(files) || !files.length) return send(res, 400, { error: '参数不完整' });
        // 资源名安全化：仅去掉路径分隔符与父目录引用，保留中文/数字/连字符
        const safeDoc = String(doc).replace(/[\/\\]/g, '_').replace(/\.\./g, '_').slice(0, 120);
        if (!safeDoc) return send(res, 400, { error: '资源名非法' });
        let count = 0;
        const imported = [];
        for (const f of files) {
          const kind = (f.kind === 'JsonOCR') ? 'JsonOCR' : 'imgs';
          const base = (kind === 'JsonOCR') ? OCR_DIR : IMG_DIR;
          // rel 防穿越：只允许相对子路径，禁止 .. 与绝对路径
          const rel = String(f.rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
          if (!rel || rel.includes('..')) continue;
          const target = path.join(base, safeDoc, rel);
          const resolved = path.resolve(target);
          const allowed = path.resolve(base, safeDoc);
          if (!resolved.startsWith(allowed + path.sep)) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const buf = Buffer.from(String(f.data || ''), 'base64');
          if (!buf.length) continue;
          fs.writeFileSync(target, buf);
          count++;
          imported.push(kind + '/' + rel);
        }
        return send(res, 200, { ok: true, doc: safeDoc, imported: count, files: imported });
      } catch (e) {
        return send(res, 500, { error: String(e) });
      }
    });
    return;
  }
  if (url.pathname === '/api/stats') return send(res, 200, globalStats());
  if (url.pathname === '/api/log') return send(res, 200, { log: readLog().slice(-500).reverse() });
  if (url.pathname === '/api/reset' && req.method === 'POST') {
    try {
      // 清空 imgs / JsonOCR 下的全部资源目录（保留目录本身）
      for (const base of [IMG_DIR, OCR_DIR]) {
        if (fs.existsSync(base)) {
          for (const d of fs.readdirSync(base)) {
            const p = path.join(base, d);
            fs.rmSync(p, { recursive: true, force: true });
          }
        }
      }
      // 清空修改日志内容（edits.json / log.jsonl / 修改日志.md / origins.json），保留修改日志目录
      for (const f of [EDITS_FILE, LOG_FILE, MD_FILE, ORIGINS_FILE]) {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      // 内存中的覆盖文本与「最初导入内容」基准一并清空
      edits = {};
      origins = {};
      originsDirty = false;
      return send(res, 200, { ok: true, message: '已清空所有资源与修改日志' });
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  }
  if (url.pathname === '/api/edit' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { doc, page, index, text } = JSON.parse(body);
        if (!doc || !page || index === undefined || typeof text !== 'string')
          return send(res, 400, { error: '参数不完整' });
        const key = blockKey(doc, page, index);
        const blocks = parsePage(doc, page);
        const blk = blocks.find(b => b.index === index);
        if (!blk) return send(res, 404, { error: '块不存在' });
        const before = Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : blk.text;
        const oldCount = charCount(blk.isTable ? stripHtml(before) : before);
        const newCount = charCount(blk.isTable ? stripHtml(text) : text);
        if (text === before) return send(res, 200, { changed: false, message: '内容未变化' });
        edits[key] = text;
        saveEdits();
        const entry = {
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          doc, docName: docName(doc), page, block: index,
          blockType: blk.type, oldText: before, newText: text,
          oldCount, newCount
        };
        appendLog(entry);
        const pageInfo = pageWithEdits(doc, page);
        return send(res, 200, {
          changed: true, entry,
          blocks: pageInfo.blocks,
          pageStats: { origCount: pageInfo.origCount, unmodCount: pageInfo.unmodCount },
          globalStats: globalStats()
        });
      } catch (e) {
        return send(res, 500, { error: String(e) });
      }
    });
    return;
  }
  send(res, 404, { error: 'unknown api' });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'
};

function serveFile(res, root, relPath) {
  const filePath = path.join(root, relPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(resolved, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (url.pathname.startsWith('/data/')) {
    return serveFile(res, DATA_DIR, decodeURIComponent(url.pathname.slice('/data/'.length)));
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  return serveFile(res, PUBLIC_DIR, p);
}).listen(PORT, HOST, () => {
  console.log(`OCR 校对编辑器已启动:`);
  console.log(`  本机访问:   http://localhost:${PORT}`);
  const os = require('os');
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs))
    for (const info of ifs[name] || [])
      if (info.family === 'IPv4' && !info.internal)
        console.log(`  局域网访问: http://${info.address}:${PORT}   (${name})`);
});
