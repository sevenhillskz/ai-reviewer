import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const DEFAULTS = {
  model: 'claude-opus-5-5',
  effort: 'high',
  language: 'ru',
  maxTurns: 30,
  maxOutputTokens: 16000,
  // Diff above this size is not inlined; the model pulls per-file diffs via a tool.
  maxInlineDiffChars: 120000,
  maxFiles: 80,
  maxInlineComments: 20,
  // Hard stop for one review, USD. Protects the monthly credit pool.
  maxCostUsd: 3,
  // Comments below this severity are dropped: critical > major > minor > nit.
  minSeverity: 'minor',
  skipDraft: true,
  ignore: [
    '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.lock',
    '**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**', '**/.next/**',
    '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.snap',
    '**/*.{png,jpg,jpeg,gif,webp,ico,svg,pdf,xlsx,docx,zip,mp4,mov,woff,woff2,ttf}',
  ],
  // Never readable by the model, even via tools.
  secretFiles: [
    '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/*.p12', '**/*.pfx',
    '**/*.p8', '**/*.jks', '**/*.keystore', '**/*.tfvars', '**/.npmrc', '**/.netrc', '**/.pypirc',
    '**/.htpasswd', '**/.aws/**', '**/.ssh/**', '**/secrets/**',
  ],
  // Files injected into the system prompt in full (project rules).
  instructions: [],
  // Docs the model may read on demand: [{ path, when }].
  guides: [],
  // Free-form project notes appended to the prompt.
  notes: '',
};

// Hard limits a repo config cannot exceed.
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

export function sanitize(cfg) {
  return {
    ...cfg,
    model: MODELS.includes(cfg.model) ? cfg.model : DEFAULTS.model,
    maxCostUsd: clamp(cfg.maxCostUsd, 0.1, 10, DEFAULTS.maxCostUsd),
    maxTurns: clamp(cfg.maxTurns, 3, 40, DEFAULTS.maxTurns),
    maxOutputTokens: clamp(cfg.maxOutputTokens, 2000, 32000, DEFAULTS.maxOutputTokens),
    maxInlineComments: clamp(cfg.maxInlineComments, 0, 50, DEFAULTS.maxInlineComments),
    maxInlineDiffChars: clamp(cfg.maxInlineDiffChars, 10000, 400000, DEFAULTS.maxInlineDiffChars),
    instructions: Array.isArray(cfg.instructions) ? cfg.instructions.filter((x) => typeof x === 'string').slice(0, 10) : [],
    guides: Array.isArray(cfg.guides) ? cfg.guides.filter((g) => g && typeof g.path === 'string').slice(0, 30) : [],
    notes: typeof cfg.notes === 'string' ? cfg.notes.slice(0, 8000) : '',
  };
}

// readTrusted(rel) → string | null. In CI it reads from the BASE commit, so a PR cannot
// change its own review rules, limits or model.
export function loadConfig(readTrusted, overridePath) {
  const candidates = [overridePath, '.github/ai-review.json'].filter(Boolean);
  for (const rel of candidates) {
    const text = isAbsolute(rel) ? (existsSync(rel) ? readFileSync(rel, 'utf8') : null) : readTrusted(rel);
    if (text == null) continue;
    const user = JSON.parse(text);
    return sanitize({
      ...DEFAULTS,
      ...user,
      ignore: [...DEFAULTS.ignore, ...(Array.isArray(user.ignore) ? user.ignore : [])],
      secretFiles: [...DEFAULTS.secretFiles, ...(Array.isArray(user.secretFiles) ? user.secretFiles : [])],
      _source: rel,
    });
  }
  return { ...DEFAULTS, _source: null };
}

export function diskReader(root) {
  return (rel) => {
    const p = join(root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
}
