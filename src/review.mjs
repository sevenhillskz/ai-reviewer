import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessage, costOf } from './anthropic.mjs';
import { renderFileDiff } from './diff.mjs';
import { matchesAny } from './glob.mjs';
import { TOOL_DEFS, Toolbox, checkRel } from './tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, nit: 3 };

function buildSystem(cfg, readTrusted) {
  const parts = [readFileSync(join(HERE, '..', 'prompts', 'base.md'), 'utf8')];

  const rules = [];
  for (const rel of cfg.instructions ?? []) {
    let text = null;
    try { text = readTrusted(checkRel(rel, cfg.secretFiles)); } catch { /* path rejected by sandbox */ }
    if (text != null) rules.push(`<file path="${rel}">\n${text.slice(0, 120000)}\n</file>`);
  }
  if (rules.length || cfg.notes) {
    parts.push('## Правила проекта\n\nЭти правила обязательны и важнее общих стандартов выше.');
    if (cfg.notes) parts.push(cfg.notes);
    parts.push(...rules);
  }
  if (cfg.guides?.length) {
    parts.push(
      '## Инструкции для ревью в репозитории\n\nПрочитай через `read_file` те, что относятся к изменённым файлам, ДО того как писать замечания:\n'
        + cfg.guides.map((g) => `- \`${g.path}\` — ${g.when}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

function buildFirstMessage({ pr, files, cfg }) {
  const reviewable = files.filter((f) => !f.binary && f.status !== 'deleted'
    && !matchesAny(f.path, cfg.ignore) && !matchesAny(f.path, cfg.secretFiles));
  const skipped = files.filter((f) => !reviewable.includes(f));

  // Source first, tests and docs last — they matter less when the diff has to be cut.
  const weight = (p) => (/\.(spec|test)\.[jt]sx?$|\/test\/|__tests__/.test(p) ? 2 : /\.(md|txt)$/.test(p) ? 3 : /migration/i.test(p) ? 0 : 1);
  reviewable.sort((a, b) => weight(a.path) - weight(b.path));

  let budget = cfg.maxInlineDiffChars;
  const shown = [];
  const hidden = [];
  for (const f of reviewable) {
    const r = renderFileDiff(f);
    if (r.length <= budget) { shown.push(r); budget -= r.length; } else hidden.push(f);
  }

  const table = files
    .map((f) => `- \`${f.path}\` ${f.status} +${f.additions}/-${f.deletions}${skipped.includes(f) ? ' (не ревьюим)' : hidden.includes(f) ? ' (дифф через get_file_diff)' : ''}`)
    .join('\n');

  return [
    `# PR #${pr.number}: ${pr.title}`,
    `Ветка: \`${pr.head}\` → \`${pr.base}\`. Автор: ${pr.author}.`,
    pr.body ? `## Описание\n${pr.body.slice(0, 6000)}` : '## Описание\n(пусто)',
    `## Файлы (${files.length})\n${table}`,
    files.length > cfg.maxFiles ? `\n⚠️ PR большой (${files.length} файлов). Сосредоточься на самых рискованных изменениях.` : '',
    hidden.length ? `\nДифф ${hidden.length} файлов не поместился — запрашивай через get_file_diff те, что важны.` : '',
    `## Дифф\n${shown.join('\n\n')}`,
  ].filter(Boolean).join('\n\n');
}

function setCacheBreakpoint(messages) {
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
  }
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content) && last.content.length) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  }
}

// Returns an error message, or null if the submitted review is well-formed.
export function validateSubmit(input) {
  if (!input || typeof input !== 'object') return 'пустой ввод';
  if (typeof input.summary !== 'string' || !input.summary.trim()) return 'нет summary';
  if (!['low', 'medium', 'high'].includes(input.risk)) return 'risk должен быть low|medium|high';
  if (!Array.isArray(input.comments)) return 'comments должен быть массивом';
  for (const [i, c] of input.comments.entries()) {
    if (typeof c?.path !== 'string' || !Number.isInteger(c.line) || !(c.severity in SEVERITY_RANK)
      || typeof c.title !== 'string' || typeof c.body !== 'string') {
      return `comments[${i}]: нужны path, line (целое), severity, title, body`;
    }
  }
  if (input.positives !== undefined && !Array.isArray(input.positives)) return 'positives должен быть массивом';
  return null;
}

