import * as cheerio from 'cheerio';
import {
  isCompetitionPublicTextSafe,
  isCompetitionPublicUrlSafe,
} from './competition-report.mjs';

const DROPPED_CANDIDATES = Symbol('droppedCandidates');
const ALLCON_MAX_PAGES_PER_TYPE = 50;
const THINKGOOD_MAX_PAGES = 50;
const EPEOPLE_MAX_PAGES = 20;

export const CONTEST_POSITIVE = /(?:공모(?:전|제)?|경진(?:대회)?|아이디어\s*(?:공모(?:전)?|제안대회|대회)|(?:토론|자원봉사|창업|발명|트레일러닝)\s*대회|(?:문학|발명|미술|광고|디자인|과학)대전|예술제|가요제|슬로건|이름찾기|청년기업가대상|어워드|콘테스트|챌린지|해커톤|competition|contest|challenge|hackathon|award)/iu;
export const CONTEST_EXCLUDED = /(?:지원금|지원\s*사업|보조금|융자|대출|사업화\s*지원|판로\s*지원|입주기업|입주사|(?:채용|구인|인턴)\s*(?:공고|모집|정보)|일자리\s*(?:지원|사업|채용|구인)|(?:구매|입찰|조달|용역)\s*(?:공고|모집|사업)|경품\s*(?:추첨|이벤트)|추첨\s*(?:이벤트|행사)|댓글\s*이벤트|이벤트\s*투표|설문\s*(?:조사|참여|이벤트))/iu;

function text(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\s*페이지 이동$/u, '');
}

