// netlify/functions/solve.js
// --------------------------------------
// 역할: 한국외대 편입 영어 객관식 기출 "정답만" 생성하는 함수 (멀티 프롬프트 + 가중 다수결)
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: A\n2: D\n...", debug: {...} } 또는 { ok: false, error: "..." }
//
// 필요한 환경변수 (Netlify 에서 설정):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 예: "openai/gpt-4.1", 기본값: "openai/gpt-4.1")
// - TEMPERATURE         (선택, 기본 0)
// - STOP_TOKEN          (선택, 현재는 응답 텍스트에 별도로 사용하지 않음)

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

// OCR 텍스트에서 문항 번호 추출 (1~50, "1.", "2)" 등)
function extractQuestionNumbers(ocrText) {
  const nums = new Set();

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

  const lines = String(output || "").split(/\r?\n/);

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
      answers[q] = choice; // 같은 번호 여러 번 나오면 첫 번째만 사용
    }
  }

  return answers;
}

// OCR 텍스트에서 문항 유형 감지 (외대 전용이지만 다른 연도에도 동작하게 설계)
function detectQuestionTypes(ocrText) {
  const types = {
    grammarIncorrect: new Set(), // "grammatically INCORRECT" 유형
    referent: new Set(),         // "what it refers to" 유형
  };

  if (!ocrText) return types;
  const text = String(ocrText);

  // [18-19] Choose the one that makes the sentence grammatically INCORRECT.
  const reGrammarRange = /\[(\d{1,2})\s*[-~]\s*(\d{1,2})\]\s*Choose the one that.*grammatically\s+INCORRECT/gi;
  let m;
  while ((m = reGrammarRange.exec(text)) !== null) {
    const s = parseInt(m[1], 10);
    const e = parseInt(m[2], 10);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    const from = Math.min(s, e);
    const to = Math.max(s, e);
    for (let q = from; q <= to; q++) {
      types.grammarIncorrect.add(q);
    }
  }

  // 단일 문항 형식: "18. Choose the one that ... grammatically INCORRECT."
  const reGrammarSingle = /(\d{1,2})\.\s*Choose the one that.*grammatically\s+INCORRECT/gi;
  while ((m = reGrammarSingle.exec(text)) !== null) {
    const q = parseInt(m[1], 10);
    if (!Number.isNaN(q)) {
      types.grammarIncorrect.add(q);
    }
  }

  // 참조 대상 비교: "Which of the following is different from the others in what it refers to"
  const reReferent1 = /(\d{1,2})\.\s*Which of the following is different from the others in what it refers to/gi;
  while ((m = reReferent1.exec(text)) !== null) {
    const q = parseInt(m[1], 10);
    if (!Number.isNaN(q)) {
      types.referent.add(q);
    }
  }

  // 조금 느슨한 버전 (혹시 wording이 살짝 달라지는 연도 대비)
  const reReferent2 = /(\d{1,2})\.\s*Which of the following .*what it refers to/gi;
  while ((m = reReferent2.exec(text)) !== null) {
    const q = parseInt(m[1], 10);
    if (!Number.isNaN(q)) {
      types.referent.add(q);
    }
  }

  return types;
}

