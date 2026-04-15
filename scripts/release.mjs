#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('Usage: npm run release -- <version>');
}

const tagName = `v${version}`;

run('git', ['fetch', 'origin']);

const branch = output('git', ['branch', '--show-current']);
if (branch !== 'main') {
  fail(`Release must be run from main, but current branch is ${branch || '(detached)'}.`);
}

const status = output('git', ['status', '--porcelain']);
if (status) {
  fail('Working tree must be clean before release.');
}

const localHead = output('git', ['rev-parse', 'HEAD']);
const remoteHead = output('git', ['rev-parse', 'origin/main']);
if (localHead !== remoteHead) {
  fail('Local main must match origin/main before release. Run git pull --ff-only origin main first.');
}

if (exists('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`])) {
  fail(`Local tag ${tagName} already exists.`);
}

if (remoteTagExists(tagName)) {
  fail(`Remote tag ${tagName} already exists.`);
}

run('npm', ['version', version, '--no-git-tag-version']);
run('git', ['add', 'package.json', 'package-lock.json']);
run('npm', ['run', 'verify:release']);
run('git', ['diff', '--exit-code']);
run('git', ['add', 'package.json', 'package-lock.json']);
run('git', ['commit', '-m', `Release ${version}`]);
run('git', ['push', 'origin', 'main']);
run('git', ['tag', tagName]);
run('git', ['push', 'origin', tagName]);

console.log(`Release ${version} pushed. GitHub Actions will publish ${tagName} to npm.`);

function run(command, args) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function exists(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error) {
    fail(result.error.message);
  }
  return result.status === 0;
}

function remoteTagExists(tag) {
  const result = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', tag], { stdio: 'ignore' });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 2) {
    return false;
  }
  fail(`Could not check remote tag ${tag}.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
