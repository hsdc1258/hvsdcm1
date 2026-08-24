(() => {
  'use strict';

  // 읽기 전용 학습 콘텐츠. 화면·상태 로직은 app.js에만 둔다.
  // 검증 불변식: 4개 대단원, 13개 소단원, 소단원당 6문항, 총 78문항.
  const UNITS = [{
    id: 'I',
    title: '사회·문화 현상의 탐구',
    desc: '현상 구분, 관점, 연구 방법, 자료 수집, 연구 윤리',
    subs: [{
      id: 'I-01',
      title: '탐구 대상으로서의 사회·문화 현상',
      time: 18,
      keywords: '자연 현상 · 사회·문화 현상 · 기능론 · 갈등론 · 상징적 상호 작용론',
      sections: [{
        title: '자연 현상과 사회·문화 현상',
        points: ['자연 현상은 인간의 의지와 무관하게 발생하며 필연성·확실성, 보편성, 몰가치성이 강하다.', '사회·문화 현상은 인간의 가치·의지·목적이 개입하며 개연성·확률성, 보편성과 특수성이 함께 나타난다.', '두 현상 모두 경험 자료로 과학적으로 탐구할 수 있고 인과 관계와 규칙성을 찾을 수 있다.'],
        trap: '문장에 제시되지 않은 인간의 배경을 상상하지 않는다. 태풍 때문에 나무가 쓰러진 현상은 자연 현상이다.'
      }, {
        title: '거시 관점: 기능론과 갈등론',
        points: ['기능론은 사회를 상호 의존하는 부분들의 체계로 보고 합의·통합·균형을 강조한다. 사회 문제는 일시적 기능 장애로 본다.', '갈등론은 희소 자원을 둘러싼 지배·피지배와 강제를 강조한다. 불평등을 구조적 모순으로 보고 갈등을 변동의 원동력으로 본다.', '기능론은 불평등·기존 질서 옹호 가능성, 갈등론은 통합·안정과 합의를 경시한다는 비판을 받는다.'],
        trap: '‘지배적 규범’만으로 갈등론이라 단정하지 않는다. ‘지배 집단의 이익’이 제시되어야 근거가 강하다.'
      }, {
        title: '미시 관점: 상징적 상호 작용론',
        points: ['개인은 상징을 매개로 상호 작용하며 상황을 해석하고 의미를 구성한다.', '행위자는 구조에 끌려가는 수동적 존재가 아니라 상황 정의에 따라 행동하는 능동적 존재다.', '일상적 상호 작용을 깊게 설명하지만 거시 구조의 강한 영향력을 경시할 수 있다.'],
        trap: '기능론·갈등론은 거시, 상징적 상호 작용론은 미시 관점이다.'
      }]
    }, {
      id: 'I-02',
      title: '사회·문화 현상의 탐구 방법',
      time: 30,
      keywords: '양적·질적 연구 · 가설과 변인 · 1차·2차 자료 · 다섯 자료 수집법',
      sections: [{
        title: '양적 연구와 질적 연구',
        points: ['양적 연구는 방법론적 일원론·실증주의에 기초해 수치 자료로 변수 관계와 일반 법칙을 찾고, 주로 연역적으로 가설을 검증한다.', '질적 연구는 방법론적 이원론·해석주의에 기초해 언어·행동·경험을 통해 동기와 맥락을 이해하고, 주로 귀납적으로 개념을 만든다.', '둘 다 경험적 자료를 사용하고 상호 보완할 수 있다. 도구 이름 하나만으로 연구 성격을 단정하지 않는다.'],
        trap: '질문지=항상 양적, 면접=항상 질적이 아니다. 폐쇄형·개방형 설계와 자료 처리 방식을 본다.'
      }, {
        title: '가설·변인·가치 중립',
        points: ['독립 변인은 원인·처치·설명 변수, 종속 변인은 그에 따라 달라질 것으로 보는 결과 변수다.', '조작적 정의는 추상적 개념을 측정 가능한 지표로 바꾸는 것이다. 좋은 가설은 검증 가능하고 변인 관계가 명확하며 당위 판단이 없어야 한다.', '주제·가설·설계 선택과 결과 활용에는 가치가 개입할 수 있으나 자료 수집·분석·가설 검증에서는 가치 중립을 지켜야 한다.'],
        trap: '연구자가 가설을 선택할 때 가치가 개입할 수 있다는 사실과 가설 문장 자체가 가치 판단이라는 말은 다르다.'
      }, {
        title: '1차·2차 자료와 자료 수집법',
        points: ['1차 자료는 현재 연구 목적을 위해 연구자가 직접 처음 수집한 자료다. 자기의 과거 자료도 새 연구에서 재활용하면 2차 자료다.', '문헌 연구는 기존 자료, 질문지법은 대규모·통계, 실험법은 조작·통제와 인과, 면접법은 깊은 답변, 참여 관찰법은 실제 생활 맥락에 강점이 있다.', '모집단은 연구 대상 전체, 표본은 실제 조사 대상 일부다. 무작위 표집은 대표성 확보에 유리하지만 대표성을 자동 보장하지 않는다.'],
        trap: '1차·2차 구분 기준은 ‘누가 만들었나’가 아니라 ‘현재 연구를 위해 직접 수집했나’이다.'
      }]
    }, {
      id: 'I-03',
      title: '사회·문화 현상의 탐구와 연구 윤리',
      time: 16,
      keywords: '객관적·개방적·상대주의적·성찰적 태도 · 동의 · 익명성 · 사후 설명',
      sections: [{
        title: '네 가지 탐구 태도',
        points: ['객관적 태도는 연구자의 선호를 배제하고 제3자가 검증 가능한 절차와 근거를 중시한다.', '개방적 태도는 지식을 잠정적 결과로 보고 새 증거와 합리적 비판을 받아들인다.', '상대주의적 태도는 역사·문화적 맥락과 행위자 입장에서 이해하고, 성찰적 태도는 익숙한 전제와 연구의 영향을 되돌아본다.'],
        trap: '객관성은 주관이 전혀 없다는 뜻이 아니라 관찰자 사이에 공유 가능한 상호 주관성을 확보한다는 뜻이다.'
      }, {
        title: '연구 대상자 보호',
        points: ['자발적 참여와 충분한 사전 설명에 기초한 동의, 개인정보·익명성 보호가 원칙이다.', '사전 고지가 행동을 왜곡할 때 일부 목적을 숨길 수 있으나 연구 후 충분히 설명하고 사후 동의를 받아야 한다.', '익명성 보장은 개별 신원을 숨기는 것이며 집단 수준 연구 결과 전체를 숨긴다는 뜻은 아니다.'],
        trap: '과학적 엄밀성과 연구 윤리가 충돌하면 연구 윤리가 우선한다.'
      }, {
        title: '연구 진실성',
        points: ['자료를 위조·변조·날조하지 않고 결과를 과장하거나 왜곡하지 않는다.', '타인의 연구를 인용 없이 사용하지 않으며 출처를 정확히 밝힌다.', '연구 주제 자체도 사회적으로 유익하고 윤리적으로 정당해야 한다.'],
        trap: '성과가 좋아도 자료 조작과 표절은 정당화되지 않는다.'
      }]
    }]
  }, {
    id: 'II',
    title: '개인과 사회 구조',
    desc: '사회화, 지위와 역할, 사회 구조, 집단·조직, 일탈',
    subs: [{
      id: 'II-01',
      title: '사회화와 사회적 상호 작용',
      time: 21,
      keywords: '사회화 기관 · 예기·재사회화 · 거울 자아 · 지위·역할·갈등',
      sections: [{
        title: '사회화와 사회화 기관',
        points: ['사회화는 지식·가치·규범·기술을 학습하고 문화를 내면화하는 평생 과정이다.', '1차적 기관은 가족·또래처럼 기초 인성을, 2차적 기관은 학교·기업·대중 매체처럼 전문 지식과 역할을 학습시키는 경향이 있다.', '공식적 사회화 기관은 사회화가 주된 목적이고 의도적·체계적이다. 가족·회사·대중 매체는 사회화가 부수적인 비공식적 사회화 기관이다.'],
        trap: '회사는 공식 조직이지만 사회화가 본래 목적은 아니므로 비공식적 사회화 기관이다.'
      }, {
        title: '사회화 유형과 자아',
        points: ['예기 사회화는 앞으로 들어갈 지위·집단의 규범을 미리 배우는 것, 재사회화는 변화한 환경에 맞게 새 규범과 기술을 다시 배우는 것이다.', '쿨리의 거울 자아는 타인이 나를 어떻게 볼지 상상하고 그 평가를 내면화해 자아가 형성된다고 본다.', '미드는 중요한 타자와 일반화된 타자의 기대를 내면화하며 자아가 발달한다고 본다.'],
        trap: '한 사례에서 예기 사회화와 재사회화가 겹칠 수 있다.'
      }, {
        title: '지위·역할·역할 갈등',
        points: ['귀속 지위는 의지와 무관하게 주어지고, 성취 지위는 노력·선택으로 획득한다.', '역할은 특정 지위에 대한 사회적 기대, 역할 행동은 실제 수행이다. 평가는 역할이 아니라 역할 행동에 내려진다.', '역할 갈등은 서로 다른 지위의 역할 기대가 동시에 충돌하는 상태다. 한 지위 안의 상충 기대는 역할 긴장이다.'],
        trap: '지위가 여러 개이거나 단순히 고민한다는 이유만으로 역할 갈등은 아니다. 실제 역할 기대의 충돌이 있어야 한다.'
      }]
    }, {
      id: 'II-02',
      title: '사회 구조와 개인의 삶',
      time: 17,
      keywords: '사회 명목론 · 사회 실재론 · 뒤르켐 자살론 · 사회 구조',
      sections: [{
        title: '사회 명목론과 사회 실재론',
        points: ['사회 명목론은 사회를 개인들의 합으로 보고 개인의 자율성·능동성·계약을 강조한다.', '사회 실재론은 사회가 개인의 합을 넘어 독립적으로 존재하며 개인을 구속한다고 본다.', '사회 계약론·개인주의는 명목론, 유기체론·전체론은 실재론과 가깝다.'],
        trap: '사회 실재론과 기능론은 같은 말이 아니다. 기능론과 갈등론 모두 거시 구조의 제약을 중시할 수 있다.'
      }, {
        title: '뒤르켐의 자살론',
        points: ['자살을 개인 심리만이 아니라 사회 통합과 사회 규제의 정도로 설명한다.', '이기적 자살은 통합 약화, 이타적 자살은 통합 과잉과 관련된다.', '아노미적 자살은 규제 약화, 숙명적 자살은 규제 과잉과 관련된다.'],
        trap: '통합과 규제를 서로 바꾸지 않는다.'
      }, {
        title: '사회 구조의 성격',
        points: ['사회 구조는 지위·역할·제도의 안정된 관계 양식이다.', '안정성·지속성·예측 가능성·강제성을 지니지만 사회별로 다르고 변할 수도 있다.', '개인은 구조의 제약을 받으면서도 상호 작용을 통해 구조를 재생산하거나 변화시킬 수 있다.'],
        trap: '구조가 안정적이라는 말은 영원히 변하지 않는다는 뜻이 아니다.'
      }]
    }, {
      id: 'II-03',
      title: '사회 집단과 사회 조직의 이해',
      time: 27,
      keywords: '내·외·준거 집단 · 공동·이익사회 · 공식 조직 · 관료제 · 자발적 결사체',
      sections: [{
        title: '사회 집단과 분류 기준',
        points: ['사회 집단은 2명 이상, 소속감·공동체 의식, 지속적 상호 작용을 갖는다.', '내·외집단은 심리적 소속감과 거리감, 준거 집단은 행동·가치 판단·비교의 기준 여부로 구분한다.', '공동사회는 결합 자체가 목적이고 본질 의지, 이익사회는 특정 목적 달성의 수단이고 선택 의지에 기초한다. 1차·2차 집단은 접촉과 관계 방식이 기준이다.'],
        trap: '공동사회/이익사회와 1차/2차 집단은 기준이 달라 완전히 일치하지 않는다.'
      }, {
        title: '관료제와 탈관료제',
        points: ['관료제는 수직 위계, 전문화, 명문화된 규칙, 비인격성, 연공서열, 상명하달을 특징으로 하며 안정적 환경에 적합하다.', '탈관료제는 수평적 의사 결정, 팀·네트워크, 재량·창의성, 능력 중심 보상과 유연성을 강조한다.', '둘 다 공식 조직의 운영 방식이며 한 조직에서 혼합될 수 있다. 탈관료제에도 업무 분화와 일부 규칙은 존재한다.'],
        trap: '탈관료제는 규칙이 전혀 없는 조직이 아니다.'
      }, {
        title: '비공식 조직과 자발적 결사체',
        points: ['비공식 조직은 공식 조직 내부의 친밀한 인간관계로 형성되어 긴장 완화와 소속감에 기여하지만 파벌을 낳을 수 있다.', '자발적 결사체는 공통 관심을 바탕으로 자발적으로 가입하며 직접 경제 보상이 주목적이 아니다.', '친목·시민·이익 집단이 자발적 결사체에 포함될 수 있지만 모든 자발적 결사체가 비공식 조직은 아니다.'],
        trap: '시민 단체처럼 공식 규칙을 갖춘 자발적 결사체도 존재한다.'
      }]
    }, {
      id: 'II-04',
      title: '일탈 행동의 원인과 해결 방안',
      time: 20,
      keywords: '아노미 · 차별 교제 · 낙인 · 1차·2차 일탈',
      sections: [{
        title: '일탈의 상대성',
        points: ['일탈은 특정 사회의 규범에서 벗어난 행위이며 시대·사회·상황에 따라 기준이 달라진다.', '아노미 이론은 객관적 일탈 기준의 존재를 전제하는 경향이 있다.', '낙인 이론은 행위 자체보다 사회적 반응이 일탈자 정체성을 만든다고 본다.'],
        trap: '일탈의 상대성이 곧 규범과 제재가 불필요하다는 뜻은 아니다.'
      }, {
        title: '아노미 이론',
        points: ['뒤르켐은 급격한 변화로 기존 규범이 약화되고 새 규범이 미정립된 상태를 아노미로 본다. 해결은 규범·통제 회복이다.', '머튼은 문화적 목표와 제도적 수단의 괴리를 강조한다. 합법적 기회와 수단 확대가 해결 방향이다.', '머튼의 혁신형은 문화적 목표를 수용하지만 제도적 수단 대신 비제도적 수단을 사용한다.'],
        trap: '‘급격한 변동으로 규범 약화’는 뒤르켐, ‘목표-수단 괴리’는 머튼이다.'
      }, {
        title: '차별 교제와 낙인',
        points: ['차별 교제 이론은 일탈자와 지속적으로 접촉하며 일탈에 우호적인 정의와 기술을 학습한다고 본다.', '낙인 이론은 1차 일탈 뒤 타인의 낙인과 차별적 제재가 부정적 자아를 형성해 2차 일탈로 이어진다고 본다.', '차별 교제는 접촉 차단·건전한 집단 교류, 낙인은 신중한 제재·낙인 최소화를 처방한다.'],
        trap: '통제와 단속을 무조건 강화하는 처방은 낙인 이론과 반대 방향에 가깝다.'
      }]
    }]
  }, {
    id: 'III',
    title: '문화와 사회',
    desc: '문화의 의미·속성·관점, 하위문화와 대중문화, 문화 변동',
    subs: [{
      id: 'III-01',
      title: '문화의 이해',
      time: 23,
      keywords: '넓은·좁은 문화 · 물질·비물질 · 문화 속성 · 총체론·비교론·상대론',
      sections: [{
        title: '문화의 의미와 구성',
        points: ['넓은 의미의 문화는 구성원이 공유하고 학습한 생활 양식 전체, 좁은 의미는 교양·예술·세련됨 같은 평가적 의미다.', '물질문화는 도구·기계·건축과 물질을 다루는 기술, 비물질문화는 언어·가치·규범·관념·제도다.', '문화 지체는 물질문화의 빠른 변화를 비물질문화가 따라가지 못해 부조화가 생기는 현상이다.'],
        trap: '기술은 눈에 보이지 않아도 물질을 다루고 변형하므로 교과상 물질문화다.'
      }, {
        title: '문화의 다섯 속성',
        points: ['학습성은 후천적 사회화, 공유성은 예측 가능한 공동생활, 축적성은 전승과 새 요소 추가를 뜻한다.', '전체성은 문화 요소의 유기적 연결, 변동성은 발명·발견·전파 등으로 시간에 따라 변화함을 뜻한다.', '‘새 요소가 더해짐’은 축적성, ‘시간이 지나 모습이 달라짐’은 변동성이다.'],
        trap: '제시문이 무엇을 강조하는지 끝까지 읽고 축적성과 변동성을 구분한다.'
      }, {
        title: '문화 이해의 관점과 태도',
        points: ['총체론적 관점은 한 문화 내부 요소들의 유기적 관련, 비교론적 관점은 문화 간 공통점·차이, 상대론적 관점은 역사·환경과 내부자 맥락을 본다.', '자문화 중심주의와 문화 사대주의는 평가 기준만 다를 뿐 모두 문화 절대주의다.', '문화 상대주의는 절대적 우열 판단을 경계하지만 극단화되면 보편적 인권까지 부정할 위험이 있다.'],
        trap: '한 사회 내부에서 가족·종교·경제의 연결을 보면 총체론, 형성 배경과 내부 의미를 보면 상대론이다.'
      }]
    }, {
      id: 'III-02',
      title: '다양한 하위문화와 현대의 대중문화',
      time: 20,
      keywords: '주류·하위·반문화 · 대중문화 · 상업성 · 획일화',
      sections: [{
        title: '주류·하위·반문화',
        points: ['주류 문화는 사회 다수 또는 지배적 집단이 공유해 통합과 질서 유지에 기여한다.', '하위문화는 특정 집단의 독특한 문화로 소속감·정체성·다양성에 기여한다. 반문화는 주류 가치와 질서에 저항하는 하위문화다.', '모든 반문화는 하위문화지만 모든 하위문화가 반문화는 아니다. 같은 문화의 지위도 시대·사회·집단에 따라 바뀐다.'],
        trap: '대중문화 전체를 하위문화라고 단정하지 않는다. 사회 전체의 보편적 문화가 된 부분도 크다.'
      }, {
        title: '대중문화의 양면성',
        points: ['대중문화는 문화 향유 기회를 넓히고 고급문화를 대중화하지만 획일화·상업화·선정성·수동적 소비를 낳을 수 있다.', '상품화는 조회 수와 이윤을 위해 자극·갈등·연성 뉴스가 강화되는 문제와 연결된다.', '대중문화 수용자는 단순한 소비자가 아니라 의미를 선택하고 재구성할 수도 있다.'],
        trap: '대중문화는 순기능이나 역기능 중 하나만 갖는 것이 아니다.'
      }, {
        title: '대중문화와 대중 매체',
        points: ['대중문화는 대중 매체의 발달과 교육 기회의 확대로 널리 확산되며 고급문화의 대중화와 문화 향유 기회 확대에 기여할 수 있다.', '대중문화는 계층 간 문화적 차이를 줄일 수 있지만 상업성·선정성·획일화, 수동적 소비와 같은 문제를 낳을 수 있다.', '대중 매체를 통해 소수 생산자가 다수의 취향과 여론에 큰 영향을 미칠 수 있으며 유행에 따라 문화 상품이 빠르게 소비되고 사라질 수 있다.'],
        trap: '평가원은 대중문화의 상업성·획일화·선정성과 문화 향유 기회 확대를 주로 대비시킨다.'
      }]
    }, {
      id: 'III-03',
      title: '문화의 변동과 한국 문화의 세계화',
      time: 23,
      keywords: '발명·발견 · 직접·간접·자극 전파 · 공존·동화·융합 · 다문화',
      sections: [{
        title: '문화 변동 요인',
        points: ['발명은 없던 문화 요소를 새로 만드는 것, 발견은 이미 존재하지만 알려지지 않았던 것을 찾는 것이다.', '직접 전파는 교역·이민·전쟁 등 사람의 직접 접촉, 간접 전파는 매체를 통한 비대면 전파다.', '자극 전파는 외부 문화의 아이디어가 자극이 되어 새로운 문화 요소를 만드는 것이다.'],
        trap: '자극 전파에는 외부 문화 아이디어라는 원인이 반드시 있다. 2차 발명과 완전히 같은 말이 아니다.'
      }, {
        title: '문화 접변 결과',
        points: ['문화 공존 A+B→A와 B는 두 정체성이 함께 유지되는 결과다.', '문화 동화 A+B→A 또는 B는 한쪽 정체성이 소멸하는 결과, 문화 융합 A+B→C는 제3의 문화가 생기는 결과다.', '문화 저항은 외래문화를 거부하며 기존 문화를 방어하는 반응이다. 동화는 자발적일 수도 강제적일 수도 있다.'],
        trap: '‘A가 B를 동화했다’와 ‘B가 A에 동화되었다’의 주체·객체를 뒤집지 않는다.'
      }, {
        title: '다문화 사회와 세계화',
        points: ['용광로 모형은 하나의 문화로 흡수되는 동화의 위험, 샐러드 볼 모형은 정체성 보존의 장점과 집단 갈등 가능성을 갖는다.', '차별 금지와 제도적 권리 보장, 상대주의적 이해, 공통 규범 형성을 함께 추구해야 한다.', '한국 문화의 고유성을 고정된 것으로 보지 말고 창조적으로 계승하며 다른 문화와 상호 교류한다.'],
        trap: '다문화주의는 차이를 인정하되 인권과 공동체의 기본 규범까지 포기하는 태도가 아니다.'
      }]
    }]
  }, {
    id: 'IV',
    title: '사회 계층과 불평등',
    desc: '계층 이론과 이동, 빈곤·성·소수자, 사회 복지 제도',
    subs: [{
      id: 'IV-01',
      title: '사회 계층화 현상의 이해',
      time: 29,
      keywords: '기능론·갈등론 · 마르크스·베버 · 사회 이동 · 계층 구조',
      sections: [{
        title: '불평등을 보는 관점',
        points: ['기능론은 중요한 역할에 유능한 인재를 배치하기 위한 차등 보상을 불가피하고 기능적인 것으로 본다.', '갈등론은 지배 집단이 만든 구조적 불평등이 교육·법·문화를 통해 재생산된다고 본다.', '기능론은 배경과 권력 차이를, 갈등론은 성취 동기와 통합을 충분히 설명하지 못한다는 비판을 받는다.'],
        trap: '기능론은 차등 배분 기준이 사회적으로 합의된다고 보고, 갈등론은 지배 집단의 가치가 반영된다고 본다.'
      }, {
        title: '마르크스와 베버',
        points: ['마르크스는 생산 수단 소유 여부를 중심으로 자본가와 노동자 계급, 계급 갈등과 계급 의식을 강조한다.', '베버는 경제적 계급, 사회적 위신인 지위, 정치적 권력을 함께 보는 다차원적 계층론을 제시한다.', '베버는 경제·위신·권력이 일치하지 않는 지위 불일치가 가능하다고 본다.'],
        trap: '계급은 공동 이해와 의식을 지닌 실제 집단 성격이 강하고, 계층은 연속선상의 분류 범주다.'
      }, {
        title: '사회 이동과 계층 구조',
        points: ['수평 이동은 계층 위치가 같고 수직 이동은 상승·하강한다. 세대 간은 부모-자녀, 세대 내는 한 개인 생애의 변화다.', '개인적 이동은 개인의 노력·선택, 구조적 이동은 산업 구조·전쟁·경제 위기 등 사회 변화가 다수의 계층을 바꾸는 경우다.', '개방적 구조는 성취 지위와 수직 이동이 크다. 피라미드형은 하층, 다이아몬드형은 중층, 모래시계형은 상·하층 비중이 큰 구조다.'],
        trap: '두 시점의 계층 비율이 같아도 상승·하강이 상쇄되었을 수 있으므로 개인 이동이 없다고 단정할 수 없다.'
      }]
    }, {
      id: 'IV-02',
      title: '다양한 사회적 불평등과 해결 방안',
      time: 20,
      keywords: '절대·상대 빈곤 · 성 불평등 · 사회적 소수자 · 적극적 우대 조치',
      sections: [{
        title: '절대적·상대적 빈곤',
        points: ['절대적 빈곤은 인간다운 최저 생활에 필요한 자원이 부족한 상태로 최저 생계비·공식 빈곤선과 관련된다.', '상대적 빈곤은 사회의 일반 생활 수준과 비교해 자원이 크게 부족한 상태로 상대적 박탈과 사회 통합 문제와 관련된다.', '둘은 상호 배타적이지 않아 한 가구가 동시에 해당할 수 있다. 경제가 성장해도 격차가 커지면 상대 빈곤은 심화될 수 있다.'],
        trap: '빈곤율은 빈곤 가구의 비율, 빈곤선은 빈곤 여부를 가르는 소득·생활비 기준 금액이다.'
      }, {
        title: '성 불평등',
        points: ['생물학적 성은 신체적 차이, 사회적 성은 사회가 기대하는 성 역할과 정체성이다.', '성 불평등은 임금·직종 분리, 정치 대표성, 돌봄·가사 부담, 성 역할 사회화와 관련된다.', '해결에는 법·제도, 노동 시장과 돌봄 구조, 성 고정관념의 변화를 함께 추진해야 한다.'],
        trap: '성 평등은 한 성을 적으로 삼는 것이 아니라 성별에 따른 제도적 불평등을 줄이고 동등한 권리·책임을 지향한다.'
      }, {
        title: '사회적 소수자와 적극적 우대',
        points: ['사회적 소수자는 수가 아니라 식별되는 특성, 권력상 열세, 차별, 집단 정체성이 핵심이다.', '수적으로 다수여도 권력상 열세와 차별을 받으면 소수자일 수 있고, 소수자 여부는 시대·사회에 따라 달라진다.', '적극적 우대 조치는 역사적 불이익을 보정해 실질적 평등을 이루려는 정책이지만 적용 조건에 따라 역차별 논쟁이 생길 수 있다.'],
        trap: '수적으로 적다는 사실만으로 사회적 소수자가 되는 것은 아니다.'
      }]
    }, {
      id: 'IV-03',
      title: '불평등 해소를 위한 사회 복지 제도',
      time: 25,
      keywords: '보편·선별 복지 · 사회 보험 · 공공 부조 · 사회 서비스 · 생산적 복지',
      sections: [{
        title: '복지의 흐름과 대상 선정',
        points: ['자유방임에서 사회 보험, 보편 복지, 복지 국가 위기와 신자유주의적 축소, 제3의 길·생산적 복지로 흐름을 정리한다.', '보편적 복지는 낙인이 적고 통합에 유리하지만 비용이 크다. 선별적 복지는 필요한 대상에 집중하지만 조사 비용·낙인·사각지대가 생길 수 있다.', '생산적 복지는 노동 참여와 자립을 지원하며 공공 부조에만 한정되지 않는다.'],
        trap: '보편과 선별은 각각 장단점이 있으며 어느 하나가 항상 우월한 것은 아니다.'
      }, {
        title: '사회 보험과 공공 부조',
        points: ['사회 보험은 질병·실업·노령 등 위험을 예방하며 자격 충족자에게 원칙적 강제 가입, 보험료 분담, 수혜자 부담, 상대적으로 약한 재분배가 특징이다.', '공공 부조는 소득·재산 조사로 빈곤층을 선정하고 조세로 최저 생활을 보장한다. 수혜자 부담이 없고 재분배 효과가 가장 강하다.', '교과서식 표현에서 사회 보험은 가입자와 수혜자가 대체로 일치한다. 사용자·국가가 보험료를 분담해도 이 원칙은 유지된다.'],
        trap: '사회 보험의 ‘강제 가입’은 자격 조건을 충족한 경우라는 뜻이지 모든 국민이 동일 방식으로 가입한다는 뜻이 아니다.'
      }, {
        title: '사회 서비스와 제도 비교',
        points: ['사회 서비스는 상담·재활·보육·돌봄·취업 지원 등 비금전적 도움을 중심으로 하며 예방과 사후 지원이 모두 가능하다.', '재원은 국가·지자체·민간이고 이용자가 일부 또는 전부 비용을 부담할 수 있다.', '세 제도의 수급자는 상호 배타적이지 않다. 한 사람이 건강 보험, 기초 생활 보장, 돌봄 서비스를 함께 이용할 수 있다.'],
        trap: '사회 서비스는 반드시 무료가 아니며 수혜자 일부 부담이 가능하다.'
      }]
    }]
  }];

  // 정확한 한국어 개념도를 코드로 그리기 위한 읽기 전용 콘텐츠다.
  // 외부 이미지에 핵심 정보를 맡기지 않아 모바일·저속 환경에서도 학습 구조가 유지된다.
  const VISUAL_GUIDES = {
    'I-01': {
      question: '현상의 성격과 설명 관점을 어떤 단서로 구분할까?',
      flow: ['현상 분류', '분석 수준 확인', '핵심 단서 대조'],
      checks: ['자연 현상과 사회·문화 현상의 발생 원인·규칙성을 구분한다.', '거시 관점은 구조, 미시 관점은 상호 작용과 상황 정의에 주목한다.', '기능론의 합의·균형, 갈등론의 지배·강제 단서를 끝까지 대조한다.']
    },
    'I-02': {
      question: '연구 목적부터 자료 해석까지 어떤 순서로 판별할까?',
      flow: ['연구 문제·가설', '설계·자료 수집', '분석·결론'],
      checks: ['양적·질적 연구는 자료의 형태보다 연구 목적과 처리 방식을 먼저 본다.', '독립·종속 변인과 조작적 정의가 실제 측정 지표에 맞는지 확인한다.', '모집단·표본, 1차·2차 자료, 자료 수집법의 장단점을 서로 섞지 않는다.']
    },
    'I-03': {
      question: '좋은 탐구 태도와 연구 윤리는 어느 단계에서 작동할까?',
      flow: ['탐구 태도', '대상자 보호', '연구 진실성'],
      checks: ['객관·개방·상대주의·성찰적 태도의 판단 기준을 사례에 적용한다.', '자발적 동의, 익명성, 사후 설명이 필요한 시점을 구분한다.', '자료 조작·표절·결과 왜곡은 연구 성과와 무관하게 허용되지 않는다.']
    },
    'II-01': {
      question: '개인이 사회 구성원으로 성장하고 역할을 수행하는 과정은?',
      flow: ['사회화 기관', '자아 형성', '지위·역할'],
      checks: ['공식 조직과 공식적 사회화 기관을 같은 말로 보지 않는다.', '예기 사회화와 재사회화가 겹칠 수 있음을 사례에서 확인한다.', '지위·역할·역할 행동과 역할 갈등을 각각 분리해 판단한다.']
    },
    'II-02': {
      question: '개인과 사회 구조 중 무엇의 영향력을 강조하는가?',
      flow: ['명목론·실재론', '통합·규제', '구조와 행위'],
      checks: ['사회 명목론은 개인의 능동성, 실재론은 구조의 외재성과 구속성을 강조한다.', '뒤르켐의 자살 유형은 통합과 규제의 과소·과잉 축으로 정리한다.', '구조의 안정성과 변동 가능성이 함께 존재함을 기억한다.']
    },
    'II-03': {
      question: '집단과 조직을 나누는 기준이 무엇인지 먼저 찾을 수 있는가?',
      flow: ['집단 분류', '조직 운영', '결사체 관계'],
      checks: ['내·외·준거 집단, 공동·이익사회, 1차·2차 집단의 기준을 교차하지 않는다.', '관료제와 탈관료제는 이상형이며 실제 조직에서는 혼합될 수 있다.', '비공식 조직과 자발적 결사체의 소속 범위·형성 목적을 구분한다.']
    },
    'II-04': {
      question: '일탈의 원인 설명과 해결책을 같은 이론끼리 연결할 수 있는가?',
      flow: ['규범 상태', '학습·상호 작용', '사회적 반응'],
      checks: ['뒤르켐은 규범 약화, 머튼은 문화적 목표와 제도적 수단의 괴리를 본다.', '차별 교제 이론은 일탈 정의와 기술의 학습을 강조한다.', '낙인 이론은 1차 일탈보다 낙인 이후의 자아와 2차 일탈에 주목한다.']
    },
    'III-01': {
      question: '문화의 의미·속성·이해 태도를 어떤 기준으로 나눌까?',
      flow: ['문화의 의미', '문화의 속성', '이해 관점·태도'],
      checks: ['좁은 의미와 넓은 의미, 물질문화와 비물질문화를 별도 기준으로 본다.', '축적성은 추가·전승, 변동성은 시간에 따른 변화가 핵심이다.', '총체론·비교론·상대론과 자문화 중심·사대·상대주의 태도를 구분한다.']
    },
    'III-02': {
      question: '하위문화의 위치와 대중문화의 양면성을 함께 설명할 수 있는가?',
      flow: ['주류·하위·반문화', '생산·유통', '수용·재구성'],
      checks: ['반문화는 하위문화에 포함되지만 모든 하위문화가 반문화는 아니다.', '대중문화의 문화 향유 확대와 상업성·획일화를 함께 평가한다.', '수용자는 수동적 소비자일 수도, 의미를 재구성하는 능동적 주체일 수도 있다.']
    },
    'III-03': {
      question: '문화 변동의 원인과 접변 결과를 화살표로 설명할 수 있는가?',
      flow: ['내재·외재 요인', '전파 방식', '공존·동화·융합'],
      checks: ['발명·발견과 직접·간접·자극 전파의 발생 조건을 확인한다.', 'A+B의 결과에서 원래 정체성이 남는지로 공존·동화·융합을 판별한다.', '다문화주의는 차이 인정과 보편적 인권·공통 규범을 함께 요구한다.']
    },
    'IV-01': {
      question: '불평등 이론과 실제 계층 이동 자료를 어떻게 연결할까?',
      flow: ['불평등 관점', '계층 이론', '이동·구조 자료'],
      checks: ['기능론의 차등 보상과 갈등론의 지배 집단 재생산 논리를 대조한다.', '마르크스의 단일 차원과 베버의 계급·지위·권력 다차원을 구분한다.', '세대 간·내, 수평·수직, 개인적·구조적 이동의 기준을 먼저 세운다.']
    },
    'IV-02': {
      question: '불평등의 유형마다 판단 기준과 해결 원리가 어떻게 다른가?',
      flow: ['빈곤 기준', '성 불평등', '소수자·우대 조치'],
      checks: ['절대·상대 빈곤은 동시에 나타날 수 있고 기준선이 서로 다르다.', '성 불평등은 개인 인식뿐 아니라 노동·돌봄·대표성 구조와 연결된다.', '사회적 소수자는 수가 아니라 권력상 열세와 차별 여부로 판단한다.']
    },
    'IV-03': {
      question: '복지 제도를 대상·재원·부담·기능으로 비교할 수 있는가?',
      flow: ['대상 선정', '재원·부담', '급여·서비스'],
      checks: ['사회 보험은 위험 대비, 공공 부조는 최저 생활 보장, 사회 서비스는 비금전 지원 중심이다.', '수혜자 비용 부담과 소득 재분배 효과를 제도별로 비교한다.', '한 사람이 여러 제도의 수급자가 될 수 있으며 보편·선별 방식에는 각각 장단점이 있다.']
    }
  };

  for (const unit of UNITS) {
    for (const sub of unit.subs) sub.visual = VISUAL_GUIDES[sub.id];
  }

  // 2022~2026학년도 평가원 6월·9월·수능 원문에서 선별한 실기출 78문항.
  // 문항·정답은 원문 PDF/정답표 대조, 오답률은 통사랑 문항별 정답률 데이터로 검증했다.
  const CHOICE_MARKS = ['①', '②', '③', '④', '⑤'];
  const KICE_SOURCES = {
    "2022|6월": {
      "question": "https://horaeng.com/wp-content/uploads/2022학년도-대수능-6월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2022학년도-대수능-6월-모의평가-사회문화-정답.pdf",
      "page": "https://horaeng.com/109"
    },
    "2022|9월": {
      "question": "https://horaeng.com/wp-content/uploads/2022학년도-대수능-9월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2022학년도-대수능-9월-모의평가-사회문화-답지.pdf",
      "page": "https://horaeng.com/166"
    },
    "2022|수능": {
      "question": "https://horaeng.com/wp-content/uploads/2022학년도-대학수학능력시험-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2022학년도-대학수학능력시험-사회문화-답지.pdf",
      "page": "https://horaeng.com/184"
    },
    "2023|6월": {
      "question": "https://horaeng.com/wp-content/uploads/2023학년도-6월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2023학년도-6월-모의평가-사회문화-답지.pdf",
      "page": "https://horaeng.com/223"
    },
    "2023|9월": {
      "question": "https://horaeng.com/wp-content/uploads/2023학년도-9월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2023학년도-9월-모의평가-사회문화-답지.pdf",
      "page": "https://horaeng.com/252"
    },
    "2023|수능": {
      "question": "https://horaeng.com/wp-content/uploads/2023학년도-대학수학능력시험-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2023학년도-대학수학능력시험-사회문화-정답.pdf",
      "page": "https://horaeng.com/254"
    },
    "2024|6월": {
      "question": "https://horaeng.com/wp-content/uploads/2024학년도-6월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2024학년도-6월-모의평가-사회문화-정답.pdf",
      "page": "https://horaeng.com/263"
    },
    "2024|9월": {
      "question": "https://horaeng.com/wp-content/uploads/2024학년도-9월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2024학년도-9월-모의평가-사회문화-해설.pdf",
      "page": "https://horaeng.com/267"
    },
    "2024|수능": {
      "question": "https://horaeng.com/wp-content/uploads/2024학년도-대학수학능력시험-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2024학년도-대학수학능력시험-사회문화-정답.pdf",
      "page": "https://horaeng.com/350"
    },
    "2025|6월": {
      "question": "https://horaeng.com/wp-content/uploads/2025학년도-6월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2025학년도-6월-모의평가-사회문화-정답.pdf",
      "page": "https://horaeng.com/279"
    },
    "2025|9월": {
      "question": "https://horaeng.com/wp-content/uploads/2025학년도-9월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2025학년도-9월-모의평가-사회문화-정답.pdf",
      "page": "https://horaeng.com/353"
    },
    "2026|6월": {
      "question": "https://horaeng.com/wp-content/uploads/2026학년도-6월-모의평가-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2026학년도-6월-모의평가-사회문화-정답.pdf",
      "page": "https://horaeng.com/438"
    },
    "2026|9월": {
      "question": "https://horaeng.com/wp-content/uploads/2025년-9월-고3-모의고사-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2025년-9월-고3-모의고사-사회문화-정답.pdf",
      "page": "https://horaeng.com/442"
    },
    "2026|수능": {
      "question": "https://horaeng.com/wp-content/uploads/2026학년도-대학수학능력시험-사회문화-문제.pdf",
      "answer": "https://horaeng.com/wp-content/uploads/2026학년도-대학수학능력시험-사회문화-정답.pdf",
      "page": "https://horaeng.com/446"
    }
  };
  const QUESTION_ROWS = [{
    "id": "KICE-2026-CSAT-01",
    "sub": "I-01",
    "year": 2026,
    "session": "수능",
    "number": 1,
    "answerNumber": 5,
    "correctRate": 91,
    "wrongRate": 9,
    "image": "assets/kice/2026-csat-01.webp"
  }, {
    "id": "KICE-2025-JUNE-01",
    "sub": "I-01",
    "year": 2025,
    "session": "6월",
    "number": 1,
    "answerNumber": 4,
    "correctRate": 74,
    "wrongRate": 26,
    "image": "assets/kice/2025-june-01.webp"
  }, {
    "id": "KICE-2024-CSAT-01",
    "sub": "I-01",
    "year": 2024,
    "session": "수능",
    "number": 1,
    "answerNumber": 4,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2024-csat-01.webp"
  }, {
    "id": "KICE-2023-CSAT-03",
    "sub": "I-01",
    "year": 2023,
    "session": "수능",
    "number": 3,
    "answerNumber": 5,
    "correctRate": 76,
    "wrongRate": 24,
    "image": "assets/kice/2023-csat-03.webp"
  }, {
    "id": "KICE-2022-SEPTEMBER-02",
    "sub": "I-01",
    "year": 2022,
    "session": "9월",
    "number": 2,
    "answerNumber": 3,
    "correctRate": 93,
    "wrongRate": 7,
    "image": "assets/kice/2022-september-02.webp"
  }, {
    "id": "KICE-2022-CSAT-03",
    "sub": "I-01",
    "year": 2022,
    "session": "수능",
    "number": 3,
    "answerNumber": 5,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2022-csat-03.webp"
  }, {
    "id": "KICE-2026-CSAT-05",
    "sub": "I-02",
    "year": 2026,
    "session": "수능",
    "number": 5,
    "answerNumber": 1,
    "correctRate": 53,
    "wrongRate": 47,
    "image": "assets/kice/2026-csat-05.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-04",
    "sub": "I-02",
    "year": 2025,
    "session": "9월",
    "number": 4,
    "answerNumber": 1,
    "correctRate": 78,
    "wrongRate": 22,
    "image": "assets/kice/2025-september-04.webp"
  }, {
    "id": "KICE-2025-JUNE-09",
    "sub": "I-02",
    "year": 2025,
    "session": "6월",
    "number": 9,
    "answerNumber": 5,
    "correctRate": 71,
    "wrongRate": 29,
    "image": "assets/kice/2025-june-09.webp"
  }, {
    "id": "KICE-2024-SEPTEMBER-03",
    "sub": "I-02",
    "year": 2024,
    "session": "9월",
    "number": 3,
    "answerNumber": 4,
    "correctRate": 76,
    "wrongRate": 24,
    "image": "assets/kice/2024-september-03.webp"
  }, {
    "id": "KICE-2023-SEPTEMBER-02",
    "sub": "I-02",
    "year": 2023,
    "session": "9월",
    "number": 2,
    "answerNumber": 3,
    "correctRate": 45,
    "wrongRate": 55,
    "image": "assets/kice/2023-september-02.webp"
  }, {
    "id": "KICE-2022-JUNE-02",
    "sub": "I-02",
    "year": 2022,
    "session": "6월",
    "number": 2,
    "answerNumber": 4,
    "correctRate": 56,
    "wrongRate": 44,
    "image": "assets/kice/2022-june-02.webp"
  }, {
    "id": "KICE-2026-JUNE-09",
    "sub": "I-03",
    "year": 2026,
    "session": "6월",
    "number": 9,
    "answerNumber": 2,
    "correctRate": 68,
    "wrongRate": 32,
    "image": "assets/kice/2026-june-09.webp"
  }, {
    "id": "KICE-2025-JUNE-05",
    "sub": "I-03",
    "year": 2025,
    "session": "6월",
    "number": 5,
    "answerNumber": 4,
    "correctRate": 80,
    "wrongRate": 20,
    "image": "assets/kice/2025-june-05.webp"
  }, {
    "id": "KICE-2024-SEPTEMBER-04",
    "sub": "I-03",
    "year": 2024,
    "session": "9월",
    "number": 4,
    "answerNumber": 1,
    "correctRate": 75,
    "wrongRate": 25,
    "image": "assets/kice/2024-september-04.webp"
  }, {
    "id": "KICE-2024-JUNE-02",
    "sub": "I-03",
    "year": 2024,
    "session": "6월",
    "number": 2,
    "answerNumber": 4,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2024-june-02.webp"
  }, {
    "id": "KICE-2023-SEPTEMBER-08",
    "sub": "I-03",
    "year": 2023,
    "session": "9월",
    "number": 8,
    "answerNumber": 2,
    "correctRate": 94,
    "wrongRate": 6,
    "image": "assets/kice/2023-september-08.webp"
  }, {
    "id": "KICE-2022-JUNE-11",
    "sub": "I-03",
    "year": 2022,
    "session": "6월",
    "number": 11,
    "answerNumber": 3,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2022-june-11.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-03",
    "sub": "II-01",
    "year": 2025,
    "session": "9월",
    "number": 3,
    "answerNumber": 4,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2025-september-03.webp"
  }, {
    "id": "KICE-2024-CSAT-07",
    "sub": "II-01",
    "year": 2024,
    "session": "수능",
    "number": 7,
    "answerNumber": 4,
    "correctRate": 64,
    "wrongRate": 36,
    "image": "assets/kice/2024-csat-07.webp"
  }, {
    "id": "KICE-2023-JUNE-08",
    "sub": "II-01",
    "year": 2023,
    "session": "6월",
    "number": 8,
    "answerNumber": 2,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2023-june-08.webp"
  }, {
    "id": "KICE-2022-CSAT-06",
    "sub": "II-01",
    "year": 2022,
    "session": "수능",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 79,
    "wrongRate": 21,
    "image": "assets/kice/2022-csat-06.webp"
  }, {
    "id": "KICE-2026-JUNE-08",
    "sub": "II-01",
    "year": 2026,
    "session": "6월",
    "number": 8,
    "answerNumber": 2,
    "correctRate": 72,
    "wrongRate": 28,
    "image": "assets/kice/2026-june-08.webp"
  }, {
    "id": "KICE-2022-JUNE-13",
    "sub": "II-01",
    "year": 2022,
    "session": "6월",
    "number": 13,
    "answerNumber": 1,
    "correctRate": 80,
    "wrongRate": 20,
    "image": "assets/kice/2022-june-13.webp"
  }, {
    "id": "KICE-2026-CSAT-02",
    "sub": "II-02",
    "year": 2026,
    "session": "수능",
    "number": 2,
    "answerNumber": 2,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2026-csat-02.webp"
  }, {
    "id": "KICE-2026-SEPTEMBER-07",
    "sub": "II-02",
    "year": 2026,
    "session": "9월",
    "number": 7,
    "answerNumber": 2,
    "correctRate": 63,
    "wrongRate": 37,
    "image": "assets/kice/2026-september-07.webp"
  }, {
    "id": "KICE-2025-JUNE-07",
    "sub": "II-02",
    "year": 2025,
    "session": "6월",
    "number": 7,
    "answerNumber": 3,
    "correctRate": 84,
    "wrongRate": 16,
    "image": "assets/kice/2025-june-07.webp"
  }, {
    "id": "KICE-2024-JUNE-07",
    "sub": "II-02",
    "year": 2024,
    "session": "6월",
    "number": 7,
    "answerNumber": 4,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2024-june-07.webp"
  }, {
    "id": "KICE-2023-CSAT-08",
    "sub": "II-02",
    "year": 2023,
    "session": "수능",
    "number": 8,
    "answerNumber": 1,
    "correctRate": 93,
    "wrongRate": 7,
    "image": "assets/kice/2023-csat-08.webp"
  }, {
    "id": "KICE-2023-SEPTEMBER-07",
    "sub": "II-02",
    "year": 2023,
    "session": "9월",
    "number": 7,
    "answerNumber": 1,
    "correctRate": 83,
    "wrongRate": 17,
    "image": "assets/kice/2023-september-07.webp"
  }, {
    "id": "KICE-2026-CSAT-13",
    "sub": "II-03",
    "year": 2026,
    "session": "수능",
    "number": 13,
    "answerNumber": 2,
    "correctRate": 71,
    "wrongRate": 29,
    "image": "assets/kice/2026-csat-13.webp"
  }, {
    "id": "KICE-2025-JUNE-03",
    "sub": "II-03",
    "year": 2025,
    "session": "6월",
    "number": 3,
    "answerNumber": 3,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2025-june-03.webp"
  }, {
    "id": "KICE-2024-SEPTEMBER-07",
    "sub": "II-03",
    "year": 2024,
    "session": "9월",
    "number": 7,
    "answerNumber": 2,
    "correctRate": 41,
    "wrongRate": 59,
    "image": "assets/kice/2024-september-07.webp"
  }, {
    "id": "KICE-2023-CSAT-05",
    "sub": "II-03",
    "year": 2023,
    "session": "수능",
    "number": 5,
    "answerNumber": 5,
    "correctRate": 59,
    "wrongRate": 41,
    "image": "assets/kice/2023-csat-05.webp"
  }, {
    "id": "KICE-2022-SEPTEMBER-06",
    "sub": "II-03",
    "year": 2022,
    "session": "9월",
    "number": 6,
    "answerNumber": 5,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2022-september-06.webp"
  }, {
    "id": "KICE-2022-CSAT-18",
    "sub": "II-03",
    "year": 2022,
    "session": "수능",
    "number": 18,
    "answerNumber": 2,
    "correctRate": 48,
    "wrongRate": 52,
    "image": "assets/kice/2022-csat-18.webp"
  }, {
    "id": "KICE-2026-CSAT-09",
    "sub": "II-04",
    "year": 2026,
    "session": "수능",
    "number": 9,
    "answerNumber": 4,
    "correctRate": 71,
    "wrongRate": 29,
    "image": "assets/kice/2026-csat-09.webp"
  }, {
    "id": "KICE-2026-JUNE-14",
    "sub": "II-04",
    "year": 2026,
    "session": "6월",
    "number": 14,
    "answerNumber": 2,
    "correctRate": 83,
    "wrongRate": 17,
    "image": "assets/kice/2026-june-14.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-09",
    "sub": "II-04",
    "year": 2025,
    "session": "9월",
    "number": 9,
    "answerNumber": 1,
    "correctRate": 67,
    "wrongRate": 33,
    "image": "assets/kice/2025-september-09.webp"
  }, {
    "id": "KICE-2024-CSAT-11",
    "sub": "II-04",
    "year": 2024,
    "session": "수능",
    "number": 11,
    "answerNumber": 3,
    "correctRate": 72,
    "wrongRate": 28,
    "image": "assets/kice/2024-csat-11.webp"
  }, {
    "id": "KICE-2023-CSAT-07",
    "sub": "II-04",
    "year": 2023,
    "session": "수능",
    "number": 7,
    "answerNumber": 1,
    "correctRate": 42,
    "wrongRate": 58,
    "image": "assets/kice/2023-csat-07.webp"
  }, {
    "id": "KICE-2022-CSAT-02",
    "sub": "II-04",
    "year": 2022,
    "session": "수능",
    "number": 2,
    "answerNumber": 1,
    "correctRate": 95,
    "wrongRate": 5,
    "image": "assets/kice/2022-csat-02.webp"
  }, {
    "id": "KICE-2026-CSAT-04",
    "sub": "III-01",
    "year": 2026,
    "session": "수능",
    "number": 4,
    "answerNumber": 4,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2026-csat-04.webp"
  }, {
    "id": "KICE-2026-JUNE-06",
    "sub": "III-01",
    "year": 2026,
    "session": "6월",
    "number": 6,
    "answerNumber": 5,
    "correctRate": 70,
    "wrongRate": 30,
    "image": "assets/kice/2026-june-06.webp"
  }, {
    "id": "KICE-2025-JUNE-04",
    "sub": "III-01",
    "year": 2025,
    "session": "6월",
    "number": 4,
    "answerNumber": 1,
    "correctRate": 78,
    "wrongRate": 22,
    "image": "assets/kice/2025-june-04.webp"
  }, {
    "id": "KICE-2024-CSAT-06",
    "sub": "III-01",
    "year": 2024,
    "session": "수능",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 37,
    "wrongRate": 63,
    "image": "assets/kice/2024-csat-06.webp"
  }, {
    "id": "KICE-2023-JUNE-05",
    "sub": "III-01",
    "year": 2023,
    "session": "6월",
    "number": 5,
    "answerNumber": 1,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2023-june-05.webp"
  }, {
    "id": "KICE-2022-CSAT-14",
    "sub": "III-01",
    "year": 2022,
    "session": "수능",
    "number": 14,
    "answerNumber": 4,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2022-csat-14.webp"
  }, {
    "id": "KICE-2026-JUNE-05",
    "sub": "III-02",
    "year": 2026,
    "session": "6월",
    "number": 5,
    "answerNumber": 4,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2026-june-05.webp"
  }, {
    "id": "KICE-2026-SEPTEMBER-06",
    "sub": "III-02",
    "year": 2026,
    "session": "9월",
    "number": 6,
    "answerNumber": 5,
    "correctRate": 96,
    "wrongRate": 4,
    "image": "assets/kice/2026-september-06.webp"
  }, {
    "id": "KICE-2025-JUNE-06",
    "sub": "III-02",
    "year": 2025,
    "session": "6월",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 96,
    "wrongRate": 4,
    "image": "assets/kice/2025-june-06.webp"
  }, {
    "id": "KICE-2024-SEPTEMBER-02",
    "sub": "III-02",
    "year": 2024,
    "session": "9월",
    "number": 2,
    "answerNumber": 5,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2024-september-02.webp"
  }, {
    "id": "KICE-2023-CSAT-13",
    "sub": "III-02",
    "year": 2023,
    "session": "수능",
    "number": 13,
    "answerNumber": 5,
    "correctRate": 90,
    "wrongRate": 10,
    "image": "assets/kice/2023-csat-13.webp"
  }, {
    "id": "KICE-2022-JUNE-03",
    "sub": "III-02",
    "year": 2022,
    "session": "6월",
    "number": 3,
    "answerNumber": 5,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2022-june-03.webp"
  }, {
    "id": "KICE-2026-CSAT-07",
    "sub": "III-03",
    "year": 2026,
    "session": "수능",
    "number": 7,
    "answerNumber": 2,
    "correctRate": 69,
    "wrongRate": 31,
    "image": "assets/kice/2026-csat-07.webp"
  }, {
    "id": "KICE-2026-SEPTEMBER-12",
    "sub": "III-03",
    "year": 2026,
    "session": "9월",
    "number": 12,
    "answerNumber": 5,
    "correctRate": 72,
    "wrongRate": 28,
    "image": "assets/kice/2026-september-12.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-18",
    "sub": "III-03",
    "year": 2025,
    "session": "9월",
    "number": 18,
    "answerNumber": 5,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2025-september-18.webp"
  }, {
    "id": "KICE-2024-CSAT-14",
    "sub": "III-03",
    "year": 2024,
    "session": "수능",
    "number": 14,
    "answerNumber": 1,
    "correctRate": 63,
    "wrongRate": 37,
    "image": "assets/kice/2024-csat-14.webp"
  }, {
    "id": "KICE-2023-SEPTEMBER-12",
    "sub": "III-03",
    "year": 2023,
    "session": "9월",
    "number": 12,
    "answerNumber": 5,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2023-september-12.webp"
  }, {
    "id": "KICE-2022-CSAT-17",
    "sub": "III-03",
    "year": 2022,
    "session": "수능",
    "number": 17,
    "answerNumber": 1,
    "correctRate": 38,
    "wrongRate": 62,
    "image": "assets/kice/2022-csat-17.webp"
  }, {
    "id": "KICE-2026-CSAT-10",
    "sub": "IV-01",
    "year": 2026,
    "session": "수능",
    "number": 10,
    "answerNumber": 3,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2026-csat-10.webp"
  }, {
    "id": "KICE-2026-JUNE-07",
    "sub": "IV-01",
    "year": 2026,
    "session": "6월",
    "number": 7,
    "answerNumber": 5,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2026-june-07.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-06",
    "sub": "IV-01",
    "year": 2025,
    "session": "9월",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2025-september-06.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-10",
    "sub": "IV-01",
    "year": 2025,
    "session": "9월",
    "number": 10,
    "answerNumber": 3,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2025-september-10.webp"
  }, {
    "id": "KICE-2023-CSAT-12",
    "sub": "IV-01",
    "year": 2023,
    "session": "수능",
    "number": 12,
    "answerNumber": 4,
    "correctRate": 79,
    "wrongRate": 21,
    "image": "assets/kice/2023-csat-12.webp"
  }, {
    "id": "KICE-2022-SEPTEMBER-18",
    "sub": "IV-01",
    "year": 2022,
    "session": "9월",
    "number": 18,
    "answerNumber": 1,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2022-september-18.webp"
  }, {
    "id": "KICE-2026-CSAT-16",
    "sub": "IV-02",
    "year": 2026,
    "session": "수능",
    "number": 16,
    "answerNumber": 5,
    "correctRate": 78,
    "wrongRate": 22,
    "image": "assets/kice/2026-csat-16.webp"
  }, {
    "id": "KICE-2026-SEPTEMBER-16",
    "sub": "IV-02",
    "year": 2026,
    "session": "9월",
    "number": 16,
    "answerNumber": 1,
    "correctRate": 85,
    "wrongRate": 15,
    "image": "assets/kice/2026-september-16.webp"
  }, {
    "id": "KICE-2025-SEPTEMBER-19",
    "sub": "IV-02",
    "year": 2025,
    "session": "9월",
    "number": 19,
    "answerNumber": 3,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2025-september-19.webp"
  }, {
    "id": "KICE-2024-CSAT-17",
    "sub": "IV-02",
    "year": 2024,
    "session": "수능",
    "number": 17,
    "answerNumber": 5,
    "correctRate": 83,
    "wrongRate": 17,
    "image": "assets/kice/2024-csat-17.webp"
  }, {
    "id": "KICE-2023-CSAT-09",
    "sub": "IV-02",
    "year": 2023,
    "session": "수능",
    "number": 9,
    "answerNumber": 2,
    "correctRate": 56,
    "wrongRate": 44,
    "image": "assets/kice/2023-csat-09.webp"
  }, {
    "id": "KICE-2022-JUNE-19",
    "sub": "IV-02",
    "year": 2022,
    "session": "6월",
    "number": 19,
    "answerNumber": 1,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2022-june-19.webp"
  }, {
    "id": "KICE-2026-CSAT-15",
    "sub": "IV-03",
    "year": 2026,
    "session": "수능",
    "number": 15,
    "answerNumber": 5,
    "correctRate": 31,
    "wrongRate": 69,
    "image": "assets/kice/2026-csat-15.webp"
  }, {
    "id": "KICE-2026-SEPTEMBER-15",
    "sub": "IV-03",
    "year": 2026,
    "session": "9월",
    "number": 15,
    "answerNumber": 5,
    "correctRate": 31,
    "wrongRate": 69,
    "image": "assets/kice/2026-september-15.webp"
  }, {
    "id": "KICE-2025-JUNE-15",
    "sub": "IV-03",
    "year": 2025,
    "session": "6월",
    "number": 15,
    "answerNumber": 4,
    "correctRate": 60,
    "wrongRate": 40,
    "image": "assets/kice/2025-june-15.webp"
  }, {
    "id": "KICE-2024-CSAT-15",
    "sub": "IV-03",
    "year": 2024,
    "session": "수능",
    "number": 15,
    "answerNumber": 2,
    "correctRate": 42,
    "wrongRate": 58,
    "image": "assets/kice/2024-csat-15.webp"
  }, {
    "id": "KICE-2023-CSAT-15",
    "sub": "IV-03",
    "year": 2023,
    "session": "수능",
    "number": 15,
    "answerNumber": 4,
    "correctRate": 45,
    "wrongRate": 55,
    "image": "assets/kice/2023-csat-15.webp"
  }, {
    "id": "KICE-2022-JUNE-15",
    "sub": "IV-03",
    "year": 2022,
    "session": "6월",
    "number": 15,
    "answerNumber": 5,
    "correctRate": 55,
    "wrongRate": 45,
    "image": "assets/kice/2022-june-15.webp"
  }];
  const QUESTIONS = QUESTION_ROWS.map(row => {
    const source = KICE_SOURCES[`${row.year}|${row.session}`];
    return {
      ...row,
      source,
      type: 'choice',
      correct: row.answerNumber - 1,
      answer: CHOICE_MARKS[row.answerNumber - 1],
      prompt: `${row.year}학년도 ${row.session} 사회·문화 ${row.number}번`,
      weak: row.wrongRate >= 35
    };
  });
  window.SMSTUDY_DATA = Object.freeze({
    CHOICE_MARKS,
    KICE_SOURCES,
    QUESTIONS,
    QUESTION_ROWS,
    UNITS
  });
})();
