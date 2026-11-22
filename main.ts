// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. Sections 1 to 4, 9 and 10 of SPEC.md are the command line, the output and exit
// codes, safe paths, format detection, JSON edits and the all-or-nothing write. Sections 5 to 8 are the matching
// tiers and the three text formats: unified diffs, SEARCH/REPLACE blocks and V4A patches.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Set from `--strict` before the patch is read: only tier 0 is tried (SPEC.md section 5). */
let strictFlag = false;

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** A file's line break (SPEC.md section 3): CRLF when its first line feed follows a carriage return. */
function breakOf(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

/** A file's lines, its line break, and whether it ends with that break (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = breakOf(text);
  const cut = br === '\r\n' ? text.replaceAll('\r\n', '\n') : text;
  const parts = cut.split('\n');
  const final = cut.endsWith('\n');
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// Section 5: matching lines. stripLevel 0 keeps the line, 1 removes trailing spaces and tabs, 2 removes leading and
// trailing spaces and tabs.
function strip(line: string, level: number): string {
  if (level === 0) return line;
  if (level === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based positions where O occurs in file at tier `level` (occurrences may overlap). */
function occurrences(file: string[], o: string[], level: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const fo = o.map((l) => strip(l, level));
  const ff = file.map((l) => strip(l, level));
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (fo[j] !== ff[i + j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// Section 5: an old-line list O found in the file at the first tier it occurs at, with the positions it occurs at.
interface Found {
  level: number;
  at: number[];
}
function findTiers(file: string[], o: string[], strict: boolean): Found | null {
  for (let level = 0; level <= (strict || o.length === 0 ? 0 : 2); level += 1) {
    const at = occurrences(file, o, level);
    if (at.length > 0) return { level, at };
  }
  return null;
}

// Section 5: at tier 2, re-indent a new line so that the file's own indentation replaces the patch's. At tiers 0 and 1
// the line is written as it is.
function reindent(line: string, F: string, P: string, level: number): string {
  if (level < 2) return line;
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}
function leading(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

// A line of N after reading a format: a context line (taken from the file's own matched lines) or a new line.
interface NLine {
  context: boolean;
  line: string;
}

/** Replace the k = O.length lines at position i in file with N (section 5). */
function splice(file: string[], i: number, o: string[], n: NLine[], level: number): string[] {
  const F = leading(file[i] ?? '');
  const P = leading(o[0] ?? '');
  const out: string[] = [];
  let ci = 0;
  for (const nl of n) {
    if (nl.context) {
      out.push(file[i + ci] ?? '');
      ci += 1;
    } else {
      out.push(reindent(nl.line, F, P, level));
    }
  }
  return [...file.slice(0, i), ...out, ...file.slice(i + o.length)];
}

// Section 6: unified diffs.
interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  renamed: boolean;
  hunks: UHunk[];
}
interface UHunk {
  a: number;
  body: ULine[];
}
interface ULine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

// Section 6: the path after `--- ` / `+++ ` (four characters, up to the first tab, trimmed; `a/`/`b/` removed).
function uPath(s: string): string | null {
  let p = s.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** The `\`-flag after the body's last context or `+` line (the last N line). */
function lastNoNewline(body: UBodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === ' ' || k === '+') return body[i + 1]?.kind === '\\';
  }
  return false;
}

function readUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, renamed: false, hunks: [] };
      sections.push(sec);
      i = readUSection(lines, i + 1, sec);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { oldPath: uPath(line), newPath: uPath(lines[i + 1]!), create: false, del: false, renamed: false, hunks: [] };
      sections.push(sec);
      i = readUSection(lines, i + 2, sec);
      continue;
    }
    i += 1;
  }
  return sections.map(usectionEdit);
}

function readUSection(lines: string[], i: number, sec: USection): number {
  let header = true;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: UBodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        const c = b[0];
        if (c === ' ') body.push({ kind: ' ', text: b.slice(1) });
        else if (c === '-') body.push({ kind: '-', text: b.slice(1) });
        else if (c === '+') body.push({ kind: '+', text: b.slice(1) });
        else if (c === '\\') body.push({ kind: '\\', text: b.slice(1) });
        else if (b === '') body.push({ kind: ' ', text: '' });
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      sec.hunks.push({ a, body });
      header = false;
      continue;
    }
    if (header) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) sec.newPath = uPath(line);
      else if (line.startsWith('rename from ')) { sec.oldPath = line.slice('rename from '.length); sec.renamed = true; }
      else if (line.startsWith('rename to ')) { sec.newPath = line.slice('rename to '.length); sec.renamed = true; }
      else if (line.startsWith('new file mode')) sec.create = true;
      else if (line.startsWith('deleted file mode')) sec.del = true;
    }
    i += 1;
  }
  return i;
}

function uApplyHunks(file: FileLines, hunks: UHunk[], strict: boolean, path: string): FileLines {
  let lines = file.lines;
  let final = file.final;
  let d = 0;
  for (const hunk of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of hunk.body) {
      if (b.kind === ' ' || b.kind === '-') O.push(b.text);
      if (b.kind === ' ' || b.kind === '+') N.push({ context: b.kind === ' ', line: b.text });
    }
    let at: number;
    let level = 0;
    if (O.length > 0) {
      const found = findTiers(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      level = found.level;
      const target = hunk.a - 1 + d;
      at = found.at[0]!;
      let best = Math.abs(at - target);
      for (const x of found.at) {
        const dist = Math.abs(x - target);
        if (dist < best) { best = dist; at = x; }
      }
    } else {
      at = Math.min(hunk.a + d, lines.length);
      const inserted = N.map((n) => n.line);
      lines = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
      if (at + inserted.length === lines.length) final = !lastNoNewline(hunk.body);
      d += N.length - O.length;
      continue;
    }
    const atEnd = at + O.length === lines.length;
    lines = splice(lines, at, O, N, level);
    if (atEnd) final = !lastNoNewline(hunk.body);
    d += N.length - O.length;
  }
  return { lines, br: file.br, final };
}

function requireSafe(...paths: (string | null)[]): void {
  for (const p of paths) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
}

function usectionEdit(sec: USection): Edit {
  return (tree) => {
    if (sec.create || sec.oldPath === null) {
      const p = sec.newPath;
      if (p === null) return;
      requireSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const bodies = sec.hunks.flatMap((h) => h.body);
      const lines = bodies.filter((b) => b.kind === '+').map((b) => b.text);
      const final = !lastNoNewline(bodies);
      tree.now.set(p, joinFile(lines, '\n', final));
      return;
    }
    if (sec.del || sec.newPath === null) {
      const p = sec.oldPath;
      if (p === null) return;
      requireSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === newP) {
      requireSafe(oldP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const fl = splitFile(before);
      const out = uApplyHunks(fl, sec.hunks, strictFlag, oldP);
      tree.now.set(oldP, joinFile(out.lines, fl.br, out.final));
      return;
    }
    requireSafe(oldP, newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const fl = splitFile(before);
    const out = uApplyHunks(fl, sec.hunks, strictFlag, oldP);
    tree.now.set(oldP, null);
    tree.now.set(newP, joinFile(out.lines, fl.br, out.final));
  };
}

// Section 4: detecting the format.
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
  strictFlag = strict;
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
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? readUnified(lines)
      : kind === 'search-replace' ? readSearchReplace(lines)
      : readV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
