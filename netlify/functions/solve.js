// netlify/functions/solve.js
// --------------------------------------
// HUFS (한국외대) 편입 T2 영어 객관식 전용 정답 생성 함수
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: C\n2: B...\nUNSURE: 7, 14" , debug: {...} }
// - 선택지는 항상 A~D 중 하나만 사용 (외대 T2는 4지선다)
// - 모델: 기본 openai/gpt-4.1, 온도는 항상 0으로 고정
// - STOP_TOKEN 이 있으면 거기까지만 사용

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

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

function safeParseBody(event) {
  try {
    if (!event.body) return {};
    return JSON.parse(event.body);
  } catch (_) {
    return null;
  }
}

function extractQuestionNumbers(ocrText) {
  const text = String(ocrText || "");
  const nums = new Set();
  // 줄 시작의 "숫자." 또는 "숫자)" 패턴
  const re = /(^|\n)\s*(\d{1,2})\s*[\.\)]\s/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[2]);
    if (!Number.isNaN(n) && n >= 1 && n <= 100) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

function normalizeChoice(ch) {
  if (!ch) return null;
  const c = String(ch).trim().toUpperCase();
  if (["A", "B", "C", "D"].includes(c)) return c;
  // 혹시 1~4 로 온 경우 방어적으로 매핑
  if (c === "1") return "A";
  if (c === "2") return "B";
  if (c === "3") return "C";
  if (c === "4") return "D";
  return null;
}

function parseAnswerLines(raw, stopToken) {
  if (!raw) return { answers: {}, unsure: [] };
  let text = String(raw);
  if (stopToken) {
    const idx = text.indexOf(stopToken);
    if (idx >= 0) text = text.slice(0, idx);
  }

  const answers = {};
  let unsure = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    // UNSURE 라인
    const mu = line.match(/^UNSURE\s*:\s*(.*)$/i);
    if (mu) {
      const rest = mu[1].trim();
      if (!rest || rest.toLowerCase() === "(none)" || rest === "-") {
        unsure = [];
      } else {
        unsure = rest
          .split(/[;,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => Number(x))
          .filter((n) => !Number.isNaN(n));
      }
      continue;
    }

    const m = line.match(/^(\d{1,3})\s*[:\-]\s*([A-D1-4])/i);
    if (!m) continue;
    const q = Number(m[1]);
    const choice = normalizeChoice(m[2]);
    if (!choice) continue;
    answers[q] = choice;
  }

  return { answers, unsure };
}

async function callOpenRouter({ apiKey, model, stopToken, roleName, ocrText, questionNumbers, page }) {
  const baseSystem = `You are an AI that solves **HUFS (Hankuk University of Foreign Studies) transfer exam T2 English multiple-choice questions**.

Rules (VERY IMPORTANT):
- This exam is always 4-choice: options are A, B, C, D only.
- Use the OCR text exactly as given. Do NOT invent or hallucinate text.
- Answer **only** for the question numbers listed below. If some numbers are missing in OCR, skip them.
- Output format: one line per question -> "<number>: <choice>".
  - Example: "7: C"
  - <choice> must be exactly one of A, B, C, D.
- At the end, add one more line: "UNSURE: n1, n2" listing question numbers where you are **not at least 70% confident**.
  - If you are confident about all, write: "UNSURE: (none)".
- Never add explanations, commentary, translations, or anything else.
- NEVER change the question numbers; they must match the input question numbers.

HUFS T2-specific guidance:
- 1–4: choose the option that best completes the sentence (semantic + grammatical fit).
- 5–13: vocabulary / meaning questions. Focus on the underlined word and its contextual meaning.
- 14–17: paraphrase / sentence equivalence and grammar. Choose the option that best matches the logical meaning of the original sentence.
- 18–21: "grammatically INCORRECT" / error-detection items. Pick the ONLY option that makes the sentence ungrammatical.
- 22–25: reading-based questions (major topic, reference of pronouns/letters like (A)(B)(C)(D), best phrase for a blank, etc.).
- 26–30 and later: standard reading comprehension (inference, main idea, detail, etc.).

Hard constraints:
- If you are **forced to guess**, still output ONE best choice per question, then include that question number in UNSURE.
- Do not ever output choices E, F, or numbers as choices.
- Do not output any text after the answers and UNSURE line.
${stopToken ? `- End your output with the exact token ${stopToken} on a new line.` : "" }
`;

  const roleHint = (() => {
    switch (roleName) {
      case "lexical":
        return "Focus extra on precise vocabulary, collocations, and subtle meaning differences between options.";
      case "logic":
        return "Focus extra on logical structure, conditionals, contrast, cause/effect, and grammatical well-formedness.";
      case "reading":
        return "Focus extra on paragraph logic, discourse structure, and consistent interpretation across the whole passage.";
      case "grammar":
        return "Focus extra on pure grammar, especially for 'grammatically INCORRECT' questions (subject–verb agreement, tense, relative clauses, pronouns, articles).";
      default:
        return "Use a balanced approach over vocabulary, grammar, and reading comprehension.";
    }
  })();

  const questionList = Array.isArray(questionNumbers) && questionNumbers.length
    ? questionNumbers.join(", ")
    : "(none)";

  const userContent = `You are the ${roleName} solver. Solve the HUFS T2 English questions below.

Page: ${page || 1}
Visible question numbers: ${questionList}

OCR TEXT START
----------------
${ocrText}
----------------
OCR TEXT END

Now output the answers strictly in the required format.`;

  const temperature = 0; // 외대 전용: 항상 0으로 고정

  const body = {
    model,
    messages: [
      { role: "system", content: baseSystem + "\n\nROLE FOCUS: " + roleHint },
      { role: "user", content: userContent },
    ],
    temperature,
  };

  if (stopToken) {
    body.stop = [stopToken];
  }

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://answer-site.netlify.app",
      "X-Title": "answer-site-hufs-solve",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const finishReason = choice?.finish_reason || "unknown";
  const content = choice?.message?.content || "";

  return { raw: content, finishReason };
}