function safeDiscoveryUrl(href, pageUrl, allowedHosts) {
  if (!href || /^(?:javascript:|mailto:|tel:|#)/iu.test(href.trim())) return null;
  let url;
  try { url = new URL(href, pageUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!allowedHosts.includes(url.hostname.toLowerCase())) return null;
  url.hash = '';
  return isCompetitionPublicUrlSafe(url.href) ? url.href : null;
}

function inferredOrganizer(title, fallback = '주최기관 공식 확인 필요') {
  const bracketed = title.match(/^\[([^\]]{2,60})\]/u)?.[1];
  return text(bracketed || fallback);
}

function boundedOrganizer(value, title) {
  const organizer = text(value);
  if (!organizer || organizer.length > 160 || Buffer.byteLength(organizer, 'utf8') > 160
    || !isCompetitionPublicTextSafe(organizer)) return inferredOrganizer(title);
  return organizer;
}

export function inferCompetitionCategory(title) {
  const value = text(title);
  if (/(?:사진|포토|photograph|image)/iu.test(value)) return 'image';
  if (/(?:영상|숏폼|영화|트레일러|미디어아트|video|film)/iu.test(value)) return 'video';
  if (/(?:디자인|캐릭터|웹툰|포스터|로고|BI\b|design)/iu.test(value)) return 'design';
  if (/(?:에세이|글쓰기|스토리|편지|논문|수기|시나리오|writing|essay)/iu.test(value)) return 'writing';
  if (/(?:\bAI\b|인공지능|데이터|소프트웨어|\bSW\b|로봇|해커톤|기술|경진|technology|hackathon)/iu.test(value)) return 'technology';
  if (/(?:아이디어|기획|정책|제안|네이밍|idea)/iu.test(value)) return 'idea';
  return 'other';
}

function titleFromAnchor($, anchor) {
  const nested = $(anchor).find(
    'h1,h2,h3,h4,strong,[class*="title"],[class*="subject"]',
  ).first();
  const value = text(nested.text()) || text($(anchor).attr('title')) || text($(anchor).text());
  return value
    .replace(/^(?:추천|SPECIAL|IDEA)\s*/giu, '')
    .replace(/^\d+\.\s*/u, '')
    .replace(/\s*(?:(?:SPECIAL|IDEA)\s*)+$/giu, '')
    .trim();
}

function normalizeCandidate(item) {
  const title = text(item.title);
  const organizer = text(item.organizer) || inferredOrganizer(title);
  if (!title || title.length < 4 || title.length > 240 || Buffer.byteLength(title, 'utf8') > 240
    || !organizer || organizer.length > 160 || Buffer.byteLength(organizer, 'utf8') > 160
    || !isCompetitionPublicTextSafe(title) || !isCompetitionPublicTextSafe(organizer)
    || !item.discoveryUrl) return null;
  return {
    title,
    organizer,
    discoveryUrl: item.discoveryUrl,
    category: item.category || inferCompetitionCategory(title),
  };
}

function meaningfulCandidateShape(item) {
  const title = text(item.title);
  return title.length >= 4 && title.length <= 240 && Buffer.byteLength(title, 'utf8') <= 240;
}

function discoveryIdentity(href, pageUrl) {
  try {
    const url = new URL(href || '', pageUrl);
    url.hash = '';
    return url.href;
  } catch {
    return String(href || '');
  }
}

function linkItems($, source, pageUrl, selector, options = {}) {
  const include = options.include || (() => true);
  const organizer = options.organizer || null;
  const items = [];
  const accepted = new Set();
  const ambiguous = new Set();
  $(selector).each((_, anchor) => {
    const title = titleFromAnchor($, anchor);
    if (!include(title, anchor, $)) return;
    const item = {
      title,
      organizer: organizer ? organizer(title, anchor, $) : inferredOrganizer(title),
      discoveryUrl: safeDiscoveryUrl($(anchor).attr('href'), pageUrl, source.allowedHosts),
    };
    const key = discoveryIdentity($(anchor).attr('href'), pageUrl);
    const candidate = normalizeCandidate(item);
    if (candidate) {
      items.push(candidate);
      accepted.add(key);
    } else if (meaningfulCandidateShape(item)) {
      ambiguous.add(key);
    }
  });
  for (const key of accepted) ambiguous.delete(key);
  Object.defineProperty(items, DROPPED_CANDIDATES, {
    value: ambiguous.size,
    writable: true,
  });
  return items;
}

function result(items, recognized, ambiguousCount = 0) {
  return {
    items,
    recognized,
    ambiguousCount: ambiguousCount + Number(items[DROPPED_CANDIDATES] || 0),
  };
}

function hasUnexpectedPaginationControls($) {
  if ($('a[rel~="next"][href],[data-next-cursor],[data-next-page],[data-load-more]').length > 0) {
    return true;
  }
  const controls = $('a[href],button,[role="button"]');
  return controls.toArray().some((control) => {
    const node = $(control);
    const label = text([
      node.text(),
      node.attr('aria-label'),
      node.attr('title'),
      node.attr('class'),
      node.attr('id'),
    ].filter(Boolean).join(' '));
    const paginationScope = node.closest(
      'nav,[class*="paging"],[class*="pagination"],[id*="paging"],[id*="pagination"],'
      + '[class*="load-more"],[id*="load-more"]',
    );
    if (paginationScope.length > 0
      && /(?:더보기|다음|next|load[\s_-]*more)/iu.test(label)) return true;
    const href = node.attr('href') || '';
    return /(?:[?&](?:page|pageIndex|cursor)=\d+|[?&](?:cursor|nextCursor)=[A-Za-z0-9_-]+)/u.test(href)
      && paginationScope.length > 0;
  });
}

function paginationPageCount($) {
  const pages = $('nav,[class*="paging"],[class*="pagination"],[id*="paging"],[id*="pagination"]')
    .find('a,button,[role="button"]')
    .toArray()
    .map((control) => Number.parseInt(text($(control).text()), 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 500);
  return Math.max(0, ...pages);
}

function invalidStructuralCount($, selector, isValid, isKnownNavigation = () => false) {
  return $(selector).toArray().filter((anchor) => (
    !isValid(0, anchor) && !isKnownNavigation(anchor)
  )).length;
}

function parseThinkgood(source, body, pageUrl) {
  if (new URL(pageUrl).pathname.endsWith('/user/contest/subList.do')) {
    let payload;
    try { payload = JSON.parse(body); } catch { return result([], false); }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
      || String(payload.status) !== '1' || !Array.isArray(payload.listJsonData)) {
      return result([], false);
    }
    const currentPageNo = Number(payload.currentPageNo);
    const recordsPerPage = Number(payload.recordsPerPage);
    const totalCount = Number(payload.totalcnt);
    const totalPages = Math.ceil(totalCount / recordsPerPage);
    if (!Number.isSafeInteger(currentPageNo) || currentPageNo < 1 || currentPageNo > 100_000
      || !Number.isSafeInteger(recordsPerPage) || recordsPerPage < 1 || recordsPerPage > 100
      || !Number.isSafeInteger(totalCount) || totalCount < 0 || totalCount > 1_000_000
      || (totalCount > 0 && currentPageNo > totalPages)) {
      return result([], false);
    }
    const items = [];
    let ambiguousCount = 0;
    for (const row of payload.listJsonData) {
      if (!row || Array.isArray(row) || typeof row !== 'object') {
        ambiguousCount += 1;
        continue;
      }
      const process = text(row.process).toUpperCase();
      if (process === 'END') continue;
      if (!['ING', 'INGEND', 'YET'].includes(process)) {
        ambiguousCount += 1;
        continue;
      }
      const title = text(row.program_nm);
      if (!CONTEST_POSITIVE.test(title) || CONTEST_EXCLUDED.test(title)) continue;
      const id = Number(row.contest_pk);
      if (!Number.isSafeInteger(id) || id < 1) {
        ambiguousCount += 1;
        continue;
      }
      const candidate = normalizeCandidate({
        title,
        organizer: boundedOrganizer(row.host_company || row.supervises_company, title),
        discoveryUrl: safeDiscoveryUrl(
          '/thinkgood/user/contest/view.do?contest_pk=' + id,
          pageUrl,
          source.allowedHosts,
        ),
      });
      if (candidate) items.push(candidate);
      else if (meaningfulCandidateShape({ title })) ambiguousCount += 1;
    }
    const parsed = result(items, true, ambiguousCount);
    parsed.coverageLimited = totalPages > THINKGOOD_MAX_PAGES;
    return parsed;
  }
  const $ = cheerio.load(body);
  const selector = 'a[href*="user/contest/view.do?contest_pk="]';
  const validAnchors = $(selector).filter((_, anchor) => /[?&]contest_pk=\d+(?:&|$)/u.test(
    $(anchor).attr('href') || '',
  ));
  const items = linkItems($, source, pageUrl, selector, {
    include: (_, anchor) => /[?&]contest_pk=\d+(?:&|$)/u.test($(anchor).attr('href') || ''),
  });
  let structuralCount = validAnchors.length;
  let ambiguousCount = invalidStructuralCount(
    $,
    selector,
    (_, anchor) => /[?&]contest_pk=\d+(?:&|$)/u.test($(anchor).attr('href') || ''),
    (anchor) => /(?:\[\[|\{\{)\s*contest_pk\s*(?:\]\]|\}\})/iu.test(
      $(anchor).attr('href') || '',
    ),
  );
  $('[data-contest_pk], [data-contest-pk]').each((_, anchor) => {
    const id = $(anchor).attr('data-contest_pk') || $(anchor).attr('data-contest-pk');
    if (/(?:\[\[|\{\{)\s*contest_pk\s*(?:\]\]|\}\})/iu.test(id || '')) return;
    if (!/^\d+$/u.test(id || '')) {
      ambiguousCount += 1;
      return;
    }
    structuralCount += 1;
    const title = titleFromAnchor($, anchor).replace(/^\d+\.\s*/u, '');
    const candidate = normalizeCandidate({
      title,
      organizer: inferredOrganizer(title),
      discoveryUrl: safeDiscoveryUrl(
        '/thinkgood/user/contest/view.do?contest_pk=' + id,
        pageUrl,
        source.allowedHosts,
      ),
    });
    if (candidate) items.push(candidate);
    else if (meaningfulCandidateShape({ title })) items[DROPPED_CANDIDATES] += 1;
  });
  return result(items, structuralCount > 0, ambiguousCount);
}

function parseWevity(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href*="gbn=view"][href*="ix="]';
  const valid = (_, anchor) => /[?&]ix=\d+(?:&|$)/u.test($(anchor).attr('href') || '');
  return result(
    linkItems($, source, pageUrl, selector, { include: valid }),
    $(selector).filter(valid).length > 0,
    invalidStructuralCount($, selector, valid),
  );
}

function parseGongmobox(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href*="/contest/"]';
  const valid = (_, anchor) => {
    try {
      const value = new URL($(anchor).attr('href') || '', pageUrl);
      return /^\/contest\/[^/?#]{1,240}\/?$/u.test(value.pathname);
    } catch { return false; }
  };
  const items = linkItems($, source, pageUrl, selector, {
    include: valid,
  });
  return result(
    items,
    $(selector).filter(valid).length > 0,
    invalidStructuralCount($, selector, valid, (anchor) => {
      try { return new URL($(anchor).attr('href') || '', pageUrl).pathname === '/contest/'; }
      catch { return false; }
    }),
  );
}

function parseLinkareer(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href^="/activity/"],a[href*="linkareer.com/activity/"]';
  const valid = (_, anchor) => /\/activity\/\d+\/?(?:[?#].*)?$/u.test(
    $(anchor).attr('href') || '',
  );
  const items = linkItems($, source, pageUrl, selector, {
    include: valid,
  });
  return result(
    items,
    $(selector).filter(valid).length > 0,
    invalidStructuralCount($, selector, valid, (anchor) => {
      try { return new URL($(anchor).attr('href') || '', pageUrl).pathname === '/activity/'; }
      catch { return false; }
    }),
  );
}

function parseCampus(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href*="/contest/view?id="]';
  const valid = (_, anchor) => /[?&]id=\d+(?:&|$)/u.test($(anchor).attr('href') || '');
  return result(
    linkItems($, source, pageUrl, selector, { include: valid }),
    $(selector).filter(valid).length > 0,
    invalidStructuralCount($, selector, valid)
      + (hasUnexpectedPaginationControls($) ? 1 : 0),
  );
}

