import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompetitionCrawlReport,
  buildCompetitionVerificationCandidates,
  crawlCompetitionSource,
} from './competition-crawl-core.mjs';
import {
  SOURCE_DEFINITIONS,
  parseCompetitionSourcePage,
} from './competition-sources.mjs';
import { parseCompetitionCrawlArgs } from './competition-crawl.mjs';

const SOURCE_IDS = [
  'thinkgood',
  'wevity',
  'gongmobox',
  'linkareer',
  'campuspick',
  'everycareer',
  'contestkorea',
  'allcon',
  'stampit',
  'bizinfo',
  'kstartup',
  'epeople',
];

const FIXTURES = {
  thinkgood: '<div id="listDiv"><a href="/thinkgood/user/contest/view.do?contest_pk=1"><strong>테스트 아이디어 공모전</strong></a></div>',
  wevity: '<a href="?c=find&s=1&gbn=view&ix=11"><strong>테스트 영상 공모전</strong></a>',
  gongmobox: '<a href="https://gongmobox.com/contest/12/"><h3>테스트 AI 경진대회</h3></a>',
  linkareer: '<a href="/activity/13"><strong>추천 테스트 디자인 공모전</strong></a>',
  campuspick: '<a href="/contest/view?id=14"><strong>테스트 사진 공모전</strong></a>',
  everycareer: '<a href="/contest/view?id=14"><strong>테스트 사진 공모전</strong></a>',
  contestkorea: '<a href="/sub/view.php?int_gbn=1&str_no=15"><strong>1. 테스트 에세이 공모전</strong></a>',
  allcon: '<a href="/hit/contest/16"><strong>테스트 해커톤</strong></a>',
  stampit: '<article class="activityitem_item"><span>공모전</span><a href="/extraactivity/detail/17"><span class="activityitem_title">테스트 네이밍 공모전</span></a><span class="activityitem_company">테스트 기관</span></article>',
  bizinfo: '<table><tr><td><a href="/sii/siia/selectSIIA200Detail.do?pblancId=P18">테스트 아이디어 공모전</a></td><td>테스트 기관</td></tr></table>',
  kstartup: '<ul><li><a href="#" onclick="btnBizView(\'19\',\'N\')"><strong>테스트 창업 경진대회</strong></a></li></ul>',
  epeople: '<ul><li><a href="#" class="go_detail" data-ideaRegNo="1AE-2608-0000019"><strong>테스트 정책 아이디어 공모</strong></a><span class="thbot basic name">테스트 기관</span></li></ul>',
};

test('source registry freezes exactly twelve distinct coverage rows', () => {
  assert.deepEqual(SOURCE_DEFINITIONS.map((source) => source.id), SOURCE_IDS);
  assert.equal(new Set(SOURCE_DEFINITIONS.map((source) => source.id)).size, 12);
  for (const source of SOURCE_DEFINITIONS) {
    assert.match(source.referenceUrl, /^https:\/\//u);
    assert.ok(source.pageUrls.length >= 1);
    assert.ok(source.pageUrls.every((url) => source.allowedHosts.includes(new URL(url).hostname)));
  }
  assert.notEqual(
    SOURCE_DEFINITIONS.find((source) => source.id === 'campuspick').referenceUrl,
    SOURCE_DEFINITIONS.find((source) => source.id === 'everycareer').referenceUrl,
  );
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'wevity').pageUrls.length, 5);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'linkareer').pageUrls.length, 5);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'gongmobox').pageUrls.length, 7);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'contestkorea').pageUrls.length, 5);
  const allconUrls = SOURCE_DEFINITIONS.find((source) => source.id === 'allcon').pageUrls;
  assert.equal(allconUrls.length, 7);
  assert.equal(allconUrls.filter((url) => url.includes('/page/ajax.contest_list.php')).length, 6);
  assert.equal(allconUrls.some((url) => url.includes('/list/contest/')), false);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'bizinfo').pageUrls.length, 5);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'epeople').pageUrls.length, 5);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'stampit').pageUrls.length, 17);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'thinkgood').coverageLimited, true);
  assert.equal(SOURCE_DEFINITIONS.find((source) => source.id === 'kstartup').coverageLimited, true);
});

test('crawl output files must be distinct before any network work begins', () => {
  assert.throws(
    () => parseCompetitionCrawlArgs([
      '--report-out', 'work/report.json',
      '--verification-out', 'work/../work/report.json',
    ]),
    /paths must differ/u,
  );
  assert.throws(
    () => parseCompetitionCrawlArgs([
      '--report-out', 'work/Report.JSON',
      '--verification-out', 'WORK/report.json',
    ]),
    /paths must differ/u,
  );
});

