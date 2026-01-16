// netlify/functions/solve.js
// --------------------------------------
// 역할: 한국외대(HUFS) 편입 영어 객관식 기출 "정답만" 생성하는 함수
// - 대상: 한국외대 편입영어 T1 / T2 시험지 (50문항, 60분)
// - 구조를 외대 전용으로 하드코딩해서 정확도 극대화
//
// 입력:  { ocrText: string, page?: number }
// 출력:  { ok: true, text: "1: A\n2: D\n...", debug: {...} }
// 실패:  { ok: false, error: "..." }
//
// 필요한 환경변수 (Netlify):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 기본 "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본 0)
// - STOP_TOKEN          (선택)

"use strict";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

// OpenRouter 호출 함수
async function callOpenRouter({ apiKey, model, systemPrompt, userContent, temperature }) {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
    max_tokens: 512,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error: ${res.status} ${res.statusText} ${text}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message || typeof choice.message.content !== "string") {
    throw new Error("OpenRouter response format error");
  }

  return {
    text: choice.message.content.trim(),
    finishReason: choice.finish_reason || "stop",
  };
}

// 외대 전용: 문항 번호 → 유형 매핑
function getQuestionType(q) {
  if (q >= 1 && q <= 9) return "vocab_basic";          // 동의어
  if (q >= 10 && q <= 13) return "vocab_context";      // 문맥상 동의어
  if (q >= 14 && q <= 17) return "logic_sentence";     // 의미 동일/논리완성 계열
  if (q >= 18 && q <= 21) return "grammar";            // 문법·재진술
  if (q >= 22 && q <= 30) return "reading_short";      // 짧은 독해
  if (q >= 31 && q <= 40) return "reading_mid";        // 중간 길이 독해 (2.5점)
  if (q >= 41 && q <= 50) return "reading_long";       // 장문 독해 (3점)
  return "unknown";
}

// 외대 전용: run별 가중치 설정
function getRunWeight(roleName, q) {
  const t = getQuestionType(q);

  // 기본 가중치 1
  let base = 1;

  if (t === "vocab_basic" || t === "vocab_context") {
    if (roleName === "lexical") base = 4;
    else if (roleName === "base") base = 2;
    else if (roleName === "logic") base = 1;
    else if (roleName === "reading") base = 1;
  } else if (t === "grammar") {
    if (roleName === "logic") base = 4;
    else if (roleName === "base") base = 2;
    else if (roleName === "lexical") base = 1;
    else if (roleName === "reading") base = 1;
  } else if (t === "logic_sentence") {
    if (roleName === "logic") base = 3;
    else if (roleName === "reading") base = 3;
    else if (roleName === "base") base = 2;
    else if (roleName === "lexical") base = 1;
  } else if (t === "reading_short" || t === "reading_mid") {
    if (roleName === "reading") base = 4;
    else if (roleName === "logic") base = 3;
    else if (roleName === "base") base = 2;
    else if (roleName === "lexical") base = 1;
  } else if (t === "reading_long") {
    // 41~50: 배점 최고, 실수 절대 금지 → reading/logic 강하게
    if (roleName === "reading") base = 5;
    else if (roleName === "logic") base = 4;
    else if (roleName === "base") base = 3;
    else if (roleName === "lexical") base = 1;
  }

  return base;
}

// OCR 텍스트에서 문항 번호 추출
function extractQuestionNumbers(ocrText) {
  const nums = new Set();

  // 가장 일반적인 패턴: "1." "2)" "24. "
  const re = /(?:^|\s|\[)(\d{1,2})[.)](?=\s)/g;
  let m;
  while ((m = re.exec(ocrText)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) nums.add(n);
  }

  const arr = Array.from(nums);
  arr.sort((a, b) => a - b);
  return arr;
}

// 선택지 정규화: A/B/C/D 이외는 null 로 처리 (투표에서 제외)
function normalizeChoice(ch) {
  if (!ch) return null;
  const upper = String(ch).trim().toUpperCase();
  if (["A", "B", "C", "D"].includes(upper)) return upper;
  return null;
}

