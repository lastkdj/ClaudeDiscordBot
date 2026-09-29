import { describe, expect, it } from 'vitest';
import { readCa } from '../../src/config.js';

// A throwaway self-signed certificate (public data, used only to test parsing).
const PEM = `-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUYv2m0r0tqS0ktXjM8r3eGxgk8yYwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJdGVzdC1yb290MB4XDTI2MDkyOTAwMDAwMFoXDTM2MDkyNjAw
MDAwMFowFDESMBAGA1UEAwwJdGVzdC1yb290MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE0dXcVv0q7vB1rF1C9P8wz7Qf1W4k1nqk9d5L3hP2xB3u8V7yJb6Q9o1n
kY1b3s8m0t0mD3fD6bq6vJxq1m6q4aNTMFEwHQYDVR0OBBYEFJ5mYk0Fq3o1l0nS
Q3yH6d6r4w8JMB8GA1UdIwQYMBaAFJ5mYk0Fq3o1l0nSQ3yH6d6r4w8JMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAO9Z3yqzv0v5y2l4qW0k8r0r
c1Wm6o2q9f3k5gJ2h8bRAiEAuX3cX9q3t3m1u2m6o4w0y1v5t7r9s2k4j6h8g0f2e1c=
-----END CERTIFICATE-----`;

describe('DATABASE_SSL_CA parsing', () => {
  const canonical = readCa(PEM);
  it('keeps a normal multi-line PEM', () => {
    expect(canonical.startsWith('-----BEGIN CERTIFICATE-----\nMIIB')).toBe(true);
    expect(canonical.trim().endsWith('-----END CERTIFICATE-----')).toBe(true);
  });
  it('rebuilds the same PEM from one line with spaces, \\n escapes, or quotes', () => {
    expect(readCa(PEM.replace(/\n/g, ' '))).toBe(canonical);
    expect(readCa(PEM.replace(/\n/g, '\\n'))).toBe(canonical);
    expect(readCa(PEM.replace(/\n/g, ''))).toBe(canonical);
    expect(readCa(`"${PEM.replace(/\n/g, ' ')}"`)).toBe(canonical);
  });
  it('rejects text with no certificate block', () => {
    expect(() => readCa('-----BEGIN CERTIFICATE----- nope')).toThrow(/could not find/);
  });
});
