import { describe, expect, it } from 'vitest';
import { MASK, maskDeep, maskSecrets } from '../../../src/util/mask.js';

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
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----';
    expect(maskSecrets(`before\n${pem}\nafter`)).toBe(`before\n${MASK}\nafter`);
    expect(maskSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn')).toBe(MASK);
    expect(maskSecrets('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\ntail')).toBe(`${MASK}\ntail`);
  });

  it('masks API-key shapes from the §4.9 list', () => {
    const cases: [string, string][] = [
      ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', MASK],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', MASK],
      ['gho_abcdefghijklmnopqrstuvwxyz0123456789', MASK],
      ['github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', MASK],
      ['AKIAIOSFODNN7EXAMPLE', MASK],
      ['xoxb-1234567890-abcdefghijkl', MASK],
      ['xoxp-1234567890-abcdefghijkl', MASK],
      ['AIzaSyA-abcdefghijklmnopqrstuvwxyz01234', MASK],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', `Authorization: ${MASK}`],
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
    const out = maskSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789 token=x AKIAIOSFODNN7EXAMPLE');
    expect(out).toBe(`${MASK} token=${MASK} ${MASK}`);
  });
});

describe('maskDeep', () => {
  it('masks strings anywhere inside arrays and objects, without mutating the input', () => {
    const input = {
      cmd: 'export TOKEN=abc',
      nested: { list: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 1, null, { deep: 'ok' }] },
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
