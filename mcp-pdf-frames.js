/**
 * BSMNT — pull storyboard frames out of a PDF (pure JS, pdf-lib)
 * ──────────────────────────────────────────────────────────────
 * extractFrames(pdfBytes, opts) -> { frames, skipped, pages }
 *
 *   frames[i] = { index, page, slot, width, height, mime, bytes }
 *     page  1-based page number
 *     slot  0-based position on the page, reading order (top-to-bottom, left-to-right)
 *
 * What counts as a frame:
 *   - an image XObject drawn on a page (directly or inside a Form XObject)
 *   - at least opts.minWidth x opts.minHeight pixels (default 400 x 200)
 *   - aspect ratio between opts.minAspect and opts.maxAspect (default 1.0 to 2.6, landscape)
 *   - not repeated on opts.repeatLimit or more pages (default 3): page backgrounds, logos
 *   - JPEG (DCTDecode) is passed through untouched; 8-bit RGB/Gray Flate images are
 *     re-encoded as PNG. Anything else is reported in `skipped`.
 *
 * Reading order uses the image's placement on the page (from the content stream's cm/q/Q),
 * so two frames side by side come out left then right, rows top to bottom.
 */

const zlib = require('zlib');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef, decodePDFRawStream } = require('pdf-lib');

const DEFAULTS = { minWidth: 400, minHeight: 200, minAspect: 1.0, maxAspect: 2.6, repeatLimit: 3, maxFrames: 120 };
// Hard limits against hostile files (decompression bombs, huge object graphs).
const MAX_STREAM_BYTES = 32 * 1024 * 1024;   // decoded content stream
const MAX_PIXELS = 50 * 1000 * 1000;         // per Flate image
const MAX_DRAWS = 20000;                     // image/form draws walked across the whole document

// ── content stream: find "Do" operators with their transform ───────────────
function _tokens(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }
    if (c === '(') { // literal string, skip with nesting + escapes
      let depth = 1; i++;
      while (i < n && depth > 0) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      out.push({ t: 'str' }); continue;
    }
    if (c === '<' && src[i + 1] === '<') { out.push({ t: 'dict<' }); i += 2; continue; }
    if (c === '>' && src[i + 1] === '>') { out.push({ t: 'dict>' }); i += 2; continue; }
    if (c === '<') { while (i < n && src[i] !== '>') i++; i++; out.push({ t: 'str' }); continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}') { out.push({ t: c }); i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !/[\s/\[\]()<>{}%]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i + 1, j) }); i = j; continue;
    }
    let j = i;
    while (j < n && !/[\s/\[\]()<>{}%]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    const word = src.slice(i, j);
    const num = Number(word);
    if (word !== '' && !isNaN(num) && /^[+\-.\d]/.test(word)) out.push({ t: 'num', v: num });
    else out.push({ t: 'op', v: word });
    i = j;
    // Inline images: skip binary data up to "EI".
    if (word === 'ID') {
      const end = src.indexOf('EI', i);
      i = end < 0 ? n : end + 2;
    }
  }
  return out;
}

