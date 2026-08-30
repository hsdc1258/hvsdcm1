import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import {
  buildCompetitionVerificationCandidates,
  runCompetitionCrawl,
} from './competition-crawl-core.mjs';
import { requireCompetitionDistinctPaths } from './competition-paths.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function enableSystemCertificates() {
  if (typeof tls.getCACertificates !== 'function'
    || typeof tls.setDefaultCACertificates !== 'function') return;
  const certificates = [
    ...tls.getCACertificates('default'),
    ...tls.getCACertificates('system'),
  ];
  tls.setDefaultCACertificates([...new Set(certificates)]);
}

export function parseCompetitionCrawlArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--report-out', '--verification-out', '--timeout-ms', '--max-per-source']
      .includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(argument + ' requires a value');
      }
      index += 1;
      if (argument === '--report-out') options.reportOut = value;
      else if (argument === '--verification-out') options.verificationOut = value;
      else if (argument === '--timeout-ms') options.timeoutMs = Number(value);
      else options.maxPerSource = Number(value);
    } else {
      throw new Error('unknown argument: ' + argument);
    }
  }
  if (!options.reportOut) throw new Error('--report-out is required');
  if (options.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1_000 || options.timeoutMs > 120_000)) {
    throw new Error('--timeout-ms must be an integer from 1000 to 120000');
  }
  if (options.maxPerSource !== undefined
    && (!Number.isSafeInteger(options.maxPerSource)
      || options.maxPerSource < 1 || options.maxPerSource > 5_000)) {
    throw new Error('--max-per-source must be an integer from 1 to 5000');
  }
  if (options.verificationOut) {
    requireCompetitionDistinctPaths([
      ['--report-out', options.reportOut],
      ['--verification-out', options.verificationOut],
    ], { label: 'competition crawl' });
  }
  return options;
}

function atomicWrite(file, value) {
  const fullPath = path.resolve(file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporary = fullPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, fullPath);
}

function verificationQueue(crawl) {
  const report = crawl.report;
  return {
    version: 1,
    run_id: report.run.id,
    generated_at: report.run.finished_at,
    required_checks: [
      'organizer_control',
      'live_acceptance',
      'deadline_timezone',
      'eligibility',
      'fee',
      'rights',
      'privacy',
      'ai_policy',
      'deliverables',
      'receipt',
    ],
    candidates: buildCompetitionVerificationCandidates(crawl.results),
  };
}

export async function runCompetitionCrawlCli(argv) {
  const options = parseCompetitionCrawlArgs(argv);
  enableSystemCertificates();
  const crawl = await runCompetitionCrawl({
    timeoutMs: options.timeoutMs,
    maxPerSource: options.maxPerSource,
  });
  atomicWrite(options.reportOut, crawl.report);
  if (options.verificationOut) {
    atomicWrite(options.verificationOut, verificationQueue(crawl));
  }
  return {
    ok: true,
    run_id: crawl.report.run.id,
    status: crawl.report.run.status,
    counts: {
      sources: crawl.report.sources.length,
      succeeded: crawl.report.run.source_coverage.succeeded,
      candidates: crawl.report.candidates.length,
      applications: crawl.report.applications.length,
      manual_check: crawl.report.sources.filter((source) => source.manual_check).length,
    },
    sources: crawl.results.map((entry) => {
      const reported = crawl.report.sources.find((source) => source.id === entry.source.id);
      return {
        id: entry.source.id,
        status: reported.status,
        failure_code: reported.failure_code,
        extracted: entry.extractedCount,
        retained: reported.candidate_count,
      };
    }),
  };
}

async function main() {
  try {
    const summary = await runCompetitionCrawlCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(summary) + '\n');
  } catch (error) {
    process.stderr.write(
      '[competition-crawl] ' + (error?.message || 'unexpected crawl failure') + '\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) void main();