// 모델 응답(문자열)에서 "번호: 선택지" 파싱
function parseAnswersFromModelOutput(output, questionNumbers) {
  const wanted = new Set(questionNumbers);
  const answers = {};

  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 패턴: "7: B" 또는 "7 - B"
    const m = line.match(/^(\d{1,2})\s*[:\-]\s*([A-Za-z])/);
    if (!m) continue;

    const q = parseInt(m[1], 10);
    if (!wanted.has(q)) continue;

    const choice = normalizeChoice(m[2]);
    if (!choice) continue;

    if (answers[q] == null) {
      answers[q] = choice;
    }
  }

  return answers;
}

// 멀티 프롬프트 정의 (4개 관점: base / lexical / logic / reading)
function buildPromptSpecs(stopToken) {
  const stopInfo = stopToken
    ? `\n- 절대 "${stopToken}" 같은 STOP 토큰은 출력하지 마라.`
    : "";

  const commonRules = `
너는 한국외대(HUFS) 편입 영어 객관식 기출(T1/T2 전형)을 푸는 전용 AI다.

시험 정보:
- 항상 50문항, 60분 시험이다.
- 모든 문항은 4지선다형이며 보기 A/B/C/D 네 개만 존재한다.
- 정답은 반드시 대문자 A, B, C, D 중 하나여야 한다.
- 외대 편입 영어의 문항 범위/유형은 대략 다음과 같다.
  * 1~9번    : 어휘/동의어
  * 10~13번  : 문맥상 동의어
  * 14~17번  : 의미 동일/논리완성 계열(문장 수준)
  * 18~21번  : 문법/재진술 (INCORRECT·틀린 것 고르기 포함)
  * 22~30번  : 짧은 독해
  * 31~40번  : 중간 길이 독해 (보통 2.5점)
  * 41~50번  : 장문 독해 (보통 3점, 난도·배점 최상)

- 특히 31~50번, 그 중에서도 41~50번 독해 문제에서 실수하면 점수 손실이 크므로
  이 구간에서는 절대로 대충 추론하지 말고, 지문 전체 내용을 꼼꼼히 이해한 뒤 답을 고른다.

공통 출력 규칙:
- 주어진 문항번호 목록에 있는 번호는 모두 빠짐없이 정답을 내야 한다 (누락 금지).
- 최종 출력 형식:
  - 각 줄에 "번호: 선택지" 형태로만 출력 (예: "7: B").
  - 다른 텍스트(해설, 이유, 설명, 요약, 문장)는 한 글자도 출력하지 마라.
- 보기 E, F 등은 존재하지 않으니 절대 사용하지 마라.
${stopInfo}

지시어/논리 관련 추가 규칙:
- NOT, NO, EXCEPT, LEAST, FALSE, INCORRECT, NOT TRUE 같은 단어가
  문제나 선지 조건에 포함되어 있는지 먼저 확인한다.
  * 이런 단어가 있으면 "지문과 일치하지 않는 것 / 가장 덜 지지되는 것"을 고르는 문제일 수 있다.
- 지시어/대명사(it, this, that, those, they, such, former, latter, (A)~(E) 등)를 묻는 문제에서는
  1) 해당 지시어가 들어 있는 문장과 그 앞뒤 문장을 한 덩어리로 묶어
     그 덩어리가 설명하는 대상(예: wild bears, captive bears, poachers, rescuers 등)을
     한 구나 한 문장으로 요약하고,
  2) 보기마다 가리키는 대상을 동일한 방식으로 요약한 뒤,
  3) 의미가 같은 것 / 다른 것 / 가장 적절한 것을 골라야 하는지 문제 지시에 맞게 선택한다.
- 바로 앞에 나온 고유명사에 기계적으로 연결하지 말고,
  문단 전체 흐름 속에서 어떤 집단/개념을 가리키는지 먼저 파악하라.
`;

  return [
    {
      roleName: "base",
      systemPrompt:
        commonRules +
        `
모드: 종합 풀이 모드
- 어휘, 문법, 논리, 독해를 전체적으로 고려해 가장 자연스럽고 출제 의도에 맞는 정답을 고른다.
- 문법/어법 문제에서는 각 번호별 부분(①~④ 등)을 따로 떼어 보고,
  가장 명백한 문법 오류가 있는 보기를 선택한다.
- 출력 형식은 반드시 "번호: A/B/C/D"만 사용한다.
`,
    },
    {
      roleName: "lexical",
      systemPrompt:
        commonRules +
        `
모드: 어휘/유의어 집중 모드
- 1~13번 영역(어휘·문맥상 동의어)에서 특히 정확한 의미 매칭에 집중하라.
- 각 보기의 사전적 의미와 실제 용례를 머릿속으로 비교하고,
  문맥에 완전히 들어맞는 표현만 정답으로 인정한다.
- 어감·콜로케이션이 어색한 선택지는 과감히 배제한다.
- 출력 형식은 "번호: A/B/C/D"만 허용된다.
`,
    },
    {
      roleName: "logic",
      systemPrompt:
        commonRules +
        `
모드: 논리/문법/함정 검증 모드
- 14~21번 영역(논리완성·문법/재진술)과 독해 전반에서
  NOT, EXCEPT, LEAST, INCORRECT, FALSE 등의 함정 표현을 먼저 점검한다.
- 문장 구조, 부정/이중부정, 조건문(if, unless), 비교/대조,
  그리고 문법 규칙(수일치, 시제, 태, 관계사, 전치사, 관사 등)을 정교하게 따져서
  논리적으로 반드시 맞는 선택지만 남긴다.
- 지시어/대명사 문제에서는 지문 전체 흐름 속에서
  "어떤 집단/개념"을 가리키는지 먼저 파악한 뒤 보기를 비교하라.
- 출력 형식은 "번호: A/B/C/D"만 허용된다.
`,
    },
    {
      roleName: "reading",
      systemPrompt:
        commonRules +
        `
모드: 독해/요지 파악 전용 모드
- 각 지문(한 단락 또는 여러 단락으로 이루어진 글)에 대해
  1) 문단별 역할(도입, 설명, 예시, 반론, 결론)을 구분하고,
  2) 2~3문장으로 전체 요지를 머릿속으로 요약한 뒤,
  3) 각 보기가 그 요지와 "완전 일치 / 부분 일치 / 모순" 중 어디에 해당하는지 판정한다.
- 맞는 것을 고르는 문제에서는 지문이 가장 강하게 지지하는 보기를,
  NOT/EXCEPT/LEAST/FALSE 문제에서는 지문이 거의 지지하지 않는 보기를 선택한다.
- 35~37, 45~47, 49~50번처럼 여러 문항이 한 지문에 묶여 있을 때는
  첫 번째 문항에서 정확히 요지를 정리해 두고,
  이후 문항을 풀 때 항상 그 요지와 연결해서 판단한다.
- 절대로 자신의 배경지식이나 일반 상식을 근거로 답을 고르지 말고,
  반드시 "지문이 직접 말한 내용" 또는 "지문에서 명확히 추론되는 내용"만 사용한다.
- 출력 형식은 "번호: A/B/C/D"만 허용된다.
`,
    },
  ];
}

