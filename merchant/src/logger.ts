// pino logger that scrubs every configured secret from log lines.
import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string, secrets: string[]): Logger {
  const scrub = (s: string) => secrets.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), s);
  return pino({
    level,
    redact: { paths: ['token', '*.token', 'authorization', '*.authorization', 'headers.authorization', 'payoutDetails', '*.payoutDetails'], censor: '[REDACTED]' },
    hooks: {
      streamWrite: (line) => scrub(line),
    },
  });
}

export const silentLogger: Logger = pino({ level: 'silent' });
