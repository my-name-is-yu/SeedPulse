import { describe, it, expect } from 'vitest';
import { IRREVERSIBLE_PATTERNS, isIrreversibleAction } from '../../src/collaboration/irreversible.js';

describe('IRREVERSIBLE_PATTERNS', () => {
  it('matches git push', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('git push origin main'))).toBe(true);
  });

  it('matches git push with extra whitespace', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('git  push'))).toBe(true);
  });

  it('matches rm -rf', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('rm -rf /tmp/old'))).toBe(true);
  });

  it('matches curl POST', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('curl -X POST https://api.example.com'))).toBe(true);
  });

  it('matches curl PUT', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('curl -X PUT https://api.example.com'))).toBe(true);
  });

  it('matches curl DELETE', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('curl -X DELETE https://api.example.com'))).toBe(true);
  });

  it('matches curl PATCH', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('curl -X PATCH https://api.example.com'))).toBe(true);
  });

  it('matches docker push', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('docker push myimage:latest'))).toBe(true);
  });

  it('matches docker rm', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('docker rm my-container'))).toBe(true);
  });

  it('matches npm publish', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('npm publish'))).toBe(true);
  });

  it('matches deploy (case-insensitive)', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('deploy to production'))).toBe(true);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('DEPLOY'))).toBe(true);
  });

  it('matches DROP TABLE (case-insensitive)', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('DROP TABLE users'))).toBe(true);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('drop table users'))).toBe(true);
  });

  it('matches DELETE FROM (case-insensitive)', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('DELETE FROM orders WHERE id=1'))).toBe(true);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('delete from orders'))).toBe(true);
  });

  it('does not match safe git commands', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('git status'))).toBe(false);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('git pull origin main'))).toBe(false);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('git log'))).toBe(false);
  });

  it('does not match curl GET', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('curl https://api.example.com'))).toBe(false);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('curl -X GET https://api.example.com'))).toBe(false);
  });

  it('does not match safe docker commands', () => {
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('docker build .'))).toBe(false);
    expect(IRREVERSIBLE_PATTERNS.some(p => p.test('docker ps'))).toBe(false);
  });
});

describe('isIrreversibleAction', () => {
  it('returns true for bash tool with irreversible command', () => {
    expect(isIrreversibleAction('Bash', { command: 'git push origin main' })).toBe(true);
  });

  it('returns true for bash tool with rm -rf', () => {
    expect(isIrreversibleAction('Bash', { command: 'rm -rf /tmp/old' })).toBe(true);
  });

  it('returns true for bash tool with npm publish', () => {
    expect(isIrreversibleAction('Bash', { command: 'npm publish' })).toBe(true);
  });

  it('returns true for bash tool with DROP TABLE in SQL', () => {
    expect(isIrreversibleAction('Bash', { command: 'psql -c "DROP TABLE users"' })).toBe(true);
  });

  it('returns true when irreversible pattern found in nested tool input', () => {
    expect(isIrreversibleAction('Bash', { args: { sql: 'DELETE FROM orders' } })).toBe(true);
  });

  it('returns false for safe bash commands', () => {
    expect(isIrreversibleAction('Bash', { command: 'ls -la' })).toBe(false);
    expect(isIrreversibleAction('Bash', { command: 'git status' })).toBe(false);
    expect(isIrreversibleAction('Bash', { command: 'npm install' })).toBe(false);
  });

  it('returns false for Read tool calls', () => {
    expect(isIrreversibleAction('Read', { file_path: '/tmp/test.txt' })).toBe(false);
  });

  it('returns false for Write tool calls with safe content', () => {
    expect(isIrreversibleAction('Write', { file_path: '/tmp/out.txt', content: 'hello' })).toBe(false);
  });

  it('returns false for empty tool input', () => {
    expect(isIrreversibleAction('Bash', {})).toBe(false);
  });

  it('returns false for curl GET in tool input', () => {
    expect(isIrreversibleAction('Bash', { command: 'curl https://example.com' })).toBe(false);
  });
});