export async function runReview({ pr, files, root, baseSha, cfg, readTrusted, callModel = createMessage, log = console.error }) {
  const tools = new Toolbox({ root, baseSha, files, secretFiles: cfg.secretFiles });
  const system = [{ type: 'text', text: buildSystem(cfg, readTrusted), cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: [{ type: 'text', text: buildFirstMessage({ pr, files, cfg }) }] }];

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let cost = 0;
  let nudges = 0;
  let budgetWarned = false;

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    setCacheBreakpoint(messages);
    const res = await callModel({
      model: cfg.model,
      max_tokens: cfg.maxOutputTokens,
      system,
      tools: TOOL_DEFS,
      messages,
      ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
    });
    for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] ?? 0;
    cost = costOf(cfg.model, usage);
    if (cost >= cfg.maxCostUsd * 1.2) throw new Error(`Превышен лимит стоимости ревью ($${cost.toFixed(2)})`);
    if (!res.content?.length) {
      if (++nudges > 2) break;
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Продолжай ревью и заверши его вызовом submit_review.' }] });
      continue;
    }
    messages.push({ role: 'assistant', content: res.content });

    const calls = res.content.filter((b) => b.type === 'tool_use');
    const submit = calls.find((c) => c.name === 'submit_review');
    if (submit) {
      const err = res.stop_reason === 'max_tokens' ? 'ответ обрезан по max_tokens — сократи summary и тексты замечаний' : validateSubmit(submit.input);
      if (!err) {
        log(`ход ${turn}: submit_review, $${cost.toFixed(3)}`);
        return { result: submit.input, usage, cost, turns: turn };
      }
      log(`ход ${turn}: некорректный submit_review (${err}), прошу повторить`);
      messages.push({
        role: 'user',
        content: calls.map((c) => ({
          type: 'tool_result', tool_use_id: c.id, is_error: c === submit,
          content: c === submit ? `Ошибка: ${err}. Вызови submit_review ещё раз с корректными данными.` : 'Пропущено.',
        })),
      });
      continue;
    }

    if (!calls.length) {
      if (++nudges > 2) break;
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Заверши ревью: вызови submit_review с результатом.' }] });
      continue;
    }

    log(`ход ${turn}: ${calls.map((c) => `${c.name}(${c.input.path ?? c.input.pattern ?? ''})`).join(', ')}, $${cost.toFixed(3)}`);
    const results = calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: tools.run(c.name, c.input) }));

    const nearLimit = turn >= cfg.maxTurns - 2;
    const overBudget = cost >= cfg.maxCostUsd * 0.8;
    if ((nearLimit || overBudget) && !budgetWarned) {
      budgetWarned = true;
      results.push({ type: 'text', text: 'Лимит ревью почти исчерпан. Больше не вызывай инструменты чтения — сразу вызови submit_review с тем, что уже нашёл.' });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('Модель не вернула submit_review за отведённое число ходов');
}

// Split model output into inline comments (lines present in diff) and the rest.
export function placeComments(result, files, cfg, resolveLine) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const minRank = SEVERITY_RANK[cfg.minSeverity] ?? 2;
  const sorted = (result.comments ?? [])
    .filter((c) => (SEVERITY_RANK[c.severity] ?? 3) <= minRank)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const inline = [];
  const outside = [];
  for (const c of sorted) {
    const line = resolveLine(byPath.get(c.path), c.line);
    if (line && inline.length < cfg.maxInlineComments) inline.push({ ...c, line, exact: line === c.line });
    else outside.push(c);
  }
  return { inline, outside, dropped: (result.comments?.length ?? 0) - sorted.length };
}
