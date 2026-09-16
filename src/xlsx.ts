/**
 * Minimal, dependency-free readers for the two spreadsheet formats the Georgian
 * energy publishers use. Both run on the Workers runtime with no npm deps.
 *
 *  - XLSX (OOXML): a ZIP of XML parts. Enumerated via the ZIP central
 *    directory, inflated with the Workers-native DecompressionStream, then
 *    read with targeted regexes. Same ZIP approach as mcps/germany-tenders.
 *  - XLS (BIFF8 inside an OLE2 compound file): GSE's day-ahead forecast is a
 *    real Excel 97 file (`D0 CF 11 E0` magic), not an HTML table wearing an
 *    .xls extension, so it needs the compound-file container walked before the
 *    BIFF record stream can be read.
 *
 * ⚠️ The one trap worth stating, because it is silent: a naive
 * `<c ...>(.*?)</c>` regex over a worksheet MERGES a self-closing empty cell
 * with the next populated one, so a value lands under the wrong column letter.
 * On the GNERC balance sheet, where columns C..N are Jan..Dec, that reads a
 * December figure as April and returns a confident wrong month. Empty cells in
 * these files are self-closing, so the self-closing alternative MUST come
 * first in the pattern below.
 */

// ── ZIP ────────────────────────────────────────────────────────────────────

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const stream = src.pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

/** Enumerate a ZIP's entries and inflate each one to text. */
async function unzipToMap(bytes: Uint8Array): Promise<Map<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('XLSX: no ZIP End Of Central Directory record found');
  const total = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);

  const out = new Map<string, string>();
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const fnLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOffset = dv.getUint32(cd + 42, true);
    const name = dec.decode(bytes.subarray(cd + 46, cd + 46 + fnLen));
    cd += 46 + fnLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    // Only the XML parts matter; skip printerSettings*.bin, media, theme blobs.
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    if (dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lFnLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lFnLen + lExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) out.set(name, dec.decode(payload));
    else if (method === 8) out.set(name, dec.decode(await inflateRaw(payload)));
  }
  return out;
}

// ── XLSX ───────────────────────────────────────────────────────────────────

export type Sheet = {
  name: string;
  /** row number (1-based, as written in the file) -> column letter -> value */
  rows: Map<number, Map<string, string | number>>;
};

export type Workbook = { sheets: Sheet[] };

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Self-closing FIRST — see the header note. Getting this order wrong shifts
// values into neighbouring columns without erroring.
const CELL_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
const ROW_RE = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;

export async function parseXlsx(bytes: Uint8Array): Promise<Workbook> {
  const parts = await unzipToMap(bytes);
  const wbXml = parts.get('xl/workbook.xml');
  if (!wbXml) throw new Error('XLSX: xl/workbook.xml missing — not an OOXML workbook');
  const relsXml = parts.get('xl/_rels/workbook.xml.rels') ?? '';

  const relMap = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1])?.[1];
    const target = /Target="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) relMap.set(id, target);
  }

  const shared: string[] = [];
  const sstXml = parts.get('xl/sharedStrings.xml');
  if (sstXml) {
    for (const si of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let text = '';
      for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
      shared.push(text);
    }
  }

  const sheets: Sheet[] = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const name = unescapeXml(/name="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const target = relMap.get(rid);
    if (!target) continue;
    const clean = target.replace(/^\//, '');
    const path = clean.startsWith('xl/') ? clean : `xl/${clean}`;
    const sheetXml = parts.get(path);
    if (!sheetXml) continue;

    const rows = new Map<number, Map<string, string | number>>();
    for (const rm of sheetXml.matchAll(ROW_RE)) {
      const rowNum = Number(rm[1]);
      const cells = new Map<string, string | number>();
      for (const cm of rm[2].matchAll(CELL_RE)) {
        const attrsC = cm[1] !== undefined ? cm[1] : cm[2];
        const inner = cm[3] ?? '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrsC ?? '')?.[1];
        if (!ref) continue;
        const type = /t="([^"]+)"/.exec(attrsC ?? '')?.[1] ?? 'n';
        let value: string | number | undefined;
        if (type === 'inlineStr') {
          let text = '';
          for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
          value = text;
        } else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (raw === undefined) continue;
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'str' || type === 'e') value = unescapeXml(raw);
          else {
            const n = Number(raw);
            value = Number.isFinite(n) ? n : unescapeXml(raw);
          }
        }
        if (value === undefined || value === '') continue;
        cells.set(ref, value);
      }
      if (cells.size) rows.set(rowNum, cells);
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