function parseContestKorea(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href*="view.php"][href*="str_no="]';
  const valid = (_, anchor) => {
    try {
      const value = new URL($(anchor).attr('href') || '', pageUrl);
      const type = value.searchParams.get('int_gbn') || value.searchParams.get('Txt_gbn');
      return value.pathname === '/sub/view.php' && type === '1'
        && /^\d+$/u.test(value.searchParams.get('str_no') || '');
    } catch { return false; }
  };
  return result(linkItems($, source, pageUrl, selector, {
    include: valid,
  }), $(selector).filter(valid).length > 0, invalidStructuralCount(
    $,
    selector,
    valid,
    (anchor) => {
      try {
        const value = new URL($(anchor).attr('href') || '', pageUrl);
        const type = value.searchParams.get('int_gbn') || value.searchParams.get('Txt_gbn');
        return value.pathname === '/sub/view.php'
          && /^\d+$/u.test(type || '') && type !== '1';
      } catch { return false; }
    },
  ));
}

function parseAllcon(source, body, pageUrl) {
  if (new URL(pageUrl).pathname === '/page/ajax.contest_list.php') {
    let payload;
    try { payload = JSON.parse(body); } catch { return result([], false); }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object'
      || !Array.isArray(payload.rows)) return result([], false);
    const requestedPage = Number(new URL(pageUrl).searchParams.get('page'));
    const currentPage = Number(payload.currentPage);
    const perPage = Number(payload.perPage);
    const totalCount = Number(payload.totalCount);
    const totalPage = Number(payload.totalPage);
    const requestedRows = Number(new URL(pageUrl).searchParams.get('rows'));
    const advertisedTotalMatches = Number.isSafeInteger(totalCount)
      && Number.isSafeInteger(totalPage)
      && Number.isSafeInteger(perPage)
      && Number.isSafeInteger(requestedRows)
      && (totalCount === 0
        ? totalPage <= 1
        : [perPage, requestedRows].some((pageSize) => (
          pageSize >= 1 && pageSize <= 100
          && Math.ceil(totalCount / pageSize) === totalPage
        )));
    const paginationIsConsistent = Number.isSafeInteger(requestedPage) && requestedPage >= 1
      && Number.isSafeInteger(currentPage) && currentPage === requestedPage
      && Number.isSafeInteger(perPage) && perPage >= 1 && perPage <= 100
      && Number.isSafeInteger(requestedRows) && requestedRows >= 1 && requestedRows <= 100
      && Number.isSafeInteger(totalCount) && totalCount >= 0 && totalCount <= 100_000
      && Number.isSafeInteger(totalPage) && totalPage >= 0 && totalPage <= 10_000
      && requestedPage <= Math.max(1, totalPage)
      && advertisedTotalMatches;
    if (!paginationIsConsistent) return result([], false);
    const items = [];
    let dropped = 0;
    for (const row of payload.rows) {
      if (!row || Array.isArray(row) || typeof row !== 'object'
        || typeof row.cl_title !== 'string') {
        dropped += 1;
        continue;
      }
      const fragment = cheerio.load(row.cl_title);
      const anchor = fragment('a[href*="/view/contest/"],a[href*="/hit/contest/"]').first();
      const title = titleFromAnchor(fragment, anchor);
      const href = anchor.attr('href') || '';
      const kindMarkup = cheerio.load('<div id="competition-kind"></div>');
      kindMarkup('#competition-kind').html(String(row.cl_type_str || ''));
      kindMarkup('#competition-kind').find('script,style').remove();
      const kind = text(kindMarkup('#competition-kind').text());
      if (/(?:서포터즈|앰배서더|설명회)/u.test(title)
        || (kind && kind !== '공모전' && !CONTEST_POSITIVE.test(title))) continue;
      if (!/\/(?:view|hit)\/contest\/\d+/u.test(href)) {
        dropped += 1;
        continue;
      }
      const candidate = normalizeCandidate({
        title,
        organizer: (() => {
          const host = cheerio.load('<div id="competition-host"></div>');
          host('#competition-host').html(String(row.cl_host || ''));
          host('#competition-host').find('script,style').remove();
          return text(host('#competition-host').text()) || inferredOrganizer(title);
        })(),
        discoveryUrl: safeDiscoveryUrl(href, pageUrl, source.allowedHosts),
      });
      if (candidate) items.push(candidate);
      else dropped += 1;
    }
    const parsed = result(items, true, dropped);
    const type = new URL(pageUrl).searchParams.get('t');
    if (/^\d+$/u.test(type || '')) {
      const boundedTotal = Math.min(totalPage, ALLCON_MAX_PAGES_PER_TYPE);
      parsed.additionalPageUrls = Array.from(
        { length: Math.max(0, boundedTotal - 1) },
        (_, index) => {
          const next = new URL(pageUrl);
          next.searchParams.set('page', String(index + 2));
          return next.href;
        },
      );
      parsed.coverageLimited = totalPage > ALLCON_MAX_PAGES_PER_TYPE;
    } else {
      parsed.ambiguousCount += 1;
    }
    return parsed;
  }
  const $ = cheerio.load(body);
  const selector = 'a[href*="/view/contest/"],a[href*="/hit/contest/"]';
  const valid = (title, anchor) => /\/(?:view|hit)\/contest\/\d+/u.test(
    $(anchor).attr('href') || '',
  ) && !/(?:서포터즈|앰배서더|설명회)/u.test(title);
  const items = linkItems($, source, pageUrl, selector, {
    include: valid,
  });
  const structuralValid = (_, anchor) => /\/(?:view|hit)\/contest\/\d+/u.test(
    $(anchor).attr('href') || '',
  );
  return result(
    items,
    $(selector).filter(structuralValid).length > 0,
    invalidStructuralCount($, selector, structuralValid, (anchor) => {
      try {
        return /^\/(?:view|hit)\/contest\/?$/u.test(
          new URL($(anchor).attr('href') || '', pageUrl).pathname,
        );
      } catch { return false; }
    }),
  );
}

