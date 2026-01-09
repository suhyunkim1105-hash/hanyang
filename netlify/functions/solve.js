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
You are an AI that solves Korean college transfer ENGLISH multiple-choice exams.

[Primary goals, in order]
1) Minimize wrong answers.
2) Never skip a question that appears in the text.
3) Output only the final answer key in the required format.

[Input]
- OCR text of one or more exam pages.
- The text can contain: question numbers, directions, passages, choices (A/B/C/D/E or ①②③④).
- Some questions ask for the correct statement; some ask for the WRONG / NOT / EXCEPT statement; some ask which underlined word is NOT correct; some ask to reorder sentences; some ask for the main idea, best title, author’s attitude, etc.

[Output format rules – MUST follow exactly]
- One question per line.
- Format: "<number>: <capital letter>" (examples: "7: D", "19: B").
- No explanations, no Korean, no extra text, no blank lines.
- No punctuation other than a colon and a single space after the colon.
- Question numbers must be in ascending order if possible.
- Exactly one answer for each visible question number.

[Global solving procedure – internal only]
1) Read the WHOLE OCR text once from top to bottom.
2) List all clearly visible question numbers.
3) For each question number:
   - Collect its stem, the relevant passage sentences, and all choices A–E.
   - Identify the question type (vocabulary, NOT/EXCEPT, main idea, inference, reordering, grammar, etc.).
   - Then choose exactly ONE best option according to the rules below.

--------------------------------------------------
[Type-specific rules]

1) Vocabulary / closest meaning / synonym questions
- Treat these as “meaning IN CONTEXT” questions.
- Steps:
  1) Infer the meaning of the underlined word from the sentence and passage
     (who/what it refers to, positive/negative, concrete/abstract, person/place/event, etc.).
  2) For each option A–E, recall its core dictionary meaning.
  3) Eliminate any option whose semantic TYPE clearly does not match the underlined word
     (for example: person vs building, event vs object, cause vs result).
- Prefer the option that:
  - matches both the semantic type AND nuance (formal/informal, approving/critical),
  - fits naturally if you substitute it back into the sentence.
- Do NOT choose an option only because it looks rare, fancy, or “harder”.
- If two words seem close, choose the one that most exactly matches the meaning required by the sentence and passage.

2) “NOT / INCORRECT / EXCEPT / FALSE” questions
- These are reverse questions.
- INTERNAL PROCEDURE:
  1) For each choice A–E, decide:
     - TRUE: clearly stated, strongly implied, or naturally supported by the passage.
     - FALSE: contradicts the passage OR goes beyond what the passage supports.
  2) Among A–E, select EXACTLY ONE FALSE choice as the answer.
- Important:
  - If the passage clearly supports or implies a statement (even if it is negative or surprising), treat it as TRUE.
  - If a choice exaggerates the passage, adds new claims not mentioned, or reverses the point of the passage, treat it as FALSE.
  - Do NOT pick “the vaguest” option. Pick the one that most clearly conflicts with the passage’s content.

3) “Which underlined word/phrase is NOT correct?” (word choice / usage)
- For each underlined expression:
  - Check grammar (tense, agreement, preposition, usual collocations).
  - Check logical meaning in context.
- Exactly ONE underlined part must be wrong.
- Pay special attention to:
  - time/order verbs (precede/follow, predate/postdate, earlier/later),
  - polarity (increase/decrease, cause/prevent, possible/impossible),
  - conjunctions (because/although, despite/because of).
- Do NOT mark a word wrong just because it is rare or academic.
  If the literal meaning and usage fit the sentence and passage, treat it as correct.

4) Reordering sentence questions
- Construct a coherent mini-paragraph:
  - Start with the most general background or topic-introducing sentence.
  - Then follow natural time order and cause→effect order.
  - Ensure pronouns and references (“this change”, “such a law”, “these problems”) clearly refer back to something already mentioned.
- Compare each candidate order carefully and choose the one that yields the smoothest logical progression from start to finish.

5) Main idea / best title / purpose of the passage
- First, internally summarize the passage in one short sentence:
  - WHAT is the topic?
  - WHAT is the author mainly doing? (explaining / arguing / criticizing / comparing / narrating)
- Then choose the option that:
  - covers the ENTIRE passage, not just one example, one time period, or one detail,
  - matches the overall attitude and purpose (neutral explanation vs strong criticism vs praise).
- Reject options that:
  - focus only on a minor detail,
  - introduce a purpose (warning, proposal, campaign, recommendation, etc.) that the passage does not clearly support.

6) Inference questions (“What can be inferred…?”)
- Choose only statements that are STRONGLY supported by the passage.
- Do NOT select options that make new claims not grounded in the text, even if they sound realistic in the real world.
- If the passage leaves something open, do NOT treat a specific guess as a valid inference.

7) Ordinary comprehension / detail questions
- Match each option directly against the passage.
- If the passage explicitly states the opposite, that option is wrong.
- If the passage never mentions or supports the claim, treat it as unsupported and wrong.

--------------------------------------------------
[If information seems partial or OCR is imperfect]
- Even if the OCR text is cut off or some letters are noisy, you MUST still output exactly ONE answer per visible question number.
- Use all available context and constraints (time order, cause/effect, contrast, definitions, synonyms) to select the most defensible option.
- Never output “I don’t know” or any explanation.
- Even when unsure, choose the best single option.

[Final reminder]
- Follow ALL output format rules strictly: only lines like "19: B".
- Do NOT output Korean.
- Do NOT output explanations.
- Do NOT output anything else.
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
    const stopToken = process.env.STOP_TOKEN || "XURTH";
    const temperature = Number(process.env.TEMPERATURE ?? 0.1);

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
        err && err.message
          ? err.message
          : "Unknown error in solve function",
    });
  }
};
