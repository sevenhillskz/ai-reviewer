import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegExp, matchesAny } from '../src/glob.mjs';
import { parseDiff, renderFileDiff, resolveCommentLine } from '../src/diff.mjs';
import { Toolbox } from '../src/tools.mjs';
import { placeComments, runReview } from '../src/review.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { existingFingerprints, fingerprint, inlineBody, summaryBody } from '../src/format.mjs';
import { mockModel } from '../src/mock.mjs';
import { costOf } from '../src/anthropic.mjs';

test('glob', () => {
  assert.ok(globToRegExp('**/package-lock.json').test('package-lock.json'));
  assert.ok(globToRegExp('**/package-lock.json').test('backend/package-lock.json'));
  assert.ok(globToRegExp('**/dist/**').test('frontend/dist/a/b.js'));
  assert.ok(globToRegExp('**/.env.*').test('backend/.env.local'));
  assert.ok(!globToRegExp('**/.env.*').test('backend/.env-example'));
  assert.ok(globToRegExp('backend/src/modules/*-document/**').test('backend/src/modules/x-document/a.ts'));
  assert.ok(!globToRegExp('backend/src/modules/*-document/**').test('backend/src/modules/banks/a.ts'));
  assert.ok(globToRegExp('**/*.{png,svg}').test('a/b/logo.svg'));
  assert.ok(matchesAny('src/a.min.js', DEFAULTS.ignore));
  assert.ok(!matchesAny('src/a.ts', DEFAULTS.ignore));
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line1
-old2
+new2
+new3
 line4
 line5
@@ -20,2 +21,3 @@ fn
 l21
+l22
 l23
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/old.ts b/renamed.ts
similarity index 90%
rename from old.ts
rename to renamed.ts
--- a/old.ts
+++ b/renamed.ts
@@ -1 +1 @@
-x
+y
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test('parseDiff', () => {
  const files = parseDiff(DIFF);
  assert.equal(files.length, 4);
  const [a, png, ren, gone] = files;
  assert.equal(a.path, 'src/a.ts');
  assert.equal(a.additions, 3);
  assert.equal(a.deletions, 1);
  assert.deepEqual([...a.commentable].sort((x, y) => x - y), [1, 2, 3, 4, 5, 21, 22, 23]);
  assert.ok(png.binary);
  assert.equal(png.status, 'added');
  assert.equal(ren.status, 'renamed');
  assert.equal(ren.path, 'renamed.ts');
  assert.equal(ren.oldPath, 'old.ts');
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.path, 'gone.ts');
  assert.match(renderFileDiff(a), /\s+3 \+ new3/);
});

test('resolveCommentLine', () => {
  const [a] = parseDiff(DIFF);
  assert.equal(resolveCommentLine(a, 3), 3);
  assert.equal(resolveCommentLine(a, 7), 5);
  assert.equal(resolveCommentLine(a, 12), null);
  assert.equal(resolveCommentLine(undefined, 3), null);
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'air-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/svc.ts'), 'export class Svc {\n  a() { return 1; }\n}\n');
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  g('add', 'src/svc.ts'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'src/svc.ts'), 'export class Svc {\n  a() { return 1; }\n  b(id: any) { return db.query("select * from t where id=" + id); }\n}\n');
  g('add', 'src/svc.ts'); g('commit', '-qm', 'feat: b');
  const diff = g('diff', base, 'HEAD');
  return { dir, base, diff };
}

