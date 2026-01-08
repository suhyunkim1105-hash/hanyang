<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>answer-site</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#0b1020; color:#e9eefc; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 18px; }
    .card { background:#0f1835; border:1px solid rgba(255,255,255,.08); border-radius: 18px; padding: 16px; margin-bottom: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
    h2 { margin:0 0 10px 0; font-size: 18px; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    button { background:#2b6cff; border:none; color:white; padding:10px 14px; border-radius: 12px; font-weight: 700; cursor:pointer; }
    button.secondary { background:#243055; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    input { background:#0b1020; color:#e9eefc; border:1px solid rgba(255,255,255,.14); border-radius: 10px; padding:10px 12px; }
    .previewWrap {
      height: 70vh;
      min-height: 360px;
      border-radius: 18px;
      overflow:hidden;
      background:#050a18;
      border:1px solid rgba(255,255,255,.08);
    }
    video, img { width:100%; height:100%; object-fit: contain; background:#000; }
    .hint { opacity:.8; font-size: 13px; line-height: 1.5; margin-top: 10px; }
    pre { margin:0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.45; }
    textarea {
      width:100%; min-height: 160px; resize: vertical;
      background:#0b1020; color:#e9eefc;
      border:1px solid rgba(255,255,255,.14);
      border-radius: 12px; padding:12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .small { font-size: 12px; opacity: .85; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2>카메라</h2>
      <div class="row">
        <button id="btnStart">카메라 시작</button>
        <button id="btnShot" class="secondary">현재 페이지 촬영</button>
        <span class="small">현재 페이지</span>
        <input id="page" type="number" value="1" min="1" style="width:90px" />
        <span id="res" class="small"></span>
      </div>

      <div style="height:12px"></div>

      <div class="previewWrap">
        <video id="video" playsinline autoplay muted></video>
      </div>

      <div class="hint">
        ① 시험지를 화면에 꽉 채우고<br/>
        ② 글자/문항번호/보기(A~E)까지 선명하게 보이게 맞춘 뒤<br/>
        ③ “현재 페이지 촬영” → OCR → 정답 생성 순서로 진행.
      </div>
    </div>

    <div class="card">
      <h2>로그</h2>
      <pre id="log"></pre>
    </div>

    <div class="card">
      <h2>OCR 원문 확인</h2>
      <div class="small">여기서 OCR이 얼마나 제대로 뽑혔는지 즉시 확인해. (정답률의 핵심)</div>
      <div style="height:10px"></div>
      <textarea id="ocrBox" placeholder="OCR 결과가 여기에 표시됨" readonly></textarea>
    </div>

    <div class="card">
      <h2>정답</h2>
      <textarea id="ansBox" placeholder="정답 결과가 여기에 표시됨" readonly></textarea>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    const video = $("video");
    const logEl = $("log");
    const ocrBox = $("ocrBox");
    const ansBox = $("ansBox");
    const btnShot = $("btnShot");
    const btnStart = $("btnStart");
    const resEl = $("res");

    function ts() {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2,"0");
      const mm = String(d.getMinutes()).padStart(2,"0");
      const ss = String(d.getSeconds()).padStart(2,"0");
      return `${hh}:${mm}:${ss}`;
    }

    function log(msg) {
      logEl.textContent += `[${ts()}] ${msg}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }

    let stream = null;
    let busy = false; // ✅ 연타 방지 락

    async function startCamera() {
      if (stream) return;

      log("STATUS: 카메라를 켜고, 페이지 1부터 한 페이지씩 촬영해.");

      // ✅ iPhone Safari가 ideal을 무시하는 경우가 있어 min+ideal 같이 줌
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width:  { min: 1280, ideal: 1920 },
          height: { min: 720,  ideal: 1080 },
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;

      await new Promise((r) => {
        video.onloadedmetadata = () => r();
      });

      // ✅ 가능한 경우 한 번 더 해상도 올리기 시도(실패해도 무시)
      try {
        const track = stream.getVideoTracks()[0];
        await track.applyConstraints({
          advanced: [
            { width: 1920, height: 1080 },
            { width: 1280, height: 720 }
          ]
        });
      } catch (_) {}

      // ✅ 실제 들어온 해상도 표시
      setTimeout(() => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        resEl.textContent = vw && vh ? `캠 해상도: ${vw}×${vh}` : "";
        log("STATUS: 카메라가 켜졌어. 시험지를 화면에 꽉 차게 맞춰줘.");
      }, 200);
    }

    function captureDataURL() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) throw new Error("Video not ready");

      const canvas = document.createElement("canvas");
      canvas.width = vw;
      canvas.height = vh;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, vw, vh);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      return { dataUrl, vw, vh, length: dataUrl.length };
    }

    async function doOCR(page, dataUrl) {
      const res = await fetch("/.netlify/functions/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page, image: dataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok && data.ok, ...data };
    }

    async function doSolve(page, ocrText) {
      const res = await fetch("/.netlify/functions/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page, ocrText }),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok && data.ok, ...data };
    }

    btnStart.addEventListener("click", async () => {
      try {
        await startCamera();
      } catch (e) {
        log(`STATUS: 카메라 실패: ${e?.message || e}`);
      }
    });

    btnShot.addEventListener("click", async () => {
      if (busy) return;         // ✅ 연타 방지
      busy = true;
      btnShot.disabled = true;  // ✅ UI 차단

      try {
        await startCamera();

        const page = Number($("page").value || 1);

        log(`STATUS: 페이지 ${page} 촬영 중... 시험지를 흔들리지 않게 잡고 있어줘.`);
        const cap = captureDataURL();
        log(`capture size ${JSON.stringify({ width: cap.vw, height: cap.vh, length: Math.floor(cap.length/4) })}`);

        log("STATUS: OCR 처리 중...");
        const ocr = await doOCR(page, cap.dataUrl);
        log(`OCR response ${JSON.stringify(ocr).slice(0, 1200)}`);

        if (!ocr.ok) {
          log(`STATUS: OCR 실패: ${ocr.error || "Unknown"}${ocr.detail ? " / " + ocr.detail : ""}`);
          return;
        }

        ocrBox.value = ocr.text || "";

        log(`STATUS: OCR 완료 (평균 신뢰도: ${ocr.conf ?? 0}, 번호 패턴 수: ${ocr.hits ?? 0}). 이제 정답을 생성할게.`);
        const solved = await doSolve(page, ocr.text || "");
        log(`solve response ${JSON.stringify(solved).slice(0, 1200)}`);

        if (!solved.ok) {
          log(`STATUS: solve 실패: ${solved.error || "Unknown"}`);
          return;
        }

        ansBox.value = solved.text || "";
        log(`STATUS: 페이지 ${page} 정답을 생성했어. XURTH가 들리면 이 페이지는 끝이야.`);
      } catch (e) {
        log(`STATUS: 처리 실패: ${e?.message || e}`);
      } finally {
        busy = false;
        btnShot.disabled = false;
      }
    });
  </script>
</body>
</html>