function _mul(a, b) { // 2D affine [a b c d e f]
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

// Returns [{ name, ctm }] for every "/Name Do" in the stream, in drawing order.
function _drawsIn(contentText, baseCtm) {
  const toks = _tokens(contentText);
  const draws = [];
  let ctm = baseCtm.slice();
  const stack = [];
  const operands = [];
  for (const tk of toks) {
    if (tk.t !== 'op') { operands.push(tk); continue; }
    const op = tk.v;
    if (op === 'q') stack.push(ctm.slice());
    else if (op === 'Q') ctm = stack.pop() || baseCtm.slice();
    else if (op === 'cm') {
      const nums = operands.filter(o => o.t === 'num').slice(-6).map(o => o.v);
      if (nums.length === 6) ctm = _mul(nums, ctm);
    } else if (op === 'Do') {
      const nm = [...operands].reverse().find(o => o.t === 'name');
      if (nm) draws.push({ name: nm.v, ctm: ctm.slice() });
    }
    operands.length = 0;
  }
  return draws;
}

function _decodeBounded(s) {
  const f = _filters(s.dict);
  if (f.length === 0) return Buffer.from(s.contents);
  if (f.length === 1 && f[0] === 'FlateDecode') return zlib.inflateSync(Buffer.from(s.contents), { maxOutputLength: MAX_STREAM_BYTES });
  if (s.contents.length > MAX_STREAM_BYTES / 64) throw new Error('stream too large');
  const out = Buffer.from(decodePDFRawStream(s).decode());
  if (out.length > MAX_STREAM_BYTES) throw new Error('stream too large');
  return out;
}

function _streamText(doc, obj) {
  const parts = [];
  let total = 0;
  const add = (o) => {
    const s = o instanceof PDFRef ? doc.context.lookup(o) : o;
    if (s instanceof PDFRawStream) {
      try {
        const b = _decodeBounded(s);
        total += b.length;
        if (total > MAX_STREAM_BYTES) throw new Error('content too large');
        parts.push(b.toString('latin1'));
      } catch (e) { /* unreadable or over the limit: skip */ }
    } else if (s instanceof PDFArray) {
      for (let i = 0; i < s.size(); i++) add(s.get(i));
    }
  };
  add(obj);
  return parts.join('\n');
}

function _num(dict, key) {
  const v = dict.get(PDFName.of(key));
  return v && typeof v.asNumber === 'function' ? v.asNumber() : (v && typeof v.numberValue === 'number' ? v.numberValue : null);
}
function _nameOf(v) { return v && typeof v.asString === 'function' ? v.asString().replace(/^\//, '') : (v ? String(v).replace(/^\//, '') : ''); }
function _filters(dict) {
  const f = dict.get(PDFName.of('Filter'));
  if (!f) return [];
  if (f instanceof PDFArray) { const out = []; for (let i = 0; i < f.size(); i++) out.push(_nameOf(f.get(i))); return out; }
  return [_nameOf(f)];
}

// ── PNG encoder for 8-bit RGB / Gray pixel data ───────────────────────────────
const _crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function _crc(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function _chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(_crc(td));
  return Buffer.concat([len, td, crc]);
}
function _png(width, height, channels, pixels) {
  const rowLen = width * channels;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (rowLen + 1)] = 0; Buffer.from(pixels.buffer, pixels.byteOffset + y * rowLen, rowLen).copy(raw, y * (rowLen + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), _chunk('IHDR', ihdr), _chunk('IDAT', zlib.deflateSync(raw)), _chunk('IEND', Buffer.alloc(0))]);
}

function _imageBytes(stream) {
  const d = stream.dict;
  const filters = _filters(d);
  const w = _num(d, 'Width'), h = _num(d, 'Height');
  if (filters.length === 1 && filters[0] === 'DCTDecode') return { mime: 'image/jpeg', bytes: Buffer.from(stream.contents) };
  if (filters.length === 1 && filters[0] === 'JPXDecode') return { skip: 'JPEG 2000 image' };
  if ((filters.length === 0 || (filters.length === 1 && filters[0] === 'FlateDecode')) && _num(d, 'BitsPerComponent') === 8) {
    const parms = d.get(PDFName.of('DecodeParms'));
    if (parms instanceof PDFDict && (_num(parms, 'Predictor') || 1) > 1) return { skip: 'Flate image with predictor' };
    const cs = _nameOf(d.get(PDFName.of('ColorSpace')));
    const channels = cs === 'DeviceRGB' ? 3 : cs === 'DeviceGray' ? 1 : 0;
    if (!channels) return { skip: 'colour space ' + (cs || 'indexed/ICC') };
    if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) return { skip: 'image too large' };
    let pixels;
    try { pixels = filters.length ? zlib.inflateSync(Buffer.from(stream.contents), { maxOutputLength: w * h * channels }) : Buffer.from(stream.contents); }
    catch (e) { return { skip: 'unreadable pixel data' }; }
    if (pixels.length < w * h * channels) return { skip: 'truncated pixel data' };
    return { mime: 'image/png', bytes: _png(w, h, channels, pixels) };
  }
  return { skip: 'unsupported filter ' + filters.join('+') };
}

