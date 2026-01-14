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
Model is GPT-4.1 with temperature = 0 (deterministic). Accuracy is more important than speed or brevity.

[Primary goals, in order]
1) Minimize wrong answers.
2) Never skip a question number that appears in the OCR text.
3) Output only the final answer key in the required format.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, underlined words, and choices (A/B/C/D/E or ①②③④⑤).
- Question types include:
  • normal comprehension / vocabulary / inference
  • “Which is NOT / WRONG / INCORRECT / EXCEPT?”
  • “Which underlined word is NOT correct?”
  • sentence / paragraph ordering (A/B/C style 단락 배열 포함)
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

────────────────────────────────────
[Global solving procedure – INTERNAL ONLY]

0) Choice-set detection (VERY IMPORTANT)
  - Before choosing answers, scan the OCR text to see which answer labels actually appear:
    • Lettered choices: "A.", "B.", "C.", "D.", "E." (or "A)", "B)", etc.).
    • Numbered choices: "①", "②", "③", "④", "⑤".
  - Determine the maximum valid option for THIS page:
    • If you never see any "E." or "⑤", assume the exam uses ONLY four options (A–D or ①–④).
    • In that case, you MUST NOT output an option that does not exist (e.g., NEVER output "E" if only A–D appear).
  - In all cases, never output a letter or numeral that does not appear as a choice on that page.

1) Read the ENTIRE OCR text first to understand structure and passages.

2) Scan for all clearly visible question numbers (1, 2, 3, …).
   - Do NOT assume a continuous range. Only answer numbers that clearly appear in the text.
   - If a page only shows 13–17, then answer ONLY 13,14,15,16,17 for that page.
   - Ignore page headers/footers, form fields (name, ID), and scoring info.

3) For each question:
   - Collect its stem, any passage it depends on, and all its choices.
   - Determine what the question is really asking:
     • vocabulary / synonym
     • main idea / title
     • inference
     • NOT / EXCEPT / INCORRECT (reverse questions)
     • ordering (sentences or paragraphs)
     • contextually inappropriate word
     • two-blank paired choices
   - Choose EXACTLY ONE best option from the allowed choice set for that page.

4) Always respect explicit instructions in the stem:
   - Words like “NOT”, “EXCEPT”, “INCORRECT”, “WRONG”, “일치하지 않는 것”, “옳지 않은 것” mean you must find the FALSE statement.
   - Double-check these reverse-question markers AFTER you pick a draft answer.

5) For each passage with multiple questions in a row (e.g., 35–40, 45–50):
   - Treat them as a group.
   - For the LAST question of that passage set (usually the highest number in that block), perform an EXTRA check:
     • First, summarize the whole passage in ONE short English sentence in your head (subject + core claim).
     • Then compare each choice for that last question against this summary.
     • Choose the option that best matches the global summary, not just a local sentence.

6) After selecting answers for all questions, perform an internal second pass:
   - Re-check:
     • all NOT/EXCEPT/INCORRECT questions,
     • all vocabulary/synonym questions,
     • all two-blank paired-choice questions,
     • all final questions of each passage set.
   - Correct any answer that conflicts with the passage or with the rules below.
   - Then output the final answer key.

────────────────────────────────────
[Type 1: Normal comprehension / vocabulary / inference]

• Comprehension / inference:
  - Choose the option most strongly supported by the passage’s meaning, logic, and tone.
  - Reject options that introduce new claims not supported by the text, even if they sound plausible.
  - Prefer choices that reflect the main point of the relevant paragraph, not minor details.

• Vocabulary / synonym (“밑줄 친 단어의 뜻과 가장 가까운 것”):
  INTERNAL MANDATORY STEPS (DO NOT SKIP):
  1) For the underlined word, think of a short English definition (1–3 core words).
  2) For EACH choice A–E (or ①–⑤), recall its core dictionary meaning in 1–3 words.
  3) Eliminate any choice whose core meaning is clearly in a different semantic field.
  4) Among the remaining candidates, choose the option whose core meaning is closest to the underlined word.
  5) Finally, re-read the sentence with the candidate word inserted and check that the sentence meaning fits the overall context.
  - Never rely only on vague “feeling” or rarity; use literal meaning and context.

────────────────────────────────────
[Type 2: “NOT / INCORRECT / WRONG / EXCEPT” (reverse questions)]

Treat these as “find the FALSE statement” questions.

INTERNAL PROCEDURE:
1) For each choice A–E (or ①–⑤), classify it against the passage:
   - TRUE = clearly stated, strongly implied, or naturally supported.
   - FALSE = contradicts the passage OR lacks sufficient support.
2) Mark EXACTLY ONE choice as FALSE. That FALSE choice is the correct answer.
3) If the passage clearly supports a statement (even if surprising), you MUST treat it as TRUE.
4) If a choice exaggerates or distorts the passage’s claim, treat it as FALSE.
5) Before finalizing, re-check the question stem to ensure you are indeed selecting the FALSE/NOT/EXCEPT option.

────────────────────────────────────
[Type 3: “Which underlined word/phrase is NOT correct?”]

• For each underlined expression:
  - Check both meaning AND grammar.
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

Goal: build the most coherent single paragraph.

INTERNAL PROCEDURE:
1) Find the best opening sentence:
   - Introduces the topic without unclear pronouns.
   - Does not refer back to something not yet mentioned.
