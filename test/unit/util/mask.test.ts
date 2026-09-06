import { describe, expect, it } from 'vitest';
import { MASK, maskDeep, maskSecrets } from '../../../src/util/mask.js';

/**
 * Joins fragments at runtime so no secret-shaped literal appears in this file.
 * These are synthetic test vectors, but committed literals that match provider
 * key formats (AIza…, ghp_…, xoxb-…, PEM headers) trip GitHub secret scanning
 * on every fork and clone; assembling them here keeps the masker exercised on
 * the exact same strings without the false alerts. AKIAIOSFODNN7EXAMPLE stays
 * literal — it is AWS's officially designated documentation key.
 */
const fake = (...parts: string[]): string => parts.join('');

describe('maskSecrets', () => {
  it('masks key=value credentials, keeping the key', () => {
    expect(maskSecrets('token=abc123def456ghi789jkl')).toContain(MASK);
    expect(maskSecrets('token=abc123def456ghi789jkl')).toBe(`token=${MASK}`);
    expect(maskSecrets('export PASSWORD=hunter2 && echo ok')).toBe(`export PASSWORD=${MASK} && echo ok`);
    expect(maskSecrets('curl "https://h/?access_token=abc&x=1"')).toBe(`curl "https://h/?access_token=${MASK}"`);
    expect(maskSecrets('client_secret=s3cr3t passwd=pw')).toBe(`client_secret=${MASK} passwd=${MASK}`);
    expect(maskSecrets("export TOKEN='abc def' x")).toBe(`export TOKEN=${MASK} x`);
    expect(maskSecrets('export TOKEN="abc" x')).toBe(`export TOKEN=${MASK} x`);
    expect(maskSecrets('TOKEN=abc;')).toBe(`TOKEN=${MASK}`);
  });

  it('masks an unquoted value up to whitespace (§4.9 \\S+), keeping only a closing delimiter', () => {
    expect(maskSecrets('token=abc"def')).toBe(`token=${MASK}`);
    expect(maskSecrets("token=abc'def ghi")).toBe(`token=${MASK} ghi`);
    expect(maskSecrets('echo `token=abc`')).toBe(`echo \`token=${MASK}\``);
    expect(maskSecrets('--password=p@ss,word) next')).toBe(`--password=${MASK} next`);
    expect(maskSecrets('token="unterminated')).toBe(`token=${MASK}`);
  });

  it('masks PEM private-key blocks, with or without an END line', () => {
    const beginRsa = fake('-----BEGIN RSA PRIV', 'ATE KEY-----');
    const endRsa = fake('-----END RSA PRIV', 'ATE KEY-----');
    const pem = `${beginRsa}\nMIIEow\nAAAA\n${endRsa}`;
    expect(maskSecrets(`before\n${pem}\nafter`)).toBe(`before\n${MASK}\nafter`);
    expect(maskSecrets(`${fake('-----BEGIN OPENSSH PRIV', 'ATE KEY-----')}\nb3Blbn`)).toBe(MASK);
    expect(maskSecrets(`${fake('-----BEGIN PRIV', 'ATE KEY-----')}\nMIIE\n${fake('-----END PRIV', 'ATE KEY-----')}\ntail`)).toBe(`${MASK}\ntail`);
  });

  it('masks API-key shapes from the §4.9 list', () => {
    const cases: [string, string][] = [
      [fake('sk-ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz0123456789'), MASK],
      [fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'), MASK],
      [fake('gho_', 'abcdefghijklmnopqrstuvwxyz0123456789'), MASK],
      [fake('github_', 'pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'), MASK],
      ['AKIAIOSFODNN7EXAMPLE', MASK],
      [fake('xoxb-', '1234567890-abcdefghijkl'), MASK],
      [fake('xoxp-', '1234567890-abcdefghijkl'), MASK],
      [fake('AIzaSyA-', 'abcdefghijklmnopqrstuvwxyz01234'), MASK],
      [fake('Authorization: Bearer ', 'eyJhbGciOiJIUzI1NiJ9.abc.def'), `Authorization: ${MASK}`],
    ];
    for (const [input, expected] of cases) expect(maskSecrets(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    const plain = 'ran npm test: 12 passed; the token was rotated; sk-1 and AKIA are short';
    expect(maskSecrets(plain)).toBe(plain);
    expect(maskSecrets('')).toBe('');
    expect(maskSecrets('ghp_short')).toBe('ghp_short');
  });

  it('masks several secrets in one string', () => {
    const out = maskSecrets(fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789', ' token=x AKIAIOSFODNN7EXAMPLE'));
    expect(out).toBe(`${MASK} token=${MASK} ${MASK}`);
  });
});

describe('maskDeep', () => {
  it('masks strings anywhere inside arrays and objects, without mutating the input', () => {
    const input = {
      cmd: 'export TOKEN=abc',
      nested: { list: [fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'), 1, null, { deep: 'ok' }] },
      n: 3,
      flag: true,
      nothing: null,
    };
    const snapshot = JSON.stringify(input);
    expect(maskDeep(input)).toEqual({
      cmd: `export TOKEN=${MASK}`,
      nested: { list: [MASK, 1, null, { deep: 'ok' }] },
      n: 3,
      flag: true,
      nothing: null,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns non-container values unchanged', () => {
    expect(maskDeep(5)).toBe(5);
    expect(maskDeep(undefined)).toBeUndefined();
    expect(maskDeep('secret=x')).toBe(`secret=${MASK}`);
  });
});
