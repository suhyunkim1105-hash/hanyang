// netlify/functions/solve.js
// --------------------------------------
// 역할: 편입 영어 객관식 기출 "정답만" 생성하는 함수 (멀티 프롬프트 + 다수결)
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

    // 패턴 1: "7: B" 또는 "7 - B" 등
    let m = line.match(/^(\d{1,2})\s*[:\-]\s*([A-Za-z])/);
    if (!m) continue;

    const q = parseInt(m[1], 10);
    if (!wanted.has(q)) continue;

    const choice = normalizeChoice(m[2]);
    if (!choice) continue;

    // 같은 번호가 여러 번 나오면 첫 번째만 사용
    if (answers[q] == null) {
      answers[q] = choice;
    }
  }

  return answers;
}

// 멀티 프롬프트 정의 (3개 관점)
function buildPromptSpecs(stopToken) {
  const stopInfo = stopToken
    ? `\n- 절대 "${stopToken}" 같은 STOP 토큰은 출력하지 마라.`
    : "";

  // 공통 시스템 규칙 (각 프롬프트마다 포함할 핵심 규칙)
  const commonRules = `
너는 편입 영어 객관식 기출 문제를 푸는 전용 AI다.

규칙:
- 문제는 모두 4지선다형이며, 보기 A/B/C/D 네 개만 존재한다.
- 정답은 반드시 대문자 A, B, C, D 중 하나여야 한다.
- E, F 등의 보기는 존재하지 않으니 절대 사용하지 마라.
- 주어진 문항번호 목록에 있는 번호는 모두 빠짐없이 정답을 내야 한다 (누락 금지).
- 최종 출력 형식:
  - 각 줄에 "번호: 선택지" 형태로만 출력 (예: "7: B").
  - 다른 텍스트(해설, 이유, 설명, 요약, 문장)는 한 글자도 출력하지 마라.
${stopInfo}
`;

  return [
    {
      roleName: "base",
      systemPrompt:
        commonRules +
        `
모드: 종합 풀이 모드
- 문맥, 어휘, 문법, 논리를 모두 고려해서 가장 자연스럽고 출제 의도에 맞는 정답을 고른다.
- 단, 출력 형식은 위 규칙을 반드시 지킨다.
`,
    },
    {
      roleName: "lexical",
      systemPrompt:
        commonRules +
        `
모드: 어휘/유의어 집중 모드
- 밑줄 친 단어, 괄호 안 단어 등 어휘 문제에서 특히 정확한 의미 매칭에 집중하라.
- 각 보기의 사전적 의미를 머릿속으로 비교하고, 문맥에 가장 정확히 들어맞는 것을 선택하라.
- 동의어/반의어 문제, 어감 미묘한 차이 문제에서 실수하지 않도록 주의하라.
- 출력 형식은 "번호: A/B/C/D"만 허용된다.
`,
    },
    {
      roleName: "logic",
      systemPrompt:
        commonRules +
        `
모드: 논리/함정 검증 모드
- NOT, EXCEPT, INCORRECT, LEAST, MOST 등 함정 표현이 있는지 먼저 점검하라.
- 문장 구조, 부정/이중부정, 조건문(if, unless), 비교/대조 등을 정교하게 따져서
  논리적으로 반드시 맞는 선택지만 고르도록 한다.
- 문맥상 부적절한 선택지를 철저히 배제하라.
- 출력 형식은 "번호: A/B/C/D"만 허용된다.
`,
    },
  ];
}

// user prompt 생성
function buildUserPrompt(ocrText, questionNumbers) {
  const numListStr = questionNumbers.join(", ");
  return `
다음은 어떤 대학교 편입 영어 객관식 시험지의 OCR 결과이다.

- 이 OCR 텍스트 안에는 여러 문항(번호와 보기)이 포함되어 있다.
- 너는 아래 "문항 번호 목록"에 포함된 모든 문항에 대해 정답을 골라야 한다.
- 각 문항의 정답은 보기 A, B, C, D 중 하나다.
- 최종 출력은 오직 "번호: 선택지" 형식의 줄들만 포함해야 한다.

문항 번호 목록: ${numListStr}

OCR 텍스트:
"""
${ocrText}
"""

위 정보를 바탕으로, 지정된 모든 문항 번호에 대한 정답만 계산해서 출력하라.
`;
}

// 다수결 앙상블
function majorityVote(questionNumbers, runs) {
  const finalAnswers = {};
  const voteDetail = {};

  for (const q of questionNumbers) {
    const counts = {};
    for (const run of runs) {
      const choice = run.answers[q];
      if (!choice) continue;
      counts[choice] = (counts[choice] || 0) + 1;
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
      const baseRun = runs[0];
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
    // 너가 요구한 대로 기본 0, 환경변수로 바꾸더라도 solve 로그에 그대로 찍히게만 함
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

    const ocrPreview = ocrText.length > 400
      ? ocrText.slice(0, 400)
      : ocrText;

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
