#!/usr/bin/env node
// Entry point: GitHub Action mode (default) or local dry-run (--local).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { diskReader, loadConfig, sanitize } from './config.mjs';
import { parseDiff, resolveCommentLine } from './diff.mjs';
import { GitHub } from './github.mjs';
import { placeComments, runReview } from './review.mjs';
import { existingFingerprints, fingerprint, inlineBody, summaryBody, SUMMARY_MARKER } from './format.mjs';
import { mockModel } from './mock.mjs';

const log = (...a) => console.error('[ai-review]', ...a);
const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
  cwd, encoding: 'utf8', maxBuffer: 200e6, stdio: ['ignore', 'pipe', 'pipe'],
});

// Reads a file as of a commit — used for config and rules so a PR cannot rewrite its own review rules.
const commitReader = (root, sha) => (rel) => {
  try { return git(root, ['show', `${sha}:${rel}`]); } catch { return null; }
};

// Workflow inputs override the repo config (they come from the trusted workflow file).
function applyInputs(cfg) {
  const env = process.env;
  const next = { ...cfg };
  if (env.AI_REVIEW_MODEL) next.model = env.AI_REVIEW_MODEL;
  if (env.AI_REVIEW_EFFORT) next.effort = env.AI_REVIEW_EFFORT;
  if (env.AI_REVIEW_MAX_COST) next.maxCostUsd = Number(env.AI_REVIEW_MAX_COST);
  return sanitize(next);
}

function buildSummary(result, placed, cfg, extra) {
  const tokens = Object.values(extra.usage).reduce((a, b) => a + b, 0);
  const meta = { model: cfg.model, turns: extra.turns, tokens, cost: extra.cost, sha: extra.sha };
  return summaryBody({ result, ...placed, meta });
}

// ---------- local dry-run ----------
async function runLocal(opts) {
  let root = opts.repo;
  const headSha = git(root, ['rev-parse', opts.head]).trim();
  if (headSha !== git(root, ['rev-parse', 'HEAD']).trim()) {
    // Tools read files from disk, so materialize head in a temporary worktree.
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-'));
    git(root, ['worktree', 'add', '--detach', '--quiet', dir, headSha]);
    process.on('exit', () => { try { git(opts.repo, ['worktree', 'remove', '--force', dir]); } catch {} });
    root = dir;
  }
  const base = git(root, ['merge-base', opts.base, headSha]).trim();
  const files = parseDiff(git(root, ['diff', '--no-color', '-M', base, headSha]));
  const subject = git(root, ['log', '-1', '--format=%s', headSha]).trim();
  const readTrusted = opts['trust-head'] ? diskReader(root) : commitReader(root, base);
  const cfg = applyInputs(loadConfig(readTrusted, opts.config));
  log(`локальный прогон: ${files.length} файлов, конфиг: ${cfg._source ?? 'по умолчанию'}`);

  const pr = { number: 0, title: opts.title ?? subject, body: opts.body ?? '', head: opts.head, base: opts.base, author: 'local' };
  const out = await runReview({
    pr, files, root, baseSha: base, cfg, readTrusted, log,
    callModel: opts.mock ? mockModel(files) : undefined,
  });
  const placed = placeComments(out.result, files, cfg, resolveCommentLine);
  const { inline, outside } = placed;
  const summary = buildSummary(out.result, placed, cfg, { ...out, sha: headSha });

  const report = [summary, '', '---', `## Inline (${inline.length})`, ...inline.map((c) => `\n**${c.path}:${c.line}**${c.exact ? '' : ' (сдвинуто)'}\n${inlineBody(c)}`)].join('\n');
  if (opts.out) writeFileSync(opts.out, report);
  console.log(report);
  return { inline, outside };
}

// ---------- GitHub Action ----------
async function postInline(gh, number, commitId, comments) {
  const payload = (c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: inlineBody(c) });
  const header = (n) => `🤖 AI-ревью: ${n} замечаний в коде, сводка — в комментарии PR.`;
  try {
    await gh.createReview(number, { commitId, body: header(comments.length), comments: comments.map(payload) });
    return [];
  } catch (e) {
    if (e.status !== 422) throw e;
    log(`пакетная отправка отклонена (422), отправляю по одному`);
  }
  // One bad line rejects the whole review — retry individually, collect what fails.
  const failed = [];
  for (const c of comments) {
    try {
      await gh.createReview(number, { commitId, body: header(1), comments: [payload(c)] });
    } catch (e) {
      log(`не удалось оставить замечание ${c.path}:${c.line}: ${e.status}`);
      failed.push(c);
    }
  }
  return failed;
}

