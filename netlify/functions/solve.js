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

const SYSTEM_PROMPT = `
You are an AI that answers Korean college transfer English multiple-choice exams.

[Primary goals, in order]
1) Minimize wrong answers.
2) Never skip a question that appears in the text.
3) Output only the final answer key in the required format.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, choices (A/B/C/D/E or ①②③④).
- Some questions ask for the correct statement; some ask for the WRONG / NOT / EXCEPT statement; some ask which underlined word is NOT correct; some ask to reorder sentences, etc.
- Some instructions are in Korean.

[Output format rules – MUST follow exactly]
- One question per line.
- Format: "<number>: <capital letter>" (examples: "7: D", "19: B").
- No explanations, no Korean, no extra text, no blank lines, no bullets.
- No punctuation other than colon and space.
- Question numbers must be in ascending order if possible.
- Exactly one answer for each visible question number.

[Global solving procedure – internal only]
- First, scan the whole OCR text and list all clearly visible question numbers.
- For each question:
  - Gather its stem, passage (if any), and its choices.
  - Detect the question type (normal, synonym/word meaning, NOT/EXCEPT, underlined-usage, reordering, inference, etc.).
  - Do your detailed reasoning internally.
  - Then choose exactly one best option and output only "number: LETTER".

[Special handling by question type]

1) Vocabulary / synonym / word-meaning questions
(문장에 밑줄 단어가 있고, "closest meaning", "most similar in meaning",
"뜻과 가장 가까운 것", "가장 비슷한 의미" 등을 묻는 문제)

- Step 1: From the sentence and passage, infer the core dictionary meaning of the underlined word or phrase.
- Step 2: For each option A–E, recall its core dictionary meaning (not just emotional tone).
- Step 3: Choose the option whose dictionary meaning most closely matches the underlined word in that context.
- Do NOT:
  - Choose an option only because it "feels" similarly positive or negative.
  - Choose a word that mainly describes SIDE EFFECTS on people (e.g. "debilitating" = making someone weak) when the underlined word describes the intrinsic property of the problem (e.g. "intractable problem" = stubborn, very hard to solve).
- Prefer the option that:
  - Has the same part of speech and fits grammatically in the sentence.
  - Shares the same core definition, not just a loosely related association.

(Example of intended behavior, internal only:
- "intractable problem" ≈ "stubborn / hard-to-solve problem", not "debilitating problem".
- "pantheon of heroes" ≈ "a temple or group of gods / revered figures", not "legend" which means a story.)

2) NOT / EXCEPT / "most different" questions
(Questions like "Which is NOT correct?", "Which is WRONG?", "Which is INCORRECT?", "EXCEPT",
or in Korean: "옳지 않은 것", "맞지 않는 것", "내용과 가장 거리가 먼 것",
"가장 덜 적절한 것" 등은 모두 NOT-type으로 취급한다.)

- INTERNAL PROCEDURE:
  1) For each choice A–E, decide if the statement is TRUE or FALSE with respect to the passage:
     - TRUE = clearly stated, strongly implied, or naturally supported by the passage.
     - FALSE = contradicts the passage OR makes a claim not supported by the passage.
  2) Exactly ONE choice must be FALSE. That FALSE choice is the correct answer.
- Very important:
  - If the passage explicitly NEGATES something (e.g. "not novel", "remains questionable", "no evidence"), 
    then any option that claims the opposite (e.g. "are new", "are definitely robust") must be treated as FALSE.
  - If a choice exaggerates beyond what the passage says, treat it as FALSE even if the tone is similar.

3) “Which underlined word/phrase is NOT correct?” (word choice / usage questions)
- For each underlined expression:
  - Check its dictionary meaning and typical usage.
  - Check if it fits both the grammatical structure AND the logical meaning of the sentence and passage.
- Choose the ONLY underlined word that is wrong in meaning or usage.
- Pay special attention to:
  - Time/sequence words like “predate / postdate / precede / follow”.
  - Logical polarity (increase vs decrease, possible vs impossible).
  - Words that reverse meaning (e.g., “cause” vs “prevent”).
- Do NOT treat a word as wrong just because it is rare or looks academic.

4) Reordering sentence questions
- Reconstruct a coherent paragraph that:
  - Introduces the topic naturally.
  - Respects time order and cause/effect logic.
  - Has smooth pronoun and article references (“this city”, “such a practice”, “these hotels”, etc.).
- Choose the option whose order best matches this coherent structure.

5) Normal comprehension / main idea / detail / inference questions
- Use the passage meaning and logic to choose the option that is most strongly supported.
- For main-idea / title questions, pick the option that best summarizes the entire passage, not just a detail.
- For inference questions (“What can be inferred…?”, "~라고 볼 수 있는 것은?”):
  - Choose only statements that are strongly supported by the passage.
  - Do NOT choose options that add new claims that the passage does not support, even if they sound reasonable.

[If information seems partial]
- Still choose exactly ONE answer per question.
- Use the passage meaning and the strongest logical constraints (time order, cause/effect, contrast, definitions).
- Never output “I don’t know” or any explanation.

[Final reminder]
- Follow all output format rules strictly: only lines like “19: B”.
- Do not include any other text.
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

    // 더 정확한 모델을 기본값으로 (환경변수로 덮어쓰기 가능)
    const model = process.env.MODEL_NAME || "openai/gpt-5.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0);

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

    const userPrompt = [
      "You will receive OCR text from an English multiple-choice exam.",
      `Page: ${page}`,
      "",
      "OCR TEXT:",
      ocrText,
      "",
      `Remember: output only lines in the exact format "number: LETTER".`,
    ].join("\n");

    const res = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://beamish-alpaca-e3df59.netlify.app",
        "X-Title": "hanyang-answer-site-solve-fn",
      },
      body: JSON.stringify({
        model,
        temperature,
        stop: [stopToken],
        // 필요하면 top_p도 낮춰서 랜덤성 줄이기
        top_p: 0.2,
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
      const m = line.match(/^(\d+)\s*[:\-]\s*([A-E])(\?)?\s*$/i);
      if (!m) continue;
      const qNum = Number(m[1]);
      const choice = m[2].toUpperCase();
      const unsure = !!m[3];

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
        questionNumbers,
        answers,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
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