// ── XLS (OLE2 + BIFF8) ─────────────────────────────────────────────────────

function readOleStream(bytes: Uint8Array, wanted: string[]): Uint8Array | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== magic[i]) throw new Error('XLS: not an OLE2 compound file');
  }
  const sectorSize = 1 << dv.getUint16(30, true);
  const miniSectorSize = 1 << dv.getUint16(32, true);
  const numFat = dv.getUint32(44, true);
  const dirFirst = dv.getUint32(48, true);
  const miniFirst = dv.getUint32(60, true);
  const difatFirst = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);

  const fatSectors: number[] = [];
  for (let i = 0; i < Math.min(109, numFat); i++) {
    const s = dv.getUint32(76 + i * 4, true);
    if (s < 0xfffffffa) fatSectors.push(s);
  }
  let sec = difatFirst;
  for (let n = 0; n < numDifat && sec < 0xfffffffa; n++) {
    const off = 512 + sec * sectorSize;
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const v = dv.getUint32(off + i * 4, true);
      if (v < 0xfffffffa) fatSectors.push(v);
    }
    sec = dv.getUint32(off + sectorSize - 4, true);
  }

  const fat: number[] = [];
  for (const s of fatSectors) {
    const off = 512 + s * sectorSize;
    for (let i = 0; i < sectorSize / 4; i++) fat.push(dv.getUint32(off + i * 4, true));
  }

  const readChain = (start: number, size?: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    let s = start;
    let guard = 0;
    while (s < 0xfffffffa && guard++ < 200000) {
      parts.push(bytes.subarray(512 + s * sectorSize, 512 + (s + 1) * sectorSize));
      s = fat[s] ?? 0xfffffffe;
    }
    let len = 0;
    for (const p of parts) len += p.length;
    const merged = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    return size !== undefined ? merged.subarray(0, size) : merged;
  };

  const dir = readChain(dirFirst);
  const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
  const utf16 = new TextDecoder('utf-16le');
  for (let i = 0; i + 128 <= dir.length; i += 128) {
    const nameLen = dir[i + 64] | (dir[i + 65] << 8);
    const name = nameLen > 2 ? utf16.decode(dir.subarray(i, i + nameLen - 2)) : '';
    const ddv = new DataView(dir.buffer, dir.byteOffset + i, 128);
    entries.push({ name, type: dir[i + 66], start: ddv.getUint32(116, true), size: Number(ddv.getBigUint64(120, true)) });
  }

  const root = entries.find((e) => e.type === 5);
  const miniFatRaw = readChain(miniFirst);
  const miniFat: number[] = [];
  const mdv = new DataView(miniFatRaw.buffer, miniFatRaw.byteOffset, miniFatRaw.byteLength);
  for (let i = 0; i + 4 <= miniFatRaw.length; i += 4) miniFat.push(mdv.getUint32(i, true));
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);

  for (const want of wanted) {
    const e = entries.find((x) => x.name === want && x.type === 2);
    if (!e) continue;
    if (e.size < 4096) {
      const parts: Uint8Array[] = [];
      let s = e.start;
      let guard = 0;
      while (s < 0xfffffffa && guard++ < 200000) {
        parts.push(miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize));
        s = miniFat[s] ?? 0xfffffffe;
      }
      let len = 0;
      for (const p of parts) len += p.length;
      const merged = new Uint8Array(len);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }
      return merged.subarray(0, e.size);
    }
    return readChain(e.start, e.size);
  }
  return null;
}

function rkToNumber(rk: number): number {
  const isCents = (rk & 1) === 1;
  const isInt = (rk & 2) === 2;
  const masked = rk & 0xfffffffc;
  let n: number;
  if (isInt) {
    n = (masked | 0) >> 2;
  } else {
    const buf = new ArrayBuffer(8);
    const bdv = new DataView(buf);
    bdv.setUint32(4, masked >>> 0, true);
    bdv.setUint32(0, 0, true);
    n = bdv.getFloat64(0, true);
  }
  return isCents ? n / 100 : n;
}

/** BIFF8 cell grid: row (0-based) -> column (0-based) -> value. */
export type BiffGrid = Map<number, Map<number, string | number>>;