async function runAction() {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const gh = new GitHub(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY);
  const root = env.GITHUB_WORKSPACE || process.cwd();

  let number;
  let manual = false;
  if (env.GITHUB_EVENT_NAME === 'issue_comment') {
    if (!event.issue?.pull_request) return log('комментарий не в PR — пропуск');
    if (!/^\/ai-review(\s|$)/.test(event.comment?.body?.trim() ?? '')) return log('нет команды /ai-review — пропуск');
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(event.comment.author_association)) return log('команда не от участника репо — пропуск');
    number = event.issue.number;
    manual = true;
    await gh.react(event.comment.id, 'eyes');
  } else if (event.pull_request) {
    number = event.pull_request.number;
    manual = event.action === 'labeled';
  } else {
    return log(`событие ${env.GITHUB_EVENT_NAME} не поддерживается`);
  }

  const pull = await gh.getPull(number);
  if (pull.state !== 'open') return log('PR закрыт — пропуск');
  if (pull.head.repo?.full_name !== env.GITHUB_REPOSITORY) return log('PR из форка — пропуск');

  // Review exactly what is checked out; comments are attached to this commit.
  const headSha = git(root, ['rev-parse', 'HEAD']).trim();
  if (headSha !== pull.head.sha) log(`HEAD ${headSha.slice(0, 7)} ≠ head PR ${pull.head.sha.slice(0, 7)} — ревьюю checkout`);

  let baseSha;
  try {
    baseSha = git(root, ['merge-base', pull.base.sha, headSha]).trim();
  } catch {
    throw new Error(`базовый коммит ${pull.base.sha.slice(0, 7)} не найден — нужен actions/checkout с fetch-depth: 0`);
  }
  const files = parseDiff(git(root, ['diff', '--no-color', '-M', baseSha, headSha]));

  // Config and rules come from the base commit: a PR cannot loosen its own review.
  const readTrusted = commitReader(root, baseSha);
  const cfg = applyInputs(loadConfig(readTrusted, env.AI_REVIEW_CONFIG));
  if (pull.draft && cfg.skipDraft && !manual) return log('draft PR — пропуск');
  log(`PR #${number}: ${files.length} файлов, модель ${cfg.model}, конфиг ${cfg._source ?? 'по умолчанию'} (из ${baseSha.slice(0, 7)})`);

  const pr = {
    number, title: pull.title, body: pull.body ?? '',
    head: pull.head.ref, base: pull.base.ref, author: pull.user?.login ?? '?',
  };

  let out;
  try {
    out = await runReview({ pr, files, root, baseSha, cfg, readTrusted, log });
  } catch (e) {
    await gh.upsertIssueComment(number, SUMMARY_MARKER, `${SUMMARY_MARKER}\n## 🤖 AI-ревью\nНе удалось выполнить ревью: \`${e.message.slice(0, 300)}\``).catch(() => null);
    throw e;
  }

  const placed = placeComments(out.result, files, cfg, resolveCommentLine);
  const seen = existingFingerprints(await gh.listReviewComments(number));
  const fresh = placed.inline.filter((c) => !seen.has(fingerprint(c.path, c.title)));
  const failed = fresh.length ? await postInline(gh, number, headSha, fresh) : [];

  // Comments GitHub rejected move into the summary instead of being lost.
  const shown = {
    ...placed,
    inline: placed.inline.filter((c) => !failed.includes(c)),
    outside: [...placed.outside, ...failed],
  };
  const finalSummary = buildSummary(out.result, shown, cfg, { ...out, sha: headSha });
  await gh.upsertIssueComment(number, SUMMARY_MARKER, finalSummary);

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${finalSummary}\n`);
  log(`готово: ${fresh.length - failed.length} новых inline, ${placed.inline.length - fresh.length} уже были, ${failed.length} в сводку; $${out.cost.toFixed(3)}`);
}

const { values } = parseArgs({
  options: {
    local: { type: 'boolean' },
    mock: { type: 'boolean' },
    'trust-head': { type: 'boolean' },
    repo: { type: 'string', default: process.cwd() },
    base: { type: 'string' },
    head: { type: 'string', default: 'HEAD' },
    title: { type: 'string' },
    body: { type: 'string' },
    config: { type: 'string' },
    out: { type: 'string' },
  },
});

(values.local ? runLocal(values) : runAction()).catch((e) => {
  log(e.stack ?? e.message);
  process.exitCode = 1;
});