function parseStampit(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href*="/extraactivity/detail/"]';
  const valid = (_, anchor) => /\/extraactivity\/detail\/[A-Za-z0-9-]+\/?(?:[?#].*)?$/u.test(
    $(anchor).attr('href') || '',
  );
  const items = linkItems($, source, pageUrl, selector, {
    include: (_, anchor) => valid(_, anchor) && /공모전/u.test(text(
      $(anchor).closest('article,li,[class*="activityitem_item"]').text(),
    )),
    organizer: (title, anchor) => boundedOrganizer(
      $(anchor).closest('article,li,[class*="activityitem_item"]')
        .find('[class*="company"]').first().text(),
      title,
    ),
  });
  return result(
    items,
    $(selector).filter(valid).length > 0,
    invalidStructuralCount($, selector, valid, (anchor) => {
      try {
        return new URL($(anchor).attr('href') || '', pageUrl).pathname === '/extraactivity/detail/';
      } catch { return false; }
    }) + (
      $('[data-next-cursor],[data-next-page],[data-load-more]').length > 0
        || paginationPageCount($) > source.pageUrls.length
        ? 1
        : 0
    ),
  );
}

function strictGovernmentItems($, source, pageUrl, selector, organizer, isValidDetail) {
  const items = [];
  let ambiguousCount = 0;
  $(selector).each((_, anchor) => {
    const title = titleFromAnchor($, anchor);
    if (!CONTEST_POSITIVE.test(title)) return;
    if (CONTEST_EXCLUDED.test(title)) return;
    if (isValidDetail && !isValidDetail(anchor, $)) {
      ambiguousCount += 1;
      return;
    }
    const candidate = normalizeCandidate({
      title,
      organizer: organizer(title, anchor, $),
      discoveryUrl: safeDiscoveryUrl($(anchor).attr('href'), pageUrl, source.allowedHosts),
    });
    if (candidate) items.push(candidate);
    else ambiguousCount += 1;
  });
  return { items, ambiguousCount };
}

