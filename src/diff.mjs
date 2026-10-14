// Unified diff parser. Tracks which new-side lines can carry inline review comments.

// Git C-style quoted path ("a/\320\272.ts") → UTF-8 string.
function unquote(p) {
  if (!p.startsWith('"')) return p;
  const bytes = [];
  for (let i = 1; i < p.length - 1; i++) {
    const c = p[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = p[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(p.slice(i, i + 3), 8)); i += 2; }
    else bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

const stripPrefix = (p, pre) => (p.startsWith(pre) ? p.slice(pre.length) : p);
const headerPath = (raw, pre) => stripPrefix(unquote(raw.replace(/\t.*$/, '')), pre);

export function parseDiff(text) {
  const files = [];
  let cur = null;
  let newLine = 0;
  let oldLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of text.split('\n')) {
    const inHunk = cur && (oldLeft > 0 || newLeft > 0);

    if (!inHunk && raw.startsWith('diff --git ')) {
      const rest = raw.slice(11);
      const m = rest.match(/^("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/);
      cur = {
        oldPath: m ? stripPrefix(unquote(m[1]), 'a/') : null,
        path: m ? stripPrefix(unquote(m[2]), 'b/') : null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        commentable: new Set(),
        lines: [],
      };
      files.push(cur);
      continue;
    }
    if (!cur) continue;

    if (inHunk) {
      const tag = raw[0];
      if (tag === '+') {
        cur.lines.push({ kind: 'add', newLine, text: raw.slice(1) });
        cur.commentable.add(newLine);
        cur.additions++;
        newLine++; newLeft--;
      } else if (tag === '-') {
        cur.lines.push({ kind: 'del', oldLine, text: raw.slice(1) });
        cur.deletions++;
        oldLine++; oldLeft--;
      } else if (tag === '\\') {
        // "\ No newline at end of file"
      } else {
        // ' ' context, or an empty line whose leading space was stripped.
        cur.lines.push({ kind: 'ctx', newLine, text: raw.slice(1) });
        cur.commentable.add(newLine);
        newLine++; oldLine++; newLeft--; oldLeft--;
      }
      continue;
    }

    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      oldLine = Number(m[1]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLine = Number(m[3]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      cur.lines.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('new file mode')) cur.status = 'added';
    else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (raw.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = unquote(raw.slice(12)); }
    else if (raw.startsWith('rename to ')) cur.path = unquote(raw.slice(10));
    else if (raw.startsWith('Binary files')) cur.binary = true;
    else if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      if (!p.startsWith('/dev/null')) cur.path = headerPath(p, 'b/');
    }
  }
  return files.filter((f) => f.path);
}

// Render a file diff with new-side line numbers so the model can cite exact lines.
export function renderFileDiff(file) {
  const out = [`### ${file.path} (${file.status}${file.oldPath && file.oldPath !== file.path ? ` ← ${file.oldPath}` : ''}, +${file.additions}/-${file.deletions})`];
  if (file.binary) {
    out.push('(бинарный файл)');
    return out.join('\n');
  }
  for (const l of file.lines) {
    if (l.kind === 'hunk') out.push(l.text);
    else if (l.kind === 'add') out.push(`${String(l.newLine).padStart(5)} + ${l.text}`);
    else if (l.kind === 'ctx') out.push(`${String(l.newLine).padStart(5)}   ${l.text}`);
    else out.push(`      - ${l.text}`);
  }
  return out.join('\n');
}

// Snap a line to the nearest commentable line within `radius`, preferring added lines.
export function resolveCommentLine(file, line, radius = 3) {
  if (!file || !Number.isInteger(line)) return null;
  if (file.commentable.has(line)) return line;
  for (let d = 1; d <= radius; d++) {
    if (file.commentable.has(line - d)) return line - d;
    if (file.commentable.has(line + d)) return line + d;
  }
  return null;
}
