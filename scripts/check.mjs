// Guards the files that are published to the public profile. Exits non-zero on the first violation.

import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const problems = [];
const check = (ok, message) => ok || problems.push(message);

const snapshot = JSON.parse(await read('data/stats.json'));

const expected = ['generatedAt', 'contributions12m', 'activeDays', 'longestStreak', 'weekly', 'yearly', 'mergedPRs', 'externalRepos', 'byOwner', 'focus'];
check(
  JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify([...expected].sort()),
  `data/stats.json has unexpected keys: ${Object.keys(snapshot).join(', ')}`,
);

// Owner logins only: a slash would mean a repository name leaked into the snapshot.
for (const entry of snapshot.byOwner) {
  check(
    Array.isArray(entry) && typeof entry[0] === 'string' && !entry[0].includes('/') && Number.isInteger(entry[1]),
    `data/stats.json byOwner entry is malformed: ${JSON.stringify(entry)}`,
  );
}
check(snapshot.weekly.length === 52 && snapshot.weekly.every(Number.isInteger), 'weekly must be 52 integers');
check(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.generatedAt), 'generatedAt must be YYYY-MM-DD');

// Every relative asset the README points at must exist, or the profile renders broken images.
const readme = await read('README.md');
for (const [, ref] of readme.matchAll(/(?:src|href)="((?!https?:|#|mailto:)[^"]+)"/g)) {
  try {
    await access(new URL(ref, root));
  } catch {
    problems.push(`README.md references a missing file: ${ref}`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('✓ snapshot schema, privacy shape and README asset references are valid');
