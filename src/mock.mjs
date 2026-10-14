// Scripted model for offline tests: exercises tools, then submits a review.
export function mockModel(files) {
  let turn = 0;
  const target = files.find((f) => f.additions > 0 && !f.binary) ?? files[0];
  const firstAdded = target?.lines.find((l) => l.kind === 'add')?.newLine ?? 1;
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };

  return async (req) => {
    turn++;
    if (!req.tools?.length || !req.system?.[0]?.text) throw new Error('mock: пустой запрос');
    if (turn === 1) {
      return {
        stop_reason: 'tool_use',
        usage,
        content: [
          { type: 'text', text: 'Смотрю файл.' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: target.path, start_line: 1, end_line: 20 } },
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: '../../etc/passwd' } },
          { type: 'tool_use', id: 't3', name: 'read_file', input: { path: '.env' } },
          { type: 'tool_use', id: 't4', name: 'search', input: { pattern: 'class ', path: target.path } },
          { type: 'tool_use', id: 't5', name: 'read_base_file', input: { path: target.path, end_line: 5 } },
        ],
      };
    }
    // Verify tool results came back and sandbox held.
    const results = req.messages.at(-1).content;
    const text = (id) => results.find((r) => r.tool_use_id === id)?.content ?? '';
    if (!/путь вне репозитория/.test(text('t2'))) throw new Error(`mock: sandbox пропустил ../ → ${text('t2')}`);
    if (!/секрет/.test(text('t3'))) throw new Error(`mock: .env доступен → ${text('t3')}`);

    return {
      stop_reason: 'tool_use',
      usage,
      content: [{
        type: 'tool_use', id: 't9', name: 'submit_review',
        input: {
          summary: 'Mock: PR меняет файлы, проверка работы пайплайна.',
          risk: 'low',
          comments: [
            { path: target.path, line: firstAdded, severity: 'major', title: 'Тестовое замечание в диффе', body: 'Проверка inline.' },
            { path: target.path, line: 999999, severity: 'minor', title: 'Строка вне диффа', body: 'Должно уйти в сводку.' },
            { path: target.path, line: firstAdded, severity: 'nit', title: 'Мелочь', body: 'Должно отфильтроваться по minSeverity.' },
          ],
          positives: ['Мок работает'],
        },
      }],
    };
  };
}
