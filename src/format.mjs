export const SUMMARY_MARKER = '<!-- ai-review:summary -->';
export const INLINE_MARKER = '<!-- ai-review:inline -->';

const ICON = { critical: '🔴', major: '🟠', minor: '🟡', nit: '⚪' };
const LABEL = { critical: 'Критично', major: 'Важно', minor: 'Желательно', nit: 'Мелочь' };
const RISK = { low: 'низкий', medium: 'средний', high: 'высокий' };

export function fingerprint(path, title) {
  return `${path}|${String(title).trim().toLowerCase().slice(0, 80)}`;
}

export function inlineBody(c) {
  const parts = [`**${ICON[c.severity]} ${LABEL[c.severity]}: ${c.title}**`, '', c.body];
  if (c.suggestion && c.exact) parts.push('', '```suggestion', c.suggestion, '```');
  parts.push('', `${INLINE_MARKER}<!-- fp:${encodeURIComponent(fingerprint(c.path, c.title))} -->`);
  return parts.join('\n');
}

export function existingFingerprints(reviewComments) {
  const set = new Set();
  for (const c of reviewComments) {
    if (c.user?.type !== 'Bot' || !c.body?.includes(INLINE_MARKER)) continue;
    const m = c.body.match(/<!-- fp:([^ ]+) -->/);
    if (!m) continue;
    try { set.add(decodeURIComponent(m[1])); } catch { /* malformed marker */ }
  }
  return set;
}

export function summaryBody({ result, inline, outside, dropped, meta }) {
  const counts = {};
  for (const c of [...inline, ...outside]) counts[c.severity] = (counts[c.severity] ?? 0) + 1;
  const countLine = Object.keys(LABEL)
    .filter((k) => counts[k])
    .map((k) => `${ICON[k]} ${LABEL[k]}: ${counts[k]}`)
    .join(' · ') || 'замечаний нет';

  const out = [
    SUMMARY_MARKER,
    `## 🤖 AI-ревью`,
    `**Риск:** ${RISK[result.risk] ?? result.risk} · ${countLine}`,
    '',
    result.summary,
  ];

  if (outside.length) {
    out.push('', '### Замечания вне диффа');
    for (const c of outside) {
      out.push(`- ${ICON[c.severity]} **${c.title}** — \`${c.path}:${c.line}\``, `  ${String(c.body ?? '').replace(/\n/g, '\n  ')}`);
    }
  }
  if (result.positives?.length) {
    out.push('', '### Что хорошо', ...result.positives.map((p) => `- ${p}`));
  }
  const footer = [
    meta.model,
    `${meta.turns} ход.`,
    `${meta.tokens.toLocaleString('ru-RU')} ток.`,
    `~$${meta.cost.toFixed(2)}`,
    `коммит ${meta.sha.slice(0, 7)}`,
    dropped ? `скрыто мелочей: ${dropped}` : null,
    'перезапуск — комментарий `/ai-review`',
  ].filter(Boolean).join(' · ');
  out.push('', `<sub>${footer}</sub>`);
  return out.join('\n');
}
