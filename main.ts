// mend — one patch tool for every AI edit format (unified diff, SEARCH/REPLACE
// blocks, V4A patches and JSON tool calls), as SPEC.md specifies. Node 22,
// standard library only; run as `node main.ts [options] [PATCH]` with the
// working directory as the root of the tree being patched.
//
// Layout of this file: the command line and the all-or-nothing write live at
// the bottom; above them sit the file/line model, the three matching tiers,
// one reader per format (each reader turns patch text into a list of edits),
// and the edit appliers shared by the line-based formats. Every reader raises
// Exit2 for a parse fault before any file is looked at; every applier raises
// Fail for a per-edit failure, which the driver collects while rolling that
// edit's changes back, so a run either writes every change or none.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no final empty piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when no segment is empty, "." or "..", and it is relative and backslash-free. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into its lines, remembering its break and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in order, as [oldPath, newPath]; rolled back with `now`. */
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- matching

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/**
 * Find old lines O in `lines` at the first tier (0, 1 or 2; only 0 when strict)
 * that has an occurrence at or after `from`. Returns the tier and every
 * occurrence position at that tier, or null when O occurs nowhere.
 */
function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (!lineEq(lines[i + k]!, O[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: a context line (shared with O) or a fresh line, plus its no-newline mark. */
interface NLine {
  text: string;
  ctx: boolean;
  noNl: boolean;
}

/**
 * Pair a body's items (context / old / new, in order) into O's texts, N's
 * lines and the old-line offset of each context line, so buildN can pick the
 * file's own line for every context line.
 */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
  /** True only for a literally empty patch line (a blank context line), as opposed to a ` ` line. */
  litEmpty?: boolean;
}

function pairLines(items: BodyItem[]): { O: string[]; N: NLine[]; ctxOld: number[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  const ctxOld: number[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      ctxOld.push(O.length);
      O.push(it.text);
      N.push({ text: it.text, ctx: true, noNl: it.noNl });
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else {
      N.push({ text: it.text, ctx: false, noNl: it.noNl });
    }
  }
  return { O, N, ctxOld };
}

/** buildN variant that honours the context pairing produced by pairLines. */
function buildPaired(items: BodyItem[], fileLines: string[], pos: number, tier: number): { O: string[]; out: string[] } {
  const { O, N, ctxOld } = pairLines(items);
  const out: string[] = [];
  let ci = 0;
  const F = tier === 2 ? leadWs(fileLines[0] ?? '') : '';
  const P = tier === 2 && O.length > 0 ? leadWs(O[0]!) : '';
  for (const nl of N) {
    if (nl.ctx) {
      out.push(fileLines[ctxOld[ci]!]!);
      ci += 1;
    } else {
      let t = nl.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  void pos;
  return { O, out };
}

/** Re-indent plain replacement lines (SEARCH/REPLACE, where no line is context) at tier 2. */
function reindentPlain(N: string[], O: string[], fileFirst: string, tier: number): string[] {
  if (tier !== 2) return [...N];
  const F = leadWs(fileFirst);
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  return N.map((t) => (t.trim() !== '' && t.startsWith(P) ? F + t.slice(P.length) : t));
}

// ----------------------------------------------------------------- unified

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The path written after `--- `/`+++ `: up to the first tab, spaces trimmed, one a/ or b/ prefix removed. */
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const startSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, hasPair: false, isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.oldPath = m[1]!;
      s.newPath = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair opens a new section unless the current section is still in its
      // header and has no pair of its own yet.
      const s = cur !== null && !cur.hasPair && cur.hunks.length === 0 ? cur : startSection();
      s.oldPath = headerPath(line.slice(4));
      s.newPath = headerPath(lines[i + 1]!.slice(4));
      s.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1]!.noNl = true;
          i += 1;
          continue;
        }
        if (b === '') items.push({ kind: 'ctx', text: '', noNl: false, litEmpty: true });
        else if (b[0] === ' ') items.push({ kind: 'ctx', text: b.slice(1), noNl: false });
        else if (b[0] === '-') items.push({ kind: 'old', text: b.slice(1), noNl: false });
        else if (b[0] === '+') items.push({ kind: 'new', text: b.slice(1), noNl: false });
        else break;
        i += 1;
      }
      // Literally empty lines at the end of a body are not part of it; a
      // trailing ` ` context line is a real line and stays.
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.litEmpty === true && !last.noNl) items.pop();
        else break;
      }
      cur.hunks.push({ a, items });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Still in the section header: names and flags are read, the rest ignored.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1; // prose, fences and anything else outside bodies and headers
  }
  return sections;
}

/** The last context or new item of a hunk, whose `\` mark decides the final break at the file's end. */
function lastWritten(items: BodyItem[]): BodyItem | null {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    if (items[k]!.kind !== 'old') return items[k]!;
  }
  return null;
}