// user prompt 생성 (외대 전용 설명 포함)
function buildUserPrompt(ocrText, questionNumbers) {
  const numListStr = questionNumbers.join(", ");
  return `
다음은 한국외대(HUFS) 편입 영어 객관식 시험지(T1 또는 T2)의 OCR 결과이다.

- 이 텍스트에는 1번부터 50번까지의 문항과 보기(A~D)가 포함되어 있다.
- 너는 아래 "문항 번호 목록"에 포함된 모든 문항에 대해 정답을 골라야 한다.
- 각 문항의 정답은 보기 A, B, C, D 중 하나다.
- 외대 편입 영어는 보통 앞쪽 번호(1~21)는 어휘/문법, 뒤쪽 번호(22~50)는 독해 문제이며,
  31번 이후, 특히 41~50번은 긴 독해 + 높은 배점이므로 실수하면 안 된다.
- 최종 출력은 오직 "번호: 선택지" 형식의 줄들만 포함해야 한다.

문항 번호 목록: ${numListStr}

OCR 텍스트 (한국어 설명 등은 이미 제거된 상태이며, 주로 영어·숫자·기호만 남아 있다):
"""
${ocrText}
"""

위 정보를 바탕으로, 지정된 모든 문항 번호에 대한 정답만 계산해서 출력하라.
`;
}

