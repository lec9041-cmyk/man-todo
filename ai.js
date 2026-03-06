/**
 * PulseHome AI Proxy — /api/ai.js
 * Provider: "claude" | "openai" (env: AI_PROVIDER, default: claude)
 * Vercel env vars:
 *   ANTHROPIC_API_KEY  — for Claude
 *   OPENAI_API_KEY     — for OpenAI (fallback)
 *   AI_PROVIDER        — "claude" | "openai" (optional, default "claude")
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ reply: '', error: 'POST only', message: 'POST only' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  if (!body) return res.status(400).json({ reply: '', error: 'Invalid body', message: 'Invalid body' });

  const { mode, payload } = body;
  if (!payload) return res.status(400).json({ reply: '', error: 'Missing payload', message: 'Missing payload' });

  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase();

  try {
    let reply;
    if (provider === 'openai') {
      reply = await callOpenAI(mode, payload);
    } else {
      reply = await callClaude(mode, payload);
    }
    return res.status(200).json({ reply, message: 'OK' });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'AI 요청 시간 초과' : `AI 오류: ${String(err).slice(0, 200)}`;
    return res.status(500).json({ reply: '', error: msg, message: msg });
  }
}

// ─── Claude (Anthropic) ────────────────────────────────────────────────────
async function callClaude(mode, payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const { systemPrompt, userMessage, history = [] } = buildMessages(mode, payload);

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
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
  return data.content?.[0]?.text || '응답을 받지 못했어요.';
}

// ─── OpenAI ───────────────────────────────────────────────────────────────
async function callOpenAI(mode, payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const { systemPrompt, userMessage, history = [] } = buildMessages(mode, payload);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 28000);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
  return data.choices?.[0]?.message?.content || '응답을 받지 못했어요.';
}

// ─── Message Builder ───────────────────────────────────────────────────────
function buildMessages(mode, payload) {
  const baseSystem = `당신은 PulseHome의 AI 플래너 어시스턴트입니다. 
사용자의 생산성과 목표 달성을 돕는 친근하고 동기부여가 되는 한국어 코치입니다.
구체적이고 실행 가능한 짧은 답변을 주세요 (200자 이내).`;

  if (mode === 'chat') {
    return {
      systemPrompt: payload.systemPrompt || baseSystem,
      userMessage: payload.message || '',
      history: Array.isArray(payload.history) ? payload.history : []
    };
  }

  // Legacy modes (breakdown / mandalart / top3) — kept for compatibility
  if (mode === 'breakdown') {
    return {
      systemPrompt: baseSystem,
      userMessage: `"${payload.todoText}"를 실행 가능한 하위 할일 5~7개로 분해해서 번호 목록으로 알려주세요.`,
      history: []
    };
  }

  if (mode === 'mandalart') {
    return {
      systemPrompt: baseSystem,
      userMessage: `만다라트 중심 목표: "${payload.coreGoal}"\n이 목표를 달성하기 위한 8가지 핵심 전략을 번호 목록으로 제안해주세요.`,
      history: []
    };
  }

  if (mode === 'top3') {
    const list = (payload.todos || []).map(t => `- ${t.text}`).join('\n');
    return {
      systemPrompt: baseSystem,
      userMessage: `아래 할일 목록 중 오늘 가장 집중해야 할 3개를 골라 이유와 함께 알려주세요:\n${list}`,
      history: []
    };
  }

  return { systemPrompt: baseSystem, userMessage: payload.message || '안녕하세요!', history: [] };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
