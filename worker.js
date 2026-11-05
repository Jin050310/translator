// Cloudflare Worker: Gemini 키를 숨기고, 비밀번호가 맞을 때만 번역해 주는 중계 서버
//
// 필요한 설정 (Cloudflare 대시보드 → Worker → Settings → Variables and Secrets)
//   GEMINI_API_KEY : AI Studio에서 만든 키 (Secret)
//   APP_PASSWORD   : 친구와 나만 아는 비밀번호 (Secret)
//   ALLOWED_ORIGIN : (선택) 예: https://내아이디.github.io  → 이 주소에서만 요청 허용

const MODEL = "gemini-2.5-flash-lite"; // 한도가 안 맞으면 여기만 바꾸면 돼요

const PROMPT = `You are a precise OCR + translation tool.
Read ALL visible text in the image. The text is Korean or English.
Translate each piece of text into natural Japanese.
- If the image is a word list or vocabulary table, make one item per word: "original" is the word, "japanese" is its Japanese translation. Use the Korean meaning shown next to the word as a hint for the correct sense.
- If the image is a sentence or paragraph, make one item per sentence or line.
- Skip watermarks, URLs, browser UI and status bars.
- Keep the reading order (top to bottom, left to right).
If there is no readable text, return an empty items array.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          original: { type: "STRING" },
          japanese: { type: "STRING" },
        },
        required: ["original", "japanese"],
      },
    },
  },
  required: ["items"],
};

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "잘못된 요청이에요." }, 400, env);
    }

    // 비밀번호 확인
    if (!env.APP_PASSWORD || body.password !== env.APP_PASSWORD) {
      return json({ error: "비밀번호가 틀렸어요." }, 401, env);
    }

    const image = body.image; // base64 (data: 접두사 없이)
    const mime = body.mime || "image/jpeg";
    if (!image || typeof image !== "string") {
      return json({ error: "이미지가 없어요." }, 400, env);
    }
    if (image.length > 6_000_000) {
      return json({ error: "이미지가 너무 커요." }, 413, env);
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL +
      ":generateContent";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mime, data: image } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          temperature: 0.2,
        },
      }),
    });

    if (res.status === 429) {
      return json({ error: "오늘 무료 한도나 분당 한도에 걸렸어요. 잠시 뒤에 다시 해보세요." }, 429, env);
    }
    if (!res.ok) {
      const t = await res.text();
      return json({ error: "Gemini 오류 (" + res.status + ")", detail: t.slice(0, 300) }, 502, env);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return json({ error: "응답이 비어 있어요. 다시 찍어보세요." }, 502, env);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "결과를 해석하지 못했어요. 다시 시도해 주세요." }, 502, env);
    }
    return json(parsed, 200, env);
  },
};