function parseBizinfo(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = 'a[href*="selectSIIA200Detail.do"][href*="pblancId="]';
  const parsed = strictGovernmentItems($, source, pageUrl, selector, (title, anchor) => {
    const row = $(anchor).closest('tr');
    const cells = row.find('td');
    const headers = row.closest('table').find('thead th').toArray()
      .map((header) => text($(header).text()));
    const operatorIndex = headers.findIndex((header) => header.includes('사업수행기관'));
    const operator = operatorIndex >= 0 ? text(cells.eq(operatorIndex).text()) : '';
    return operator || text(cells.length > 5 ? cells.eq(5).text() : cells.last().text())
      || inferredOrganizer(title);
  }, (anchor) => /[?&]pblancId=[A-Za-z0-9_-]{1,80}(?:&|$)/u.test(
    $(anchor).attr('href') || '',
  ));
  const officialEmpty = $('table').toArray().some((table) => {
    const tableNode = $(table);
    if (!text(tableNode.find('caption').first().text()).includes('지원사업 공고')) return false;
    return tableNode.find('tbody td[colspan="8"]').toArray().some((cell) =>
      text($(cell).text()) === '등록된 게시물이 없습니다.');
  });
  return result(parsed.items, $(selector).length > 0 || officialEmpty, parsed.ambiguousCount);
}