// 가중치 다수결 앙상블 (외대 전용)
function majorityVote(questionNumbers, runs) {
  const finalAnswers = {};
  const voteDetail = {};

  for (const q of questionNumbers) {
    const counts = {};
    for (const run of runs) {
      const choice = run.answers[q];
      if (!choice) continue;
      const w = getRunWeight(run.roleName, q);
      counts[choice] = (counts[choice] || 0) + w;
    }

    let bestChoice = null;
    let bestScore = -1;

    for (const [choice, score] of Object.entries(counts)) {
      if (score > bestScore) {
        bestChoice = choice;
        bestScore = score;
      }
    }

    if (!bestChoice) {
      // 투표가 하나도 없으면 base run 결과에 fallback, 그것도 없으면 A로.
      const baseRun = runs.find((r) => r.roleName === "base") || runs[0];
      const fallback = baseRun && baseRun.answers[q];
      finalAnswers[q] = normalizeChoice(fallback) || "A";
    } else {
      finalAnswers[q] = bestChoice;
    }

    voteDetail[q] = counts;
  }

  return { finalAnswers, voteDetail };
}

// Netlify handler (외대 전용)
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "POST only" });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
    }

    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const temperature = Number(process.env.TEMPERATURE ?? 0); // 기본 0
    const stopToken = process.env.STOP_TOKEN || "";

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;

    // 1) 원본 OCR 텍스트
    const rawText = String(body.ocrText || body.text || "");

    if (!rawText.trim()) {
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    // 2) 외대 전용: 한글 제거 (영어/숫자/기호 위주로 정리)
    const ocrText = rawText.replace(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g, " ");

    // 3) 문항 번호 추출
    let questionNumbers = extractQuestionNumbers(ocrText);
    if (!questionNumbers.length) {
      return json(400, {
        ok: false,
        error: "No question numbers detected in OCR text",
      });
    }

    const promptSpecs = buildPromptSpecs(stopToken);
    const userPrompt = buildUserPrompt(ocrText, questionNumbers);

    const runs = [];

    for (const spec of promptSpecs) {
      const { roleName, systemPrompt } = spec;
      const { text: modelText, finishReason } = await callOpenRouter({
        apiKey,
        model,
        systemPrompt,
        userContent: userPrompt,
        temperature,
      });

      const answers = parseAnswersFromModelOutput(modelText, questionNumbers);

      runs.push({
        index: runs.length,
        roleName,
        questionNumbers,
        answers,
        finishReason,
      });
    }

    const { finalAnswers, voteDetail } = majorityVote(questionNumbers, runs);

    const lines = questionNumbers.map((q) => `${q}: ${finalAnswers[q]}`);
    const outText = lines.join("\n");

    const ocrPreview = ocrText.length > 400 ? ocrText.slice(0, 400) : ocrText;

    return json(200, {
      ok: true,
      text: outText,
      debug: {
        page,
        model,
        temperature,
        questionNumbers,
        visibleQuestionNumbers: questionNumbers,
        answers: finalAnswers,
        voteDetail,
        ensembleUsed: true,
        runs,
        ocrTextPreview: ocrPreview,
      },
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};


