export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const mode = body.mode;
  const payload = body.payload;

  if (!['chat', 'suggest', 'weekly-review'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing payload' });
  }

  const validated = validatePayload(payload);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();

  try {
    const reply = provider === 'claude'
      ? await callClaude(mode, validated.value)
      : await callOpenAI(mode, validated.value);

    return res.status(200).json({ reply: truncateReply(reply), message: 'OK' });
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? 'AI request timeout'
      : `AI request failed: ${String(err).slice(0, 220)}`;
    return res.status(500).json({ error: message });
  }
}

function validatePayload(payload) {
  const message = String(payload.message ?? payload.prompt ?? '').trim();
  if (!message) return { ok: false, error: 'Message is required' };
  if (message.length > 4000) return { ok: false, error: 'Message is too long (max 4000 chars)' };

  const allowedRoles = new Set(['system', 'user', 'assistant']);
  const rawHistory = Array.isArray(payload.history) ? payload.history : [];
  if (rawHistory.length > 10) {
    return { ok: false, error: 'History is too long (max 10 messages)' };
  }

  const history = [];
  for (const item of rawHistory) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Invalid history item' };
    }
    if (!allowedRoles.has(item.role)) {
      return { ok: false, error: 'Invalid history role' };
    }
    if (typeof item.content !== 'string') {
      return { ok: false, error: 'Invalid history content' };
    }
    history.push({ role: item.role, content: item.content.slice(0, 2000) });
  }

  const historyTotalLength = history.reduce((sum, item) => sum + item.content.length, 0);
  if (historyTotalLength > 12000) {
    return { ok: false, error: 'History is too long' };
  }

  const systemPrompt = typeof payload.systemPrompt === 'string'
    ? payload.systemPrompt.slice(0, 3000)
    : '';

  return {
    ok: true,
    value: { message, history, systemPrompt }
  };
}

async function callOpenAI(mode, payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const { systemPrompt, userMessage, history } = buildMessages(mode, payload);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
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
      temperature: 0.4,
      messages
    })
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'No response.';
}

async function callClaude(mode, payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const { systemPrompt, userMessage, history } = buildMessages(mode, payload);
  const messages = [
    ...history,
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
  return data.content?.[0]?.text || 'No response.';
}

function buildMessages(mode, payload) {
  const baseSystem = `You are PulseHome's productivity coach.
Keep tone calm, encouraging, practical.
Keep answers concise and structured.`;

  if (mode === 'suggest') {
    return {
      systemPrompt: payload.systemPrompt || baseSystem,
      userMessage: `Give one short daily productivity suggestion:\n${payload.message}`,
      history: payload.history
    };
  }

  if (mode === 'weekly-review') {
    return {
      systemPrompt: payload.systemPrompt || `${baseSystem}\nUse sections: Overall evaluation, Good points, Improvement points, Suggestions for next week, Weekly MVP.`,
      userMessage: payload.message,
      history: payload.history
    };
  }

  return {
    systemPrompt: payload.systemPrompt || baseSystem,
    userMessage: payload.message,
    history: payload.history
  };
}

function truncateReply(text) {
  const normalized = String(text || '').trim();
  const maxLen = 800;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen).trimEnd()}…`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