async function extractFrames(pdfBytes, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const placements = []; // { page, refKey, stream, x, y, w, h }
  const pagesUsing = new Map(); // refKey -> Set(page)
  const formText = new Map();   // form ref -> decoded content (decode each form once)
  let draws = 0;

  const walk = (resources, contentText, baseCtm, pageNo, depth) => {
    if (!(resources instanceof PDFDict) || depth > 3) return;
    const xo = resources.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) return;
    for (const dr of _drawsIn(contentText, baseCtm)) {
      if (++draws > MAX_DRAWS) throw new Error('PDF is too complex to read');
      const raw = xo.get(PDFName.of(dr.name));
      const ref = raw instanceof PDFRef ? raw : null;
      const obj = ref ? doc.context.lookup(ref) : raw;
      if (!(obj instanceof PDFRawStream)) continue;
      const sub = _nameOf(obj.dict.get(PDFName.of('Subtype')));
      if (sub === 'Image') {
        const key = ref ? ref.toString() : 'inline' + placements.length;
        const m = dr.ctm; // image space is the unit square
        placements.push({ page: pageNo, key, stream: obj, x: Math.min(m[4], m[4] + m[0]), y: Math.max(m[5], m[5] + m[3]), w: Math.abs(m[0]), h: Math.abs(m[3]) });
        if (!pagesUsing.has(key)) pagesUsing.set(key, new Set());
        pagesUsing.get(key).add(pageNo);
      } else if (sub === 'Form') {
        let fm = [1, 0, 0, 1, 0, 0];
        const mx = obj.dict.lookup(PDFName.of('Matrix'));
        if (mx instanceof PDFArray && mx.size() === 6) fm = [0, 1, 2, 3, 4, 5].map(i => mx.get(i).asNumber());
        const formRes = obj.dict.lookup(PDFName.of('Resources'));
        const fkey = ref ? ref.toString() : null;
        let text = fkey ? formText.get(fkey) : undefined;
        if (text === undefined) { text = _streamText(doc, obj); if (fkey) formText.set(fkey, text); }
        walk(formRes instanceof PDFDict ? formRes : resources, text, _mul(fm, dr.ctm), pageNo, depth + 1);
      }
    }
  };

  pages.forEach((page, i) => {
    const res = page.node.Resources();
    const contents = page.node.Contents();
    if (!contents) return;
    walk(res, _streamText(doc, contents), [1, 0, 0, 1, 0, 0], i + 1, 0);
  });

  const frames = [];
  const skipped = [];
  const seen = new Set();
  const byPage = new Map();
  for (const p of placements) { if (!byPage.has(p.page)) byPage.set(p.page, []); byPage.get(p.page).push(p); }
  for (const pageNo of [...byPage.keys()].sort((a, b) => a - b)) {
    // Reading order: rows top-to-bottom (PDF y grows upward), then left-to-right.
    const list = byPage.get(pageNo).sort((a, b) => (Math.abs(a.y - b.y) > 20 ? b.y - a.y : a.x - b.x));
    let slot = 0;
    for (const p of list) {
      const d = p.stream.dict;
      const w = _num(d, 'Width') || 0, h = _num(d, 'Height') || 0;
      const why = (() => {
        if (seen.has(p.key + '@' + pageNo)) return 'drawn twice on the page';
        if ((pagesUsing.get(p.key) || new Set()).size >= o.repeatLimit) return 'repeats on ' + pagesUsing.get(p.key).size + ' pages (background/logo)';
        if (_nameOf(d.get(PDFName.of('ImageMask'))) === 'true') return 'mask';
        if (w < o.minWidth || h < o.minHeight) return 'small (' + w + 'x' + h + ')';
        const ar = w / h;
        if (ar < o.minAspect || ar > o.maxAspect) return 'aspect ' + ar.toFixed(2);
        return null;
      })();
      seen.add(p.key + '@' + pageNo);
      if (why) { skipped.push({ page: pageNo, width: w, height: h, reason: why }); continue; }
      const img = _imageBytes(p.stream);
      if (img.skip) { skipped.push({ page: pageNo, width: w, height: h, reason: img.skip }); continue; }
      if (frames.length >= o.maxFrames) { skipped.push({ page: pageNo, width: w, height: h, reason: 'over ' + o.maxFrames + ' frames' }); continue; }
      frames.push({ index: frames.length, page: pageNo, slot: slot++, width: w, height: h, mime: img.mime, bytes: img.bytes });
    }
  }
  return { frames, skipped, pages: pages.length };
}

// Same as extractFrames, but in a worker thread with a memory cap and a timeout, so a hostile
// or broken PDF can't take the server down. Use this one from request handlers.
function extractFramesIsolated(pdfBytes, opts, limits) {
  const l = Object.assign({ timeoutMs: 45000, maxOldMb: 768 }, limits || {});
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { __bsmntPdf: true, bytes: pdfBytes, opts: opts || {} }, resourceLimits: { maxOldGenerationSizeMb: l.maxOldMb, maxYoungGenerationSizeMb: 64 } });
    let settled = false;
    const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { w.terminate(); end(reject, new Error('PDF took too long to read')); }, l.timeoutMs);
    w.once('message', (m) => {
      if (m && m.error) return end(reject, new Error(m.error));
      const r = m.result;
      r.frames.forEach(f => { f.bytes = Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength); });
      end(resolve, r);
    });
    w.once('error', (e) => end(reject, new Error(/memory|heap/i.test(e.message) ? 'PDF needs too much memory to read' : e.message)));
    w.once('exit', (code) => end(reject, new Error('PDF reader stopped (' + code + ')')));
  });
}

if (!isMainThread && workerData && workerData.__bsmntPdf) {
  extractFrames(Buffer.from(workerData.bytes), workerData.opts)
    .then(r => parentPort.postMessage({ result: r }))
    .catch(e => parentPort.postMessage({ error: e.message || String(e) }));
}

module.exports = { extractFrames, extractFramesIsolated };