async function ensembleSolve({ apiKey, model, stopToken, ocrText, page }) {
  const questionNumbers = extractQuestionNumbers(ocrText);

  // 숫자를 하나도 못 찾으면, 외대 T2 패턴에 맞춰 대략 추정 (안전장치)
  let visibleQuestionNumbers = questionNumbers;
  if (!visibleQuestionNumbers.length) {
    const fallback = [];
    if (ocrText.includes("[1~13")) {
      for (let i = 1; i <= 14; i++) fallback.push(i);
    } else if (ocrText.includes("[18~30")) {
      for (let i = 15; i <= 30; i++) fallback.push(i);
    } else if (ocrText.includes("[22-23")) {
      for (let i = 22; i <= 30; i++) fallback.push(i);
    }
    visibleQuestionNumbers = fallback;
  }

  const roles = ["base", "lexical", "logic", "reading", "grammar"];
  const runs = [];

  const voteDetail = {}; // { [q]: { [choice]: count } }

  for (let i = 0; i < roles.length; i++) {
    const roleName = roles[i];
    const { raw, finishReason } = await callOpenRouter({
      apiKey,
      model,
      stopToken,
      roleName,
      ocrText,
      questionNumbers: visibleQuestionNumbers,
      page,
    });

    const { answers } = parseAnswerLines(raw, stopToken);

    const runQs = Object.keys(answers).map((x) => Number(x)).sort((a, b) => a - b);

    runs.push({
      index: i,
      roleName,
      questionNumbers: runQs,
      answers,
      finishReason,
    });

    for (const qStr of Object.keys(answers)) {
      const q = Number(qStr);
      const choice = answers[q];
      if (!voteDetail[q]) voteDetail[q] = {};
      if (!voteDetail[q][choice]) voteDetail[q][choice] = 0;
      voteDetail[q][choice] += 1;
    }
  }

  // 최종 정답 선택 (다수결 + 불확실성 계산)
  const finalAnswers = {};
  const unsureList = [];

  const allQuestions = new Set(visibleQuestionNumbers);
  // 모델이 추가로 답한 번호도 포함
  for (const qStr of Object.keys(voteDetail)) {
    allQuestions.add(Number(qStr));
  }

  const sortedQuestions = Array.from(allQuestions).sort((a, b) => a - b);

  for (const q of sortedQuestions) {
    const counts = voteDetail[q] || {};
    let bestChoice = null;
    let bestCount = 0;
    let total = 0;

    for (const [choice, cnt] of Object.entries(counts)) {
      total += cnt;
      if (cnt > bestCount) {
        bestCount = cnt;
        bestChoice = choice;
      }
    }

    if (!bestChoice) {
      // 모든 러너가 답을 못 낸 경우: base 러너 결과에서 가져온다.
      const baseRun = runs[0];
      if (baseRun && baseRun.answers[q]) {
        bestChoice = baseRun.answers[q];
        bestCount = 1;
        total = 1;
      }
    }

    if (bestChoice) {
      finalAnswers[q] = bestChoice;
      const confidence = total > 0 ? bestCount / total : 0;
      if (confidence < 0.7) {
        unsureList.push(q);
      }
    }
  }

  const answerLines = sortedQuestions
    .filter((q) => finalAnswers[q])
    .map((q) => `${q}: ${finalAnswers[q]}`);

  const unsureLine = unsureList.length
    ? `UNSURE: ${unsureList.join(", ")}`
    : "UNSURE: (none)";

  let text = answerLines.join("\n") + "\n" + unsureLine;
  if (stopToken) {
    text += "\n" + stopToken;
  }

  return {
    text,
    debug: {
      model,
      temperature: 0,
      page,
      questionNumbers: sortedQuestions,
      visibleQuestionNumbers,
      answers: finalAnswers,
      voteDetail,
      ensembleUsed: true,
      runs,
    },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only" });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return json(500, { ok: false, error: "OPENROUTER_API_KEY is not set" });
  }

  const body = safeParseBody(event);
  if (body === null) {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const page = body.page ?? 1;
  const rawText = body.ocrText || body.text || "";
  const ocrText = String(rawText || "");

  if (!ocrText.trim()) {
    return json(400, { ok: false, error: "ocrText is empty" });
  }

  const model = process.env.MODEL_NAME || "openai/gpt-4.1"; // 외대 전용: 기본 4.1
  const stopToken = process.env.STOP_TOKEN || "XURTH";

  try {
    const { text, debug } = await ensembleSolve({
      apiKey,
      model,
      stopToken,
      ocrText,
      page,
    });

    return json(200, { ok: true, text, debug });
  } catch (e) {
    return json(500, {
      ok: false,
      error: e?.message || String(e),
    });
  }
};