function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  const lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O } = pairLines(h.items);
    if (O.length === 0) {
      const news = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      // Insert after the first A+d lines; the count may be negative or past
      // the end, so clamp it instead of letting splice read it as an offset.
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...news);
      if (atEnd) {
        const lw = lastWritten(h.items);
        if (lw !== null) final = !lw.noNl;
      }
      d += news.length;
      continue;
    }
    const found = findTier(lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const cand of found.at) {
      if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
    }
    const matched = lines.slice(pos, pos + O.length);
    const { out } = buildPaired(h.items, matched, pos, found.tier);
    const runsToEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...out);
    if (runsToEnd) {
      const lw = lastWritten(h.items);
      if (lw !== null) final = !lw.noNl;
    }
    d += out.length - O.length;
  }
  return { lines, br: f.br, final };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const creation = sec.oldPath === '/dev/null' || sec.isNew;
    const deletion = sec.newPath === '/dev/null' || sec.isDel;
    if (creation) {
      const p = sec.newPath;
      if (p === null || p === '/dev/null') throw new Fail('no-match', p ?? '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let lastPlus: BodyItem | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            outLines.push(it.text);
            lastPlus = it;
          }
        }
      }
      const text = outLines.length === 0 ? '' : outLines.join('\n') + (lastPlus !== null && lastPlus.noNl ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    if (deletion) {
      const p = sec.oldPath;
      if (p === null || p === '/dev/null') throw new Fail('missing', p ?? '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath ?? sec.oldPath;
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const isMove = newP !== oldP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const after = applyHunks(splitFile(before), sec.hunks, strict, oldP);
    tree.now.set(newP, joinFile(after));
    if (isMove) {
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------- search/replace

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0; // index just past the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    // The path is the nearest usable line above, not crossing the last block.
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchAt + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.at.length > 1) throw new Fail('ambiguous', p);
    const pos = found.at[0]!;
    const out = reindentPlain(b.newLines, b.oldLines, f.lines[pos]!, found.tier);
    const lines = [...f.lines];
    lines.splice(pos, b.oldLines.length, ...out);
    tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSR(lines).map((b) => srEdit(b, strict));
}

// --------------------------------------------------------------------- v4a

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  atLine: number;
  content: { line: string; no: number }[];
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: [string, VSection['kind']][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    let sec: VSection | null = null;
    for (const [pre, kind] of heads) {
      if (lines[i]!.startsWith(pre)) {
        sec = { kind, path: lines[i]!.slice(pre.length).trim(), atLine: i + 1, content: [] };
        break;
      }
    }
    if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
    while (i < last) {
      const l = lines[i]!;
      if (heads.some(([pre]) => l.startsWith(pre))) break;
      sec.content.push({ line: l, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (sec.content.length > 0 && blank(sec.content[sec.content.length - 1]!.line)) sec.content.pop();
    sections.push(sec);
  }
  return sections;
}

/** Split an Update File section into its optional Move to and its chunks, checking its shape. */
function v4aChunks(sec: VSection): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let start = 0;
  if (sec.content.length > 0 && sec.content[0]!.line.startsWith('*** Move to: ')) {
    moveTo = sec.content[0]!.line.slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = start; k < sec.content.length; k += 1) {
    const { line, no } = sec.content[k]!;
    if (line === '*** End of File') {
      if (cur === null) cur = { anchor: null, eof: true, items: [] };
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) cur = { anchor: null, eof: false, items: [] };
      if (line === '') cur.items.push({ kind: 'ctx', text: '', noNl: false });
      else if (line[0] === ' ') cur.items.push({ kind: 'ctx', text: line.slice(1), noNl: false });
      else if (line[0] === '-') cur.items.push({ kind: 'old', text: line.slice(1), noNl: false });
      else cur.items.push({ kind: 'new', text: line.slice(1), noNl: false });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.atLine}`);
  return { moveTo, chunks };
}

function applyVChunks(f: FileText, chunks: VChunk[], strict: boolean, path: string): FileText {
  const lines = [...f.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at = -1;
      let aTier = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        for (let k = cursor; k < lines.length; k += 1) {
          if (lineEq(lines[k]!, ch.anchor, tier)) {
            at = k;
            aTier = tier;
            break;
          }
        }
        if (at >= 0) break;
      }
      void aTier;
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { O } = pairLines(ch.items);
    if (O.length === 0) {
      const news = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
      const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(pos, 0, ...news);
      cursor = pos + news.length;
      continue;
    }
    const found = findTier(lines, O, strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    let pos = -1;
    if (ch.eof) {
      for (const cand of found.at) {
        if (cand + O.length === lines.length) {
          pos = cand;
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', path);
    } else {
      pos = found.at[0]!;
    }
    const matched = lines.slice(pos, pos + O.length);
    const { out } = buildPaired(ch.items, matched, pos, found.tier);
    lines.splice(pos, O.length, ...out);
    cursor = pos + out.length;
  }
  return { lines, br: f.br, final: f.final };
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  // Shape checks that are parse faults happen now, before any file is read.
  let moveTo: string | null = null;
  let chunks: VChunk[] = [];
  let addLines: string[] = [];
  if (sec.kind === 'add') {
    for (const { line, no } of sec.content) {
      if (line.startsWith('+')) addLines.push(line.slice(1));
      else if (line === '') addLines.push('');
      else throw new Exit2(`error: parse ${no}`);
    }
  } else if (sec.kind === 'del') {
    if (sec.content.length > 0) throw new Exit2(`error: parse ${sec.content[0]!.no}`);
  } else {
    const parsed = v4aChunks(sec);
    moveTo = parsed.moveTo;
    chunks = parsed.chunks;
  }
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const after = applyVChunks(splitFile(before), chunks, strict, p);
    const target = moveTo ?? p;
    tree.now.set(target, joinFile(after));
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((s) => v4aEdit(s, strict));
}

// -------------------------------------------------------------------- json

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------------ driver

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with a qualifying move's D+A pair replaced by one R line.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : wasOld;
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && !consumed.has(oldP) && !consumed.has(newP)) {
      consumed.add(oldP);
      consumed.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