2) Ensure logical order:
   - Time sequence (past → later → now).
   - Cause → effect.
   - General statement → example → conclusion.
3) Check pronoun and reference flow (“this practice”, “such a view”, “these results”) so each reference has a clear antecedent.
4) Choose the option whose order gives the smoothest, most logical paragraph.
5) Reject orders where:
   - “this/that/such/these” appears BEFORE its referent.
   - Conclusion or evaluation appears BEFORE explanation and examples.

────────────────────────────────────
[Type 5: Inference questions (“What can be inferred…?”)]

• The correct option must be STRONGLY supported by the passage.
• Reject choices that:
  - add new information not implied, or
  - rely on speculation beyond the given text.

────────────────────────────────────
[Type 6: Two-blank paired-choice questions (A/B, A/B in one option set)]

These often have answer choices like:
(A) word1 / (B) word2  … (A) word1 / (B) word2 …

INTERNAL PROCEDURE (MUST FOLLOW ALL STEPS):
1) For the first blank:
   - Use the immediate sentence and surrounding context.
   - Match the literal meaning and tone (e.g., “hard to understand for the public” → esoteric, abstruse, technical, etc.).
2) For the second blank:
   - Use the overall paragraph tone (optimistic vs pessimistic, hopeful vs disillusioned, etc.).
   - If the passage is clearly positive (e.g., “energized by the promise of new discoveries”, “deep drive for knowledge”), then only positive words (optimism, enthusiasm, curiosity) are allowed.
   - If the passage is clearly negative, then only negative words are allowed.
3) The correct answer must make BOTH blanks natural and consistent with the passage.
   - If only one blank fits but the other clashes, you MUST REJECT that option.
4) Prefer the pair where both blanks simultaneously fit grammar, meaning, and global tone.

────────────────────────────────────
[Type 7: “Which of (A)–(E) is contextually inappropriate?”]

Here, several words (A)–(E) are inserted into the passage, and you must find the ONE that does NOT fit the context.

INTERNAL PROCEDURE:
1) For EACH of (A), (B), (C), (D), (E):
   - Replace the underlined word with its simple meaning and read the sentence.
   - Check if the sentence still matches:
     • the local sentence meaning, and
     • the overall thesis and tone of the passage.
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
   - Mention only a minor detail or example.
   - Focus on just one paragraph when the passage clearly covers more.
   - Introduce new topics not in the passage.
3) Prefer choices that:
   - Capture the whole passage, not just part of it.
   - Reflect the key contrast or key relationship (e.g., cultural differences in reasoning, impact of a theory on practice).
4) If two options seem similar:
   - Choose the one that is more general but still specific enough to match the passage.
   - Avoid options that add extra claims (time, place, specific data) not emphasized in the text.
5) For the LAST question of a passage set, double-check that your chosen option matches the one-sentence summary you formed earlier.

────────────────────────────────────
[Type 9: Paragraph ordering / flow (단락 배열, (A)(B)(C) 순서)]

These questions involve labeled paragraphs such as (A), (B), (C) and ask for the best order.

INTERNAL PROCEDURE:
1) For EACH labeled paragraph (A), (B), (C), …:
   - Make a 1-line summary in your head:
     • Is it background / general overview?
     • Is it earliest event in time?
     • Is it a later development, improvement, or consequence?
2) Determine the natural order:
   - History / process:
     • Introduce general topic or background.
     • Earliest event (e.g., first experiments / earliest method).
     • Later improvements or more advanced methods.
   - Argument / explanation:
     • Introduce main issue.
     • Provide explanation, examples, supporting evidence.
     • Conclude or evaluate.
3) Reject orders where:
   - A later development appears before the basic, earlier method without any explanation.
   - A paragraph that clearly summarizes or evaluates appears BEFORE the detailed description of events.
4) Prefer the option where:
   - Time references (years, “at first”, “later”, “then”, “after that”) are strictly increasing.
   - Logical connectors (“however”, “therefore”, “as a result”) connect smoothly between paragraphs.
   - The story or explanation reads naturally from start to finish.

────────────────────────────────────
[If information seems partial or OCR is noisy]

- STILL choose exactly ONE answer per visible question number.
- Rely on:
  • lexical meaning,
  • grammatical constraints,
  • logical relations (cause/effect, contrast, time order),
  • overall tone (positive/negative, hopeful/critical).
- Never output “I don’t know”, explanations, or any commentary.
- Do NOT output any option letter that does not appear as a real choice on the page.

[Final reminder]
- Follow all output format rules strictly: only lines like “19: B”.
- Do NOT include any other text or symbols.
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

    // 기본 모델: GPT-4.1 (환경변수 MODEL_NAME 으로 덮어쓰기 가능)
    const model = process.env.MODEL_NAME || "openai/gpt-4.1";
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    // 온도는 0으로 고정 (이미 환경변수로 0을 쓰고 있더라도 방어적으로 처리)
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
      `Remember:`,
      `- First, detect which answer letters (A–D/E) or numerals (①–⑤) actually appear as choices on this page.`,
      `- Never output an option letter that does NOT appear as a real choice (e.g., do not output E when only A–D exist).`,
      `- Then, follow the internal procedures for each question type and output only lines in the exact format "number: LETTER".`,
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
      error:
        err && err.message ? err.message : "Unknown error in solve function",
    });
  }
};
