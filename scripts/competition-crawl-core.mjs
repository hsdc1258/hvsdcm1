import crypto from 'node:crypto';
import {
  MAX_COMPETITION_CANDIDATES,
  validateCompetitionReport,
} from './competition-report.mjs';
import { SOURCE_DEFINITIONS, parseCompetitionSourcePage } from './competition-sources.mjs';

export const DEFAULT_CRAWL_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_PAGE_BYTES = 2_000_000;
export const DEFAULT_MAX_PER_SOURCE = 2_500;
export const DEFAULT_SOURCE_BUDGET_MS = 90_000;
const MAX_DYNAMIC_PAGE_URLS = 300;
const HOST_FAILURE_CODES = new Set(['timeout', 'network', 'rate_limited', 'http_403']);
const MAX_CONSECUTIVE_HOST_FAILURES = 2;

class CrawlFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrawlFailure';
    this.code = code;
  }
}

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

function httpFailureCode(status) {
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (status === 429) return 'rate_limited';
  return 'invalid_response';
}

function allowedUrl(value, source) {
  let url;
  try { url = new URL(value); } catch {
    throw new CrawlFailure('invalid_response', 'invalid source URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password
    || !source.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new CrawlFailure('invalid_response', 'source URL escaped its HTTPS host allowlist');
  }
  return url;
}

async function fetchPage(source, pageUrl, options) {
  const { fetchImpl, timeoutMs, maxBytes } = options;
  let current = allowedUrl(pageUrl, source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await Promise.race([fetchImpl(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'hvsdcm1-competition-discovery/1.0',
        },
      }), aborted]);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location || redirects === 5) {
          throw new CrawlFailure('invalid_response', 'invalid source redirect');
        }
        try {
          const cancellation = response.body?.cancel?.('competition redirect response discarded');
          cancellation?.catch?.(() => {});
        } catch { /* Redirect body disposal is best-effort; the shared timer still bounds the page. */ }
        current = allowedUrl(new URL(location, current).href, source);
        continue;
      }
      if (!response.ok) {
        throw new CrawlFailure(
          httpFailureCode(response.status),
          'source returned HTTP ' + response.status,
        );
      }
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('text/html')
        && !contentType.includes('application/xhtml+xml')) {
        throw new CrawlFailure('invalid_response', 'source returned an unsupported content type');
      }
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new CrawlFailure('invalid_response', 'source response exceeded the byte limit');
      }
      const body = await readBoundedBody(response, { maxBytes, signal: controller.signal });
      return { body, url: current.href };
    }
    throw new CrawlFailure('invalid_response', 'source redirect limit exceeded');
  } catch (error) {
    if (error instanceof CrawlFailure) throw error;
    throw new CrawlFailure(
      error?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 'network',
      'source request failed',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response, { maxBytes, signal }) {
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          reader.cancel('competition response exceeded the byte limit').catch(() => {});
          throw new CrawlFailure('invalid_response', 'source response exceeded the byte limit');
        }
        body += decoder.decode(value, { stream: true });
      }
      reader.releaseLock();
      return body + decoder.decode();
    } catch (error) {
      reader.cancel('competition response read stopped').catch(() => {});
      throw error;
    }
  }

  const body = await Promise.race([response.text(), aborted]);
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new CrawlFailure('invalid_response', 'source response exceeded the byte limit');
  }
  return body;
}