// 멀티 프롬프트 정의 (5개 관점: base / lexical / logic / grammar / referent)
function buildPromptSpecs(stopToken) {
  const stopInfo = stopToken
    ? `\n- 절대 "${stopToken}" 같은 STOP 토큰은 출력하지 마라.`
    : "";

  // 공통 시스템 규칙
  const commonRules = `
너는 한국외대 편입 영어 객관식 시험(T1/T2) 전용 AI다.

규칙(공통):
- 문제는 모두 4지선다형이며, 보기 A/B/C/D 네 개만 존재한다.
- 정답은 반드시 대문자 A, B, C, D 중 하나여야 한다.
- E, F 등의 보기는 존재하지 않으니 절대 사용하지 마라.
- 주어진 "문항 번호 목록"에 있는 번호는 모두 빠짐없이 정답을 내야 한다 (누락 금지).
- 한국어/한글 지문(제목, 안내문 등)이 OCR에 섞여 있어도 무시하고, 영어 문장과 번호/보기만 활용하라.
- 최종 출력 형식:
  - 각 줄에 "번호: 선택지" 형태로만 출력 (예: "7: B").
  - 다른 텍스트(해설, 이유, 설명, 요약, 문장)는 한 글자도 출력하지 마라.
${stopInfo}

특수 유형 처리(모든 모드 공통으로 인지해야 함):
- "Choose the one that makes the sentence grammatically INCORRECT."가 포함된 문항 범위에서는
  - 각 번호(①~④) 부분을 한 번씩 떼어보며, 문장 구조·시제·수일치·관계사·대명사 호응 등을 점검하고,
  - 가장 명백하게 문법 규칙을 어기는 번호 하나만 INCORRECT로 선택한다.
- 'NOT', 'NEVER', 'EXCEPT', 'LEAST'가 있는 문항에서는
  - positive/negative 논리를 정확하게 파악한 뒤, 조건에 맞는 보기 하나를 고른다.
- "Which of the following is different from the others in what it refers to?" 와 같은 문항에서는
  - (A)(B)(C)(D)가 각각 정확히 무엇을 가리키는지 머릿속에 표를 만든 뒤,
  - 셋과 다른 대상을 가리키는 선택지 하나만 고른다.
`;

  return [
    {
      roleName: "base",
      systemPrompt:
        commonRules +
        `
모드: 종합 풀이 모드
- 어휘, 문법, 논리, 지시어, 독해를 모두 균형 있게 고려한다.
- 가장 '정답처럼 보이는' 선택지를 전반적으로 고르는 기본 모드다.
`,
    },
    {
      roleName: "lexical",
      systemPrompt:
        commonRules +
        `
모드: 어휘/유의어 집중 모드
- 밑줄 친 단어, 괄호 안 단어 등 어휘 문제에서 특히 정확한 의미 매칭에 집중하라.
- 각 보기의 사전적 정의를 머릿속으로 한국어로 번역해 보고, 문맥에 가장 잘 들어맞는 것을 선택하라.
- 형태가 비슷한 단어(consolidation / consonance 등)는 반드시 사전적 정의를 비교한 뒤 결정하라.
`,
    },
    {
      roleName: "logic",
      systemPrompt:
        commonRules +
        `
모드: 논리/함정 검증 모드
- NOT, EXCEPT, LEAST, INCORRECT 등 함정 표현을 먼저 체크하고 부정/이중부정, 비교·대조, 조건문(if, unless)을 정밀하게 분석한다.
- 문장/지문 전체 흐름을 기준으로, 논리적으로 모순이 없는 선택지만 남기고 나머지는 버려라.
- 지시어(it, they, this, that, such, those, (A) 등)의 지칭 대상이 모호한 문제에서는
  문맥을 통해 '무엇'을 가리키는지 먼저 찾은 뒤, 그 의미와 가장 잘 대응되는 보기를 고른다.
`,
    },
    {
      roleName: "grammar",
      systemPrompt:
        commonRules +
        `
모드: 문법/오류 탐지 특화 모드
- "grammatically INCORRECT" 문항에서는:
  1) 전체 문장을 ①~④ 각 부분별로 나누어 본다.
  2) 시제, 수일치, 관계대명사/관계절, 분사/준동사, 대명사 참조, 전치사 등 문법 규칙 위반을 찾는다.
  3) 단순 어색함이 아니라 명백한 문법 오류를 만드는 부분을 선택한다.
- 그 외 문항에서도 문법적으로 말이 되지 않는 보기가 있으면 적극적으로 배제하라.
`,
    },
    {
      roleName: "referent",
      systemPrompt:
        commonRules +
        `
모드: 지시어/참조 대상 분석 특화 모드
- "what it refers to", "refer to", "Which of the following refers to" 등 지시어 관련 문항에서:
  1) 문제에 등장하는 각 표현(A, B, C, D 또는 (A)(B)(C)(D))이 정확히 무엇을 가리키는지 문장/문단을 따라가며 확인한다.
  2) 각 표현과 대응되는 대상(사람, 집단, 사건, 추상 개념 등)을 머릿속 표로 정리한다.
  3) 세 표현은 같은 대상을 가리키고, 하나만 다른 대상을 가리키면, 그 '하나'를 정답으로 고른다.
- 긴 독해 지문에서도 대명사/지시어의 참조가 애매하면 우선 그 참조 관계부터 확정한 뒤 선택지를 비교하라.
`,
    },
  ];
}

