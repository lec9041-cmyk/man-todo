/**
 * PulseHome AI Proxy — /api/ai.js (legacy)
 * Provider: "claude" | "openai" (env: AI_PROVIDER, default: claude)
 * Vercel env vars:
 *   ANTHROPIC_API_KEY  — for Claude
 *   OPENAI_API_KEY     — for OpenAI (fallback)
 *   AI_PROVIDER        — "claude" | "openai" (optional, default "claude")
 */

const VALID_MODES = new Set(["chat", "suggest", "weekly-review", "breakdown", "mandalart", "top3"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ reply: "", error: "POST only", message: "POST only" });
  }

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ reply: "", error: "Invalid body", message: "Invalid body" });
  }

  const { mode, payload } = body;

  // [버그수정] mode 검증 추가 — 정의되지 않은 mode로 호출 시 400 반환
  if (!mode || !VALID_MODES.has(mode)) {
    const emsg=`Invalid mode. Allowed: ${[...VALID_MODES].join(", ")}`;
    return res.status(400).json({ reply: "", error: emsg, message: emsg });
  }

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ reply: "", error: "Missing payload", message: "Missing payload" });
  }

  // [버그수정] payload 기본 검증 — 필수 필드 누락 시 빠른 실패
  const validationError = validatePayload(mode, payload);
  if (validationError) {
    return res.status(400).json({ reply: "", error: validationError, message: validationError });
  }

  const provider = (process.env.AI_PROVIDER || "claude").toLowerCase();

  try {
    let reply;
    if (provider === "openai") {
      reply = await callOpenAI(mode, payload);
    } else {
      reply = await callClaude(mode, payload);
    }
    return res.status(200).json({ reply, message: "OK" });
  } catch (err) {
    const msg = err?.name === "AbortError"
      ? "AI 요청 시간 초과"
      : `AI 오류: ${String(err).slice(0, 200)}`;
    return res.status(500).json({ reply: "", error: msg, message: msg });
  }
}

// ─── Payload 검증 ─────────────────────────────────────────────────────────
function validatePayload(mode, payload) {
  if (mode === "chat") {
    const msg = payload.message ?? payload.prompt;
    if (!msg || typeof msg !== "string" || !String(msg).trim()) {
      return "chat 모드: payload.message가 필요합니다.";
    }
    if (String(msg).length > 4000) return "메시지가 너무 깁니다 (최대 4000자).";
  }

  if (mode === "suggest" || mode === "weekly-review") {
    const msg = payload.message ?? payload.prompt;
    if (!msg || typeof msg !== "string" || !String(msg).trim()) {
      return `${mode} 모드: payload.message가 필요합니다.`;
    }
    if (String(msg).length > 4000) return "메시지가 너무 깁니다 (최대 4000자).";
  }

  if (mode === "breakdown") {
    if (!payload.todoText || typeof payload.todoText !== "string" || !payload.todoText.trim()) {
      return "breakdown 모드: payload.todoText가 필요합니다.";
    }
  }

  if (mode === "mandalart") {
    if (!payload.coreGoal || typeof payload.coreGoal !== "string" || !payload.coreGoal.trim()) {
      return "mandalart 모드: payload.coreGoal이 필요합니다.";
    }
  }

  if (mode === "top3") {
    if (!Array.isArray(payload.todos)) {
      return "top3 모드: payload.todos 배열이 필요합니다.";
    }
  }

  // history 검증 (chat 모드에서 선택적 사용)
  if (payload.history !== undefined && payload.history !== null) {
    if (!Array.isArray(payload.history)) return "payload.history는 배열이어야 합니다.";
    if (payload.history.length > 20) return "history가 너무 깁니다 (최대 20개).";
    const allowedRoles = new Set(["system", "user", "assistant"]);
    for (const item of payload.history) {
      if (!item || typeof item !== "object") return "history 항목이 올바르지 않습니다.";
      if (!allowedRoles.has(item.role)) return `올바르지 않은 history role: ${item.role}`;
      if (typeof item.content !== "string") return "history content는 문자열이어야 합니다.";
    }
  }

  return null; // 검증 통과
}