export function parseXls(bytes: Uint8Array): { sheetNames: string[]; grid: BiffGrid } {
  const stream = readOleStream(bytes, ['Workbook', 'Book']);
  if (!stream) throw new Error('XLS: no Workbook/Book stream inside the compound file');
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

  const records: Array<{ type: number; start: number; length: number }> = [];
  for (let i = 0; i + 4 <= stream.length; ) {
    const type = dv.getUint16(i, true);
    const length = dv.getUint16(i + 2, true);
    records.push({ type, start: i + 4, length });
    i += 4 + length;
  }

  const sheetNames: string[] = [];
  const cp1251 = new TextDecoder('windows-1251');
  const utf16 = new TextDecoder('utf-16le');

  // SST + its CONTINUE records, concatenated into one logical buffer. The
  // grapheme boundary handling below follows the BIFF8 rule that a CONTINUE
  // may restart a split string with a fresh 1-byte compression flag.
  const sstChunks: Uint8Array[] = [];
  let inSst = false;
  for (const r of records) {
    const body = stream.subarray(r.start, r.start + r.length);
    if (r.type === 0x00fc) {
      sstChunks.push(body);
      inSst = true;
    } else if (r.type === 0x003c && inSst) {
      sstChunks.push(body);
    } else if (r.type === 0x0085) {
      // BOUNDSHEET
      const len = body[6];
      const flags = body[7];
      sheetNames.push(
        flags & 1 ? utf16.decode(body.subarray(8, 8 + len * 2)) : cp1251.decode(body.subarray(8, 8 + len)),
      );
      inSst = false;
    } else if (r.type !== 0x003c) {
      inSst = false;
    }
  }

  const strings: string[] = [];
  if (sstChunks.length) {
    let ci = 0;
    let cur = sstChunks[0];
    let off = 8;
    const first = new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
    const total = first.getUint32(4, true);
    const advance = () => {
      ci += 1;
      cur = sstChunks[ci];
      off = 0;
    };
    for (let n = 0; n < total && ci < sstChunks.length; n++) {
      if (off + 3 > cur.length) {
        if (ci + 1 >= sstChunks.length) break;
        advance();
      }
      const cdv = new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
      let remaining = cdv.getUint16(off, true);
      off += 2;
      let flags = cur[off];
      off += 1;
      let high = (flags & 1) === 1;
      let richRuns = 0;
      let extSize = 0;
      if (flags & 8) {
        richRuns = cdv.getUint16(off, true);
        off += 2;
      }
      if (flags & 4) {
        extSize = cdv.getUint32(off, true);
        off += 4;
      }
      let text = '';
      while (remaining > 0) {
        const width = high ? 2 : 1;
        const avail = Math.floor((cur.length - off) / width);
        const take = Math.min(avail, remaining);
        if (take > 0) {
          const raw = cur.subarray(off, off + take * width);
          text += high ? utf16.decode(raw) : cp1251.decode(raw);
          off += take * width;
          remaining -= take;
        }
        if (remaining > 0) {
          if (ci + 1 >= sstChunks.length) break;
          advance();
          flags = cur[0];
          high = (flags & 1) === 1;
          off = 1;
        }
      }
      off += richRuns * 4 + extSize;
      strings.push(text);
    }
  }

  const grid: BiffGrid = new Map();
  const put = (row: number, col: number, value: string | number) => {
    let r = grid.get(row);
    if (!r) {
      r = new Map();
      grid.set(row, r);
    }
    r.set(col, value);
  };

  for (const r of records) {
    const body = stream.subarray(r.start, r.start + r.length);
    if (body.length < 6) continue;
    const bdv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const row = bdv.getUint16(0, true);
    const col = bdv.getUint16(2, true);
    switch (r.type) {
      case 0x00fd: // LABELSST
        put(row, col, strings[bdv.getUint32(6, true)] ?? '');
        break;
      case 0x0203: // NUMBER
        if (body.length >= 14) put(row, col, bdv.getFloat64(6, true));
        break;
      case 0x027e: // RK
        put(row, col, rkToNumber(bdv.getInt32(6, true)));
        break;
      case 0x00bd: {
        // MULRK — a run of RK cells sharing one row
        const count = Math.floor((body.length - 6) / 6);
        for (let k = 0; k < count; k++) put(row, col + k, rkToNumber(bdv.getInt32(4 + k * 6 + 2, true)));
        break;
      }
      default:
        break;
    }
  }
  return { sheetNames, grid };
}
