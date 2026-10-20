const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/fw_[A-Za-z0-9]{12,}/g, 'fw_[REDACTED]'],
  [/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]'],
  [/(Authorization:\s*(?:Bearer|token)\s+)[^\s"']+/gi, '$1[REDACTED]'],
  [/(https:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[REDACTED]@'],
  [/([?&](?:access_token|api_key|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
];

/** Strip anything that looks like a credential before it reaches a log or a model. */
export function redact(input: string): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Redact secrets *and* literal values from the environment that must never be
 * echoed back, for example when a model is asked to summarize a test log.
 */
export function redactWithSecrets(input: string, secrets: Array<string | undefined>): string {
  let output = redact(input);
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function emit(level: string, scope: string, message: string, fields: Record<string, unknown>) {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...fields,
  };
  const line = redact(JSON.stringify(payload));
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string, base: Record<string, unknown> = {}): Logger {
  const build =
    (level: string) => (message: string, fields: Record<string, unknown> = {}) =>
      emit(level, scope, message, { ...base, ...fields });
  return {
    debug: build('debug'),
    info: build('info'),
    warn: build('warn'),
    error: build('error'),
    child: (fields) => createLogger(scope, { ...base, ...fields }),
  };
}
