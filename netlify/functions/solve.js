// netlify/functions/solve.js
// --------------------------------------
// HUFS (한국외대) 편입 T2 영어 객관식 정답 생성 함수
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: C\n2: B...\nUNSURE: 7, 14", debug: {...} }
//
// - 선택지는 항상 A~D (4지선다)
// - 모델: 기본 openai/gpt-4.1
// - temperature: 항상 0 (결정적)
// - UNSURE: 모델이 70% 미만 확신인 번호 목록

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

// OCR 텍스트에서 보이는 문항 번호 추출
function extractQuestionNumbers(ocrText) {
  const text = String(ocrText || "");
  const nums = new Set();
  const re = /(^|\n)\s*(\d{1,2})\s*[\.\)]\s/g; // 줄 시작의 "숫자." / "숫자)" 패턴
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
  // 혹시 1~4로 올 경우 방어적으로 매핑
  if (c === "1") return "A";
  if (c === "2") return "B";
  if (c === "3") return "C";
  if (c === "4") return "D";
  return null;
}

// 모델 출력에서 "번호: 선택지" 패턴 파싱 + UNSURE 라인 파싱
function parseAnswerLines(raw) {
  if (!raw) return { answers: {}, unsure: [] };
  let text = String(raw);

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

async function callOpenRouter({ apiKey, model, roleName, ocrText, questionNumbers, page }) {
  const baseSystem = `You are an AI that solves **HUFS (Hankuk University of Foreign Studies) transfer exam T2 English multiple-choice questions**.

Global rules (VERY IMPORTANT):
- This exam is ALWAYS 4-choice: options are A, B, C, D only.
- Use the OCR text exactly as given. Do NOT invent or hallucinate text.
- Answer ONLY for the question numbers listed below. If some numbers are missing in OCR, skip them.
- Output format: one line per question -> "<number>: <choice>".
  - Example: "7: C"
  - <choice> must be exactly one of A, B, C, D.
- At the end, add one more line: "UNSURE: n1, n2" listing question numbers where you are **not at least 70% confident**.
  - If you are confident about all answers, write exactly: "UNSURE: (none)".
- Never add explanations, commentary, translations, or anything else.
- NEVER change the question numbers; they must match the input question numbers.

HUFS T2 section guidance:
- 1–4: choose the option that best completes the sentence (semantic + grammatical fit).
- 5–13: vocabulary / contextual meaning questions. Focus on the **underlined word** in context.
- 14–17: paraphrase / sentence equivalence and grammar. Choose the option that best matches the logical meaning AND is grammatically well-formed.
- 18–19: "grammatically INCORRECT" (error-detection). The sentence includes (A), (B), (C), (D) marked phrases.
  1) Treat EACH labeled phrase (A)(B)(C)(D) as a separate unit.
  2) Internally classify each as "OK" or "ERROR" based ONLY on grammar, NOT style.
  3) There is exactly ONE grammatically incorrect phrase; choose that one.
  4) Pay extra attention to:
     - redundant or unnecessary pronouns (especially "it", "they") that create double subjects or awkward clausal structure,
     - wrong relative pronouns or complementizers,
     - wrong tense or agreement inside the marked phrase.
  5) Do NOT mark participle clauses like "constructed with novel methods ..." as incorrect if they can be integrated as reduced relative clauses.
- 20–21: "grammatically INCORRECT" again. Use the same 1)–5) procedure above.
- 22–25: reading-based questions (major topic, reference of pronouns/letters like (A)(B)(C)(D), best phrase for a blank, etc.).

Special protocol for reference questions:
- If the question stem contains any of the following phrases:
  - "different from the others in what it refers to"
  - "different from the rest in what it refers to"
  - "which refers to a different thing than the others"
  then you MUST follow this procedure **internally** before choosing an answer:
  1) Identify exactly what each marker (A), (B), (C), (D) refers to in the passage.
     - Write down for yourself four short mappings in your scratchpad:
       (A) -> [antecedent phrase or concept]
       (B) -> [...]
       (C) -> [...]
       (D) -> [...]
  2) Compare these four antecedents:
     - If three of them clearly refer to the same noun phrase / group / concept, and one refers to a different noun phrase / group / concept, you MUST choose the one with the different antecedent.
  3) You are **not allowed** to choose an option whose antecedent is the same as the other three.
  4) Do NOT base your choice on which option "sounds odd" or "feels different in wording"; only the REFERENT (antecedent) matters.
- For all such questions, you MUST perform the above steps even if the answer feels obvious.

- 26–30 and later: standard reading comprehension (inference, main idea, detail, etc.).

Hard constraints:
- If you are FORCED TO GUESS, still output ONE best choice per question, then include that question number in the UNSURE list.
- Do NOT ever output choices E, F, or numbers as choices.
- Do NOT output any text after the answers and the UNSURE line.`;

  const roleHint = (() => {
    switch (roleName) {
      case "lexical":
        return "Focus extra on precise vocabulary, collocations, and subtle meaning differences between options.";
      case "logic":
        return "Focus extra on logical structure, conditionals, contrast, cause/effect, and overall coherence.";
      case "reading":
        return "Focus extra on passage-level reasoning, global coherence, and consistency across sentences. Be especially careful with reference questions: always determine exact antecedents of (A)(B)(C)(D).";
      case "grammar":
        return "Focus extra on pure grammar: subject–verb agreement, tense, clause structure, relative clauses, and pronoun usage (including redundant 'it').";
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

  const temperature = 0; // 외대 전용: 항상 0

  const body = {
    model,
    messages: [
      { role: "system", content: baseSystem + "\n\nROLE FOCUS: " + roleHint },
      { role: "user", content: userContent },
    ],
    temperature,
  };

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

// 여러 역할(base / lexical / logic / reading / grammar) 앙상블
async function ensembleSolve({ apiKey, model, ocrText, page }) {
  const questionNumbers = extractQuestionNumbers(ocrText);

  // 숫자를 못 찾았을 때 HUFS T2 패턴 기반 대략 추정 (안전장치)
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
      roleName,
      ocrText,
      questionNumbers: visibleQuestionNumbers,
      page,
    });

    const { answers } = parseAnswerLines(raw);
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

  const finalAnswers = {};
  const unsureList = [];

  const allQuestions = new Set(visibleQuestionNumbers);
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

  const text = answerLines.join("\n") + "\n" + unsureLine;

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
      ocrPreview: ocrText.slice(0, 400),
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

  const model = process.env.MODEL_NAME || "openai/gpt-4.1";

  try {
    const { text, debug } = await ensembleSolve({
      apiKey,
      model,
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

