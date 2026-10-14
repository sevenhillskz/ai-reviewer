// Read-only tools exposed to the model. All paths are sandboxed to the repo checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, normalize, relative, isAbsolute } from 'node:path';
import { matchesAny } from './glob.mjs';
import { renderFileDiff } from './diff.mjs';

const MAX_OUT = 60000;
const clip = (s, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n…[обрезано, ${s.length - n} симв.]` : s);

export const TOOL_DEFS = [
  {
    name: 'get_file_diff',
    description: 'Дифф одного файла из PR с номерами строк новой версии. Используй, если дифф не был показан целиком.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Прочитать файл из репозитория (версия PR). Возвращает строки с номерами. Для больших файлов указывай диапазон.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_base_file',
    description: 'Прочитать файл в базовой ветке (до изменений PR) — чтобы сравнить старое поведение.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: 'Список файлов и папок в директории репозитория.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Поиск по коду (git grep, регулярное выражение). Используй, чтобы найти вызовы, определения, похожие паттерны.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regex' },
        path: { type: 'string', description: 'Подпапка или glob, напр. backend/src или *.ts' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_review',
    description: 'Финальный результат ревью. Вызови ровно один раз в конце.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Сводка: что делает PR, главные риски, общее впечатление. Markdown, 3–8 строк.' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer', description: 'Номер строки в НОВОЙ версии файла, из диффа' },
              severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
              title: { type: 'string', description: 'Суть проблемы, одна строка' },
              body: { type: 'string', description: 'Почему это проблема и как исправить. Markdown.' },
              suggestion: { type: 'string', description: 'Необязательно: готовый код на замену ровно этой строки' },
            },
            required: ['path', 'line', 'severity', 'title', 'body'],
            additionalProperties: false,
          },
        },
        positives: { type: 'array', items: { type: 'string' }, description: 'Что сделано хорошо (0–3 пункта)' },
      },
      required: ['summary', 'risk', 'comments'],
      additionalProperties: false,
    },
  },
];

// Lexical sandbox check for a repo-relative path. Returns the normalized path ('' for root).
export function checkRel(p, secretFiles) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('путь не задан');
  const clean = normalize(p.replace(/^\/+/, '')).replace(/\\/g, '/');
  const segs = clean.split('/');
  if (isAbsolute(clean) || segs.includes('..') || segs.some((s) => s.toLowerCase() === '.git')) {
    throw new Error('путь вне репозитория');
  }
  if (matchesAny(clean, secretFiles)) throw new Error('файл с секретами недоступен');
  return clean === '.' ? '' : clean;
}

const EXEC = { encoding: 'utf8', maxBuffer: 20e6, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] };
const orEmpty = (s) => (s && s.trim() ? s : '(пусто)');

export class Toolbox {
  constructor({ root, baseSha, files, secretFiles }) {
    this.root = realpathSync(root);
    this.baseSha = baseSha;
    this.files = new Map(files.map((f) => [f.path, f]));
    this.secretFiles = secretFiles;
  }

  safePath(p) {
    const rel = checkRel(p, this.secretFiles);
    const abs = join(this.root, rel);
    if (existsSync(abs)) {
      // Symlinks committed in the PR must not lead to .git, secrets or outside the repo.
      const realRel = relative(this.root, realpathSync(abs)).replace(/\\/g, '/');
      checkRel(realRel || '.', this.secretFiles);
    }
    return { rel, abs };
  }

  numbered(text, start, end) {
    const lines = text.split('\n');
    const s = Math.max(1, start ?? 1);
    const e = Math.min(lines.length, end ?? Math.min(lines.length, s + 799));
    const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join('\n');
    const tail = e < lines.length ? `\n…[ещё ${lines.length - e} строк, всего ${lines.length}]` : '';
    return body + tail;
  }

  run(name, input) {
    try {
      switch (name) {
        case 'get_file_diff': {
          const f = this.files.get(input.path);
          if (!f) return `Файла ${input.path} нет в диффе PR.`;
          if (matchesAny(f.path, this.secretFiles)) return 'Ошибка: файл с секретами недоступен';
          return clip(renderFileDiff(f));
        }
        case 'read_file': {
          const { abs } = this.safePath(input.path);
          if (!existsSync(abs)) return 'Файл не найден (возможно, удалён в PR).';
          if (statSync(abs).size > 2_000_000) return 'Файл слишком большой.';
          return orEmpty(clip(this.numbered(readFileSync(abs, 'utf8'), input.start_line, input.end_line)));
        }
        case 'read_base_file': {
          const { rel } = this.safePath(input.path);
          let text;
          try {
            text = execFileSync('git', ['show', `${this.baseSha}:${rel}`], { cwd: this.root, ...EXEC });
          } catch {
            return 'Файла нет в базовой ветке (новый файл).';
          }
          return orEmpty(clip(this.numbered(text, input.start_line, input.end_line)));
        }
        case 'list_dir': {
          const { abs } = this.safePath(input.path || '.');
          return orEmpty(readdirSync(abs, { withFileTypes: true })
            .filter((d) => d.name.toLowerCase() !== '.git' && d.name !== 'node_modules')
            .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
            .sort()
            .slice(0, 500)
            .join('\n'));
        }
        case 'search': {
          const args = ['grep', '-n', '-I', '-E', '-e', input.pattern];
          if (input.path) {
            if (input.path.startsWith(':')) throw new Error('pathspec magic не поддерживается');
            this.safePath(input.path.replace(/[*?{}]/g, 'x'));
            args.push('--', input.path);
          }
          let out;
          try {
            out = execFileSync('git', args, { cwd: this.root, ...EXEC });
          } catch (e) {
            if (e.status === 1) return 'Ничего не найдено.';
            throw e;
          }
          const lines = out.split('\n').filter((l) => l && !matchesAny(l.split(':')[0], this.secretFiles));
          if (!lines.length) return 'Ничего не найдено.';
          return clip(lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n…[ещё ${lines.length - 200} совпадений]` : ''), 30000);
        }
        default:
          return `Неизвестный инструмент ${name}`;
      }
    } catch (e) {
      return `Ошибка: ${e.message}`;
    }
  }
}
