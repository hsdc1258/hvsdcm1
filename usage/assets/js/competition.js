(() => {
  'use strict';

  const STALE_SCAN_MS = 30 * 60 * 60 * 1000;
  const AUTO_REFRESH_MS = 30 * 60 * 1000;

  const STATUS_LABELS = {
    watching: '살펴보는 중',
    verifying: '검증 중',
    preparing: '지원 준비',
    'awaiting-approval': '승인 대기',
    approved: '승인됨',
    applied: '지원 완료',
    blocked: '막힘',
    closed: '종료',
    unknown: '수집 범위 확인 필요',
  };
  const ELIGIBILITY_LABELS = {
    eligible: '지원 가능', qualified: '지원 가능', yes: '지원 가능',
    review: '확인 필요', maybe: '확인 필요', conditional: '확인 필요',
    ineligible: '지원 불가', no: '지원 불가',
    unknown: '미확인',
  };
  const FEE_LABELS = {
    free: '무료',
    paid: '유료',
    unknown: '미확인',
  };
  const PARTICIPATION_LABELS = {
    none: '추가 일정 없음',
    online_only: '온라인만',
    offline_required: '대면·현장 필수',
    unknown: '미확인',
  };
  const COVERAGE_LABELS = {
    success: '성공',
    failed: '실패', error: '실패',
    partial: '부분',
    unknown: '미확인',
  };
  const STATUS_KEYS = {
    watching: 'watching', review: 'watching', discovered: 'watching', new: 'watching',
    verifying: 'verifying', validating: 'verifying', checking: 'verifying', eligibility: 'verifying',
    'source-verified': 'verifying',
    preparing: 'preparing', draft: 'preparing', ready: 'preparing', qualified: 'preparing',
    active: 'preparing', eligible: 'preparing', prepared: 'preparing', validated: 'preparing',
    'awaiting-approval': 'awaiting-approval', awaitingapproval: 'awaiting-approval',
    'waiting-approval': 'awaiting-approval', 'waiting-user-approval': 'awaiting-approval',
    'pending-approval': 'awaiting-approval',
    'waiting-artifacts': 'preparing',
    'waiting-deadline-clarification': 'blocked', 'waiting-identity': 'blocked',
    'waiting-eligibility': 'blocked', 'waiting-clarification': 'blocked',
    'waiting-legal-consent': 'blocked', 'waiting-rights-approval': 'blocked',
    'waiting-fee-approval': 'blocked',
    approved: 'approved', accepted: 'approved', authorized: 'approved',
    applied: 'applied', submitted: 'applied', complete: 'applied', completed: 'applied',
    submitting: 'preparing',
    blocked: 'blocked', paused: 'blocked', deferred: 'blocked', needsaction: 'blocked',
    'needs-action': 'blocked', 'submission-unknown': 'blocked',
    closed: 'closed', archived: 'closed', expired: 'closed', rejected: 'closed',
    unknown: 'unknown',
  };
  const ELIGIBILITY_KEYS = {
    eligible: 'eligible', qualified: 'eligible', yes: 'eligible', true: 'eligible',
    review: 'review', maybe: 'review', conditional: 'review',
    ineligible: 'ineligible', no: 'ineligible', false: 'ineligible',
    unknown: 'unknown',
  };
  const COVERAGE_KEYS = {
    success: 'success', ok: 'success', complete: 'success', completed: 'success', 'no-results': 'success',
    failed: 'failed', error: 'failed',
    partial: 'partial', incomplete: 'partial', pending: 'partial', unknown: 'unknown',
  };
  const RISK_LABELS = {
    unknown: '미확인',
    low: '낮음',
    medium: '중간',
    high: '높음',
    blocked: '차단됨',
  };
  const BLOCKER_LABELS = {
    none: '',
    official_verification: '공식 공고 검증 필요',
    eligibility: '지원 자격 확인 필요',
    deadline: '마감 확인 필요',
    rights: '권리 조건 확인 필요',
    submission: '제출 조건 확인 필요',
    artifacts: '제출물 준비 필요',
    account: '제출 계정 준비 필요',
    consent: '필수 동의 확인 필요',
    payment: '결제 조건 확인 필요',
    user_approval: '사용자 승인 필요',
    other: '기타 차단 요인',
  };
  const NEXT_ACTION_LABELS = {
    none: '기록된 다음 행동 없음',
    verify_official_source: '공식 공고 확인',
    verify_eligibility: '지원 자격 확인',
    review_rights: '권리 조건 검토',
    review_submission: '제출 조건 검토',
    prepare_artifacts: '제출물 준비',
    draft_application: '지원서 초안 작성',
    stage_form: '제출 양식 준비',
    request_approval: '사용자 승인 요청',
    manual_check: '수동 확인',
    hold: '보류',
  };
  const SOURCE_FAILURE_LABELS = {
    none: '',
    timeout: '시간 초과',
    http_403: '접근 거부',
    http_404: '찾을 수 없음',
    rate_limited: '요청 제한',
    network: '네트워크 오류',
    invalid_response: '잘못된 응답',
    parse_error: '응답 해석 실패',
    unknown: '수집 범위 제한',
  };
  const SOURCE_KIND_LABELS = {
    listing: '공고 목록',
    official: '공식 원본',
    search: '검색 결과',
  };
  const RECENCY_LABELS = {
    new: '신규',
    recent: '최근',
    stale: '오래됨',
  };
  const OFFICIAL_VERIFICATION_KEYS = {
    verified: 'verified',
    unverified: 'unverified',
    'not-found': 'not-found',
    failed: 'failed',
    unknown: 'unknown',
  };
  const OFFICIAL_VERIFICATION_LABELS = {
    verified: '검증됨',
    unverified: '미검증',
    'not-found': '공식 공고 미발견',
    failed: '검증 실패',
    unknown: '미확인',
  };
  const APPROVAL_KIND_LABELS = {
    preparation: '준비 승인',
    legal_consent: '법적 동의 승인',
    rights_acceptance: '권리 조건 승인',
    payment: '결제 승인',
    final_submission: '최종 제출 승인',
  };
  const APPROVAL_KIND_BOUNDARIES = {
    preparation: '준비 승인은 개인정보 입력·서명·법적 동의·결제·전송·최종 제출을 포함하지 않습니다.',
    legal_consent: '이 승인은 카드에 적힌 정확한 법적·개인정보 동의만 허용합니다. 문구, 계정 또는 action hash가 바뀌면 새 승인이 필요하며 서명·결제·전송·최종 제출은 포함하지 않습니다.',
    rights_acceptance: '이 승인은 카드에 적힌 정확한 저작권·이용권 조건 수락만 허용합니다. 조건 또는 action hash가 바뀌면 새 승인이 필요하며 개인정보·서명·결제·최종 제출은 포함하지 않습니다.',
    payment: '이 승인은 카드에 적힌 수취처·금액·통화의 결제 1회만 허용합니다. 어느 값이나 action hash가 바뀌거나 유효 시간이 지나면 새 승인이 필요하며 최종 제출은 포함하지 않습니다.',
    final_submission: '이 승인은 카드 요약과 action hash에 묶인 계정·파일·입력 항목의 최종 제출 1회만 허용합니다. 내용, 대상 또는 파일이 바뀌거나 유효 시간이 지나면 새 승인이 필요합니다.',
  };
  const APPROVAL_STATUS_LABELS = {
    pending: '승인 대기',
    approved: '승인됨',
    held: '보류됨',
    expired: '만료됨',
  };

  const escapeHtml = (value) => String(value ?? '').replace(
    /[&<>"']/gu,
    (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character],
  );

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function array(value) {
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).map(([key, item]) => (
      item && typeof item === 'object' ? { _key: key, ...item } : { _key: key, value: item }
    ));
  }

  function first(...values) {
    return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  }

  function text(value) {
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
    if (value && typeof value === 'object') {
      return text(first(value.label, value.name, value.summary, value.text, value.description));
    }
    return String(value ?? '').trim();
  }

  function stringList(value) {
    if (Array.isArray(value)) return value.map(text).filter(Boolean);
    const one = text(value);
    return one ? [one] : [];
  }

  function number(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return null;
  }

  function boundedScore(value) {
    const parsed = number(value);
    return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : null;
  }

  function time(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function day(value) {
    const parsed = time(value);
    if (parsed === null) return '';
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' }).format(parsed);
  }

  function dateTime(value) {
    const parsed = time(value);
    if (parsed === null) return '미확인';
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
    }).format(parsed);
  }

  function relative(value, now) {
    const parsed = time(value);
    if (parsed === null) return '미확인';
    const minutes = Math.max(0, Math.round((now - parsed) / 60_000));
    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
  }

  function safeUrl(value) {
    const raw = text(value);
    if (!raw) return '';
    try {
      const url = new URL(raw, location?.href || 'https://hvsdcm1.xyz/usage/');
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function firstSafeUrl(...values) {
    for (const value of values) {
      const url = safeUrl(value);
      if (url) return url;
    }
    return '';
  }

  function enumKey(value, aliases) {
    const key = text(value).toLowerCase().replace(/[\s_]+/gu, '-');
    return aliases[key] || 'unknown';
  }

  function codedLabel(value, labels, missing = '미확인') {
    const original = text(value);
    if (!original) return missing;
    const key = original.toLowerCase().replace(/[\s-]+/gu, '_');
    if (Object.prototype.hasOwnProperty.call(labels, key)) return labels[key];
    // enum처럼 생긴 한 토큰은 새 서버 코드일 수 있다. 그대로 노출해 의미를 지어내지 않고
    // 미확인으로 닫는다. 사람이 쓴 설명문(공백·한글·문장부호 포함)은 그대로 보존한다.
    return /^[a-z0-9_]+$/iu.test(original) ? missing : original;
  }

  function normalizeBlockers(value) {
    if (value === undefined || value === null || value === '') return [];
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((entry) => {
      const label = codedLabel(entry, BLOCKER_LABELS);
      return label ? [label] : [];
    });
  }

  function applicationKey(source, fallbackId = '') {
    const entry = object(source);
    const id = text(first(entry.competition_id, entry.contest_id, entry.candidate_id, entry.id, fallbackId));
    const category = text(entry.category);
    return category ? `${id}\u0000${category}` : id;
  }

  function normalizeApproval(entry) {
    const source = object(entry);
    const requestId = text(source.request_id);
    const actionSha256 = text(source.action_sha256).toLowerCase();
    if (!requestId || !/^[a-f0-9]{64}$/u.test(actionSha256)) return null;
    const rawKind = text(source.kind).toLowerCase();
    const rawStatus = text(source.status).toLowerCase();
    return {
      requestId,
      kind: Object.prototype.hasOwnProperty.call(APPROVAL_KIND_LABELS, rawKind) ? rawKind : 'unknown',
      actionSha256,
      requestedAt: source.requested_at,
      expiresAt: source.expires_at,
      readSummary: text(source.read_summary),
      approvalText: text(source.approval_text),
      status: Object.prototype.hasOwnProperty.call(APPROVAL_STATUS_LABELS, rawStatus) ? rawStatus : 'expired',
      decidedAt: source.decided_at,
    };
  }

  function normalizeApplication(entry, fallbackId = '') {
    const source = object(entry);
    const approval = normalizeApproval(source.approval);
    const reportedStatus = enumKey(first(source.state, source.status, source.stage), STATUS_KEYS);
    const status = approval?.status === 'pending'
      ? 'awaiting-approval'
      : approval?.status === 'approved'
        ? 'approved'
        : approval?.status === 'held' || approval?.status === 'expired'
          ? 'blocked'
          : reportedStatus;
    const blockerFields = ['blockers', 'blocker', 'missing', 'issues'];
    const nextAction = first(source.next_action, source.next, source.action);
    return {
      id: text(first(source.competition_id, source.contest_id, source.candidate_id, source.id, fallbackId)),
      category: text(source.category),
      status,
      blockers: normalizeBlockers(first(source.blockers, source.blocker, source.missing, source.issues)),
      blockersKnown: blockerFields.some((key) => Object.prototype.hasOwnProperty.call(source, key)),
      nextAction: nextAction ? codedLabel(nextAction, NEXT_ACTION_LABELS) : '',
      updatedAt: first(source.updated_at, source.changed_at, source.at),
      approval,
    };
  }

  function normalizeSource(entry) {
    const source = object(entry);
    const status = enumKey(first(source.status, source.outcome, source.result), COVERAGE_KEYS);
    const failureCode = text(source.failure_code);
    return {
      id: text(first(source.id, source.key, source._key, source.name, source.label)),
      name: text(first(source.name, source.label, source.source, source._key)) || '이름 없는 원본',
      kind: codedLabel(source.kind, SOURCE_KIND_LABELS),
      referenceUrl: firstSafeUrl(source.reference_url),
      status,
      checkedAt: first(source.checked_at, source.scanned_at, source.updated_at, source.at),
      found: number(first(source.found, source.count, source.discovered, source.candidate_count)),
      error: text(first(source.error, source.message, source.reason)),
      failureCode: failureCode ? codedLabel(failureCode, SOURCE_FAILURE_LABELS) : '',
      manualCheck: source.manual_check === true
        ? '필요'
        : source.manual_check === false ? '불필요' : text(source.manual_check),
    };
  }

  function normalizeRun(entry) {
    const run = object(entry);
    const counts = object(first(run.counts, run.summary));
    return {
      id: text(first(run.id, run.run_id, run._key)),
      at: first(run.finished_at, run.completed_at, run.scanned_at, run.started_at, run.at, run.date),
      status: enumKey(first(run.status, run.outcome, run.result), COVERAGE_KEYS),
      found: number(first(run.found, run.discovered, counts.found, counts.discovered, counts.total)),
      eligible: number(first(run.eligible, counts.eligible, counts.qualified)),
      error: text(first(run.error, run.message, run.reason)),
    };
  }

  function normalizeCandidate(entry, applications, sourcesById) {
    const source = object(entry);
    const organizer = object(source.organizer);
    const discovery = object(first(source.discovery, source.discovery_source, source.source));
    const eligibility = object(source.eligibility);
    const risk = object(first(source.risk, source.risks));
    const id = text(first(source.id, source.contest_id, source.candidate_id, source.competition_id, source.slug, source._key));
    const category = text(source.category);
    const embeddedApplication = first(source.application, source.application_state);
    const application = applications.get(applicationKey({ contest_id: id, category }))
      || (!category ? applications.get(id) : null)
      || normalizeApplication(embeddedApplication, id);
    const status = application.status !== 'unknown'
      ? application.status
      : enumKey(first(source.status, source.state), STATUS_KEYS);
    const eligibilityStatus = enumKey(
      first(eligibility.status, eligibility.result, source.eligibility_status, source.eligibility, source.eligible),
      ELIGIBILITY_KEYS,
    );
    const rawEligibility = text(source.eligibility);
    const eligibilityDescription = text(first(
      eligibility.summary, eligibility.text, eligibility.requirements,
      source.eligibility_summary, source.eligibility_text, source.eligibility_description,
    )) || (rawEligibility && eligibilityStatus === 'unknown' && rawEligibility.toLowerCase() !== 'unknown'
      ? rawEligibility
      : '');
    const sourceName = sourcesById.get(text(source.source_id))?.name || '';
    const officialVerification = enumKey(source.official_verification, OFFICIAL_VERIFICATION_KEYS);
    const rawFeeStatus = text(source.fee_status).toLowerCase();
    const feeStatus = Object.prototype.hasOwnProperty.call(FEE_LABELS, rawFeeStatus) ? rawFeeStatus : 'unknown';
    const rawParticipationMode = text(source.participation_mode).toLowerCase();
    const participationMode = Object.prototype.hasOwnProperty.call(PARTICIPATION_LABELS, rawParticipationMode)
      ? rawParticipationMode
      : 'unknown';
    return {
      id,
      category,
      title: text(first(source.title, source.name, source.competition_name)) || '이름 없는 공모전',
      organizer: text(first(organizer.name, source.organizer_name, source.organizer)) || '주최기관 미확인',
      officialUrl: firstSafeUrl(
        source.official_url, source.rules_url, source.organizer_url, organizer.url, organizer.official_url,
      ),
      officialVerification,
      officialVerifiedAt: first(source.official_verified_at, source.official_checked_at),
      discoveryName: text(first(
        discovery.name, discovery.label, source.discovery_source_name, source.source_name, sourceName,
      )) || '발견 경로 미확인',
      discoveryUrl: firstSafeUrl(discovery.url, source.discovery_url, source.source_url),
      eligibilityStatus,
      eligibility: eligibilityDescription,
      feeStatus,
      feeLabel: FEE_LABELS[feeStatus],
      participationMode,
      participationLabel: PARTICIPATION_LABELS[participationMode],
      deadline: first(source.deadline, source.deadline_at, source.closes_at, source.due_at, source.end_at, source.application_deadline),
      status,
      recency: codedLabel(source.recency, RECENCY_LABELS),
      fitScore: boundedScore(source.fit_score),
      effortScore: boundedScore(source.effort_score),
      rightsRisk: codedLabel(
        first(risk.rights, source.rights_risk, source.rights, source.ip_terms), RISK_LABELS,
        '권리 조건 미확인',
      ),
      submissionRisk: codedLabel(
        first(risk.submission, source.submission_risk, source.submission_requirements), RISK_LABELS,
        '제출 조건 미확인',
      ),
      partial: Boolean(source.partial || source.incomplete || source.error),
      application,
      hasApplication: applications.has(applicationKey({ contest_id: id, category }))
        || (!category && applications.has(id)) || Boolean(embeddedApplication),
    };
  }

  function normalizePayload(payload) {
    const outer = object(payload);
    const root = object(first(outer.data, outer.result, outer.payload, outer));
    // 초기 보고 API는 각 run wrapper 안에 현재 후보·원본·지원 상태를 함께 넣었다. 최종
    // 계약은 같은 배열을 최상위에 두지만, 배포 순서가 엇갈려도 가장 최신 wrapper를 읽는다.
    const rawRuns = array(root.runs);
    const reportWrappers = rawRuns.filter((entry) => Object.keys(object(entry.run)).length > 0)
      .sort((left, right) => (
        time(first(right.run?.finished_at, right.received_at, right.run?.started_at)) ?? 0
      ) - (time(first(left.run?.finished_at, left.received_at, left.run?.started_at)) ?? 0));
    const current = reportWrappers[0] || root;
    const latest = object(first(current.latest, current.latest_scan, current.run, root.latest, root.latest_scan));
    const summary = object(first(root.summary, current.summary, latest.summary, latest));
    const applicationEntries = array(first(
      current.applications, root.applications, root.application_states, root.application_board,
    ));
    const applicationRecords = applicationEntries.map((entry) => ({
      key: applicationKey(entry, entry._key),
      value: normalizeApplication(entry, entry._key),
    })).filter((entry) => entry.key);
    const applications = new Map(applicationRecords.map((entry) => [entry.key, entry.value]));
    const sources = array(first(current.sources, root.sources, root.coverage, summary.sources)).map(normalizeSource);
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const candidates = array(first(current.candidates, root.candidates, root.contests, root.items, root.opportunities))
      .map((entry) => normalizeCandidate(entry, applications, sourcesById));
    const runs = reportWrappers.length
      ? reportWrappers.map((entry) => normalizeRun({
        ...object(entry.run), found: array(entry.candidates).length,
      }))
      : array(first(root.runs, root.scans, root.timeline, root.history)).map(normalizeRun);
    const latestAt = first(
      summary.latest_scan_at, summary.scanned_at, summary.completed_at,
      latest.finished_at, latest.completed_at, latest.scanned_at, current.received_at,
      runs.map((run) => run.at).filter(Boolean).sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0))[0],
    );
    const today = object(first(summary.today, root.today, root.counts_today));
    const errors = stringList(first(root.errors, summary.errors, outer.errors));
    const partial = Boolean(
      root.partial || summary.partial || errors.length
      || sources.some((source) => ['failed', 'partial'].includes(source.status))
      || candidates.some((candidate) => candidate.partial),
    );
    return {
      latestAt,
      today: {
        discovered: number(first(today.discovered, today.found, today.new, summary.today_discovered)),
        verified: number(first(today.verified, today.validated, today.checked, summary.today_verified)),
        preparing: number(first(today.preparing, today.prepared, today.ready, summary.today_preparing)),
        awaitingApproval: number(first(
          today.awaiting_approval, today.pending_approval, today.approval_pending, summary.today_awaiting_approval,
        )),
        deadlineSoon: number(first(today.deadline_soon, today.due_soon, today.closing_soon, summary.today_deadline_soon)),
      },
      sources,
      runs: runs.sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0)).slice(0, 8),
      candidates,
      applications: [
        ...applicationRecords.map(({ key, value }) => {
          const candidate = candidates.find((entry) => applicationKey({
            contest_id: entry.id, category: entry.category,
          }) === key);
          return {
            ...value,
            title: candidate?.title || [value.id, value.category].filter(Boolean).join(' · ') || '이름 없는 지원',
          };
        }),
        ...candidates.filter((candidate) => candidate.hasApplication
          && !applications.has(applicationKey({ contest_id: candidate.id, category: candidate.category })))
          .map((candidate) => ({
            ...candidate.application,
            id: candidate.id,
            category: candidate.category,
            title: candidate.title,
          })),
      ],
      partial,
      errors,
    };
  }

  function deadlineBucket(candidate, now) {
    const deadline = time(candidate.deadline);
    if (deadline === null) return 'unknown';
    const days = (deadline - now) / 86_400_000;
    if (days < 0) return 'overdue';
    if (days <= 7) return '7d';
    if (days <= 30) return '30d';
    return 'later';
  }

  function deadlineExpired(deadline, now) {
    const instant = time(deadline);
    return instant !== null && now >= instant;
  }

  function applicationAtDeadline(application, deadline, now) {
    if (!deadlineExpired(deadline, now) || ['applied', 'closed'].includes(application.status)) {
      return application;
    }
    return {
      ...application,
      status: 'closed',
      blockers: [...new Set([...application.blockers, '마감 지남'])],
      blockersKnown: true,
      nextAction: '마감 지남 · 추가 진행 금지',
      deadlineExpired: true,
    };
  }

  function candidateAtDeadline(candidate, now) {
    if (!deadlineExpired(candidate.deadline, now)) return candidate;
    return {
      ...candidate,
      status: 'closed',
      deadlineExpired: true,
      application: applicationAtDeadline(candidate.application, candidate.deadline, now),
    };
  }

  function currentStatusCount(reported, rawItems, currentItems, status) {
    const current = currentItems.filter((item) => item.status === status).length;
    if (reported === null || reported === undefined) return current;
    const raw = rawItems.filter((item) => item.status === status).length;
    return Math.max(0, reported - Math.max(0, raw - current));
  }

  function filterCandidates(candidates, filters = {}, now = Date.now()) {
    const query = text(filters.search).toLocaleLowerCase('ko-KR');
    const status = text(filters.status) || 'all';
    const eligibility = text(filters.eligibility) || 'all';
    const official = text(filters.official) || 'all';
    const fee = text(filters.fee) || 'all';
    const participation = text(filters.participation) || 'all';
    const deadline = text(filters.deadline) || 'all';
    const result = candidates.map((candidate) => candidateAtDeadline(candidate, now)).filter((candidate) => {
      const haystack = [candidate.title, candidate.organizer, candidate.eligibility, candidate.discoveryName]
        .join(' ').toLocaleLowerCase('ko-KR');
      return (!query || haystack.includes(query))
        && (status === 'all' || candidate.status === status)
        && (eligibility === 'all' || candidate.eligibilityStatus === eligibility)
        && (official === 'all'
          || candidate.officialVerification === official
          || (official === 'needs-review' && candidate.officialVerification !== 'verified'))
        && (fee === 'all' || candidate.feeStatus === fee)
        && (participation === 'all' || candidate.participationMode === participation)
        && (deadline === 'all' || deadlineBucket(candidate, now) === deadline);
    });
    if (!filters.sort || filters.sort === 'priority') {
      const participationRank = { none: 0, online_only: 1, offline_required: 2, unknown: 3 };
      return result.sort((left, right) => {
        const feeDifference = (left.feeStatus === 'free' ? 0 : 1) - (right.feeStatus === 'free' ? 0 : 1);
        if (feeDifference) return feeDifference;
        const modeDifference = participationRank[left.participationMode] - participationRank[right.participationMode];
        if (modeDifference) return modeDifference;
        const fitDifference = (right.fitScore ?? -1) - (left.fitScore ?? -1);
        if (fitDifference) return fitDifference;
        const effortDifference = (left.effortScore ?? 101) - (right.effortScore ?? 101);
        if (effortDifference) return effortDifference;
        const leftTime = time(left.deadline) ?? Number.POSITIVE_INFINITY;
        const rightTime = time(right.deadline) ?? Number.POSITIVE_INFINITY;
        return leftTime - rightTime || left.title.localeCompare(right.title, 'ko');
      });
    }
    const direction = filters.sort === 'deadline-desc' ? -1 : 1;
    return result.sort((left, right) => {
      const leftTime = time(left.deadline);
      const rightTime = time(right.deadline);
      if (leftTime === null && rightTime === null) return left.title.localeCompare(right.title, 'ko');
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return (leftTime - rightTime) * direction;
    });
  }

  function tone(key) {
    if (['failed', 'ineligible', 'closed', 'overdue', 'blocked'].includes(key)) return ' is-danger';
    if (['partial', 'review', 'watching', 'verifying', 'awaiting-approval', 'unverified', 'not-found', 'unknown'].includes(key)) return ' is-warn';
    if (['success', 'eligible', 'preparing', 'approved', 'applied'].includes(key)) return ' is-good';
    return '';
  }

  function link(url, label, className = '') {
    return url
      ? `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`
      : `<span class="cp-missing">${escapeHtml(label)} 없음</span>`;
  }

  function approvalStatusAt(approval, now) {
    if (!approval) return 'expired';
    if (approval.status !== 'pending') return approval.status;
    const expiresAt = time(approval.expiresAt);
    return expiresAt !== null && expiresAt <= now ? 'expired' : 'pending';
  }

  function renderApprovalInbox(applications, candidates, now) {
    const candidatesByKey = new Map(candidates.map((candidate) => [
      applicationKey({ contest_id: candidate.id, category: candidate.category }), candidate,
    ]));
    const rows = applications.map((application) => ({
      application,
      candidate: candidatesByKey.get(applicationKey(application))
        || candidates.find((candidate) => candidate.id === application.id),
      status: approvalStatusAt(application.approval, now),
    })).filter((entry) => entry.application.approval).sort((left, right) => {
      const rank = { pending: 0, approved: 1, held: 2, expired: 3 };
      const statusOrder = (rank[left.status] ?? 4) - (rank[right.status] ?? 4);
      if (statusOrder) return statusOrder;
      return (time(left.candidate?.deadline) ?? Number.MAX_SAFE_INTEGER)
        - (time(right.candidate?.deadline) ?? Number.MAX_SAFE_INTEGER);
    });
    const pending = rows.filter((entry) => entry.status === 'pending').length;
    const cards = rows.length ? rows.map(({ application, candidate, status }) => {
      const approval = application.approval;
      const title = candidate?.title || application.title || application.id || '이름 없는 지원';
      const kind = APPROVAL_KIND_LABELS[approval.kind] || '승인 유형 미확인';
      const boundary = APPROVAL_KIND_BOUNDARIES[approval.kind]
        || '승인 유형을 확인할 수 없어 진행할 수 없습니다. 새 승인 요청이 필요합니다.';
      const controls = status === 'pending' && Object.prototype.hasOwnProperty.call(APPROVAL_KIND_BOUNDARIES, approval.kind)
        ? `<div class="cp-approval-actions">
            <button class="btn btn-primary" type="button" data-competition-approval-decision="approved" data-request-id="${escapeHtml(approval.requestId)}" data-action-sha256="${escapeHtml(approval.actionSha256)}">${escapeHtml(kind)}</button>
            <button class="btn btn-secondary" type="button" data-competition-approval-decision="held" data-request-id="${escapeHtml(approval.requestId)}" data-action-sha256="${escapeHtml(approval.actionSha256)}">보류</button>
          </div>`
        : `<p class="cp-approval-result"><strong>${escapeHtml(APPROVAL_STATUS_LABELS[status] || '처리 상태 미확인')}</strong>${approval.decidedAt ? ` · ${escapeHtml(dateTime(approval.decidedAt))}` : ''}</p>`;
      return `<article class="cp-approval-card${status === 'pending' ? ' is-pending' : ''}">
        <header>
          <div><p class="us-eyebrow">${escapeHtml(candidate?.organizer || '주최기관 미확인')}</p><h3>${escapeHtml(title)}</h3></div>
          <span class="cp-state${tone(status === 'pending' ? 'awaiting-approval' : status === 'approved' ? 'approved' : 'blocked')}">${escapeHtml(APPROVAL_STATUS_LABELS[status] || '미확인')}</span>
        </header>
        <dl class="cp-approval-facts">
          <div><dt>승인 종류</dt><dd>${escapeHtml(kind)}</dd></div>
          <div><dt>마감</dt><dd>${escapeHtml(candidate?.deadline ? dateTime(candidate.deadline) : '미확인')}</dd></div>
          <div><dt>지원 자격</dt><dd>${escapeHtml(ELIGIBILITY_LABELS[candidate?.eligibilityStatus] || ELIGIBILITY_LABELS.unknown)}</dd></div>
          <div><dt>지원 비용</dt><dd>${escapeHtml(candidate?.feeLabel || FEE_LABELS.unknown)}</dd></div>
          <div><dt>추가 참여</dt><dd>${escapeHtml(candidate?.participationLabel || PARTICIPATION_LABELS.unknown)}</dd></div>
          <div><dt>권리 위험</dt><dd>${escapeHtml(candidate?.rightsRisk || '미확인')}</dd></div>
          <div><dt>제출 위험</dt><dd>${escapeHtml(candidate?.submissionRisk || '미확인')}</dd></div>
          <div><dt>유효 시간</dt><dd>${escapeHtml(approval.expiresAt ? dateTime(approval.expiresAt) : '준비 승인 · 만료 없음')}</dd></div>
        </dl>
        <section class="cp-approval-copy" aria-label="읽어야 하는 내용">
          <h4>읽어야 하는 내용</h4>
          <p>${escapeHtml(approval.readSummary || '자동 검토 요약이 없습니다. 공식 공고를 직접 확인해야 합니다.')}</p>
          ${link(candidate?.officialUrl, candidate?.officialVerification === 'verified' ? '주최기관 공식 공고 열기 ↗' : '공고 링크 열기 ↗', 'cp-official-link')}
        </section>
        <section class="cp-approval-copy is-decision" aria-label="승인하는 내용">
          <h4>승인하는 내용</h4>
          <p>${escapeHtml(approval.approvalText || '승인 범위가 없어 승인할 수 없습니다.')}</p>
          <p class="cp-approval-boundary">${escapeHtml(boundary)}</p>
        </section>
        <details class="cp-approval-hash"><summary>이 승인에 묶인 action hash</summary><code>${escapeHtml(approval.actionSha256)}</code></details>
        ${controls}
      </article>`;
    }).join('') : '<p class="us-empty">현재 웹 승인 요청이 없습니다.</p>';
    return `<section class="cp-approvals" aria-labelledby="cpApprovalsTitle">
      <div class="cp-section-head"><div><p class="us-eyebrow">APPROVAL INBOX</p><h2 id="cpApprovalsTitle" class="title-2">승인해야 하는 목록</h2></div><p>대기 ${pending}건 · 항상 최상단</p></div>
      <p class="cp-approval-intro">자동 검토 요약과 정확한 승인 범위를 읽은 뒤 결정하세요. 내용이나 action hash가 바뀌면 기존 승인은 재사용되지 않습니다.</p>
      <div class="cp-approval-list">${cards}</div>
    </section>`;
  }

  function renderSummary(data, now) {
    const latest = time(data.latestAt);
    const stale = latest !== null && now - latest > STALE_SCAN_MS;
    const scanState = latest === null ? '스캔 시각 미확인' : stale ? '30시간 초과 · 오래됨' : '최신';
    const coverage = data.sources.reduce((counts, source) => {
      const key = ['success', 'failed', 'partial'].includes(source.status) ? source.status : 'unknown';
      counts[key] += 1;
      return counts;
    }, { success: 0, failed: 0, partial: 0, unknown: 0 });
    const currentCandidates = data.candidates.map((candidate) => candidateAtDeadline(candidate, now));
    const candidatesByKey = new Map(data.candidates.map((candidate) => [
      applicationKey({ contest_id: candidate.id, category: candidate.category }), candidate,
    ]));
    const currentApplications = data.applications.map((application) => {
      const candidate = candidatesByKey.get(applicationKey(application))
        || data.candidates.find((entry) => entry.id === application.id);
      return applicationAtDeadline(application, candidate?.deadline, now);
    });
    const today = {
      discovered: data.today.discovered ?? data.candidates.length,
      verified: data.today.verified ?? data.candidates.filter((candidate) => !['unknown', 'review'].includes(candidate.eligibilityStatus)).length,
      preparing: currentStatusCount(data.today.preparing, data.candidates, currentCandidates, 'preparing'),
      awaitingApproval: currentStatusCount(
        data.today.awaitingApproval, data.applications, currentApplications, 'awaiting-approval',
      ),
      deadlineSoon: data.today.deadlineSoon ?? data.candidates.filter((candidate) => deadlineBucket(candidate, now) === '7d').length,
    };
    return `<section class="cp-overview" aria-labelledby="cpOverviewTitle">
      <div class="cp-section-head">
        <div><p class="us-eyebrow">LATEST SCAN</p><h2 id="cpOverviewTitle" class="title-2">스캔 현황</h2></div>
        <span class="cp-state${latest === null || stale ? ' is-warn' : ' is-good'}">${scanState}</span>
      </div>
      <dl class="cp-metrics cp-metrics-five">
        <div><dt>마지막 스캔</dt><dd>${escapeHtml(dateTime(data.latestAt))}<small>${escapeHtml(relative(data.latestAt, now))}</small></dd></div>
        <div><dt>오늘 발견</dt><dd>${today.discovered}<small>후보</small></dd></div>
        <div><dt>오늘 검증</dt><dd>${today.verified}<small>자격 확인</small></dd></div>
        <div><dt>오늘 지원준비</dt><dd>${today.preparing}<small>진행 중</small></dd></div>
        <div><dt>오늘 승인대기</dt><dd>${today.awaitingApproval}<small>확인 필요</small></dd></div>
        <div><dt>오늘 마감임박</dt><dd>${today.deadlineSoon}<small>7일 안</small></dd></div>
      </dl>
      <p class="cp-coverage-line">원본 ${data.sources.length}개 · 성공 ${coverage.success} · 실패 ${coverage.failed} · 부분 ${coverage.partial}${coverage.unknown ? ` · 미확인 ${coverage.unknown}` : ''}</p>
    </section>`;
  }

  function renderTimeline(runs) {
    const rows = runs.length ? runs.map((run) => `<li>
      <span class="cp-timeline-dot${tone(run.status)}" aria-hidden="true"></span>
      <div><strong>${escapeHtml(dateTime(run.at))}</strong><span>${escapeHtml(COVERAGE_LABELS[run.status] || COVERAGE_LABELS.unknown)} · 발견 ${run.found ?? '—'} · 지원 가능 ${run.eligible ?? '—'}</span>${run.error ? `<small>${escapeHtml(run.error)}</small>` : ''}</div>
    </li>`).join('') : '<li class="us-empty">스캔 이력이 없습니다.</li>';
    return `<section class="cp-panel" aria-labelledby="cpTimelineTitle"><div class="cp-section-head"><div><p class="us-eyebrow">TIMELINE</p><h2 id="cpTimelineTitle" class="title-2">최근 스캔</h2></div></div><ol class="cp-timeline">${rows}</ol></section>`;
  }

  function renderCoverage(sources, now) {
    const rows = sources.length ? sources.map((source) => `<li class="cp-source">
      <div><strong>${escapeHtml(source.name)}</strong><span>${escapeHtml(source.kind)} · ${escapeHtml(relative(source.checkedAt, now))}${source.found === null ? '' : ` · ${source.found}건`}</span>${link(source.referenceUrl, '원본 확인 ↗', 'cp-source-link')}</div>
      <span class="cp-state${tone(source.status)}">${escapeHtml(COVERAGE_LABELS[source.status] || COVERAGE_LABELS.unknown)}</span>
      ${source.error ? `<p>${escapeHtml(source.error)}</p>` : ''}
      ${source.failureCode ? `<p><b>확인 사유</b> ${escapeHtml(source.failureCode)}</p>` : ''}
      ${source.manualCheck ? `<p><b>수동 확인</b> ${escapeHtml(source.manualCheck)}</p>` : ''}
    </li>`).join('') : '<li class="us-empty">원본별 수집 기록이 없습니다.</li>';
    return `<section class="cp-panel" aria-labelledby="cpCoverageTitle"><div class="cp-section-head"><div><p class="us-eyebrow">COVERAGE</p><h2 id="cpCoverageTitle" class="title-2">원본 수집 범위</h2></div></div><ul class="cp-sources">${rows}</ul></section>`;
  }

  function renderCandidate(candidate) {
    const application = candidate.application;
    const officialLinkLabel = candidate.officialVerification === 'verified'
      ? '주최기관 공식 공고'
      : '공고 링크';
    const officialVerification = OFFICIAL_VERIFICATION_LABELS[candidate.officialVerification]
      || OFFICIAL_VERIFICATION_LABELS.unknown;
    const officialVerificationTime = candidate.officialVerifiedAt
      ? ` · 확인 기록 ${dateTime(candidate.officialVerifiedAt)}`
      : '';
    const blockers = application.blockers.length
      ? `<ul>${application.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : application.blockersKnown ? '<p>기록된 차단 요인 없음</p>' : '<p>차단 요인 미확인</p>';
    return `<article class="cp-candidate">
      <header>
        <div><p class="us-eyebrow">${escapeHtml(candidate.organizer)}</p><h3>${escapeHtml(candidate.title)}</h3></div>
        <span class="cp-state${tone(candidate.status)}">${escapeHtml(STATUS_LABELS[candidate.status] || STATUS_LABELS.unknown)}</span>
      </header>
      <div class="cp-candidate-links">
        ${link(candidate.officialUrl, officialLinkLabel, 'cp-official-link')}
        ${link(candidate.discoveryUrl, `발견 경로 · ${candidate.discoveryName}`, 'cp-discovery-link')}
      </div>
      <dl class="cp-candidate-facts">
        <div><dt>마감</dt><dd>${escapeHtml(candidate.deadline ? dateTime(candidate.deadline) : '미확인')}${candidate.deadlineExpired ? ' · <strong class="cp-deadline-expired">마감 지남</strong>' : ''}</dd></div>
        <div><dt>공식 공고 검증</dt><dd><span class="cp-inline-state${tone(candidate.officialVerification)}">${escapeHtml(officialVerification)}</span>${escapeHtml(officialVerificationTime)}</dd></div>
        <div><dt>최신성</dt><dd>${escapeHtml(candidate.recency)}</dd></div>
        <div><dt>적합도 점수</dt><dd>${candidate.fitScore ?? '미확인'}</dd></div>
        <div><dt>작업량 점수</dt><dd>${candidate.effortScore ?? '미확인'}</dd></div>
        <div><dt>지원 자격</dt><dd><span class="cp-inline-state${tone(candidate.eligibilityStatus)}">${escapeHtml(ELIGIBILITY_LABELS[candidate.eligibilityStatus] || ELIGIBILITY_LABELS.unknown)}</span>${candidate.eligibility ? ` ${escapeHtml(candidate.eligibility)}` : ''}</dd></div>
        <div><dt>지원 비용</dt><dd>${escapeHtml(candidate.feeLabel)}</dd></div>
        <div><dt>추가 참여</dt><dd>${escapeHtml(candidate.participationLabel)}</dd></div>
        <div><dt>권리 위험</dt><dd>${escapeHtml(candidate.rightsRisk)}</dd></div>
        <div><dt>제출 위험</dt><dd>${escapeHtml(candidate.submissionRisk)}</dd></div>
      </dl>
      <section class="cp-application" aria-label="${escapeHtml(candidate.title)} 지원 상태">
        <div><strong>지원 상태</strong><span>${escapeHtml(STATUS_LABELS[application.status] || STATUS_LABELS.unknown)}</span></div>
        <div><strong>차단 요인</strong>${blockers}</div>
        <div><strong>다음 행동</strong><p>${escapeHtml(application.nextAction || '다음 행동 미확인')}</p></div>
      </section>
    </article>`;
  }

  function renderApplicationBoard(applications, candidates, now) {
    const candidatesByKey = new Map(candidates.map((candidate) => [
      applicationKey({ contest_id: candidate.id, category: candidate.category }), candidate,
    ]));
    const currentApplications = applications.map((application) => {
      const candidate = candidatesByKey.get(applicationKey(application))
        || candidates.find((entry) => entry.id === application.id);
      return applicationAtDeadline(application, candidate?.deadline, now);
    });
    const order = ['verifying', 'preparing', 'awaiting-approval', 'approved', 'applied', 'blocked', 'watching', 'closed', 'unknown'];
    const groups = order.map((status) => ({
      status,
      rows: currentApplications.filter((application) => application.status === status),
    })).filter((group) => group.rows.length);
    const board = groups.length ? groups.map((group) => `<section class="cp-board-column" aria-label="${escapeHtml(STATUS_LABELS[group.status])}">
      <header><h3>${escapeHtml(STATUS_LABELS[group.status])}</h3><span>${group.rows.length}</span></header>
      <div>${group.rows.map((application) => `<article>
        <strong>${escapeHtml(application.title || application.id || '이름 없는 지원')}</strong>
        <p><b>다음 행동</b> ${escapeHtml(application.nextAction || '미확인')}</p>
        <p><b>차단 요인</b> ${escapeHtml(application.blockers.join(', ') || (application.blockersKnown ? '기록된 차단 요인 없음' : '미확인'))}</p>
      </article>`).join('')}</div>
    </section>`).join('') : '<p class="us-empty">지원 상태 기록이 없습니다.</p>';
    return `<section class="cp-applications" aria-labelledby="cpApplicationsTitle">
      <div class="cp-section-head"><div><p class="us-eyebrow">APPLICATIONS</p><h2 id="cpApplicationsTitle" class="title-2">지원 상태 보드</h2></div><p>승인은 최상단에서 처리 · ${currentApplications.length}건</p></div>
      <div class="cp-board" role="region" aria-label="지원 상태 보드 가로 목록" tabindex="0">${board}</div>
    </section>`;
  }

  function renderCandidates(data, filters, now) {
    const candidates = filterCandidates(data.candidates, filters, now);
    const body = candidates.length
      ? `<div class="cp-candidate-list">${candidates.map(renderCandidate).join('')}</div>`
      : `<div class="cp-empty"><p>조건에 맞는 후보가 없습니다.</p>${data.candidates.length ? '<button class="btn btn-secondary btn-sm" type="button" data-competition-clear>필터 초기화</button>' : '<span>다음 스캔 뒤 다시 확인해 주세요.</span>'}</div>`;
    return `<section class="cp-candidates" aria-labelledby="cpCandidatesTitle">
      <div class="cp-section-head"><div><p class="us-eyebrow">CANDIDATES</p><h2 id="cpCandidatesTitle" class="title-2">후보 ${candidates.length}개</h2></div><p>전체 ${data.candidates.length}개</p></div>
      ${body}
    </section>`;
  }

  function renderDashboard(data, filters = {}, now = Date.now(), includeApprovals = true) {
    const notices = data.partial
      ? `<div class="cp-notice" role="status"><strong>일부 결과만 표시합니다.</strong><span>${escapeHtml(data.errors[0] || '원본 장애, 수집 범위 제한 또는 웹 표시 상한이 있습니다. 원본별 확인 사유를 확인해 주세요.')}</span></div>`
      : '';
    return `${includeApprovals ? renderApprovalInbox(data.applications, data.candidates, now) : ''}${notices}${renderSummary(data, now)}<div class="cp-pair">${renderTimeline(data.runs)}${renderCoverage(data.sources, now)}</div>${renderApplicationBoard(data.applications, data.candidates, now)}${renderCandidates(data, filters, now)}`;
  }

  function scrollApplicationBoard(board, key) {
    const max = Math.max(0, Number(board?.scrollWidth || 0) - Number(board?.clientWidth || 0));
    if (max <= 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return false;
    const current = Math.min(max, Math.max(0, Number(board.scrollLeft || 0)));
    const step = Math.max(160, Math.round(Number(board.clientWidth || 0) * .8));
    const target = key === 'Home'
      ? 0
      : key === 'End'
        ? max
        : current + (key === 'ArrowRight' ? step : -step);
    board.scrollLeft = Math.min(max, Math.max(0, target));
    return true;
  }

  function createDashboard({ request, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const elements = {
      approvals: document.getElementById('competitionApprovalInbox'),
      body: document.getElementById('competitionBody'),
      error: document.getElementById('competitionError'),
      refreshStatus: document.getElementById('competitionRefreshStatus'),
      freshness: document.getElementById('competitionFreshness'),
      reload: document.getElementById('competitionReload'),
      filters: document.getElementById('competitionFilters'),
      search: document.getElementById('competitionSearch'),
      status: document.getElementById('competitionStatus'),
      eligibility: document.getElementById('competitionEligibility'),
      official: document.getElementById('competitionOfficialVerification'),
      fee: document.getElementById('competitionFee'),
      participation: document.getElementById('competitionParticipation'),
      deadline: document.getElementById('competitionDeadline'),
      sort: document.getElementById('competitionSort'),
    };
    let active = false;
    let loaded = false;
    let inFlight = false;
    let data = null;
    let syncedAt = null;
    let refreshTimer = null;
    let pendingDecision = null;

    function filters() {
      return {
        search: elements.search?.value,
        status: elements.status?.value,
        eligibility: elements.eligibility?.value,
        official: elements.official?.value,
        fee: elements.fee?.value,
        participation: elements.participation?.value,
        deadline: elements.deadline?.value,
        sort: elements.sort?.value,
      };
    }

    function render() {
      if (!data || !elements.body) return;
      if (elements.approvals) {
        elements.approvals.innerHTML = renderApprovalInbox(data.applications, data.candidates, now());
      }
      elements.body.innerHTML = renderDashboard(data, filters(), now(), false);
      elements.body.setAttribute?.('aria-busy', 'false');
    }

    function freshness() {
      if (!elements.freshness) return;
      elements.freshness.textContent = syncedAt
        ? `화면 갱신 ${relative(syncedAt, now())} · 30분마다 자동 갱신`
        : '';
    }

    function schedule() {
      clearTimer(refreshTimer);
      refreshTimer = null;
      if (!active) return;
      refreshTimer = setTimer(() => { void load(); }, AUTO_REFRESH_MS);
    }

    async function load({ announce = false } = {}) {
      if (inFlight || typeof request !== 'function') return;
      inFlight = true;
      if (elements.error) elements.error.textContent = '';
      if (elements.body) elements.body.setAttribute?.('aria-busy', 'true');
      if (!loaded && elements.body) elements.body.innerHTML = '<div class="cp-loading" role="status"><span aria-hidden="true"></span><p>공모전 스캔을 불러오고 있습니다.</p></div>';
      if (announce && elements.refreshStatus) elements.refreshStatus.textContent = '최신 공모전 스캔을 확인하고 있습니다.';
      if (announce && elements.reload) {
        elements.reload.disabled = true;
        elements.reload.textContent = '불러오는 중…';
      }
      try {
        const payload = await request('/api/competitions');
        data = normalizePayload(payload);
        loaded = true;
        syncedAt = now();
        render();
        if (announce && elements.refreshStatus) elements.refreshStatus.textContent = '서버에서 방금 확인했습니다.';
      } catch (error) {
        const message = error?.message === 'unauthorized' ? '' : (error?.message || '공모전 스캔을 불러오지 못했습니다.');
        if (message && elements.error) elements.error.textContent = message;
        if (!loaded && elements.body) {
          elements.body.innerHTML = '<div class="cp-empty"><p>공모전 스캔을 불러오지 못했습니다.</p><button class="btn btn-secondary btn-sm" type="button" data-competition-retry>다시 시도</button></div>';
          elements.body.setAttribute?.('aria-busy', 'false');
        }
        if (elements.refreshStatus) {
          elements.refreshStatus.textContent = loaded
            ? '업데이트하지 못했습니다. 이전 결과를 표시합니다.'
            : '공모전 스캔을 불러오지 못했습니다.';
        }
      } finally {
        inFlight = false;
        if (elements.body) elements.body.setAttribute?.('aria-busy', 'false');
        if (announce && elements.reload) {
          elements.reload.disabled = false;
          elements.reload.textContent = '새로고침';
        }
        freshness();
        schedule();
      }
    }

    async function decide(button) {
      if (pendingDecision || typeof request !== 'function') return;
      const requestId = text(button?.dataset?.requestId);
      const actionSha256 = text(button?.dataset?.actionSha256).toLowerCase();
      const decision = text(button?.dataset?.competitionApprovalDecision).toLowerCase();
      if (!requestId || !/^[a-f0-9]{64}$/u.test(actionSha256)
        || !['approved', 'held'].includes(decision)) return;
      pendingDecision = requestId;
      if (button) button.disabled = true;
      if (elements.error) elements.error.textContent = '';
      if (elements.refreshStatus) {
        elements.refreshStatus.textContent = decision === 'approved'
          ? '승인을 안전하게 저장하고 있습니다.'
          : '보류 결정을 저장하고 있습니다.';
      }
      try {
        const result = await request(
          `/api/competitions/approvals/${encodeURIComponent(requestId)}/decision`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision, action_sha256: actionSha256 }),
          },
        );
        if (result?.ok !== true || result?.request_id !== requestId
          || text(result?.action_sha256).toLowerCase() !== actionSha256
          || result?.decision !== decision) {
          throw new Error('승인 응답이 요청 내용과 일치하지 않습니다. 화면을 새로고침해 다시 확인해 주세요.');
        }
        for (const application of data?.applications || []) {
          if (application.approval?.requestId !== requestId) continue;
          application.approval.status = decision;
          application.approval.decidedAt = result?.decided_at || new Date(now()).toISOString();
          application.status = decision === 'approved' ? 'approved' : 'blocked';
        }
        render();
        if (elements.refreshStatus) {
          elements.refreshStatus.textContent = decision === 'approved'
            ? '승인됨 · 자동화가 다음 단계에서 이 결정을 확인합니다.'
            : '보류됨 · 새 승인 요청이 오기 전까지 진행하지 않습니다.';
        }
      } catch (error) {
        if (elements.error) elements.error.textContent = error?.message || '승인 결정을 저장하지 못했습니다.';
        if (elements.refreshStatus) elements.refreshStatus.textContent = '승인 결정을 저장하지 못했습니다.';
      } finally {
        pendingDecision = null;
        if (button?.isConnected !== false) button.disabled = false;
      }
    }

    function clearFilters() {
      if (elements.search) elements.search.value = '';
      if (elements.status) elements.status.value = 'all';
      if (elements.eligibility) elements.eligibility.value = 'all';
      if (elements.official) elements.official.value = 'all';
      if (elements.fee) elements.fee.value = 'all';
      if (elements.participation) elements.participation.value = 'all';
      if (elements.deadline) elements.deadline.value = 'all';
      if (elements.sort) elements.sort.value = 'priority';
      render();
      elements.search?.focus?.();
    }

    elements.reload?.addEventListener?.('click', () => { void load({ announce: true }); });
    elements.filters?.addEventListener?.('input', render);
    elements.filters?.addEventListener?.('change', render);
    function handleClick(event) {
      const approvalButton = event.target?.closest?.('[data-competition-approval-decision]');
      if (approvalButton) {
        void decide(approvalButton);
        return;
      }
      if (event.target?.closest?.('[data-competition-retry]')) void load({ announce: true });
      if (event.target?.closest?.('[data-competition-clear]')) clearFilters();
    }
    elements.approvals?.addEventListener?.('click', handleClick);
    elements.body?.addEventListener?.('click', handleClick);
    elements.body?.addEventListener?.('keydown', (event) => {
      const board = event.target?.closest?.('.cp-board');
      if (board && scrollApplicationBoard(board, event.key)) event.preventDefault?.();
    });

    return {
      activate() {
        active = true;
        if (!loaded) void load();
        else schedule();
        freshness();
      },
      deactivate() {
        active = false;
        clearTimer(refreshTimer);
        refreshTimer = null;
        freshness();
      },
      load,
      render,
      state: () => ({ active, loaded, inFlight, data, syncedAt, pendingDecision }),
    };
  }

  window.COMPETITION_UI = {
    STALE_SCAN_MS,
    AUTO_REFRESH_MS,
    normalizePayload,
    filterCandidates,
    renderApprovalInbox,
    renderDashboard,
    scrollApplicationBoard,
    createDashboard,
  };
})();
