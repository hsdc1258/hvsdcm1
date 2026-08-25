(() => {
  'use strict';

  // 읽기 전용 학습 콘텐츠. 화면·상태 로직은 app.js에만 둔다.
  // 검증 불변식: 4개 대단원, 13개 소단원, 총 78문항.
  // 문항 수는 중단원마다 다르다(2~10). docs/kice-analysis.md §3의 sub 재분류 결과다.
  // 본문 문자열 계약: 한 문장·60자 이하·개행과 꺾쇠 없음 (docs/plan.md R1·R2).
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
        points: ['자연 현상은 인간의 의지와 무관하게 일어나고 필연성이 강하다.', '사회·문화 현상은 인간의 가치와 의지가 개입해 개연성이 강하다.', '두 현상 모두 경험 자료로 규칙성을 찾을 수 있다.'],
        trap: '지문에 없는 인간의 배경을 상상해 자연 현상을 뒤집지 않는다.'
      }, {
        title: '거시 관점: 기능론과 갈등론',
        points: ['기능론은 합의와 통합으로 사회 질서를 설명한다.', '갈등론은 지배 집단의 강제와 구조적 모순을 강조한다.', '기능론은 기존 질서 옹호, 갈등론은 통합 경시라는 비판을 받는다.'],
        trap: '지배적 규범이라는 말만으로 갈등론이라고 단정하지 않는다.'
      }, {
        title: '미시 관점: 상징적 상호 작용론',
        points: ['개인은 상징을 주고받으며 상황에 의미를 부여한다.', '행위자는 구조에 끌려가지 않고 상황 정의에 따라 행동한다.', '일상은 깊게 설명하지만 거시 구조의 영향은 놓칠 수 있다.'],
        trap: '기능론과 갈등론은 거시, 상징적 상호 작용론은 미시 관점이다.'
      }]
    }, {
      id: 'I-02',
      title: '사회·문화 현상의 탐구 방법',
      time: 32,
      keywords: '양적·질적 연구 · 가설과 변수 · 실험과 통제 · 1차·2차 자료 · 가치 중립',
      sections: [{
        title: '양적 연구와 질적 연구',
        points: ['양적 연구는 방법론적 일원론에 서서 수치로 변수 관계를 검증한다.', '질적 연구는 방법론적 이원론에 서서 행위의 의미와 맥락을 이해한다.', '질문지법·실험법은 양적, 면접법·참여 관찰법은 질적 연구의 대표다.'],
        trap: '방법론적 일원론과 이원론을 서로 바꿔 서술한 선지가 반복된다.'
      }, {
        title: '가설·변수·가치 중립',
        points: ['독립 변수는 원인, 종속 변수는 그에 따라 달라지는 결과다.', '조작적 정의는 추상적 개념을 측정 가능한 지표로 바꾸는 일이다.', '주제 선택과 결과 활용에는 가치가 개입해도 검증 단계는 중립이다.'],
        trap: '가설의 방향을 정과 부로 뒤집어 서술한 선지를 조심한다.'
      }, {
        title: '자료의 종류와 다섯 수집법',
        points: ['현재 연구 목적으로 직접 모은 것만 1차 자료다.', '실험법은 독립 변수를 조작하고 다른 조건을 통제해야 성립한다.', '문헌 연구법은 양적 연구와 질적 연구 모두에서 쓸 수 있다.'],
        trap: '질문지법 조사에 실험집단과 통제집단을 끌어오는 선지를 거른다.'
      }]
    }, {
      id: 'I-03',
      title: '사회·문화 현상의 탐구와 연구 윤리',
      time: 10,
      keywords: '연구 대상자 보호 · 사전 동의 · 익명성 · 사후 설명 · 연구 진실성',
      sections: [{
        title: '연구 대상자 보호',
        points: ['자발적 참여와 충분한 설명에 기초한 동의가 원칙이다.', '개인 정보와 신원은 수집 단계부터 보호해야 한다.', '과학적 엄밀성과 충돌하면 연구 윤리를 우선한다.'],
        trap: '자료의 객관성 확보를 이유로 목적 미고지를 정당화하지 않는다.'
      }, {
        title: '익명성과 사후 설명',
        points: ['익명성은 자료와 신원을 아예 연결할 수 없게 만드는 것이다.', '비밀 보장은 신원을 알아도 외부에 공개하지 않는 것이다.', '목적을 숨겼다면 연구 후 설명하고 사후 동의를 받아야 한다.'],
        trap: '개인 정보만 지우면 익명성이 보장된다고 판단하지 않는다.'
      }, {
        title: '연구 진실성',
        points: ['자료를 위조하거나 변조하고 결과를 과장하지 않는다.', '타인의 아이디어와 표현은 출처를 밝히고 인용한다.', '연구 성과의 크기는 윤리 위반을 상쇄하지 못한다.'],
        trap: '성과가 좋으면 일부 위반이 허용된다는 선지는 언제나 오답이다.'
      }]
    }]
  }, {
    id: 'II',
    title: '개인과 사회 구조',
    desc: '사회화, 지위와 역할, 사회 구조, 집단·조직, 일탈',
    subs: [{
      id: 'II-01',
      title: '사회화와 사회적 상호 작용',
      time: 20,
      keywords: '사회화 기관 · 예기 사회화 · 재사회화 · 지위 · 역할 · 역할 갈등',
      sections: [{
        title: '사회화와 사회화 기관',
        points: ['사회화는 문화를 내면화하며 자아를 만드는 평생 과정이다.', '1차적 기관은 인성을, 2차적 기관은 전문 지식과 역할을 가르친다.', '사회화가 본래 목적인 기관만 공식적 사회화 기관이다.'],
        trap: '회사는 공식 조직이지만 비공식적 사회화 기관이다.'
      }, {
        title: '예기 사회화와 재사회화',
        points: ['예기 사회화는 앞으로 속할 집단의 규범을 미리 배우는 것이다.', '재사회화는 바뀐 환경에 맞춰 규범과 기술을 다시 배우는 것이다.', '한 사례에서 두 사회화가 겹쳐 나타날 수 있다.'],
        trap: '무엇이 되기 위한 사회화인지 대상을 반대로 지정하지 않는다.'
      }, {
        title: '지위·역할·역할 갈등',
        points: ['귀속 지위는 주어지고 성취 지위는 노력으로 얻는다.', '역할은 사회의 기대이고 역할 행동은 실제로 한 행동이다.', '보상과 제재는 역할이 아니라 역할 행동에 내려진다.'],
        trap: '서로 다른 두 지위의 기대가 충돌해야만 역할 갈등이다.'
      }]
    }, {
      id: 'II-02',
      title: '사회 구조와 개인의 삶',
      time: 17,
      keywords: '사회 명목론 · 사회 실재론 · 외재성 · 구속성 · 사회 구조',
      sections: [{
        title: '사회 명목론',
        points: ['사회는 개인들의 합에 붙인 이름일 뿐이라고 본다.', '개인의 자율성과 능동성을 사회보다 앞세운다.', '사회 계약론과 개인주의가 같은 계열에 놓인다.'],
        trap: '사회 속성이 개인 속성으로 환원된다는 서술은 명목론이다.'
      }, {
        title: '사회 실재론',
        points: ['사회는 개인의 합을 넘어 독자적으로 존재한다고 본다.', '규범과 제도는 개인 바깥에 있고 행동을 구속한다.', '사회 유기체론과 전체론이 같은 계열에 놓인다.'],
        trap: '구조화된 행동을 강조하면 명목론이 아니라 실재론이다.'
      }, {
        title: '사회 구조의 성격',
        points: ['사회 구조는 지위와 역할과 제도가 이루는 안정된 관계 양식이다.', '지속성과 예측 가능성이 있으나 영원히 고정되지는 않는다.', '개인은 구조의 제약 안에서 구조를 바꾸기도 한다.'],
        trap: '실재론을 기능론이나 갈등론과 같은 말로 바꾸지 않는다.'
      }]
    }, {
      id: 'II-03',
      title: '사회 집단과 사회 조직의 이해',
      time: 30,
      keywords: '내·외·준거 집단 · 공동 사회 · 이익 사회 · 공식 조직 · 자발적 결사체 · 관료제',
      sections: [{
        title: '사회 집단의 분류 축',
        points: ['내집단과 외집단은 우리라는 소속감으로 가른다.', '준거 집단은 소속과 무관하게 판단의 기준이 되는 집단이다.', '1차 집단은 전인격적 접촉, 2차 집단은 수단적 접촉이 기준이다.'],
        trap: '공동 사회와 1차 집단은 기준이 달라 항상 일치하지 않는다.'
      }, {
        title: '조직의 세 범주와 겹침',
        points: ['공식 조직은 명시적 규칙과 지위 체계를 갖춘 조직이다.', '비공식 조직은 공식 조직 안의 친밀한 관계에서 생긴다.', '자발적 결사체는 공식 조직일 수도 비공식 조직일 수도 있다.'],
        trap: '개수 세기 문항은 한 사람의 이중 소속을 빠뜨리기 쉽다.'
      }, {
        title: '관료제와 탈관료제',
        points: ['관료제는 위계와 규칙과 연공서열로 예측 가능성을 높인다.', '탈관료제는 수평적 결정과 능력 중심 보상으로 유연성을 얻는다.', '목적 전치는 규칙 자체가 목적이 되는 관료제의 역기능이다.'],
        trap: '탄력적 대응 강조를 목적 전치와 연결하는 선지를 거른다.'
      }]
    }, {
      id: 'II-04',
      title: '일탈 행동의 원인과 해결 방안',
      time: 22,
      keywords: '뒤르켐 아노미 · 머튼 아노미 · 차별 교제 · 낙인 · 1차·2차 일탈',
      sections: [{
        title: '아노미 이론 두 갈래',
        points: ['뒤르켐은 급격한 변동으로 규범이 약해진 상태를 원인으로 본다.', '머튼은 문화적 목표와 제도적 수단의 괴리를 원인으로 본다.', '뒤르켐은 규범 회복, 머튼은 합법적 기회 확대를 처방한다.'],
        trap: '전과자 같은 낱말만 보고 낙인 이론으로 넘겨짚지 않는다.'
      }, {
        title: '차별 교제 이론',
        points: ['일탈은 친밀한 집단과의 접촉에서 학습된다고 본다.', '배우는 것은 일탈에 우호적인 정의와 일탈의 기술이다.', '처방은 접촉 환경을 바꾸고 건전한 교류를 늘리는 것이다.'],
        trap: '또래와의 교류를 강조하면 아노미가 아니라 차별 교제다.'
      }, {
        title: '낙인 이론과 2차 일탈',
        points: ['낙인 이론은 행위보다 사회적 반응이 일탈을 만든다고 본다.', '1차 일탈 뒤 낙인이 부정적 자아를 만들어 2차 일탈로 이어진다.', '처방은 신중한 제재와 낙인 최소화다.'],
        trap: '처벌 강화 처방은 낙인 이론과 반대 방향이다.'
      }]
    }]
  }, {
    id: 'III',
    title: '문화와 사회',
    desc: '문화의 속성, 하위문화와 대중문화, 문화 변동',
    subs: [{
      id: 'III-01',
      title: '문화의 이해',
      time: 22,
      keywords: '공유성 · 학습성 · 축적성 · 전체성 · 변동성 · 문화 이해 태도',
      sections: [{
        title: '문화의 다섯 속성',
        points: ['공유성은 구성원이 함께 나눠 행동을 예측하게 만든다.', '학습성은 후천적 습득, 축적성은 전승 위의 추가를 뜻한다.', '전체성은 요소 간 연결, 변동성은 시간에 따른 변화를 뜻한다.'],
        trap: '새 요소가 더해지면 축적성, 모습이 달라지면 변동성이다.'
      }, {
        title: '속성 판별 요령',
        points: ['사례 하나에 두 속성이 겹쳐 제시되므로 소거법으로 확정한다.', '전체성은 한 요소의 변화가 다른 영역을 바꿀 때 쓴다.', '문화 요소는 물질문화와 비물질문화로도 나뉜다.'],
        trap: '동질성을 강조하면 축적성이 아니라 공유성이다.'
      }, {
        title: '문화를 대하는 세 태도',
        points: ['자문화 중심주의는 자기 문화를 절대 기준으로 삼는다.', '문화 사대주의는 다른 문화를 절대 기준으로 삼는다.', '문화 상대주의는 그 사회의 맥락에서 문화를 이해한다.'],
        trap: '보편 윤리로 비판하는 발언은 문화 상대주의가 아니다.'
      }]
    }, {
      id: 'III-02',
      title: '다양한 하위문화와 현대의 대중문화',
      time: 14,
      keywords: '주류 문화 · 하위문화 · 반문화 · 문화의 지위 변화 · 대중문화의 역기능',
      sections: [{
        title: '주류·하위·반문화의 포함',
        points: ['하위문화는 특정 집단만 공유하는 독특한 문화다.', '반문화는 주류 가치에 저항하는 하위문화의 일부다.', '모든 반문화는 하위문화지만 그 역은 성립하지 않는다.'],
        trap: '반문화의 범위를 하위문화 전체로 넓히지 않는다.'
      }, {
        title: '문화 지위의 변화',
        points: ['반문화가 널리 수용되면 주류 문화가 될 수 있다.', '반문화 여부는 시대와 사회에 따라 상대적으로 정해진다.', '하위문화는 구성원의 소속감과 사회의 다양성을 높인다.'],
        trap: '상대적으로 정해지는 성질을 하위문화 자체 속성으로 쓰지 않는다.'
      }, {
        title: '대중문화의 역기능',
        points: ['상업성은 이윤을 위해 자극과 선정성을 키운다.', '획일화는 표준화된 상품이 반복되며 개성을 지운다.', '순기능인 향유 기회 확대와 함께 판단해야 한다.'],
        trap: '상업성 비판을 정부 통제나 계층 취향 강요와 섞지 않는다.'
      }]
    }, {
      id: 'III-03',
      title: '문화의 변동과 한국 문화의 세계화',
      time: 26,
      keywords: '발명 · 발견 · 직접 전파 · 간접 전파 · 자극 전파 · 공존 · 동화 · 융합',
      sections: [{
        title: '변동의 내재적 요인',
        points: ['발견은 이미 있던 것을 새로 알아내는 일이다.', '발명은 없던 문화 요소를 새로 만드는 일이다.', '물질문화와 비물질문화 모두 발명의 대상이 된다.'],
        trap: '자극 전파를 내재적 요인 쪽으로 분류하지 않는다.'
      }, {
        title: '전파의 세 경로',
        points: ['직접 전파는 사람 사이의 직접 접촉으로 일어난다.', '간접 전파는 책과 방송과 인터넷 같은 매체를 거친다.', '자극 전파는 외부 아이디어가 새 발명을 촉발한 경우다.'],
        trap: '아이디어만 얻어 새로 만들었다면 직접 전파가 아니다.'
      }, {
        title: '접변의 결과와 강제성',
        points: ['문화 공존은 두 문화의 정체성이 모두 남는 결과다.', '문화 동화는 한쪽의 정체성이 사라지는 결과다.', '문화 융합은 제3의 새로운 문화가 생기는 결과다.'],
        trap: '강제성은 접촉의 성격이지 결과를 정하지 않는다.'
      }]
    }]
  }, {
    id: 'IV',
    title: '사회 계층과 불평등',
    desc: '계층 관점과 이동, 빈곤·성·소수자, 사회 복지 제도',
    subs: [{
      id: 'IV-01',
      title: '사회 계층화 현상의 이해',
      time: 26,
      keywords: '기능론 · 갈등론 · 계층 구조 유형 · 세대 간 이동 · 세대 내 이동 · 비율 계산',
      sections: [{
        title: '계층화를 보는 관점',
        points: ['기능론은 차등 보상이 인재 배치에 필요하다고 본다.', '갈등론은 분배 기준에 지배 집단의 이익이 반영된다고 본다.', '상징적 상호 작용론은 계층에 대한 개인의 의미 부여를 본다.'],
        trap: '귀속적 요인 강조를 기능론의 특징으로 붙이지 않는다.'
      }, {
        title: '계층 구조의 유형',
        points: ['피라미드형은 하층, 다이아몬드형은 중층이 가장 두껍다.', '모래시계형은 중층이 얇고 상층과 하층이 두껍다.', '구조의 모양과 이동 가능성은 별개의 문제다.'],
        trap: '이동 실적만 보고 개방적 구조라고 단정하지 않는다.'
      }, {
        title: '사회 이동 자료 읽기',
        points: ['세대 간 이동은 부모와 자녀, 세대 내 이동은 한 사람의 두 시점이다.', '이동표의 대각선은 대물림, 대각선 밖은 상승이나 하강이다.', '빈칸은 행과 열의 합계로 역산해 먼저 채운다.'],
        trap: '두 시점의 비율이 같아도 이동이 상쇄됐을 수 있다.'
      }]
    }, {
      id: 'IV-02',
      title: '다양한 사회적 불평등과 해결 방안',
      time: 18,
      keywords: '절대적 빈곤 · 상대적 빈곤 · 빈곤선 · 사회적 소수자 · 성 불평등 · 우대 조치',
      sections: [{
        title: '절대적 빈곤과 상대적 빈곤',
        points: ['절대적 빈곤은 최저 생활에 필요한 자원이 부족한 상태다.', '상대적 빈곤은 사회의 일반 수준에 크게 못 미치는 상태다.', '두 빈곤은 배타적이지 않아 한 가구가 동시에 해당할 수 있다.'],
        trap: '중위 소득 미달을 곧바로 상대적 빈곤으로 일반화하지 않는다.'
      }, {
        title: '빈곤선과 빈곤율',
        points: ['빈곤선은 빈곤 여부를 가르는 소득 기준 금액이다.', '빈곤율은 그 기준 아래에 있는 가구나 개인의 비율이다.', '시대와 장소를 넘어 보편적인 것은 절대적 빈곤의 기준선이다.'],
        trap: '상대적 빈곤선이 어디서나 같다고 서술한 선지를 거른다.'
      }, {
        title: '사회적 소수자와 우대 조치',
        points: ['사회적 소수자는 수가 아니라 권력상 열세로 규정된다.', '식별 가능성과 차별과 집단 정체성이 함께 요구된다.', '적극적 우대 조치는 구조적 불이익을 보정하는 정책이다.'],
        trap: '차별 금지로 차별이 사라진 것을 우대 혜택으로 읽지 않는다.'
      }]
    }, {
      id: 'IV-03',
      title: '불평등 해소를 위한 사회 복지 제도',
      time: 32,
      keywords: '사회 보험 · 공공 부조 · 사회 서비스 · 중복 수급 · 집합 계산 · 재분배 효과',
      sections: [{
        title: '세 제도 식별',
        points: ['사회 보험은 보험료를 분담하고 자격자를 강제로 가입시킨다.', '공공 부조는 소득 조사로 선별해 조세로 최저 생활을 보장한다.', '사회 서비스는 상담과 돌봄 같은 비금전적 지원이 중심이다.'],
        trap: '강제 가입은 사회 보험, 비금전 지원은 사회 서비스의 단서다.'
      }, {
        title: '재분배 효과와 부담',
        points: ['재분배 효과는 공공 부조가 가장 강하고 사회 보험은 약하다.', '수혜자 부담은 사회 보험에 있고 공공 부조에는 없다.', '사회 서비스는 이용자가 비용을 일부 낼 수 있다.'],
        trap: '사회 서비스가 언제나 무료라고 판단하지 않는다.'
      }, {
        title: '중복 수급 집합 계산',
        points: ['세 제도의 수급자는 서로 배타적이지 않고 겹칠 수 있다.', '두 제도 수혜자 수에는 3중 수혜자가 이미 포함돼 있다.', '비율만 주어지면 시점별 전체 인구를 곱해 인원으로 바꾼다.'],
        trap: '비율끼리 직접 비교하면 인구 증가 조건을 놓친다.'
      }]
    }]
  }];

  // 정확한 한국어 개념도를 코드로 그리기 위한 읽기 전용 콘텐츠다.
  // 외부 이미지에 핵심 정보를 맡기지 않아 모바일·저속 환경에서도 학습 구조가 유지된다.
  const VISUAL_GUIDES = {
    'I-01': {
      question: '현상을 가르고 관점을 고르는 순서는 무엇인가?',
      flow: ['현상 구분', '분석 수준', '핵심 단서'],
      checks: ['인간의 의지가 개입했는지로 두 현상을 먼저 가른다.', '거시 관점은 구조를, 미시 관점은 상황 정의를 본다.', '합의와 강제와 의미 중 결정적 단서를 고른다.']
    },
    'I-02': {
      question: '사례에서 연구 방법을 어떤 순서로 찾아낼까?',
      flow: ['연구자의 행동', '대표 방법 연결', '변수와 표본'],
      checks: ['연구자가 실제로 한 행동에서 자료 수집법을 정한다.', '독립 변수와 종속 변수와 조작적 정의를 표시한다.', '모집단과 표본, 1차 자료와 2차 자료를 구분한다.']
    },
    'I-03': {
      question: '연구 윤리는 어느 지점에서 깨지는가?',
      flow: ['사전 동의', '정보 보호', '사후 설명'],
      checks: ['자발적 동의를 충분한 설명 위에서 받았는지 본다.', '신원 연결 차단과 외부 비공개를 나눠 확인한다.', '목적을 숨겼다면 사후 설명과 동의가 있었는지 본다.']
    },
    'II-01': {
      question: '지위와 역할을 사례에서 어떻게 분해할까?',
      flow: ['지위 표시', '기대와 행동', '갈등 판정'],
      checks: ['인물의 자리를 귀속 지위와 성취 지위로 나눈다.', '사회의 기대와 실제 행동을 따로 표시한다.', '서로 다른 두 지위의 기대가 충돌할 때만 역할 갈등이다.']
    },
    'II-02': {
      question: '개인과 사회 구조 중 무엇을 앞세우는가?',
      flow: ['주어 확인', '환원 여부', '구속성 확인'],
      checks: ['문장의 주어가 개인인지 사회 구조인지 본다.', '사회가 개인의 합으로 환원되면 명목론이다.', '규범이 개인 바깥에서 구속하면 실재론이다.']
    },
    'II-03': {
      question: '한 조직에 여러 분류표를 어떻게 겹쳐 놓을까?',
      flow: ['기준 하나씩', '겹침 표시', '마지막에 합산'],
      checks: ['분류 기준을 하나씩 적용하고 서로 섞지 않는다.', '공식 조직과 비공식 조직과 결사체의 교집합을 그린다.', '개수는 중복을 제거한 뒤 마지막에만 센다.']
    },
    'II-04': {
      question: '일탈 이론의 원인과 처방을 어떻게 잇는가?',
      flow: ['원인 진단', '학습 여부', '사회적 반응'],
      checks: ['규범 약화는 뒤르켐, 목표와 수단의 괴리는 머튼이다.', '친밀한 접촉으로 배웠다면 차별 교제 이론이다.', '낙인 뒤의 자아와 2차 일탈이면 낙인 이론이다.']
    },
    'III-01': {
      question: '문화의 속성과 태도를 어떤 기준으로 나눌까?',
      flow: ['속성 판별', '겹침 소거', '태도 판별'],
      checks: ['추가면 축적성, 시간에 따른 변화면 변동성이다.', '한 요소의 변화가 다른 영역을 바꾸면 전체성이다.', '우열을 매기면 절대주의, 맥락을 보면 상대주의다.']
    },
    'III-02': {
      question: '하위문화의 위치와 대중문화의 역기능은?',
      flow: ['공유 범위', '저항 여부', '지위 변화'],
      checks: ['공유 범위가 특정 집단이면 하위문화다.', '주류 가치에 저항할 때만 반문화로 좁힌다.', '상업성과 선정성과 획일화를 다른 비판과 섞지 않는다.']
    },
    'III-03': {
      question: '문화가 왜 변했고 무엇이 남았는가?',
      flow: ['시작점 확인', '전파 경로', '접변 결과'],
      checks: ['변화가 내부에서 시작됐는지 외부 접촉인지 가른다.', '직접과 간접과 자극 중 어느 경로인지 확인한다.', '정체성이 모두 남았는지 하나 사라졌는지 본다.']
    },
    'IV-01': {
      question: '계층 이론과 이동 자료를 어떻게 잇는가?',
      flow: ['관점 판정', '구조 유형', '이동표 판독'],
      checks: ['차등 보상은 기능론, 지배 집단 이익은 갈등론이다.', '어느 층이 가장 두꺼운지로 구조 유형을 정한다.', '빈칸을 합계로 역산한 뒤 대각선 안팎을 나눈다.']
    },
    'IV-02': {
      question: '불평등 유형마다 판단 기준이 어떻게 다른가?',
      flow: ['빈곤 기준', '소수자 조건', '정책 성격'],
      checks: ['최저 생활 기준이면 절대적, 사회 평균 대비면 상대적이다.', '수가 아니라 권력상 열세와 차별로 소수자를 정한다.', '형식적 동일 대우인지 실질적 보정인지 구분한다.']
    },
    'IV-03': {
      question: '복지 자료 문제를 어떤 순서로 풀까?',
      flow: ['제도 식별', '집합 표시', '마지막에 계산'],
      checks: ['강제 가입과 소득 조사와 비금전 지원으로 이름을 붙인다.', '중복 수혜자와 3중 수혜자를 벤 다이어그램에 먼저 적는다.', '비율을 인원으로 바꾼 뒤에만 크기를 비교한다.']
    }
  };

  for (const unit of UNITS) {
    for (const sub of unit.subs) sub.visual = VISUAL_GUIDES[sub.id];
  }

  // 2022~2026학년도 평가원 6월·9월·수능 원문에서 선별한 실기출 78문항.
  // 문항·정답은 원문 PDF/정답표 대조, 정답률은 통사랑 문항별 집계로 검증했다.
  const CHOICE_MARKS = ['1', '2', '3', '4', '5'];
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
    "image": "assets/kice/2026-csat-01.webp",
    "tags": ["자연 현상·사회 문화 현상", "개연성과 확실성", "몰가치성과 가치 함축성"]
  }, {
    "id": "KICE-2025-JUNE-01",
    "sub": "I-01",
    "year": 2025,
    "session": "6월",
    "number": 1,
    "answerNumber": 4,
    "correctRate": 74,
    "wrongRate": 26,
    "image": "assets/kice/2025-june-01.webp",
    "tags": ["자연 현상·사회 문화 현상", "개연성과 확실성"]
  }, {
    "id": "KICE-2024-CSAT-01",
    "sub": "I-01",
    "year": 2024,
    "session": "수능",
    "number": 1,
    "answerNumber": 4,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2024-csat-01.webp",
    "tags": ["자연 현상·사회 문화 현상", "몰가치성과 가치 함축성"]
  }, {
    "id": "KICE-2023-CSAT-03",
    "sub": "I-01",
    "year": 2023,
    "session": "수능",
    "number": 3,
    "answerNumber": 5,
    "correctRate": 76,
    "wrongRate": 24,
    "image": "assets/kice/2023-csat-03.webp",
    "tags": ["기능론", "갈등론"]
  }, {
    "id": "KICE-2022-SEPTEMBER-02",
    "sub": "I-01",
    "year": 2022,
    "session": "9월",
    "number": 2,
    "answerNumber": 3,
    "correctRate": 93,
    "wrongRate": 7,
    "image": "assets/kice/2022-september-02.webp",
    "tags": ["기능론", "갈등론", "상징적 상호 작용론"]
  }, {
    "id": "KICE-2022-CSAT-03",
    "sub": "I-01",
    "year": 2022,
    "session": "수능",
    "number": 3,
    "answerNumber": 5,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2022-csat-03.webp",
    "tags": ["기능론", "갈등론", "상징적 상호 작용론"]
  }, {
    "id": "KICE-2026-CSAT-05",
    "sub": "I-02",
    "year": 2026,
    "session": "수능",
    "number": 5,
    "answerNumber": 1,
    "correctRate": 53,
    "wrongRate": 47,
    "image": "assets/kice/2026-csat-05.webp",
    "tags": ["가설 설정", "독립 변수와 종속 변수", "1차 자료와 2차 자료"]
  }, {
    "id": "KICE-2025-SEPTEMBER-04",
    "sub": "I-02",
    "year": 2025,
    "session": "9월",
    "number": 4,
    "answerNumber": 1,
    "correctRate": 78,
    "wrongRate": 22,
    "image": "assets/kice/2025-september-04.webp",
    "tags": ["자료 수집법 비교"]
  }, {
    "id": "KICE-2025-JUNE-09",
    "sub": "I-02",
    "year": 2025,
    "session": "6월",
    "number": 9,
    "answerNumber": 5,
    "correctRate": 71,
    "wrongRate": 29,
    "image": "assets/kice/2025-june-09.webp",
    "tags": ["자료 수집법 비교", "양적 연구와 질적 연구"]
  }, {
    "id": "KICE-2024-SEPTEMBER-03",
    "sub": "I-02",
    "year": 2024,
    "session": "9월",
    "number": 3,
    "answerNumber": 4,
    "correctRate": 76,
    "wrongRate": 24,
    "image": "assets/kice/2024-september-03.webp",
    "tags": ["실험법과 통제", "독립 변수와 종속 변수", "1차 자료와 2차 자료"]
  }, {
    "id": "KICE-2023-SEPTEMBER-02",
    "sub": "I-02",
    "year": 2023,
    "session": "9월",
    "number": 2,
    "answerNumber": 3,
    "correctRate": 45,
    "wrongRate": 55,
    "image": "assets/kice/2023-september-02.webp",
    "tags": ["조작적 정의", "실험법과 통제", "독립 변수와 종속 변수"]
  }, {
    "id": "KICE-2022-JUNE-02",
    "sub": "I-02",
    "year": 2022,
    "session": "6월",
    "number": 2,
    "answerNumber": 4,
    "correctRate": 56,
    "wrongRate": 44,
    "image": "assets/kice/2022-june-02.webp",
    "tags": ["모집단과 표본", "실험법과 통제", "독립 변수와 종속 변수"]
  }, {
    "id": "KICE-2026-JUNE-09",
    "sub": "I-02",
    "year": 2026,
    "session": "6월",
    "number": 9,
    "answerNumber": 2,
    "correctRate": 68,
    "wrongRate": 32,
    "image": "assets/kice/2026-june-09.webp",
    "tags": ["조작적 정의", "모집단과 표본", "양적 연구와 질적 연구"]
  }, {
    "id": "KICE-2025-JUNE-05",
    "sub": "I-02",
    "year": 2025,
    "session": "6월",
    "number": 5,
    "answerNumber": 4,
    "correctRate": 80,
    "wrongRate": 20,
    "image": "assets/kice/2025-june-05.webp",
    "tags": ["자료 수집법 비교", "모집단과 표본", "독립 변수와 종속 변수"]
  }, {
    "id": "KICE-2024-SEPTEMBER-04",
    "sub": "I-03",
    "year": 2024,
    "session": "9월",
    "number": 4,
    "answerNumber": 1,
    "correctRate": 75,
    "wrongRate": 25,
    "image": "assets/kice/2024-september-04.webp",
    "tags": ["연구 대상자 보호", "익명성과 비밀 보장"]
  }, {
    "id": "KICE-2024-JUNE-02",
    "sub": "I-02",
    "year": 2024,
    "session": "6월",
    "number": 2,
    "answerNumber": 4,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2024-june-02.webp",
    "tags": ["가설 설정", "1차 자료와 2차 자료"]
  }, {
    "id": "KICE-2023-SEPTEMBER-08",
    "sub": "I-03",
    "year": 2023,
    "session": "9월",
    "number": 8,
    "answerNumber": 2,
    "correctRate": 94,
    "wrongRate": 6,
    "image": "assets/kice/2023-september-08.webp",
    "tags": ["연구 대상자 보호", "사전 동의", "익명성과 비밀 보장"]
  }, {
    "id": "KICE-2022-JUNE-11",
    "sub": "I-02",
    "year": 2022,
    "session": "6월",
    "number": 11,
    "answerNumber": 3,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2022-june-11.webp",
    "tags": ["양적 연구와 질적 연구", "가치 중립"]
  }, {
    "id": "KICE-2025-SEPTEMBER-03",
    "sub": "II-01",
    "year": 2025,
    "session": "9월",
    "number": 3,
    "answerNumber": 4,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2025-september-03.webp",
    "tags": ["지위와 역할", "역할 갈등", "예기 사회화와 재사회화"]
  }, {
    "id": "KICE-2024-CSAT-07",
    "sub": "II-03",
    "year": 2024,
    "session": "수능",
    "number": 7,
    "answerNumber": 4,
    "correctRate": 64,
    "wrongRate": 36,
    "image": "assets/kice/2024-csat-07.webp",
    "tags": ["공동 사회와 이익 사회", "1차 집단과 2차 집단", "집단 개수 세기"]
  }, {
    "id": "KICE-2023-JUNE-08",
    "sub": "II-01",
    "year": 2023,
    "session": "6월",
    "number": 8,
    "answerNumber": 2,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2023-june-08.webp",
    "tags": ["사회화 기관", "역할 갈등", "지위와 역할"]
  }, {
    "id": "KICE-2022-CSAT-06",
    "sub": "II-01",
    "year": 2022,
    "session": "수능",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 79,
    "wrongRate": 21,
    "image": "assets/kice/2022-csat-06.webp",
    "tags": ["지위와 역할", "역할 갈등", "예기 사회화와 재사회화"]
  }, {
    "id": "KICE-2026-JUNE-08",
    "sub": "II-01",
    "year": 2026,
    "session": "6월",
    "number": 8,
    "answerNumber": 2,
    "correctRate": 72,
    "wrongRate": 28,
    "image": "assets/kice/2026-june-08.webp",
    "tags": ["지위와 역할", "사회화 기관"]
  }, {
    "id": "KICE-2022-JUNE-13",
    "sub": "II-01",
    "year": 2022,
    "session": "6월",
    "number": 13,
    "answerNumber": 1,
    "correctRate": 80,
    "wrongRate": 20,
    "image": "assets/kice/2022-june-13.webp",
    "tags": ["사회화 기관", "지위와 역할", "역할 갈등"]
  }, {
    "id": "KICE-2026-CSAT-02",
    "sub": "II-02",
    "year": 2026,
    "session": "수능",
    "number": 2,
    "answerNumber": 2,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2026-csat-02.webp",
    "tags": ["사회 실재론", "사회 명목론"]
  }, {
    "id": "KICE-2026-SEPTEMBER-07",
    "sub": "II-02",
    "year": 2026,
    "session": "9월",
    "number": 7,
    "answerNumber": 2,
    "correctRate": 63,
    "wrongRate": 37,
    "image": "assets/kice/2026-september-07.webp",
    "tags": ["사회 실재론", "사회 명목론"]
  }, {
    "id": "KICE-2025-JUNE-07",
    "sub": "II-02",
    "year": 2025,
    "session": "6월",
    "number": 7,
    "answerNumber": 3,
    "correctRate": 84,
    "wrongRate": 16,
    "image": "assets/kice/2025-june-07.webp",
    "tags": ["사회 실재론", "사회 구조의 구속성"]
  }, {
    "id": "KICE-2024-JUNE-07",
    "sub": "II-02",
    "year": 2024,
    "session": "6월",
    "number": 7,
    "answerNumber": 4,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2024-june-07.webp",
    "tags": ["사회 실재론", "사회 구조의 구속성"]
  }, {
    "id": "KICE-2023-CSAT-08",
    "sub": "II-02",
    "year": 2023,
    "session": "수능",
    "number": 8,
    "answerNumber": 1,
    "correctRate": 93,
    "wrongRate": 7,
    "image": "assets/kice/2023-csat-08.webp",
    "tags": ["사회 명목론", "개인의 능동성"]
  }, {
    "id": "KICE-2023-SEPTEMBER-07",
    "sub": "II-02",
    "year": 2023,
    "session": "9월",
    "number": 7,
    "answerNumber": 1,
    "correctRate": 83,
    "wrongRate": 17,
    "image": "assets/kice/2023-september-07.webp",
    "tags": ["사회 실재론", "사회 구조의 구속성"]
  }, {
    "id": "KICE-2026-CSAT-13",
    "sub": "II-03",
    "year": 2026,
    "session": "수능",
    "number": 13,
    "answerNumber": 2,
    "correctRate": 71,
    "wrongRate": 29,
    "image": "assets/kice/2026-csat-13.webp",
    "tags": ["관료제와 탈관료제", "목적 전치"]
  }, {
    "id": "KICE-2025-JUNE-03",
    "sub": "II-03",
    "year": 2025,
    "session": "6월",
    "number": 3,
    "answerNumber": 3,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2025-june-03.webp",
    "tags": ["관료제와 탈관료제", "목적 전치"]
  }, {
    "id": "KICE-2024-SEPTEMBER-07",
    "sub": "II-03",
    "year": 2024,
    "session": "9월",
    "number": 7,
    "answerNumber": 2,
    "correctRate": 41,
    "wrongRate": 59,
    "image": "assets/kice/2024-september-07.webp",
    "tags": ["공식 조직과 비공식 조직", "자발적 결사체", "집단 개수 세기"]
  }, {
    "id": "KICE-2023-CSAT-05",
    "sub": "II-03",
    "year": 2023,
    "session": "수능",
    "number": 5,
    "answerNumber": 5,
    "correctRate": 59,
    "wrongRate": 41,
    "image": "assets/kice/2023-csat-05.webp",
    "tags": ["공식 조직과 비공식 조직", "자발적 결사체", "집단 개수 세기"]
  }, {
    "id": "KICE-2022-SEPTEMBER-06",
    "sub": "II-03",
    "year": 2022,
    "session": "9월",
    "number": 6,
    "answerNumber": 5,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2022-september-06.webp",
    "tags": ["공동 사회와 이익 사회", "1차 집단과 2차 집단", "자발적 결사체"]
  }, {
    "id": "KICE-2022-CSAT-18",
    "sub": "II-03",
    "year": 2022,
    "session": "수능",
    "number": 18,
    "answerNumber": 2,
    "correctRate": 48,
    "wrongRate": 52,
    "image": "assets/kice/2022-csat-18.webp",
    "tags": ["공식 조직과 비공식 조직", "공동 사회와 이익 사회", "1차 집단과 2차 집단"]
  }, {
    "id": "KICE-2026-CSAT-09",
    "sub": "II-04",
    "year": 2026,
    "session": "수능",
    "number": 9,
    "answerNumber": 4,
    "correctRate": 71,
    "wrongRate": 29,
    "image": "assets/kice/2026-csat-09.webp",
    "tags": ["아노미 이론", "차별 교제 이론", "낙인 이론"]
  }, {
    "id": "KICE-2026-JUNE-14",
    "sub": "II-04",
    "year": 2026,
    "session": "6월",
    "number": 14,
    "answerNumber": 2,
    "correctRate": 83,
    "wrongRate": 17,
    "image": "assets/kice/2026-june-14.webp",
    "tags": ["아노미 이론", "차별 교제 이론", "낙인 이론"]
  }, {
    "id": "KICE-2025-SEPTEMBER-09",
    "sub": "II-04",
    "year": 2025,
    "session": "9월",
    "number": 9,
    "answerNumber": 1,
    "correctRate": 67,
    "wrongRate": 33,
    "image": "assets/kice/2025-september-09.webp",
    "tags": ["아노미 이론", "차별 교제 이론", "낙인 이론"]
  }, {
    "id": "KICE-2024-CSAT-11",
    "sub": "II-04",
    "year": 2024,
    "session": "수능",
    "number": 11,
    "answerNumber": 3,
    "correctRate": 72,
    "wrongRate": 28,
    "image": "assets/kice/2024-csat-11.webp",
    "tags": ["아노미 이론", "차별 교제 이론"]
  }, {
    "id": "KICE-2023-CSAT-07",
    "sub": "II-04",
    "year": 2023,
    "session": "수능",
    "number": 7,
    "answerNumber": 1,
    "correctRate": 42,
    "wrongRate": 58,
    "image": "assets/kice/2023-csat-07.webp",
    "tags": ["아노미 이론", "낙인 이론", "1차 일탈과 2차 일탈"]
  }, {
    "id": "KICE-2022-CSAT-02",
    "sub": "II-04",
    "year": 2022,
    "session": "수능",
    "number": 2,
    "answerNumber": 1,
    "correctRate": 95,
    "wrongRate": 5,
    "image": "assets/kice/2022-csat-02.webp",
    "tags": ["낙인 이론", "차별 교제 이론", "1차 일탈과 2차 일탈"]
  }, {
    "id": "KICE-2026-CSAT-04",
    "sub": "III-01",
    "year": 2026,
    "session": "수능",
    "number": 4,
    "answerNumber": 4,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2026-csat-04.webp",
    "tags": ["공유성과 학습성", "축적성과 변동성", "전체성"]
  }, {
    "id": "KICE-2026-JUNE-06",
    "sub": "III-01",
    "year": 2026,
    "session": "6월",
    "number": 6,
    "answerNumber": 5,
    "correctRate": 70,
    "wrongRate": 30,
    "image": "assets/kice/2026-june-06.webp",
    "tags": ["자문화 중심주의", "문화 사대주의", "문화 상대주의"]
  }, {
    "id": "KICE-2025-JUNE-04",
    "sub": "III-01",
    "year": 2025,
    "session": "6월",
    "number": 4,
    "answerNumber": 1,
    "correctRate": 78,
    "wrongRate": 22,
    "image": "assets/kice/2025-june-04.webp",
    "tags": ["공유성과 학습성", "축적성과 변동성"]
  }, {
    "id": "KICE-2024-CSAT-06",
    "sub": "III-01",
    "year": 2024,
    "session": "수능",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 37,
    "wrongRate": 63,
    "image": "assets/kice/2024-csat-06.webp",
    "tags": ["공유성과 학습성", "축적성과 변동성", "전체성"]
  }, {
    "id": "KICE-2023-JUNE-05",
    "sub": "III-01",
    "year": 2023,
    "session": "6월",
    "number": 5,
    "answerNumber": 1,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2023-june-05.webp",
    "tags": ["자문화 중심주의", "문화 사대주의", "문화 상대주의"]
  }, {
    "id": "KICE-2022-CSAT-14",
    "sub": "III-01",
    "year": 2022,
    "session": "수능",
    "number": 14,
    "answerNumber": 4,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2022-csat-14.webp",
    "tags": ["자문화 중심주의", "문화 사대주의", "문화 상대주의"]
  }, {
    "id": "KICE-2026-JUNE-05",
    "sub": "III-02",
    "year": 2026,
    "session": "6월",
    "number": 5,
    "answerNumber": 4,
    "correctRate": 92,
    "wrongRate": 8,
    "image": "assets/kice/2026-june-05.webp",
    "tags": ["하위문화와 반문화", "문화의 지위 변화"]
  }, {
    "id": "KICE-2026-SEPTEMBER-06",
    "sub": "III-02",
    "year": 2026,
    "session": "9월",
    "number": 6,
    "answerNumber": 5,
    "correctRate": 96,
    "wrongRate": 4,
    "image": "assets/kice/2026-september-06.webp",
    "tags": ["대중문화의 역기능"]
  }, {
    "id": "KICE-2025-JUNE-06",
    "sub": "III-02",
    "year": 2025,
    "session": "6월",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 96,
    "wrongRate": 4,
    "image": "assets/kice/2025-june-06.webp",
    "tags": ["대중문화의 역기능"]
  }, {
    "id": "KICE-2024-SEPTEMBER-02",
    "sub": "III-02",
    "year": 2024,
    "session": "9월",
    "number": 2,
    "answerNumber": 5,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2024-september-02.webp",
    "tags": ["하위문화와 반문화", "문화의 지위 변화"]
  }, {
    "id": "KICE-2023-CSAT-13",
    "sub": "III-02",
    "year": 2023,
    "session": "수능",
    "number": 13,
    "answerNumber": 5,
    "correctRate": 90,
    "wrongRate": 10,
    "image": "assets/kice/2023-csat-13.webp",
    "tags": ["하위문화와 반문화", "하위문화의 순기능"]
  }, {
    "id": "KICE-2022-JUNE-03",
    "sub": "III-02",
    "year": 2022,
    "session": "6월",
    "number": 3,
    "answerNumber": 5,
    "correctRate": 87,
    "wrongRate": 13,
    "image": "assets/kice/2022-june-03.webp",
    "tags": ["하위문화와 반문화", "주류 문화와의 포함 관계"]
  }, {
    "id": "KICE-2026-CSAT-07",
    "sub": "III-03",
    "year": 2026,
    "session": "수능",
    "number": 7,
    "answerNumber": 2,
    "correctRate": 69,
    "wrongRate": 31,
    "image": "assets/kice/2026-csat-07.webp",
    "tags": ["자극 전파", "직접 전파", "문화 융합"]
  }, {
    "id": "KICE-2026-SEPTEMBER-12",
    "sub": "III-03",
    "year": 2026,
    "session": "9월",
    "number": 12,
    "answerNumber": 5,
    "correctRate": 72,
    "wrongRate": 28,
    "image": "assets/kice/2026-september-12.webp",
    "tags": ["강제적 문화 접변", "자극 전파", "직접 전파"]
  }, {
    "id": "KICE-2025-SEPTEMBER-18",
    "sub": "III-03",
    "year": 2025,
    "session": "9월",
    "number": 18,
    "answerNumber": 5,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2025-september-18.webp",
    "tags": ["강제적 문화 접변", "자극 전파", "문화 동화"]
  }, {
    "id": "KICE-2024-CSAT-14",
    "sub": "III-03",
    "year": 2024,
    "session": "수능",
    "number": 14,
    "answerNumber": 1,
    "correctRate": 63,
    "wrongRate": 37,
    "image": "assets/kice/2024-csat-14.webp",
    "tags": ["문화 공존", "자극 전파", "간접 전파"]
  }, {
    "id": "KICE-2023-SEPTEMBER-12",
    "sub": "III-03",
    "year": 2023,
    "session": "9월",
    "number": 12,
    "answerNumber": 5,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2023-september-12.webp",
    "tags": ["발명과 발견", "자극 전파", "직접 전파"]
  }, {
    "id": "KICE-2022-CSAT-17",
    "sub": "III-03",
    "year": 2022,
    "session": "수능",
    "number": 17,
    "answerNumber": 1,
    "correctRate": 38,
    "wrongRate": 62,
    "image": "assets/kice/2022-csat-17.webp",
    "tags": ["발명과 발견", "자극 전파", "직접 전파"]
  }, {
    "id": "KICE-2026-CSAT-10",
    "sub": "IV-01",
    "year": 2026,
    "session": "수능",
    "number": 10,
    "answerNumber": 3,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2026-csat-10.webp",
    "tags": ["세대 간 이동", "계층 구조 유형", "표 역산 계산"]
  }, {
    "id": "KICE-2026-JUNE-07",
    "sub": "IV-01",
    "year": 2026,
    "session": "6월",
    "number": 7,
    "answerNumber": 5,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2026-june-07.webp",
    "tags": ["계층화를 보는 관점"]
  }, {
    "id": "KICE-2025-SEPTEMBER-06",
    "sub": "IV-01",
    "year": 2025,
    "session": "9월",
    "number": 6,
    "answerNumber": 2,
    "correctRate": 73,
    "wrongRate": 27,
    "image": "assets/kice/2025-september-06.webp",
    "tags": ["계층화를 보는 관점"]
  }, {
    "id": "KICE-2025-SEPTEMBER-10",
    "sub": "IV-01",
    "year": 2025,
    "session": "9월",
    "number": 10,
    "answerNumber": 3,
    "correctRate": 77,
    "wrongRate": 23,
    "image": "assets/kice/2025-september-10.webp",
    "tags": ["세대 간 이동", "세대 내 이동", "계층 구조 유형"]
  }, {
    "id": "KICE-2023-CSAT-12",
    "sub": "IV-01",
    "year": 2023,
    "session": "수능",
    "number": 12,
    "answerNumber": 4,
    "correctRate": 79,
    "wrongRate": 21,
    "image": "assets/kice/2023-csat-12.webp",
    "tags": ["계층 구조 유형", "비율과 실수 구분"]
  }, {
    "id": "KICE-2022-SEPTEMBER-18",
    "sub": "IV-01",
    "year": 2022,
    "session": "9월",
    "number": 18,
    "answerNumber": 1,
    "correctRate": 81,
    "wrongRate": 19,
    "image": "assets/kice/2022-september-18.webp",
    "tags": ["세대 간 이동", "세대 내 이동", "비율과 실수 구분"]
  }, {
    "id": "KICE-2026-CSAT-16",
    "sub": "IV-02",
    "year": 2026,
    "session": "수능",
    "number": 16,
    "answerNumber": 5,
    "correctRate": 78,
    "wrongRate": 22,
    "image": "assets/kice/2026-csat-16.webp",
    "tags": ["절대적 빈곤", "상대적 빈곤"]
  }, {
    "id": "KICE-2026-SEPTEMBER-16",
    "sub": "IV-02",
    "year": 2026,
    "session": "9월",
    "number": 16,
    "answerNumber": 1,
    "correctRate": 85,
    "wrongRate": 15,
    "image": "assets/kice/2026-september-16.webp",
    "tags": ["사회적 소수자", "적극적 우대 조치"]
  }, {
    "id": "KICE-2025-SEPTEMBER-19",
    "sub": "IV-02",
    "year": 2025,
    "session": "9월",
    "number": 19,
    "answerNumber": 3,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2025-september-19.webp",
    "tags": ["사회적 소수자", "성 불평등"]
  }, {
    "id": "KICE-2024-CSAT-17",
    "sub": "IV-02",
    "year": 2024,
    "session": "수능",
    "number": 17,
    "answerNumber": 5,
    "correctRate": 83,
    "wrongRate": 17,
    "image": "assets/kice/2024-csat-17.webp",
    "tags": ["절대적 빈곤", "상대적 빈곤"]
  }, {
    "id": "KICE-2023-CSAT-09",
    "sub": "IV-02",
    "year": 2023,
    "session": "수능",
    "number": 9,
    "answerNumber": 2,
    "correctRate": 56,
    "wrongRate": 44,
    "image": "assets/kice/2023-csat-09.webp",
    "tags": ["절대적 빈곤", "상대적 빈곤", "빈곤선과 빈곤율"]
  }, {
    "id": "KICE-2022-JUNE-19",
    "sub": "IV-02",
    "year": 2022,
    "session": "6월",
    "number": 19,
    "answerNumber": 1,
    "correctRate": 88,
    "wrongRate": 12,
    "image": "assets/kice/2022-june-19.webp",
    "tags": ["사회적 소수자", "성 불평등", "적극적 우대 조치"]
  }, {
    "id": "KICE-2026-CSAT-15",
    "sub": "IV-03",
    "year": 2026,
    "session": "수능",
    "number": 15,
    "answerNumber": 5,
    "correctRate": 31,
    "wrongRate": 69,
    "image": "assets/kice/2026-csat-15.webp",
    "tags": ["세 제도 식별", "중복 수급 집합 계산", "금전·비금전 급여"]
  }, {
    "id": "KICE-2026-SEPTEMBER-15",
    "sub": "IV-03",
    "year": 2026,
    "session": "9월",
    "number": 15,
    "answerNumber": 5,
    "correctRate": 31,
    "wrongRate": 69,
    "image": "assets/kice/2026-september-15.webp",
    "tags": ["세 제도 식별", "중복 수급 집합 계산", "강제 가입과 재분배"]
  }, {
    "id": "KICE-2025-JUNE-15",
    "sub": "IV-03",
    "year": 2025,
    "session": "6월",
    "number": 15,
    "answerNumber": 4,
    "correctRate": 60,
    "wrongRate": 40,
    "image": "assets/kice/2025-june-15.webp",
    "tags": ["세 제도 식별", "비율과 인구수 환산"]
  }, {
    "id": "KICE-2024-CSAT-15",
    "sub": "IV-03",
    "year": 2024,
    "session": "수능",
    "number": 15,
    "answerNumber": 2,
    "correctRate": 42,
    "wrongRate": 58,
    "image": "assets/kice/2024-csat-15.webp",
    "tags": ["중복 수급 집합 계산", "비율과 인구수 환산"]
  }, {
    "id": "KICE-2023-CSAT-15",
    "sub": "IV-03",
    "year": 2023,
    "session": "수능",
    "number": 15,
    "answerNumber": 4,
    "correctRate": 45,
    "wrongRate": 55,
    "image": "assets/kice/2023-csat-15.webp",
    "tags": ["세 제도 식별", "강제 가입과 재분배", "비율과 인구수 환산"]
  }, {
    "id": "KICE-2022-JUNE-15",
    "sub": "IV-03",
    "year": 2022,
    "session": "6월",
    "number": 15,
    "answerNumber": 5,
    "correctRate": 55,
    "wrongRate": 45,
    "image": "assets/kice/2022-june-15.webp",
    "tags": ["세 제도 식별", "중복 수급 집합 계산", "금전·비금전 급여"]
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