test('Toolbox sandbox', () => {
  const { dir, base, diff } = makeRepo();
  const tb = new Toolbox({ root: dir, baseSha: base, files: parseDiff(diff), secretFiles: DEFAULTS.secretFiles });
  assert.match(tb.run('read_file', { path: 'src/svc.ts' }), / 3 +b\(id: any\)/);
  assert.match(tb.run('read_file', { path: '../x' }), /вне репозитория/);
  assert.match(tb.run('read_file', { path: '/etc/passwd' }), /Ошибка|не найден/);
  assert.match(tb.run('read_file', { path: '.env' }), /секрет/);
  assert.match(tb.run('read_file', { path: '.git/config' }), /вне репозитория/);
  assert.doesNotMatch(tb.run('read_base_file', { path: 'src/svc.ts' }), /b\(id/);
  assert.match(tb.run('search', { pattern: 'db\\.query' }), /src\/svc.ts:3/);
  assert.match(tb.run('search', { pattern: 'SECRET' }), /Ничего не найдено/);
  assert.match(tb.run('list_dir', { path: '' }), /src\//);
  assert.match(tb.run('get_file_diff', { path: 'src/svc.ts' }), /3 \+ +b\(id/);
});

test('runReview with mock model end-to-end', async () => {
  const { dir, base, diff } = makeRepo();
  const files = parseDiff(diff);
  const cfg = { ...DEFAULTS };
  const pr = { number: 1, title: 't', body: '', head: 'h', base: 'main', author: 'x' };
  const out = await runReview({ pr, files, root: dir, baseSha: base, cfg, callModel: mockModel(files), log: () => {} });
  assert.equal(out.turns, 2);
  assert.ok(out.cost > 0);
  const placed = placeComments(out.result, files, cfg, resolveCommentLine);
  assert.equal(placed.inline.length, 1);
  assert.equal(placed.inline[0].line, 3);
  assert.equal(placed.outside.length, 1);
  assert.equal(placed.dropped, 1);
  const s = summaryBody({ result: out.result, ...placed, meta: { model: cfg.model, turns: 2, tokens: 12345, cost: 0.12, sha: 'abcdef123' } });
  assert.match(s, /ai-review:summary/);
  assert.match(s, /Замечания вне диффа/);
  const body = inlineBody(placed.inline[0]);
  assert.ok(existingFingerprints([{ body, user: { type: 'Bot' } }]).has(fingerprint(placed.inline[0].path, placed.inline[0].title)));
});

test('runReview: nudges, budget guard, turn limit', async () => {
  const { dir, base, diff } = makeRepo();
  const files = parseDiff(diff);
  const pr = { number: 1, title: 't', body: '', head: 'h', base: 'main', author: 'x' };

  // Model that never calls tools nor submits → error after nudges.
  const silent = async () => ({ content: [{ type: 'text', text: 'хм' }], usage: {} });
  await assert.rejects(runReview({ pr, files, root: dir, baseSha: base, cfg: { ...DEFAULTS }, callModel: silent, log: () => {} }), /submit_review/);

  // Expensive model → hard cost stop.
  let n = 0;
  const pricey = async () => ({
    content: [{ type: 'tool_use', id: `x${n++}`, name: 'list_dir', input: { path: '' } }],
    usage: { input_tokens: 400_000, output_tokens: 0 },
  });
  await assert.rejects(runReview({ pr, files, root: dir, baseSha: base, cfg: { ...DEFAULTS, maxCostUsd: 3 }, callModel: pricey, log: () => {} }), /лимит стоимости/);

  // Cache breakpoints never exceed 1 on messages (+1 on system).
  let maxMarks = 0;
  let k = 0;
  const counting = async (req) => {
    const marks = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control).length;
    maxMarks = Math.max(maxMarks, marks);
    if (++k < 4) return { content: [{ type: 'tool_use', id: `c${k}`, name: 'list_dir', input: { path: '' } }], usage: {} };
    return { content: [{ type: 'tool_use', id: 'end', name: 'submit_review', input: { summary: 's', risk: 'low', comments: [] } }], usage: {} };
  };
  await runReview({ pr, files, root: dir, baseSha: base, cfg: { ...DEFAULTS }, callModel: counting, log: () => {} });
  assert.equal(maxMarks, 1);
});

test('cost', () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  assert.equal(costOf('claude-opus-5-5', { cache_read_input_tokens: 1e6 }).toFixed(2), '0.40');
});

test('readStream assembles SSE', async () => {
  const { readStream } = await import('../src/anthropic.mjs');
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const sse = [
    ev({ type: 'message_start', message: { id: 'm', role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'При' } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'вет' } }),
    ev({ type: 'content_block_stop', index: 1 }),
    ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'read_file', input: {} } }),
    ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } }),
    ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '.ts"}' } }),
    ev({ type: 'content_block_stop', index: 2 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
    ev({ type: 'message_stop' }),
  ].join('');
  // Split at awkward boundaries, including inside a UTF-8 char.
  const bytes = Buffer.from(sse);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 37) chunks.push(bytes.subarray(i, i + 37));
  const msg = await readStream({ body: chunks });
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.content[0].signature, 'sig');
  assert.equal(msg.content[1].text, 'Привет');
  assert.deepEqual(msg.content[2].input, { path: 'a.ts' });
  assert.equal(msg.usage.output_tokens, 7);
  assert.equal(msg.usage.input_tokens, 10);
});