function parseKstartup(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const items = [];
  let ambiguousCount = 0;
  $('[onclick*="btnBizView"]').each((_, element) => {
    const title = titleFromAnchor($, element) || text($(element).closest('li').text());
    if (!CONTEST_POSITIVE.test(title)) return;
    if (CONTEST_EXCLUDED.test(title)) return;
    const id = ($(element).attr('onclick') || '').match(
      /btnBizView\(\s*['"]?(\d+)['"]?\s*(?:,|\))/u,
    )?.[1];
    if (!id) {
      ambiguousCount += 1;
      return;
    }
    const candidate = normalizeCandidate({
      title,
      organizer: inferredOrganizer(title),
      discoveryUrl: safeDiscoveryUrl(
        '/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=' + id,
        pageUrl,
        source.allowedHosts,
      ),
    });
    if (candidate) items.push(candidate);
    else ambiguousCount += 1;
  });
  return result(items, $('[onclick*="btnBizView"]').length > 0, ambiguousCount);
}

function parseEpeople(source, body, pageUrl) {
  const $ = cheerio.load(body);
  const selector = '.go_detail[data-idearegno],.go_detail[data-ideaRegNo]';
  const items = [];
  let ambiguousCount = 0;
  $(selector).each((_, anchor) => {
    const title = titleFromAnchor($, anchor);
    if (!CONTEST_POSITIVE.test(title)) return;
    if (CONTEST_EXCLUDED.test(title)) return;
    const id = $(anchor).attr('data-idearegno') || $(anchor).attr('data-ideaRegNo');
    if (!/^[A-Za-z0-9-]{8,40}$/u.test(id || '')) {
      ambiguousCount += 1;
      return;
    }
    const detail = new URL(pageUrl);
    detail.searchParams.set('ideaRegNo', id);
    const candidate = normalizeCandidate({
      title,
      // The live list can place multiple institution labels inside one broad list
      // container. Do not attach a neighbouring row's institution to this item;
      // official verification replaces this conservative placeholder later.
      organizer: inferredOrganizer(title),
      discoveryUrl: safeDiscoveryUrl(detail.href, pageUrl, source.allowedHosts),
    });
    if (candidate) items.push(candidate);
    else ambiguousCount += 1;
  });
  return result(items, $(selector).length > 0, ambiguousCount);
}

const bizinfoSearch = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do'
  + '?keyword=%EA%B3%B5%EB%AA%A8%EC%A0%84&condition=searchPblancNm&condition1=AND'
  + '&preKeywords=&hashCode=&rowsSel=6&rows=15&cpage=1&cat=&schJrsdCodeTy='
  + '&schWntyAt=&schAreaDetailCodes=&schEndAt=N&orderGb=&sort=&schPblancDiv=';

const thinkgoodApi = 'https://www.thinkcontest.com/thinkgood/user/contest/subList.do';
const thinkgoodRequests = Array.from({ length: THINKGOOD_MAX_PAGES }, (_, index) => ({
  url: thinkgoodApi,
  method: 'POST',
  headers: {
    accept: 'application/json, text/javascript, */*; q=0.01',
    'content-type': 'application/json; charset=UTF-8',
    'x-requested-with': 'XMLHttpRequest',
    origin: 'https://www.thinkcontest.com',
    referer: 'https://www.thinkcontest.com/thinkgood/user/contest/index.do',
  },
  body: JSON.stringify({
    recordsPerPage: 10,
    currentPageNo: index + 1,
    contest_field: '',
    host_organ: '',
    enter_qualified: '',
    award_size: '',
    searchStatus: 'Y',
    sidx: '',
    sord: '',
  }),
}));

export const SOURCE_DEFINITIONS = Object.freeze([
  {
    id: 'thinkgood', kind: 'listing', name: '씽굿',
    referenceUrl: 'https://www.thinkcontest.com/thinkgood/user/contest/index.do',
    pageUrls: ['https://www.thinkcontest.com/thinkgood/user/contest/index.do'],
    requests: thinkgoodRequests,
    coverageLimited: true,
    allowedHosts: ['www.thinkcontest.com', 'thinkcontest.com'], parsePage: parseThinkgood,
  },
  {
    id: 'wevity', kind: 'listing', name: '위비티',
    referenceUrl: 'https://www.wevity.com/?c=find&s=1&gub=1',
    pageUrls: [
      'https://www.wevity.com/?c=find&s=1&gub=1&gp=1',
      'https://www.wevity.com/?c=find&s=1&gub=1&gp=2',
      'https://www.wevity.com/?c=find&s=1&gub=1&gp=3',
      'https://www.wevity.com/?c=find&s=1&gub=1&gp=4',
      'https://www.wevity.com/?c=find&s=1&gub=1&gp=5',
    ],
    allowedHosts: ['www.wevity.com', 'wevity.com'], parsePage: parseWevity,
  },
  {
    id: 'gongmobox', kind: 'listing', name: '공모박스',
    referenceUrl: 'https://gongmobox.com/contest/',
    pageUrls: [
      'https://gongmobox.com/',
      'https://gongmobox.com/contest/?ccat=idea',
      'https://gongmobox.com/contest/?ccat=design-art',
      'https://gongmobox.com/contest/?ccat=video-media',
      'https://gongmobox.com/contest/?ccat=it-ai',
      'https://gongmobox.com/contest/?ccat=writing',
      'https://gongmobox.com/contest/?ccat=etc',
    ],
    allowedHosts: ['gongmobox.com', 'www.gongmobox.com'], parsePage: parseGongmobox,
  },
  {
    id: 'linkareer', kind: 'listing', name: '링커리어',
    referenceUrl: 'https://linkareer.com/list/contest',
    pageUrls: [
      'https://linkareer.com/list/contest?page=1',
      'https://linkareer.com/list/contest?page=2',
      'https://linkareer.com/list/contest?page=3',
      'https://linkareer.com/list/contest?page=4',
      'https://linkareer.com/list/contest?page=5',
    ],
    allowedHosts: ['linkareer.com', 'www.linkareer.com'], parsePage: parseLinkareer,
  },
  {
    id: 'campuspick', kind: 'listing', name: '캠퍼스픽',
    referenceUrl: 'https://www.campuspick.com/contest',
    pageUrls: ['https://www.campuspick.com/contest'],
    allowedHosts: ['www.campuspick.com', 'campuspick.com'], parsePage: parseCampus,
  },
  {
    id: 'everycareer', kind: 'listing', name: '에브리커리어(캠퍼스픽)',
    referenceUrl: 'https://www2.campuspick.com/contest',
    pageUrls: ['https://www2.campuspick.com/contest'],
    allowedHosts: ['www2.campuspick.com', 'www.campuspick.com', 'campuspick.com'],
    parsePage: parseCampus,
  },
  {
    id: 'contestkorea', kind: 'listing', name: '콘테스트코리아',
    referenceUrl: 'https://www.contestkorea.com/sub/list.php?int_gbn=1',
    pageUrls: [
      'https://www.contestkorea.com/sub/list.php?displayrow=500&int_gbn=1'
      + '&Txt_sGn=1&Txt_key=all&Txt_word=&Txt_sortkey=a.int_sort&Txt_sortword=desc&page=1',
    ],
    coverageLimited: true,
    allowedHosts: ['www.contestkorea.com', 'contestkorea.com'], parsePage: parseContestKorea,
  },
  {
    id: 'allcon', kind: 'listing', name: '올콘',
    referenceUrl: 'https://www.all-con.co.kr/',
    pageUrls: [
      'https://www.all-con.co.kr/',
      ...Array.from({ length: 6 }, (_, typeIndex) =>
        `https://www.all-con.co.kr/page/ajax.contest_list.php?page=1&rows=15&t=${typeIndex + 1}`),
    ],
    allowedHosts: ['www.all-con.co.kr', 'all-con.co.kr'], parsePage: parseAllcon,
  },
  {
    id: 'stampit', kind: 'listing', name: '스탬플릿',
    referenceUrl: 'https://stampit.co.kr/activities',
    pageUrls: Array.from({ length: 17 }, (_, index) =>
      `https://stampit.co.kr/activities?page=${index + 1}`),
    allowedHosts: ['stampit.co.kr', 'www.stampit.co.kr'], parsePage: parseStampit,
  },
  {
    id: 'bizinfo', kind: 'official', name: '기업마당',
    referenceUrl: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do',
    pageUrls: Array.from({ length: 5 }, (_, index) =>
      bizinfoSearch.replace('cpage=1', `cpage=${index + 1}`)),
    allowedHosts: ['www.bizinfo.go.kr', 'bizinfo.go.kr'], parsePage: parseBizinfo,
  },
  {
    id: 'kstartup', kind: 'official', name: 'K-Startup',
    referenceUrl: 'https://www.k-startup.go.kr/web/main/mainSectionChNaviList.do',
    pageUrls: ['https://www.k-startup.go.kr/web/main/mainSectionChNaviList.do'],
    coverageLimited: true,
    allowedHosts: ['www.k-startup.go.kr', 'k-startup.go.kr'], parsePage: parseKstartup,
  },
  {
    id: 'epeople', kind: 'official', name: '국민생각함',
    referenceUrl: 'https://idea.epeople.go.kr/nep/thk/subj/SubjThinkList.npaid',
    pageUrls: Array.from({ length: EPEOPLE_MAX_PAGES }, (_, index) =>
      `https://idea.epeople.go.kr/nep/thk/subj/SubjThinkList.npaid?pageIndex=${index + 1}`),
    coverageLimited: true,
    allowedHosts: ['idea.epeople.go.kr', 'www.epeople.go.kr'], parsePage: parseEpeople,
  },
]);

export function parseCompetitionSourcePage(source, body, pageUrl) {
  if (!source || typeof source.parsePage !== 'function') {
    throw new TypeError('source parser is required');
  }
  return source.parsePage(source, body, pageUrl);
}