function withinSourceKey(item) {
  const url = new URL(item.discoveryUrl);
  url.hash = '';
  for (const key of ['gp', 'page', 'paged', 'device']) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

function dedupeWithinSource(items, maxPerSource) {
  const unique = new Map();
  for (const item of items) {
    const key = withinSourceKey(item);
    if (!unique.has(key)) unique.set(key, item);
  }
  const values = [...unique.values()];
  return {
    candidates: values.slice(0, maxPerSource),
    truncated: values.length > maxPerSource,
  };
}

export async function crawlCompetitionSource(source, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const clock = options.clock || Date.now;
  const timeoutMs = options.timeoutMs || DEFAULT_CRAWL_TIMEOUT_MS;
  const maxBytes = options.maxBytes || DEFAULT_MAX_PAGE_BYTES;
  const maxPerSource = options.maxPerSource || DEFAULT_MAX_PER_SOURCE;
  const sourceBudgetMs = options.sourceBudgetMs || DEFAULT_SOURCE_BUDGET_MS;
  const monotonicClock = options.monotonicClock || (() => performance.now());
  if (!Number.isFinite(sourceBudgetMs) || sourceBudgetMs < 1_000 || sourceBudgetMs > 600_000) {
    throw new TypeError('source budget must be from 1000 to 600000 ms');
  }
  const sourceDeadline = monotonicClock() + sourceBudgetMs;
  const items = [];
  let firstFailure = null;
  let recognizedPages = 0;
  let ambiguousCount = 0;
  const seenPageIdentitySets = new Set();
  let consecutiveHostFailures = 0;

  const pageQueue = [...source.pageUrls];
  const scheduledPages = new Set(pageQueue.map((value) => new URL(value).href));
  let dynamicPageCount = 0;
  for (let pageIndex = 0; pageIndex < pageQueue.length; pageIndex += 1) {
    const pageUrl = pageQueue[pageIndex];
    const remainingBudget = sourceDeadline - monotonicClock();
    if (remainingBudget <= 0) {
      firstFailure ||= 'timeout';
      break;
    }
    try {
      const page = await fetchPage(source, pageUrl, {
        fetchImpl,
        timeoutMs: Math.max(1, Math.min(timeoutMs, Math.ceil(remainingBudget))),
        maxBytes,
      });
      const parsed = parseCompetitionSourcePage(source, page.body, page.url);
      if (!parsed.recognized) {
        firstFailure ||= 'invalid_response';
        continue;
      }
      recognizedPages += 1;
      consecutiveHostFailures = 0;
      ambiguousCount += parsed.ambiguousCount || 0;
      const pageIdentities = [...new Set(parsed.items.map(withinSourceKey))].sort();
      if (pageIdentities.length > 0) {
        const fingerprint = pageIdentities.join('\n');
        if (seenPageIdentitySets.has(fingerprint)) firstFailure ||= 'unknown';
        seenPageIdentitySets.add(fingerprint);
      }
      items.push(...parsed.items);
      if (parsed.coverageLimited) firstFailure ||= 'unknown';
      for (const additionalPageUrl of parsed.additionalPageUrls || []) {
        let normalized;
        try { normalized = allowedUrl(additionalPageUrl, source).href; }
        catch {
          firstFailure ||= 'invalid_response';
          continue;
        }
        if (scheduledPages.has(normalized)) continue;
        if (dynamicPageCount >= MAX_DYNAMIC_PAGE_URLS) {
          firstFailure ||= 'unknown';
          continue;
        }
        scheduledPages.add(normalized);
        pageQueue.push(normalized);
        dynamicPageCount += 1;
      }
    } catch (error) {
      const failureCode = error instanceof CrawlFailure ? error.code : 'parse_error';
      firstFailure ||= failureCode;
      consecutiveHostFailures = HOST_FAILURE_CODES.has(failureCode)
        ? consecutiveHostFailures + 1
        : 0;
      if (consecutiveHostFailures >= MAX_CONSECUTIVE_HOST_FAILURES) break;
    }
  }

  const checkedAt = timestamp(clock);
  const withinSource = dedupeWithinSource(items, maxPerSource);
  const candidates = withinSource.candidates;
  if (withinSource.truncated) firstFailure ||= 'unknown';
  if (source.coverageLimited) firstFailure ||= 'unknown';
  if (ambiguousCount > 0) firstFailure ||= 'unknown';
  if (candidates.length > 0) {
    return {
      source,
      checkedAt,
      status: firstFailure ? 'partial' : 'ok',
      failureCode: firstFailure || 'none',
      manualCheck: Boolean(firstFailure),
      candidates,
      extractedCount: items.length,
    };
  }
  if (firstFailure) {
    return {
      source,
      checkedAt,
      status: recognizedPages > 0 ? 'partial' : 'failed',
      failureCode: firstFailure,
      manualCheck: true,
      candidates: [],
      extractedCount: items.length,
    };
  }
  return {
    source,
    checkedAt,
    status: recognizedPages > 0 ? 'no_results' : 'failed',
    failureCode: recognizedPages > 0 ? 'none' : 'invalid_response',
    manualCheck: recognizedPages === 0,
    candidates: [],
    extractedCount: items.length,
  };
}

async function boundedMap(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function normalizeTitle(value) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/^(?:(?:추천|special|idea|공모전|d-day|d-\d+)\s*)+/giu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeOrganizer(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function identityParts(item) {
  const title = normalizeTitle(item.title);
  const organizer = normalizeOrganizer(item.organizer);
  const organizerIsPlaceholder = /(?:공식확인필요|주최기관확인필요)/u.test(organizer);
  return {
    title,
    organizer: organizerIsPlaceholder ? 'organizer-unverified' : organizer,
    organizerIsPlaceholder,
  };
}

function dedupeIdentity(item) {
  const identity = identityParts(item);
  return identity.title + '|' + identity.organizer;
}

function dedupeAcrossSources(results, limit = MAX_COMPETITION_CANDIDATES) {
  const selected = new Map();
  const keysByTitle = new Map();
  const overflowSourceIds = new Set();
  const maximumLength = Math.max(0, ...results.map((result) => result.candidates.length));
  for (let index = 0; index < maximumLength; index += 1) {
    for (const result of results) {
      const item = result.candidates[index];
      if (!item) continue;
      const identity = identityParts(item);
      const key = identity.title + '|' + identity.organizer;
      const titleKeys = keysByTitle.get(identity.title) || new Set();
      const placeholderKey = identity.title + '|organizer-unverified';
      const concreteKeys = [...titleKeys].filter((entry) => entry !== placeholderKey);
      let existingKey = selected.has(key) ? key : null;
      if (!existingKey && identity.organizerIsPlaceholder && concreteKeys.length === 1) {
        existingKey = concreteKeys[0];
      } else if (!existingKey && !identity.organizerIsPlaceholder
        && selected.has(placeholderKey)) {
        existingKey = placeholderKey;
      }
      const existing = existingKey ? selected.get(existingKey) : null;
      if (existing) {
        const replacingPlaceholder = !identity.organizerIsPlaceholder
          && existingKey === placeholderKey;
        if (replacingPlaceholder
          || (result.source.kind === 'official' && existing.sourceKind !== 'official')) {
          const replacement = identity.organizerIsPlaceholder && !replacingPlaceholder
            ? {
              ...existing,
              discoveryUrl: item.discoveryUrl,
              sourceId: result.source.id,
              sourceKind: result.source.kind,
            }
            : {
              ...item,
              sourceId: result.source.id,
              sourceKind: result.source.kind,
            };
          if (existingKey !== key && replacingPlaceholder) {
            selected.delete(existingKey);
            titleKeys.delete(existingKey);
            titleKeys.add(key);
            keysByTitle.set(identity.title, titleKeys);
          }
          selected.set(replacingPlaceholder ? key : existingKey, replacement);
        }
        continue;
      }
      if (selected.size >= limit) {
        overflowSourceIds.add(result.source.id);
        continue;
      }
      selected.set(key, {
        ...item,
        sourceId: result.source.id,
        sourceKind: result.source.kind,
      });
      titleKeys.add(key);
      keysByTitle.set(identity.title, titleKeys);
    }
  }
  return { candidates: [...selected.values()], overflowSourceIds };
}

function scores(category) {
  const values = {
    technology: [75, 65],
    idea: [75, 45],
    writing: [65, 55],
    image: [55, 55],
    design: [55, 60],
    video: [50, 70],
    other: [45, 50],
  };
  return values[category] || values.other;
}

function contestId(item) {
  const identity = dedupeIdentity(item) + '|' + item.category;
  const alphabet = 'abcdefghijklmnop';
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)
    .replace(/[0-9a-f]/gu, (digit) => alphabet[Number.parseInt(digit, 16)]);
  return 'discovery-' + hash;
}

export function buildCompetitionVerificationCandidates(results) {
  const maximum = results.reduce((total, result) => total + result.candidates.length, 0);
  return dedupeAcrossSources(results, maximum).candidates.map((item) => ({
    contest_id: contestId(item),
    category: item.category,
    title: item.title,
    organizer: item.organizer,
    source_id: item.sourceId,
    discovery_url: item.discoveryUrl,
  }));
}

function kstDate(instant) {
  return new Date(Date.parse(instant) + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

export function buildCompetitionCrawlReport(results, times = {}) {
  const startedAt = times.startedAt || new Date().toISOString();
  const finishedAt = times.finishedAt || new Date().toISOString();
  const suffix = finishedAt.replace(/\D/gu, '').slice(0, 17);
  const deduped = dedupeAcrossSources(results);

  const candidates = deduped.candidates.map((item) => {
    const candidateScores = scores(item.category);
    const sourceResult = results.find((entry) => entry.source.id === item.sourceId);
    return {
      contest_id: contestId(item),
      category: item.category,
      title: item.title,
      organizer: item.organizer,
      source_id: item.sourceId,
      discovery_url: item.discoveryUrl,
      discovered_at: sourceResult.checkedAt,
      recency: 'new',
      official_url: null,
      official_verification: 'unverified',
      official_verified_at: null,
      acceptance: 'unknown',
      deadline_at: null,
      eligibility: 'unknown',
      rights_risk: 'unknown',
      submission_risk: 'unknown',
      status: 'verifying',
      fit_score: candidateScores[0],
      effort_score: candidateScores[1],
    };
  });
  const candidateCounts = new Map(results.map((entry) => [entry.source.id, 0]));
  for (const candidate of candidates) {
    candidateCounts.set(
      candidate.source_id,
      candidateCounts.get(candidate.source_id) + 1,
    );
  }
  const sources = results.map((entry) => {
    const overflowed = deduped.overflowSourceIds.has(entry.source.id);
    return {
      id: entry.source.id,
      kind: entry.source.kind,
      name: entry.source.name,
      reference_url: entry.source.referenceUrl,
      checked_at: entry.checkedAt,
      status: overflowed ? 'partial' : entry.status,
      failure_code: overflowed && entry.failureCode === 'none' ? 'unknown' : entry.failureCode,
      manual_check: overflowed || entry.manualCheck,
      candidate_count: candidateCounts.get(entry.source.id),
    };
  });
  const succeeded = sources.filter((source) => ['ok', 'no_results'].includes(source.status)).length;
  const failed = sources.filter((source) => source.status === 'failed').length;
  const runStatus = failed === sources.length
    ? 'failed'
    : sources.some((source) => ['failed', 'partial'].includes(source.status))
      ? 'partial'
      : 'complete';
  const report = {
    version: 1,
    idempotency_key: 'competition-crawl-' + suffix,
    run: {
      id: 'competition-crawl-' + suffix,
      date: kstDate(startedAt),
      started_at: startedAt,
      finished_at: finishedAt,
      status: runStatus,
      source_coverage: {
        expected: sources.length,
        checked: sources.length,
        succeeded,
      },
    },
    sources,
    candidates,
    applications: [],
  };
  return validateCompetitionReport(report);
}

export async function runCompetitionCrawl(options = {}) {
  const sources = options.sources || SOURCE_DEFINITIONS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const clock = options.clock || Date.now;
  const concurrency = options.concurrency || 3;
  const timeoutMs = options.timeoutMs || DEFAULT_CRAWL_TIMEOUT_MS;
  const maxBytes = options.maxBytes || DEFAULT_MAX_PAGE_BYTES;
  const maxPerSource = options.maxPerSource || DEFAULT_MAX_PER_SOURCE;
  const startedAt = timestamp(clock);
  const results = await boundedMap(sources, concurrency, (source) => crawlCompetitionSource(source, {
    fetchImpl,
    clock,
    timeoutMs,
    maxBytes,
    maxPerSource,
  }));
  const finishedAt = timestamp(clock);
  return {
    report: buildCompetitionCrawlReport(results, { startedAt, finishedAt }),
    results,
  };
}
