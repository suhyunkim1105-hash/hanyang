// netlify/functions/solve.js

// -------------------------
// 역할: 편입 영어 객관식 기출 "정답만" 생성하는 함수 (3회 호출 + 다수결)
// 입력: { ocrText: string, page?: number }
// 출력: { ok: true, text: "1: A\n2: D\n...", debug: {...} } 또는 { ok: false, error: "..." }
//
// 필요한 환경변수 (Netlify 에서 설정):
// - OPENROUTER_API_KEY  (필수)
// - MODEL_NAME          (선택, 예: "openai/gpt-4.1", 기본값: "openai/gpt-4.1")
// - STOP_TOKEN          (선택, 기본값: "XURTH")

// Netlify Node 18+ 에서는 global fetch 가 있지만,
// 만약 없을 경우를 대비해 node-fetch 로 폴백.
const fetchFn = (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
  // eslint-disable-next-line global-require
  return import("node-fetch").then(({ default: f }) => f(...args));
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

const SYSTEM_PROMPT = `
You are an AI that answers Korean college transfer English multiple-choice exams.

[Primary goals, in order]
1) Minimize wrong answers.
2) Never skip a question number that appears in the text.
3) Output only the final answer key in the required format.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, underlined words, and choices (A/B/C/D/E or ①②③④).
- Question types include:
  • normal comprehension / vocabulary / inference
  • “Which is NOT / WRONG / INCORRECT / EXCEPT?”
  • “Which underlined word is NOT correct?”
  • ordering sentences or paragraphs (A/B/C style 단락 배열 포함)
  • two-blank questions with paired choices like (A)-(E)
  • questions asking which one of (A)-(E) is contextually inappropriate in the passage
  • 제목 / 요지 / 주제 / 내용 일치·불일치

[Output format rules – MUST follow exactly]
- One question per line.
- Format: "<number>: <capital letter>" (examples: "7: D", "19: B").
- No explanations, no Korean, no extra text, no blank lines.
- No other punctuation except colon and a single space.
- Question numbers should be in ascending order if possible.
- Exactly one answer for each visible question number.
- If you are uncertain, you must STILL choose exactly one option.
- For each question, use ONLY the choices that actually appear in the OCR text
  (for example, if the question shows only A–D, you must NOT use E).

[Global solving procedure – INTERNAL ONLY]
1) Read the ENTIRE OCR text first to understand structure and passages.
2) Scan for all clearly visible question numbers (1, 2, 3, …).
   - Do NOT assume a continuous range. Only answer numbers that clearly appear in the text.
   - If a page only shows 13–17, then answer ONLY 13,14,15,16,17 for that page.
3) For each question:
   - Collect its stem, any passage it depends on, and all its choices.
   - Determine what the question is really asking (vocabulary, title, inference, NOT/EXCEPT, ordering, etc.).
   - Choose EXACTLY ONE best option.
4) Always respect explicit instructions in the stem (“NOT”, “EXCEPT”, “INCORRECT”, “일치하지 않는 것”, etc.).
5) For history/process/timeline questions (e.g., development of a technology, sequence of events in WWI, scientific discovery):
   - Carefully track chronological order: earliest → later → latest.
   - Background explanation (general overview) usually goes BEFORE specific later events and improvements.

────────────────────────────────────
[Type 1: Normal comprehension / vocabulary / inference]

• Comprehension / inference:
  - Choose the option most strongly supported by the passage’s meaning, logic, and tone.
  - Reject options that introduce new claims not supported by the text, even if they sound plausible.
  - Prefer choices that reflect the main point of the relevant paragraph, not minor details.

• Vocabulary / synonym (“밑줄 친 단어의 뜻과 가장 가까운 것”):
  INTERNAL STEPS:
  1) For the underlined word, think of a short English definition (1–3 core words).
  2) For EACH choice A–E, recall its core dictionary meaning.
  3) Choose the option whose core meaning is closest to the underlined word.
  4) Do NOT rely only on general “feeling” or rarity; use literal meaning.

────────────────────────────────────
[Type 2: “NOT / INCORRECT / WRONG / EXCEPT” (reverse questions)]

• Treat these as “find the FALSE statement” questions.

INTERNAL PROCEDURE:
1) For each choice A–E, classify it against the passage:
   - TRUE = clearly stated, strongly implied, or naturally supported.
   - FALSE = contradicts the passage OR lacks sufficient support.
2) Mark EXACTLY ONE choice as FALSE. That FALSE choice is the correct answer.

────────────────────────────────────
[Type 3: “Which underlined word/phrase is NOT correct?”]

• For each underlined expression:
  - Check meaning AND grammar.

────────────────────────────────────
[Type 4: Reordering sentence questions (문장 배열)]
────────────────────────────────────
[Type 5: Inference questions (“What can be inferred…?”)]
────────────────────────────────────
[Type 6: Two-blank paired-choice questions (A/B, A/B in one option set)]
────────────────────────────────────
[Type 7: “Which of (A)–(E) is contextually inappropriate?”]
────────────────────────────────────
[Type 8: Title / Main idea / 요지 / 제목 / 주제]
────────────────────────────────────
[Type 9: Paragraph ordering / flow (단락 배열, (A)(B)(C) 순서)]
────────────────────────────────────
[If information seems partial or OCR is noisy]

- STILL choose exactly ONE answer per visible question number.
- Rely on lexical meaning, grammar, logic, and tone.

[Two-phase internal check – VERY IMPORTANT]

Phase 1: Solve all questions mentally and write a provisional answer key.
Phase 2: Go BACK over every single question number again.
  - Re-read its stem, passage, and choices.
  - Ask: “Is this option definitely better than all others, given the passage?”
  - If you find a better option, CORRECT your answer before outputting.

[Final reminder]
- Follow all output format rules strictly: only lines like “19: B”.
- Do NOT include any other text or symbols.
`;

// -------------------------
// OpenRouter 한 번 호출해서 정답 파싱하는 헬퍼
// -------------------------
async function callModelOnce({ apiKey, model, stopToken, temperature, userPrompt }) {
  const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
      "X-Title": "answer-site-solve-fn",
    },
    body: JSON.stringify({
      model,
      temperature,
      stop: [stopToken],
      messages: [
        { role: "system", content: SYSTEM_PROMPT.trim() },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const raw = String(data.choices?.[0]?.message?.content || "").trim();
  const finishReason = data.choices?.[0]?.finish_reason ?? null;

  const cleaned = raw.split(stopToken)[0].trim();

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const answers = {};
  const questionNumbers = [];

  for (const line of lines) {
    const m = line.match(/^(\d+)\s*[:\-]\s*([A-E])(\?)?\s*$/i);
    if (!m) continue;
    const qNum = Number(m[1]);
    const choice = m[2].toUpperCase();

    answers[qNum] = choice;
    questionNumbers.push(qNum);
  }

  return {
    raw,
    cleaned,
    lines,
    answers,
    questionNumbers,
    finishReason,
  };
}

// -------------------------
// 메인 handler
// -------------------------
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
    const stopToken = process.env.STOP_TOKEN || "XURTH";

    // 🔒 온도 0으로 완전 고정 (ENV 무시)
    const temperature = 0;

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const page = body.page ?? 1;
    const ocrTextRaw = String(body.ocrText || body.text || "");
    const ocrText = ocrTextRaw.trim();

    if (!ocrText) {
      return json(400, { ok: false, error: "Missing ocrText" });
    }

    // 디버깅용: OCR에서 보이는 문제 번호 대략 추출
    const visibleNumsSet = new Set();
    const numberPattern = /(^|\n)\s*(\d{1,3})[.)]/g;
    let m;
    while ((m = numberPattern.exec(ocrText)) !== null) {
      const n = Number(m[2]);
      if (!Number.isNaN(n)) visibleNumsSet.add(n);
    }
    const visibleQuestionNumbers = Array.from(visibleNumsSet).sort((a, b) => a - b);

    const userPrompt = [
      "You will receive OCR text from an English multiple-choice exam.",
      `Page: ${page}`,
      "",
      "OCR TEXT:",
      ocrText,
      "",
      'Remember: output only lines in the exact format "number: LETTER".',
      "Do NOT skip any question number that appears in the OCR text.",
      "For each question, use ONLY the answer choices that actually appear in the OCR text for that question.",
    ].join("\n");

    const NUM_RUNS = 3;
    const perRun = [];
    const allQuestionSet = new Set();

    for (let i = 0; i < NUM_RUNS; i++) {
      try {
        const result = await callModelOnce({
          apiKey,
          model,
          stopToken,
          temperature,
          userPrompt,
        });
        perRun.push(result);
        for (const q of result.questionNumbers) {
          allQuestionSet.add(q);
        }
      } catch (err) {
        perRun.push({
          raw: "",
          cleaned: "",
          lines: [],
          answers: {},
          questionNumbers: [],
          finishReason: `error: ${err && err.message ? err.message : "unknown"}`,
        });
      }
    }

    if (allQuestionSet.size === 0) {
      const lastRaw = perRun[perRun.length - 1]?.raw || "";
      return json(200, {
        ok: true,
        text: lastRaw,
        debug: {
          page,
          model,
          temperature,
          visibleQuestionNumbers,
          ensembleUsed: false,
          reason: "noParsedAnswers",
        },
      });
    }

    const finalAnswers = {};
    const allQuestionNumbers = Array.from(allQuestionSet).sort((a, b) => a - b);

    for (const q of allQuestionNumbers) {
      const freq = {};
      for (const run of perRun) {
        const choice = run.answers[q];
        if (!choice) continue;
        freq[choice] = (freq[choice] || 0) + 1;
      }

      let bestChoice = null;
      let bestCount = -1;

      for (const [choice, count] of Object.entries(freq)) {
        if (count > bestCount) {
          bestCount = count;
          bestChoice = choice;
        }
      }

      if (!bestChoice) {
        for (const run of perRun) {
          const choice = run.answers[q];
          if (choice) {
            bestChoice = choice;
            break;
          }
        }
      }

      if (bestChoice) {
        finalAnswers[q] = bestChoice;
      }
    }

    const outputLines = allQuestionNumbers
      .filter((q) => finalAnswers[q])
      .map((q) => `${q}: ${finalAnswers[q]}`);

    return json(200, {
      ok: true,
      text: outputLines.join("\n"),
      debug: {
        page,
        model,
        temperature,
        visibleQuestionNumbers,
        questionNumbers: allQuestionNumbers,
        answers: finalAnswers,
        ensembleUsed: true,
        runs: perRun.map((run, idx) => ({
          index: idx,
          questionNumbers: run.questionNumbers,
          answers: run.answers,
          finishReason: run.finishReason,
        })),
        ocrTextPreview: ocrText.slice(0, 400),
      },
    });
  } catch (err) {
    console.error("solve.js error", err);
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : "Unknown error in solve function",
    });
  }
};
