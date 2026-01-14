// netlify/functions/solve.js

// Netlify Node 18+ 에서는 global fetch 가 있지만,
// 만약 없을 경우를 대비해 node-fetch 로 폴백.
const fetchFn = (...args) => {
  if (typeof fetch !== "undefined") return fetch(...args);
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

// 외대 T2 시험은 선택지가 항상 4개(A~D)라고 가정한다.
const ALLOWED_CHOICES = ["A", "B", "C", "D"];

// OCR 텍스트에서 보이는 문항 번호 후보를 대충 추출해서
// 프롬프트에 힌트로 넣어준다. (1~100 사이 숫자 + '.' 또는 ')' 패턴)
function extractQuestionNumbers(ocrText) {
  const nums = new Set();
  const regex = /(?:^|\s)(\d{1,2})[.)](?=\s)/g;
  let m;
  while ((m = regex.exec(ocrText)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 100) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

const SYSTEM_PROMPT = `
You are an AI that answers Korean college transfer English multiple-choice exams.

[Primary goals, in order]
1) Minimize wrong answers.
2) Never skip a question number that appears in the text.
3) Output only the final answer key in the required format.

[Very important exam constraint]
- This exam (Hankuk University of Foreign Studies transfer English T2) ALWAYS has exactly four choices per question: A, B, C, and D.
- Even if OCR noise shows options like E, ⑤, or others, treat them as errors and IGNORE them.
- When choosing an answer, you MUST choose ONLY from {A, B, C, D}.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, underlined words, and choices (A/B/C/D or ①②③④).
- Question types include:
  • normal comprehension / vocabulary / inference
  • “Which is NOT / WRONG / INCORRECT / EXCEPT?”
  • “Which underlined word is NOT correct?”
  • ordering sentences or paragraphs (A/B/C style 단락 배열 포함)
  • two-blank questions with paired choices like (A)-(E)
  • questions asking which one of several options is contextually inappropriate in the passage
  • 제목 / 요지 / 주제 / 내용 일치·불일치

[Output format rules – MUST follow exactly]
- One question per line.
- Format: "<number>: <capital letter>" (examples: "7: D", "19: B").
- No explanations, no Korean, no extra text, no blank lines.
- No other punctuation except colon and a single space.
- Question numbers should be in ascending order if possible.
- Exactly one answer for each visible question number.
- If you are uncertain, you must STILL choose exactly one option.
- CHOICES ARE LIMITED TO: A, B, C, D ONLY. Never output E or any other letter.

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
  2) For EACH choice A–D, recall its core dictionary meaning.
  3) Choose the option whose core meaning is closest to the underlined word.
  4) Do NOT rely only on general “feeling” or rarity; use literal meaning.

────────────────────────────────────
[Type 2: “NOT / INCORRECT / WRONG / EXCEPT” (reverse questions)]

• Treat these as “find the FALSE statement” questions.

INTERNAL PROCEDURE:
1) For each choice A–D, classify it against the passage:
   - TRUE = clearly stated, strongly implied, or naturally supported.
   - FALSE = contradicts the passage OR lacks sufficient support.
2) Mark EXACTLY ONE choice as FALSE. That FALSE choice is the correct answer.
3) If the passage clearly supports a statement (even if negative or surprising), you MUST treat it as TRUE.
4) If a choice exaggerates or distorts the passage’s claim, treat it as FALSE.

────────────────────────────────────
[Type 3: “Which underlined word/phrase is NOT correct?”]

• For each underlined expression:
  - Check meaning AND grammar.
  - Does it fit the sentence structure and the logical meaning of the passage?

Choose the ONLY underlined word that is wrong in meaning or usage.

Guidelines:
- Pay attention to:
  • time/sequence (precede vs follow, predate vs postdate, etc.)
  • polarity (increase vs decrease, possible vs impossible)
  • cause vs prevent, permit vs forbid, etc.
- Do NOT mark a word wrong just because it is rare or academic.
- Academic collocations like “microcosm of ~”, “tension between A and B”, “slippage between A and B” can be correct if the context fits.
- Prefer the option whose literal meaning clearly contradicts the facts described in the passage.

────────────────────────────────────
[Type 4: Reordering sentence questions (문장 배열)]

• Goal: build the most coherent single paragraph.

INTERNAL PROCEDURE:
1) Find the best opening sentence:
   - Introduces topic without unclear pronouns.
   - Does not refer back to something not yet mentioned.
2) Ensure logical order:
   - Time sequence (past → later → now).
   - Cause → effect.
   - General statement → example → conclusion.
3) Check pronoun and reference flow (“this practice”, “such a view”, “these results”) so each reference has a clear antecedent.
4) Choose the option whose order gives the smoothest, most logical paragraph.
5) Reject options that:
   - Use “this/that/such/these” BEFORE the thing being referred to is introduced.
   - Put a conclusion or evaluation BEFORE the explanation and examples.

────────────────────────────────────
[Type 5: Inference questions (“What can be inferred…?”)]

• The correct option must be STRONGLY supported by the passage.
• Reject choices that:
  - add new information not implied, or
  - rely on speculation beyond the given text.

────────────────────────────────────
[Type 6: Two-blank paired-choice questions]

These may have answer choices like:
(A) word1 / (B) word2  … (A) word1 / (B) word2 …

INTERNAL PROCEDURE:
1) For the first blank:
   - Use the immediate sentence and surrounding context.
   - Match the literal meaning and tone.
2) For the second blank:
   - Use the overall paragraph tone (optimistic vs pessimistic, hopeful vs disillusioned).
3) The correct answer must make BOTH blanks natural and consistent with the passage.

────────────────────────────────────
[Type 7: “Which is contextually inappropriate?” (단어 쓰임이 적절하지 않은 것)]

INTERNAL PROCEDURE:
1) For EACH option A–D:
   - Replace the underlined word with its simple meaning and read the sentence.
   - Check if the sentence still matches the local meaning and the overall thesis and tone.
2) Mark as WRONG the word that creates a contradiction or clear illogic.
3) There should be exactly ONE clearly inappropriate word. Choose that one.

────────────────────────────────────
[Type 8: Title / Main idea / 요지 / 제목 / 주제]

These questions ask for:
- 제목 (title),
- 글의 요지 / 주제 (main idea),
- “가장 적절한 제목/요지/주제” 등.

INTERNAL PROCEDURE:
1) Summarize the whole passage in ONE short English sentence in your head:
   - Who/what is the main subject?
   - What is the core claim or contrast?
2) Discard choices that:
   - Mention only a minor detail or an example.
   - Focus on just one paragraph when the passage clearly covers more.
   - Introduce new topics not in the passage.
3) Prefer choices that:
   - Capture the whole passage, not just part of it.
   - Reflect the key contrast or key relationship.
4) If two options seem similar:
   - Choose the one that is more general but still specific enough to match the passage.
   - Avoid options that add extra claims not emphasized in the text.

────────────────────────────────────
[Type 9: Paragraph ordering / flow (단락 배열)]

INTERNAL PROCEDURE:
1) For EACH labeled paragraph (A), (B), (C), …:
   - Make a 1-line summary in your head (background, earliest event, later development, conclusion, etc.).
2) Determine the natural order (history/process, or argument/explanation).
3) Reject orders where time or logic obviously jump backward.
4) Prefer the option where references and connectors (“however”, “therefore”, “as a result”) connect smoothly.

────────────────────────────────────
[If information seems partial or OCR is noisy]

- STILL choose exactly ONE answer per visible question number.
- Rely on:
  • lexical meaning
  • grammatical constraints
  • logical relations (cause/effect, contrast, time order)
  • overall tone (positive/negative, hopeful/critical).
- Never output “I don’t know”, explanations, or any commentary.

[Final reminder]
- Follow all output format rules strictly: only lines like “19: B”.
- Do NOT include any other text or symbols.
- NEVER output a choice outside {A, B, C, D}.
`;

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

    // 온도는 기본 0으로 고정. (환경변수에 숫자가 들어오면 그 값을 쓰고, NaN 이면 0)
    let temperature = 0;
    if (typeof process.env.TEMPERATURE === "string") {
      const t = Number(process.env.TEMPERATURE);
      if (!Number.isNaN(t)) temperature = t;
    }

    const stopToken = process.env.STOP_TOKEN || "XURTH";

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

    const visibleQuestionNumbers = extractQuestionNumbers(ocrText);
    const questionHint = visibleQuestionNumbers.length
      ? `Visible question numbers in this OCR: ${visibleQuestionNumbers.join(
          ", ",
        )}.\nYou MUST output exactly one line for EACH of these numbers, and do not invent numbers that are not in this list.`
      : `If you can detect question numbers in the OCR, output exactly one line for each detected number.`;

    const userPrompt = [
      "You will receive OCR text from an English multiple-choice exam.",
      `Page: ${page}`,
      questionHint,
      "",
      "OCR TEXT:",
      ocrText,
      "",
      'Remember: output only lines in the exact format "number: LETTER" and LETTER must be one of A, B, C, D.',
    ].join("\n");

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
      return json(res.status, {
        ok: false,
        error: `OpenRouter HTTP ${res.status}`,
        details: text.slice(0, 500),
      });
    }

    const data = await res.json();
    const raw = String(data.choices?.[0]?.message?.content || "").trim();

    // STOP_TOKEN 이전까지만 사용
    const cleaned = raw.split(stopToken)[0].trim();

    const lines = cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const answers = {};
    const questionNumbers = [];
    const answerLines = [];

    for (const line of lines) {
      // "12: C" 또는 "12- C" 또는 "12: C?" 같은 형태 허용
      const m = line.match(/^(\d+)\s*[:\-]\s*([A-E])(\?)?\s*$/i);
      if (!m) continue;
      const qNum = Number(m[1]);
      let choice = m[2].toUpperCase();
      const unsure = !!m[3];

      // 허용되지 않는 선택지(E 등)가 나오면 D로 강제 보정하고, 이 경우는 사실상 불확실한 것으로 취급.
      if (!ALLOWED_CHOICES.includes(choice)) {
        choice = ALLOWED_CHOICES[ALLOWED_CHOICES.length - 1];
      }

      answers[qNum] = choice;
      questionNumbers.push(qNum);
      answerLines.push(`${qNum}: ${choice}${unsure ? "?" : ""}`);
    }

    const outputLines = answerLines.length > 0 ? answerLines : lines;

    return json(200, {
      ok: true,
      text: outputLines.join("\n"),
      debug: {
        page,
        model,
        temperature,
        questionNumbers,
        answers,
        visibleQuestionNumbers,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        ocrTextPreview: ocrText.slice(0, 400),
      },
    });
  } catch (err) {
    console.error("solve.js error", err);
    return json(500, {
      ok: false,
      error:
        err && err.message
          ? err.message
          : "Unknown error in solve function",
    });
  }
};
