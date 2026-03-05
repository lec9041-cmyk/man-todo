export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ items: [], message: "POST only" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ items: [], message: "OPENAI_API_KEY is missing" });
  }

  const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body;
  const mode = body && body.mode;
  const payload = (body && body.payload) || {};

  if (!["breakdown", "mandalart", "top3"].includes(mode)) {
    return res.status(400).json({ items: [], message: "Invalid mode" });
  }

  try {
    const { systemPrompt, userPrompt } = buildPrompts(mode, payload);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        temperature: 0.2,
        max_output_tokens: 1500,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] }
        ]
      })
    });

    clearTimeout(timeout);

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      return res.status(openaiRes.status).json({ items: [], message: `OpenAI error: ${errText.slice(0, 300)}` });
    }

    const openaiJson = await openaiRes.json();
    const rawText = readOutputText(openaiJson);
    const parsed = parseModelJson(rawText);

    if (!parsed || !Array.isArray(parsed.items)) {
      return res.status(502).json({ items: [], message: "Model returned invalid JSON shape" });
    }

    const items = parsed.items
      .filter((item) => item && typeof item.text === "string" && item.text.trim())
      .map((item) => ({
        text: String(item.text).trim(),
        dueDate: normalizeDate(item.dueDate),
        priority: normalizePriority(item.priority),
        category: normalizeCategory(item.category),
        mandalartCell: normalizeCell(item.mandalartCell)
      }));

    const message = typeof parsed.message === "string" ? parsed.message : "AI 추천 결과입니다.";
    return res.status(200).json({ items, message });
  } catch (error) {
    const msg = error && error.name === "AbortError" ? "AI request timeout" : `AI request failed: ${String(error)}`;
    return res.status(500).json({ items: [], message: msg });
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;

  if (Array.isArray(data.output)) {
    const parts = [];
    for (const out of data.output) {
      if (!Array.isArray(out.content)) continue;
      for (const c of out.content) {
        if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      }
    }
    if (parts.length) return parts.join("\n");
  }

  return "";
}

function parseModelJson(text) {
  const direct = safeJsonParse(text);
  if (direct) return direct;

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return safeJsonParse(text.slice(first, last + 1));
}

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function normalizePriority(value) {
  return ["high", "mid", "low"].includes(value) ? value : null;
}

function normalizeCategory(value) {
  if (typeof value !== "string") return null;
  return value.slice(0, 40);
}

function normalizeCell(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n >= 1 && n <= 8 ? n : null;
}

function buildPrompts(mode, payload) {
  const formatRules = [
    "반드시 JSON 객체 하나만 반환하세요.",
    "형식: {\"items\":[...],\"message\":\"...\"}",
    "items 각 항목은 {\"text\":string,\"dueDate\"?:\"YYYY-MM-DD\",\"priority\"?:\"high|mid|low\",\"category\"?:string,\"mandalartCell\"?:1..8}",
    "JSON 외 텍스트, 마크다운, 코드블록 금지",
    "응답 언어는 한국어"
  ].join("\n");

  const systemPrompt = `너는 생산성 코치 AI다. 아래 규칙을 반드시 지켜라.\n${formatRules}`;

  if (mode === "breakdown") {
    const todoText = String(payload.todoText || "").trim();
    return {
      systemPrompt,
      userPrompt: `모드: breakdown\n원본 투두: ${todoText}\n요청: 원본 투두를 실행 가능한 하위 투두 5~10개로 분해해라. items에만 넣어라.`
    };
  }

  if (mode === "mandalart") {
    const goal = String(payload.coreGoal || "").trim();
    return {
      systemPrompt,
      userPrompt: `모드: mandalart\n중앙 목표: ${goal}\n요청:\n1) 1~8번 만다라트 칸 목표 8개 생성 (category는 \"mandalart_goal\", mandalartCell 필수)\n2) 각 칸 목표마다 실행 투두 1개씩 생성 (category는 \"mandala_todo\", mandalartCell 동일)\n총 16개 항목을 items에 반환해라.`
    };
  }

  const todos = Array.isArray(payload.todos) ? payload.todos : [];
  const serialized = JSON.stringify(
    todos.map((t) => ({
      text: t && t.text,
      done: Boolean(t && t.done),
      today: Boolean(t && t.today),
      priority: t && t.priority,
      dueDate: t && t.dueDate,
      category: t && t.category
    }))
  );

  return {
    systemPrompt,
    userPrompt: `모드: top3\n후보 투두(JSON): ${serialized}\n요청: 오늘 집중할 3개를 선택해 items에 넣어라. 반드시 후보의 text를 그대로 사용해라.`
  };
}