test('all twelve parsers extract bounded public contest discoveries', () => {
  for (const source of SOURCE_DEFINITIONS) {
    const parsed = parseCompetitionSourcePage(source, FIXTURES[source.id], source.pageUrls[0]);
    assert.equal(parsed.recognized, true, source.id);
    assert.equal(parsed.items.length, 1, source.id);
    assert.match(parsed.items[0].discoveryUrl, /^https:\/\//u, source.id);
    assert.doesNotMatch(parsed.items[0].title, /^(?:추천|\d+\.)/u, source.id);
  }
});

test('Allcon parses strict AJAX rows and recognizes empty results fail-closed', () => {
  const allcon = SOURCE_DEFINITIONS.find((source) => source.id === 'allcon');
  const pageUrl = allcon.pageUrls[1];
  const parsed = parseCompetitionSourcePage(allcon, JSON.stringify({
    currentPage: 1,
    perPage: 15,
    totalCount: 1,
    totalPage: 1,
    rows: [{
      cl_title: "<a href='/hit/contest/4435?page=1&t=1'>2026 DATA·AI 분석 경진대회</a>",
      cl_host: '과학기술정보통신부',
    }],
  }), pageUrl);
  assert.deepEqual(
    [parsed.recognized, parsed.items.length, parsed.items[0].organizer],
    [true, 1, '과학기술정보통신부'],
  );
  assert.match(parsed.items[0].discoveryUrl, /^https:\/\/www\.all-con\.co\.kr\/hit\/contest\/4435/u);
  assert.deepEqual(
    parseCompetitionSourcePage(allcon, JSON.stringify({
      currentPage: 1, perPage: 15, totalCount: 0, totalPage: 0, rows: [],
    }), pageUrl),
    {
      items: [], recognized: true, ambiguousCount: 0,
      additionalPageUrls: [], coverageLimited: false,
    },
  );
  assert.equal(parseCompetitionSourcePage(allcon, JSON.stringify({
    currentPage: 2, perPage: 15, totalCount: 1, totalPage: 1, rows: [],
  }), pageUrl).recognized, false);
  assert.equal(parseCompetitionSourcePage(allcon, '{"missing":[]}', pageUrl).recognized, false);
  assert.equal(parseCompetitionSourcePage(allcon, 'not-json', pageUrl).recognized, false);
  const broadContestTitle = parseCompetitionSourcePage(allcon, JSON.stringify({
    currentPage: 1, perPage: 15, totalCount: 1, totalPage: 1,
    rows: [{
      cl_title: "<a href='/hit/contest/4436?page=1&t=1'>2026 대한민국 대학생 광고대회 KOSAC</a>",
      cl_host: '한국광고총연합회',
    }],
  }), pageUrl);
  assert.deepEqual(
    broadContestTitle.items.map((item) => item.title),
    ['2026 대한민국 대학생 광고대회 KOSAC'],
  );
  const markupHost = parseCompetitionSourcePage(allcon, JSON.stringify({
    currentPage: 1, perPage: 15, totalCount: 1, totalPage: 1,
    rows: [{
      cl_title: "<a href='/hit/contest/4439'>마크업 주최자 광고대회</a>",
      cl_host: '<script>alert(1)</script><b>기관</b>',
    }],
  }), pageUrl);
  assert.equal(markupHost.items[0].organizer, '기관');
});

test('Allcon follows every advertised page and marks totals beyond its safety bound partial', async () => {
  const original = SOURCE_DEFINITIONS.find((source) => source.id === 'allcon');
  const source = { ...original, pageUrls: [original.pageUrls[1]] };
  const requestedPages = [];
  const crawled = await crawlCompetitionSource(source, {
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);
      const page = Number(parsedUrl.searchParams.get('page'));
      requestedPages.push(page);
      return new Response(JSON.stringify({
        currentPage: page,
        perPage: 1,
        totalCount: 8,
        totalPage: 8,
        rows: [{
          cl_title: `<a href='/hit/contest/${4_400 + page}'>동적 ${page} 공모전</a>`,
          cl_host: '테스트 기관',
        }],
      }), { status: 200, headers: { 'content-type': 'text/html' } });
    },
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(requestedPages, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(crawled.candidates.length, 8);
  assert.equal(crawled.status, 'ok');

  const truncated = parseCompetitionSourcePage(source, JSON.stringify({
    currentPage: 1,
    perPage: 1,
    totalCount: 51,
    totalPage: 51,
    rows: [],
  }), source.pageUrls[0]);
  assert.equal(truncated.additionalPageUrls.length, 49);
  assert.equal(truncated.coverageLimited, true);

  const requestedRowsContract = parseCompetitionSourcePage(source, JSON.stringify({
    currentPage: 1,
    perPage: 10,
    totalCount: 136,
    totalPage: 10,
    rows: [],
  }), source.pageUrls[0]);
  assert.equal(requestedRowsContract.recognized, true);
});

test('a source that ignores pagination is partial even when every response parses', async () => {
  const original = SOURCE_DEFINITIONS.find((entry) => entry.id === 'contestkorea');
  const source = { ...original, pageUrls: original.pageUrls.slice(0, 2) };
  const body = '<a href="/sub/view.php?int_gbn=1&str_no=15"><strong>반복 공모전</strong></a>';
  const crawled = await crawlCompetitionSource(source, {
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
    ['partial', 'unknown', true, 1],
  );
});

test('dynamic pagination stops after two consecutive host failures', async () => {
  const original = SOURCE_DEFINITIONS.find((entry) => entry.id === 'allcon');
  const source = { ...original, pageUrls: [original.pageUrls[1]] };
  const requestedPages = [];
  const crawled = await crawlCompetitionSource(source, {
    timeoutMs: 10,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requestedPages.push(page);
      if (page > 1) return new Promise(() => {});
      return new Response(JSON.stringify({
        currentPage: 1,
        perPage: 1,
        totalCount: 8,
        totalPage: 8,
        rows: [{
          cl_title: "<a href='/hit/contest/4401'>동적 공모전</a>",
          cl_host: '테스트 기관',
        }],
      }), { status: 200, headers: { 'content-type': 'text/html' } });
    },
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.deepEqual(
    [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
    ['partial', 'timeout', true, 1],
  );
});

test('source total budget stops slow-success pagination as partial', async () => {
  const original = SOURCE_DEFINITIONS.find((entry) => entry.id === 'contestkorea');
  const source = { ...original, pageUrls: original.pageUrls.slice(0, 3) };
  const ticks = [0, 0, 500, 1_001];
  let calls = 0;
  const crawled = await crawlCompetitionSource(source, {
    sourceBudgetMs: 1_000,
    monotonicClock: () => ticks.shift() ?? 1_001,
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        `<a href="/sub/view.php?int_gbn=1&str_no=${calls}"><strong>예산 ${calls} 공모전</strong></a>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    },
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.equal(calls, 2);
  assert.deepEqual(
    [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
    ['partial', 'timeout', true, 2],
  );
});

test('government parsers exclude grants, jobs, and event votes fail-closed', () => {
  const bizinfo = SOURCE_DEFINITIONS.find((source) => source.id === 'bizinfo');
  const businessHtml = [
    '<a href="/sii/siia/selectSIIA200Detail.do?pblancId=A">진짜 데이터 경진대회</a>',
    '<a href="/sii/siia/selectSIIA200Detail.do?pblancId=B">디자인 공모전 출품 지원사업</a>',
    '<a href="/sii/siia/selectSIIA200Detail.do?pblancId=C">청년 채용 지원금</a>',
  ].join('');
  const parsedBusiness = parseCompetitionSourcePage(
    bizinfo,
    businessHtml,
    bizinfo.pageUrls[0],
  );
  assert.deepEqual(parsedBusiness.items.map((item) => item.title), ['진짜 데이터 경진대회']);
  assert.equal(parsedBusiness.ambiguousCount, 1);

  const epeople = SOURCE_DEFINITIONS.find((source) => source.id === 'epeople');
  const peopleHtml = [
    '<a href="#" class="go_detail" data-ideaRegNo="1AE-2608-0000001"><strong>진짜 정책 아이디어 공모전</strong></a>',
    '<a href="#" class="go_detail" data-ideaRegNo="1AE-2608-0000002"><strong>이벤트 투표 공모과제 평가</strong></a>',
  ].join('');
  const parsedPeople = parseCompetitionSourcePage(epeople, peopleHtml, epeople.pageUrls[0]);
  assert.deepEqual(parsedPeople.items.map((item) => item.title), ['진짜 정책 아이디어 공모전']);
  assert.equal(parsedPeople.ambiguousCount, 1);
});

test('Bizinfo recognizes only its exact official empty-result table sentinel', () => {
  const bizinfo = SOURCE_DEFINITIONS.find((source) => source.id === 'bizinfo');
  const officialEmpty = parseCompetitionSourcePage(
    bizinfo,
    '<table><caption>지원사업 공고</caption><tbody><tr><td colspan="8">등록된 게시물이 없습니다.</td></tr></tbody></table>',
    bizinfo.pageUrls[1],
  );
  assert.deepEqual(
    [officialEmpty.recognized, officialEmpty.items.length, officialEmpty.ambiguousCount],
    [true, 0, 0],
  );
  const unscopedText = parseCompetitionSourcePage(
    bizinfo,
    '<main>등록된 게시물이 없습니다.</main>',
    bizinfo.pageUrls[1],
  );
  assert.equal(unscopedText.recognized, false);
});

test('Bizinfo pagination keeps a first-page candidate when later pages are officially empty', async () => {
  const source = SOURCE_DEFINITIONS.find((entry) => entry.id === 'bizinfo');
  const empty = '<table><caption>지원사업 공고</caption><tbody><tr><td colspan="8">등록된 게시물이 없습니다.</td></tr></tbody></table>';
  const result = await crawlCompetitionSource(source, {
    fetchImpl: async (url) => new Response(
      String(url).includes('cpage=1')
        ? '<table><tr><td><a href="/sii/siia/selectSIIA200Detail.do?pblancId=P18">테스트 아이디어 공모전</a></td><td>테스트 기관</td></tr></table>'
        : empty,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [result.status, result.failureCode, result.manualCheck, result.candidates.length],
    ['ok', 'none', false, 1],
  );
});

test('contest-scoped listings keep valid detail rows without a narrow title keyword', () => {
  const wevity = SOURCE_DEFINITIONS.find((source) => source.id === 'wevity');
  const parsed = parseCompetitionSourcePage(
    wevity,
    '<a href="?c=find&s=1&gbn=view&ix=46"><strong>제46회 대한민국미술대전</strong></a>',
    wevity.pageUrls[0],
  );
  assert.deepEqual(parsed.items.map((item) => item.title), ['제46회 대한민국미술대전']);
});

test('broad navigation shells do not masquerade as clean no-result coverage', () => {
  const fixtures = {
    thinkgood: '<div id="listDiv"><a href="/thinkgood/user/contest/view.do?contest_pk=bad">공모전</a></div>',
    wevity: '<a href="?c=find&s=1&gbn=view&ix=bad">공모전</a>',
    gongmobox: '<a href="/contest/">공모전 목록</a>',
    linkareer: '<a href="/activity/">대외활동 목록</a>',
    campuspick: '<a href="/contest/view?id=bad">공모전</a>',
    everycareer: '<a href="/contest/view?id=bad">공모전</a>',
    contestkorea: '<a href="/sub/view.php?int_gbn=2&str_no=15">다른 목록</a>',
    allcon: '<a href="/view/contest/">공모전 목록</a>',
    stampit: '<a href="/extraactivity/detail/">공모전 목록</a>',
  };
  for (const [id, body] of Object.entries(fixtures)) {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.id === id);
    const parsed = parseCompetitionSourcePage(source, body, source.pageUrls[0]);
    assert.equal(parsed.recognized, false, id);
    assert.equal(parsed.items.length, 0, id);
  }
});

test('mixed valid and structurally drifted detail links are explicit partial coverage', async () => {
  const cases = {
    linkareer: [
      '<a href="/activity/123">안전한 아이디어 공모전</a>',
      '<a href="/activity/new-contract">새 계약 아이디어 공모전</a>',
    ].join(''),
    gongmobox: [
      '<a href="/contest/123/">안전한 아이디어 공모전</a>',
      '<a href="/contest/new-contract/nested">새 계약 아이디어 공모전</a>',
    ].join(''),
    contestkorea: [
      '<a href="/sub/view.php?int_gbn=1&str_no=123">안전한 아이디어 공모전</a>',
      '<a href="/sub/view.php?int_gbn=1&str_no=new-contract">새 계약 아이디어 공모전</a>',
    ].join(''),
    allcon: [
      '<a href="/view/contest/123">안전한 아이디어 공모전</a>',
      '<a href="/view/contest/new-contract">새 계약 아이디어 공모전</a>',
    ].join(''),
  };
  for (const [id, body] of Object.entries(cases)) {
    const original = SOURCE_DEFINITIONS.find((entry) => entry.id === id);
    const source = { ...original, pageUrls: [original.pageUrls[0]] };
    const parsed = parseCompetitionSourcePage(source, body, source.pageUrls[0]);
    assert.equal(parsed.items.length, 1, id);
    assert.ok(parsed.ambiguousCount > 0, id);
    const crawled = await crawlCompetitionSource(source, {
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      clock: () => Date.parse('2026-08-31T00:01:00Z'),
    });
    assert.deepEqual(
      [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
      ['partial', 'unknown', true, 1],
      id,
    );
  }
});

test('new pagination controls on single-response sources force manual partial coverage', async () => {
  for (const id of ['campuspick', 'everycareer', 'stampit']) {
    const original = SOURCE_DEFINITIONS.find((entry) => entry.id === id);
    const source = { ...original, pageUrls: [original.pageUrls[0]] };
    const body = FIXTURES[id]
      + '<a rel="next" href="/contest?page=2">다음</a>'
      + '<button data-next-cursor="abc">더보기</button>';
    const parsed = parseCompetitionSourcePage(source, body, source.pageUrls[0]);
    assert.ok(parsed.ambiguousCount > 0, id);
    const crawled = await crawlCompetitionSource(source, {
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      clock: () => Date.parse('2026-08-31T00:01:00Z'),
    });
    assert.deepEqual(
      [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
      ['partial', 'unknown', true, 1],
      id,
    );
  }
});

test('contest-scoped aggregators retain contests whose subject mentions support programs', () => {
  const title = '2026 창업 지원사업 우수사례 공모전';
  const fixtures = {
    wevity: `<a href="?c=find&s=1&gbn=view&ix=501"><strong>${title}</strong></a>`,
    linkareer: `<a href="/activity/502"><strong>${title}</strong></a>`,
    campuspick: `<a href="/contest/view?id=503"><strong>${title}</strong></a>`,
  };
  for (const [id, body] of Object.entries(fixtures)) {
    const source = SOURCE_DEFINITIONS.find((entry) => entry.id === id);
    const parsed = parseCompetitionSourcePage(source, body, source.pageUrls[0]);
    assert.deepEqual(parsed.items.map((item) => item.title), [title], id);
  }
  const allcon = SOURCE_DEFINITIONS.find((entry) => entry.id === 'allcon');
  const parsedAllcon = parseCompetitionSourcePage(allcon, JSON.stringify({
    currentPage: 1, perPage: 15, totalCount: 1, totalPage: 1,
    rows: [{
      cl_title: `<a href='/hit/contest/504'>${title}</a>`,
      cl_host: '기관',
    }],
  }), allcon.pageUrls[1]);
  assert.deepEqual(parsedAllcon.items.map((item) => item.title), [title]);
});

test('government contest filtering preserves a real idea competition about jobs', () => {
  const kstartup = SOURCE_DEFINITIONS.find((source) => source.id === 'kstartup');
  const parsed = parseCompetitionSourcePage(
    kstartup,
    '<a href="#" onclick="btnBizView(\'178352\',\'N\')"><strong>해양·수산 일자리 창출을 위한 2026 국민 아이디어 제안대회</strong></a>',
    kstartup.pageUrls[0],
  );
  assert.deepEqual(parsed.items.map((item) => item.title), [
    '해양·수산 일자리 창출을 위한 2026 국민 아이디어 제안대회',
  ]);
  assert.equal(parsed.ambiguousCount, 0);
});

test('the 국민생각함 parser does not borrow an institution label from a broad list container', () => {
  const epeople = SOURCE_DEFINITIONS.find((source) => source.id === 'epeople');
  const broadList = [
    '<div class="entire-list"><span class="name">다른 기관</span>',
    '<a href="#" class="go_detail" data-ideaRegNo="1AE-2608-0000003">',
    '<strong>고창군 정책 아이디어 공모</strong></a></div>',
  ].join('');
  const parsed = parseCompetitionSourcePage(epeople, broadList, epeople.pageUrls[0]);
  assert.equal(parsed.items[0].organizer, '주최기관 공식 확인 필요');
});

function fixtureSource(pageUrls = ['https://fixture.example/one']) {
  return {
    id: 'fixture',
    kind: 'listing',
    name: 'Fixture',
    referenceUrl: 'https://fixture.example/',
    pageUrls,
    allowedHosts: ['fixture.example'],
    parsePage: (_source, body) => ({
      recognized: body.includes('recognized'),
      ambiguousCount: body.includes('ambiguous') ? 1 : 0,
      items: body.includes('candidate') ? [{
        title: 'Fixture 아이디어 공모전',
        organizer: 'Fixture Organizer',
        discoveryUrl: 'https://fixture.example/contest/1',
        category: 'idea',
      }] : [],
    }),
  };
}

test('a later page failure preserves earlier candidates as truthful partial coverage', async () => {
  const source = fixtureSource([
    'https://fixture.example/one',
    'https://fixture.example/two',
  ]);
  const fetchImpl = async (url) => {
    if (url.endsWith('/one')) {
      return new Response('recognized candidate', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('forbidden', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await crawlCompetitionSource(source, {
    fetchImpl,
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.failureCode, 'http_403');
  assert.equal(result.manualCheck, true);
  assert.equal(result.candidates.length, 1);
});

test('first-page 403 and HTTP 200 parser drift are not reported as no-results', async () => {
  const forbidden = await crawlCompetitionSource(fixtureSource(), {
    fetchImpl: async () => new Response('', {
      status: 403,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [forbidden.status, forbidden.failureCode, forbidden.manualCheck, forbidden.candidates.length],
    ['failed', 'http_403', true, 0],
  );

  const drift = await crawlCompetitionSource(fixtureSource(), {
    fetchImpl: async () => new Response('<html>changed</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [drift.status, drift.failureCode, drift.manualCheck, drift.candidates.length],
    ['failed', 'invalid_response', true, 0],
  );
});

test('a parser exception is reported with the dedicated parse_error coverage code', async () => {
  const source = fixtureSource();
  source.parsePage = () => { throw new Error('synthetic parser failure'); };
  const parsed = await crawlCompetitionSource(source, {
    fetchImpl: async () => new Response('<html>recognized</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [parsed.status, parsed.failureCode, parsed.manualCheck, parsed.candidates.length],
    ['failed', 'parse_error', true, 0],
  );
});

test('the timeout and byte limit cover the response body, not only its headers', async () => {
  const stalled = await crawlCompetitionSource(fixtureSource(), {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('recognized '));
      },
    }), { status: 200, headers: { 'content-type': 'text/html' } }),
    timeoutMs: 10,
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [stalled.status, stalled.failureCode, stalled.manualCheck],
    ['failed', 'timeout', true],
  );

  const oversized = await crawlCompetitionSource(fixtureSource(), {
    fetchImpl: async () => new Response('recognized candidate', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    maxBytes: 8,
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [oversized.status, oversized.failureCode, oversized.manualCheck],
    ['failed', 'invalid_response', true],
  );
});

test('ambiguous government discoveries force manual partial coverage', async () => {
  const result = await crawlCompetitionSource(fixtureSource(), {
    fetchImpl: async () => new Response('recognized candidate ambiguous', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.failureCode, 'unknown');
  assert.equal(result.manualCheck, true);
  assert.equal(result.candidates.length, 1);
});

test('a source with a known bounded coverage window is explicit partial coverage', async () => {
  const source = { ...fixtureSource(), coverageLimited: true };
  const result = await crawlCompetitionSource(source, {
    fetchImpl: async () => new Response('recognized candidate', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [result.status, result.failureCode, result.manualCheck, result.candidates.length],
    ['partial', 'unknown', true, 1],
  );
  const noResults = await crawlCompetitionSource(source, {
    fetchImpl: async () => new Response('recognized', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [noResults.status, noResults.failureCode, noResults.manualCheck, noResults.candidates.length],
    ['partial', 'unknown', true, 0],
  );
});

test('cross-source duplicate is retained once and candidate counts are recomputed', () => {
  const checkedAt = '2026-08-30T00:01:00Z';
  const results = SOURCE_DEFINITIONS.map((source) => ({
    source,
    checkedAt,
    status: 'no_results',
    failureCode: 'none',
    manualCheck: false,
    candidates: [],
    extractedCount: 0,
  }));
  const shared = {
    title: '동일한 아이디어 공모전',
    organizer: '테스트 기관',
    category: 'idea',
  };
  for (const id of ['campuspick', 'everycareer']) {
    const entry = results.find((result) => result.source.id === id);
    entry.status = 'ok';
    entry.candidates = [{
      ...shared,
      discoveryUrl: entry.source.referenceUrl + '?id=77',
    }];
    entry.extractedCount = 1;
  }
  const report = buildCompetitionCrawlReport(results, {
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:02:00Z',
  });
  assert.equal(report.sources.length, 12);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].source_id, 'campuspick');
  assert.equal(report.sources.find((source) => source.id === 'campuspick').candidate_count, 1);
  assert.equal(report.sources.find((source) => source.id === 'everycareer').candidate_count, 0);
  assert.deepEqual(report.applications, []);
  assert.equal(report.candidates[0].official_verification, 'unverified');
  assert.equal(report.candidates[0].status, 'verifying');
});

test('same-title contests from different organizers remain distinct with distinct keys', () => {
  const checkedAt = '2026-08-30T00:01:00Z';
  const results = SOURCE_DEFINITIONS.slice(0, 2).map((source, index) => ({
    source,
    checkedAt,
    status: 'ok',
    failureCode: 'none',
    manualCheck: false,
    candidates: [{
      title: '동일 명칭 아이디어 공모전',
      organizer: '서로 다른 기관 ' + index,
      category: 'idea',
      discoveryUrl: source.referenceUrl,
    }],
    extractedCount: 1,
  }));
  const report = buildCompetitionCrawlReport(results, {
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:02:00Z',
  });
  assert.equal(report.candidates.length, 2);
  assert.equal(new Set(report.candidates.map((candidate) => candidate.contest_id)).size, 2);
});

test('a placeholder organizer merges into one concrete organizer without hiding real homonyms', () => {
  const checkedAt = '2026-08-30T00:01:00Z';
  const results = SOURCE_DEFINITIONS.slice(0, 3).map((source, index) => ({
    source,
    checkedAt,
    status: 'ok',
    failureCode: 'none',
    manualCheck: false,
    candidates: [{
      title: '공유 명칭 아이디어 공모전',
      organizer: index === 0 ? '주최기관 공식 확인 필요' : `구체 기관 ${index}`,
      category: 'idea',
      discoveryUrl: source.referenceUrl,
    }],
    extractedCount: 1,
  }));
  const report = buildCompetitionCrawlReport(results, {
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:02:00Z',
  });
  assert.equal(report.candidates.length, 2);
  assert.deepEqual(
    report.candidates.map((candidate) => candidate.organizer).sort(),
    ['구체 기관 1', '구체 기관 2'],
  );
});

test('an official-source duplicate replaces its discovery-listing copy', () => {
  const checkedAt = '2026-08-30T00:01:00Z';
  const listing = SOURCE_DEFINITIONS.find((source) => source.id === 'linkareer');
  const official = SOURCE_DEFINITIONS.find((source) => source.id === 'kstartup');
  const results = [listing, official].map((source) => ({
    source,
    checkedAt,
    status: 'ok',
    failureCode: 'none',
    manualCheck: false,
    candidates: [{
      title: '동일한 공식 정책 아이디어 공모전',
      organizer: '주최기관 공식 확인 필요',
      category: 'idea',
      discoveryUrl: source.referenceUrl,
    }],
    extractedCount: 1,
  }));
  const report = buildCompetitionCrawlReport(results, {
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:02:00Z',
  });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].source_id, 'kstartup');
  assert.equal(report.sources[0].candidate_count, 0);
  assert.equal(report.sources[1].candidate_count, 1);
});

test('per-source and global capacity limits are visible as partial coverage', async () => {
  const source = fixtureSource();
  source.parsePage = () => ({
    recognized: true,
    ambiguousCount: 0,
    items: Array.from({ length: 3 }, (_, index) => ({
      title: `Fixture ${index} 아이디어 공모전`,
      organizer: 'Fixture Organizer',
      discoveryUrl: `https://fixture.example/contest/${index}`,
      category: 'idea',
    })),
  });
  const truncated = await crawlCompetitionSource(source, {
    fetchImpl: async () => new Response('recognized', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    maxPerSource: 2,
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [truncated.status, truncated.failureCode, truncated.manualCheck, truncated.candidates.length],
    ['partial', 'unknown', true, 2],
  );

  const many = {
    ...truncated,
    checkedAt: '2026-08-30T00:01:00Z',
    status: 'ok',
    failureCode: 'none',
    manualCheck: false,
    candidates: Array.from({ length: 501 }, (_, index) => ({
      title: `Fixture ${index} 아이디어 공모전`,
      organizer: 'Fixture Organizer',
      discoveryUrl: `https://fixture.example/contest/${index}`,
      category: 'idea',
    })),
  };
  const report = buildCompetitionCrawlReport([many], {
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:02:00Z',
  });
  assert.equal(report.candidates.length, 500);
  assert.equal(buildCompetitionVerificationCandidates([many]).length, 501);
  assert.deepEqual(
    [report.sources[0].status, report.sources[0].failure_code, report.sources[0].manual_check],
    ['partial', 'unknown', true],
  );
});

test('private-looking listing text is dropped before strict report assembly', () => {
  const source = SOURCE_DEFINITIONS.find((entry) => entry.id === 'linkareer');
  const phone = parseCompetitionSourcePage(
    source,
    '<a href="/activity/99"><strong>010-1234-5678 아이디어 공모전</strong></a>',
    source.pageUrls[0],
  );
  const residentId = parseCompetitionSourcePage(
    source,
    '<a href="/activity/100"><strong>지원자 900101-1234567 아이디어 공모전</strong></a>',
    source.pageUrls[0],
  );
  const labeledIdentity = parseCompetitionSourcePage(
    source,
    '<a href="/activity/101"><strong>지원자: 홍길동 아이디어 공모전</strong></a>',
    source.pageUrls[0],
  );
  assert.equal(phone.recognized, true);
  assert.equal(phone.items.length, 0);
  assert.equal(residentId.recognized, true);
  assert.equal(residentId.items.length, 0);
  assert.equal(labeledIdentity.items.length, 0);
});

test('private URL aliases and assignments drop only the untrusted listing rows', async () => {
  const source = SOURCE_DEFINITIONS.find((entry) => entry.id === 'linkareer');
  const body = [
    '<a href="/activity/90"><strong>안전한 아이디어 공모전</strong></a>',
    '<a href="/activity/91?contact=person%40example.com"><strong>연락처 포함 아이디어 공모전</strong></a>',
    '<a href="/activity/92?oauthCode=privatevalue123"><strong>토큰 포함 아이디어 공모전</strong></a>',
    '<a href="/activity/93?next=%2Fprivate_key%3Dprivatevalue123"><strong>중첩 토큰 아이디어 공모전</strong></a>',
    '<a href="/activity/94"><strong>authorization=privatevalue123 아이디어 공모전</strong></a>',
  ].join('');
  const parsed = parseCompetitionSourcePage(source, body, source.pageUrls[0]);
  assert.deepEqual(parsed.items.map((item) => item.title), ['안전한 아이디어 공모전']);
  assert.ok(parsed.ambiguousCount > 0);
  const crawled = await crawlCompetitionSource({ ...source, pageUrls: [source.pageUrls[0]] }, {
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    clock: () => Date.parse('2026-08-31T00:01:00Z'),
  });
  assert.deepEqual(
    [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
    ['partial', 'unknown', true, 1],
  );
  const report = buildCompetitionCrawlReport([{
    source,
    checkedAt: '2026-08-30T00:01:00Z',
    status: 'ok',
    failureCode: 'none',
    manualCheck: false,
    candidates: parsed.items,
    extractedCount: parsed.items.length,
  }], {
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:02:00Z',
  });
  assert.equal(report.candidates.length, 1);
});

test('official parser identifier drift is partial manual coverage, never clean no-results', async () => {
  const fixtures = {
    bizinfo: '<a href="/sii/siia/selectSIIA200Detail.do?pblancId=!"><strong>정책 아이디어 공모전</strong></a>',
    kstartup: '<a href="#" onclick="btnBizView(\'FORMAT_CHANGED\',\'N\')"><strong>정책 아이디어 공모전</strong></a>',
    epeople: '<a href="#" class="go_detail" data-ideaRegNo="FORMAT_CHANGED_WITH_UNDERSCORE"><strong>정책 아이디어 공모전</strong></a>',
  };
  for (const [id, body] of Object.entries(fixtures)) {
    const original = SOURCE_DEFINITIONS.find((entry) => entry.id === id);
    const source = { ...original, pageUrls: [original.pageUrls[0]], coverageLimited: false };
    const parsed = parseCompetitionSourcePage(source, body, source.pageUrls[0]);
    assert.equal(parsed.recognized, true, id);
    assert.equal(parsed.items.length, 0, id);
    assert.ok(parsed.ambiguousCount > 0, id);
    const crawled = await crawlCompetitionSource(source, {
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      clock: () => Date.parse('2026-08-31T00:01:00Z'),
    });
    assert.deepEqual(
      [crawled.status, crawled.failureCode, crawled.manualCheck, crawled.candidates.length],
      ['partial', 'unknown', true, 0],
      id,
    );
  }
});

test('Allcon drops a private path assignment without losing safe rows', () => {
  const source = SOURCE_DEFINITIONS.find((entry) => entry.id === 'allcon');
  const parsed = parseCompetitionSourcePage(source, JSON.stringify({
    currentPage: 1, perPage: 15, totalCount: 2, totalPage: 1,
    rows: [
      { cl_title: "<a href='/hit/contest/4437'>안전한 광고대회</a>", cl_host: '기관' },
      { cl_title: "<a href='/hit/contest/4438/token=privatevalue123'>비공개 토큰 대회</a>", cl_host: '기관' },
    ],
  }), source.pageUrls[1]);
  assert.deepEqual(parsed.items.map((item) => item.title), ['안전한 광고대회']);
});
