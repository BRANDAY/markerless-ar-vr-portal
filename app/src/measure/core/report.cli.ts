/**
 * Summary of the door measurements, on the PC:
 *
 *   npm run measure:report -- <file or folder> [more files or folders] [--trials]
 *
 * Reads every `.jsonl`, `.json`, `.log` and `.txt` file given (folders are searched one
 * level deep) and prints a table per test condition. The files may be the app's own
 * `measurements/<run>.jsonl`, the server's `work/device-logs/<device>.jsonl`, or a saved
 * logcat - see `parseTrials`. With `--trials` every trial is listed as well.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { formatSummary, parseTrials, summarize, type Trial } from './measurement';

const EXTENSIONS = ['.jsonl', '.json', '.log', '.txt'];

function filesOf(path: string): string[] {
  if (!existsSync(path)) {
    console.log(`not found: ${path}`);
    return [];
  }
  if (statSync(path).isFile()) {
    return [path];
  }
  return readdirSync(path)
    .map((name) => join(path, name))
    .filter((file) => statSync(file).isFile() && EXTENSIONS.includes(extname(file).toLowerCase()));
}

function trialLine(t: Trial): string {
  const n = (value: number | null, unit: string) => (value === null ? '-' : `${value.toFixed(1)} ${unit}`);
  return (
    `${t.run} #${String(t.seq).padStart(3)}  ${t.condition.padEnd(13)} ${t.event.padEnd(10)} ` +
    `${n(t.positionCm, 'cm').padStart(9)} ${n(t.headingDeg, 'deg').padStart(10)}  ` +
    `${t.sinceStartMs === null ? '-' : `${(t.sinceStartMs / 1000).toFixed(1)} s`.padStart(7)}  ` +
    `${t.attempts ?? '-'} att  ${t.quality ?? ''}${t.stale ? '  (marks predate a tracking interruption)' : ''}`
  );
}

function main(): number {
  const args = process.argv.slice(2);
  const paths = args.filter((arg) => !arg.startsWith('--'));
  if (paths.length === 0) {
    console.log('usage: npm run measure:report -- <file or folder> [more] [--trials]');
    return 2;
  }
  const files = paths.flatMap(filesOf);
  const text = files.map((file) => readFileSync(file, 'utf-8')).join('\n');
  const trials = parseTrials(text);
  console.log(`${files.length} file(s), ${trials.length} record(s)\n`);
  console.log(formatSummary(summarize(trials)));
  if (args.includes('--trials')) {
    console.log('');
    for (const trial of trials) {
      console.log(trialLine(trial));
    }
  }
  return trials.length > 0 ? 0 : 1;
}

process.exit(main());