// ─── Claude (Anthropic) ────────────────────────────────────────────────────
async function callClaude(mode, payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const { systemPrompt, userMessage, history = [] } = buildMessages(mode, payload);

  // [버그수정] userMessage가 undefined일 경우 방어 처리
  if (!userMessage) throw new Error("buildMessages가 유효한 userMessage를 반환하지 않았습니다.");

  const messages = [
    ...history.map(h => ({ role: h.role, content: String(h.content) })),
    { role: "user", content: userMessage }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: systemPrompt,
      messages
    })
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || "응답을 받지 못했어요.";
}

// ─── OpenAI ───────────────────────────────────────────────────────────────
async function callOpenAI(mode, payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const { systemPrompt, userMessage, history = [] } = buildMessages(mode, payload);

  // [버그수정] userMessage가 undefined일 경우 방어 처리
  if (!userMessage) throw new Error("buildMessages가 유효한 userMessage를 반환하지 않았습니다.");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: String(h.content) })),
    { role: "user", content: userMessage }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: 800,
      messages
    })
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "응답을 받지 못했어요.";
}

// ─── Message Builder ───────────────────────────────────────────────────────
function buildMessages(mode, payload) {
  const baseSystem = `당신은 PulseHome의 AI 플래너 어시스턴트입니다.
사용자의 생산성과 목표 달성을 돕는 친근하고 동기부여가 되는 한국어 코치입니다.
구체적이고 실행 가능한 짧은 답변을 주세요 (200자 이내).`;

  if (mode === "chat") {
    // [버그수정] payload.message / payload.prompt 양쪽 모두 지원
    const userMessage = String(payload.message ?? payload.prompt ?? "").trim();
    return {
      systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : baseSystem,
      userMessage,
      history: Array.isArray(payload.history) ? payload.history : []
    };
  }

  if (mode === "suggest") {
    return {
      systemPrompt: payload.systemPrompt || baseSystem,
      userMessage: `오늘의 생산성 향상을 위한 짧고 실천 가능한 제안 1개를 해주세요:\n${payload.message}`,
      history: Array.isArray(payload.history) ? payload.history : []
    };
  }

  if (mode === "weekly-review") {
    return {
      systemPrompt: payload.systemPrompt || baseSystem,
      userMessage: payload.message || "이번 주를 돌아보고 다음 주 개선점을 알려줘.",
      history: Array.isArray(payload.history) ? payload.history : []
    };
  }

  if (mode === "breakdown") {
    return {
      systemPrompt: baseSystem,
      userMessage: `"${payload.todoText}"를 실행 가능한 하위 할일 5~7개로 분해해서 번호 목록으로 알려주세요.`,
      history: []
    };
  }

  if (mode === "mandalart") {
    return {
      systemPrompt: baseSystem,
      userMessage: `만다라트 중심 목표: "${payload.coreGoal}"\n이 목표를 달성하기 위한 8가지 핵심 전략을 번호 목록으로 제안해주세요.`,
      history: []
    };
  }

  if (mode === "top3") {
    // [버그수정] todos 배열의 각 항목이 text 필드를 가지는지 안전하게 확인
    const list = (payload.todos || [])
      .filter(t => t && typeof t.text === "string")
      .map(t => `- ${t.text}`)
      .join("\n");
    return {
      systemPrompt: baseSystem,
      userMessage: list
        ? `아래 할일 목록 중 오늘 가장 집중해야 할 3개를 골라 이유와 함께 알려주세요:\n${list}`
        : "할일 목록이 비어 있습니다. 오늘 시작할 수 있는 작은 할일을 제안해주세요.",
      history: []
    };
  }

  // 이론상 도달하지 않음 (validatePayload에서 걸림)
  throw new Error(`지원하지 않는 mode: ${mode}`);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