// user prompt 생성
function buildUserPrompt(ocrText, questionNumbers, questionTypes) {
  const numListStr = questionNumbers.join(", ");

  let typeHintLines = "";

  if (questionTypes) {
    const grammarArr = Array.from(questionTypes.grammarIncorrect || []);
    const referentArr = Array.from(questionTypes.referent || []);
    if (grammarArr.length) {
      typeHintLines += `- 문법적으로 INCORRECT(오류 찾기) 유형 문항: ${grammarArr.join(", ")}\n`;
    }
    if (referentArr.length) {
      typeHintLines += `- 지시어/참조 대상 비교 유형 문항: ${referentArr.join(", ")}\n`;
    }
  }

  return `
다음은 한국외대 편입 영어 객관식 시험지 일부의 OCR 결과이다.

- 이 OCR 텍스트 안에는 여러 문항(번호와 보기)이 포함되어 있다.
- 너는 아래 "문항 번호 목록"에 포함된 모든 문항에 대해 정답을 골라야 한다.
- 각 문항의 정답은 보기 A, B, C, D 중 하나다.
- 최종 출력은 오직 "번호: 선택지" 형식의 줄들만 포함해야 한다.

문항 번호 목록: ${numListStr}
${typeHintLines ? "\n문항 유형 힌트:\n" + typeHintLines : ""}

OCR 텍스트:
"""
${ocrText}
"""

위 정보를 바탕으로, 지정된 모든 문항 번호에 대한 정답만 계산해서 출력하라.
`;
}

// 다수결 앙상블 (문항 유형에 따라 일부 역할에 가중치 부여)
function majorityVote(questionNumbers, runs, questionTypes) {
  const finalAnswers = {};
  const voteDetail = {};

  for (const q of questionNumbers) {
    const counts = {};
    const isGrammarIncorrect =
      questionTypes &&
      questionTypes.grammarIncorrect &&
      questionTypes.grammarIncorrect.has(q);
    const isReferent =
      questionTypes &&
      questionTypes.referent &&
      questionTypes.referent.has(q);

    for (const run of runs) {
      const choice = run.answers[q];
      if (!choice) continue;

      // 기본 가중치 1, 특정 유형에 따라 role별로 가중치 부여
      let weight = 1;

      if (isGrammarIncorrect && run.roleName === "grammar") {
        weight = 2; // 문법 문제에서 grammar 모드 가중치↑
      } else if (isReferent && run.roleName === "referent") {
        weight = 2; // 참조 문제에서 referent 모드 가중치↑
      }

      const key = choice;
      counts[key] = (counts[key] || 0) + weight;
    }

    let bestChoice = null;
    let bestCount = -1;

    for (const [choice, cnt] of Object.entries(counts)) {
      if (cnt > bestCount) {
        bestChoice = choice;
        bestCount = cnt;
      }
    }

    // 투표가 하나도 없으면 base run 결과에 fallback, 그것도 없으면 A로.
    if (!bestChoice) {
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

// Netlify handler
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
    const temperature = Number(process.env.TEMPERATURE ?? 0);
    const stopToken = process.env.STOP_TOKEN || "";

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrText = String(body.ocrText || body.text || "");

    if (!ocrText.trim()) {
      return json(400, { ok: false, error: "ocrText is empty" });
    }

    const questionNumbers = extractQuestionNumbers(ocrText);
    if (!questionNumbers.length) {
      return json(400, {
        ok: false,
        error: "No question numbers detected in OCR text",
      });
    }

    const questionTypes = detectQuestionTypes(ocrText);

    const promptSpecs = buildPromptSpecs(stopToken);
    const userPrompt = buildUserPrompt(ocrText, questionNumbers, questionTypes);

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

    const { finalAnswers, voteDetail } = majorityVote(
      questionNumbers,
      runs,
      questionTypes
    );

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
        questionTypes: {
          grammarIncorrect: Array.from(questionTypes.grammarIncorrect || []),
          referent: Array.from(questionTypes.referent || []),
        },
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

