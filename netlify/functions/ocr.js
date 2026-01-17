// netlify/functions/ocr.js
// 입력: { image: "data:image/jpeg;base64,....", page?: number }
// 출력: { ok:true, text:"...", page, raw:{...} }

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(obj),
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const endpoint = process.env.OCR_SPACE_API_ENDPOINT; // 예: https://apipro1.ocr.space/parse/image
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!endpoint) return json(500, { ok: false, error: "OCR_SPACE_API_ENDPOINT is not set" });
    if (!apiKey) return json(500, { ok: false, error: "OCR_SPACE_API_KEY is not set" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON" });
    }

    const page = body.page ?? null;
    const image = String(body.image || "");
    if (!image.startsWith("data:image/")) {
      return json(400, { ok: false, error: "image must be dataURL (data:image/...;base64,...)" });
    }

    const base64 = image.split(",")[1] || "";
    if (!base64) return json(400, { ok: false, error: "Invalid dataURL" });

    const form = new URLSearchParams();
    form.set("base64Image", "data:image/jpeg;base64," + base64);
    form.set("language", "eng");         // 영어만
    form.set("OCREngine", "2");          // 보통 2가 더 안정적인 편
    form.set("scale", "true");           // 작은 글씨 보강
    form.set("isOverlayRequired", "false");

    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { apikey: apiKey, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      25000
    );

    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw) {
      return json(500, { ok: false, error: `OCR error ${res.status}`, raw });
    }

    const parsed = raw?.ParsedResults?.[0];
    const text = String(parsed?.ParsedText || "").trim();

    return json(200, { ok: true, page, text, raw });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};

