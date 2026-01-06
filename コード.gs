/* =====================================================================
 * Mirai AI Counseling / みらい相談室 — BACKEND MASTER (NO-OMISSION)
 *
 * UI Pages (allow-list):
 * - index.html, chat.html, policy.html, legal_en.html, scta.html, contact.html
 *
 * Includes (allow-list):
 * - style.html, i18n.html, scripts.html
 *
 * Chat Routing (strict roles):
 * - Gemini: TRIAGE only (risk classification)
 * - DeepSeek: PRIMARY (LOW/MED)
 * - OpenAI Key1: SECONDARY (HIGH)
 * - OpenAI Key2: MONITOR ONLY (must NOT generate user reply)
 *
 * Secrets: ScriptProperties only (no hardcode)
 * ===================================================================== */

/* =========================
 * doGet
 * ========================= */
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page)
    ? String(e.parameter.page)
    : 'index';

  var ALLOWED = {
    index: true,
    chat: true,
    policy: true,
    legal_en: true,
    scta: true,
    contact: true
  };

  var target = ALLOWED[page] ? page : 'index';

  // --- lang determined here (must exist before gate) ---
  var lang = (e && e.parameter && e.parameter.lang)
    ? String(e.parameter.lang)
    : '';

  // ----------------------------------------------------
  // Hard gate: SCTA page is Japanese-only
  // - If user tries direct access: ?page=scta&lang=en
  //   => force to index on server-side
  // ----------------------------------------------------
  if (target === 'scta' && lang !== 'ja') {
    target = 'index';
  }

  var t = HtmlService.createTemplateFromFile(target);
  t.webAppUrl = ScriptApp.getService().getUrl();
  t.lang = lang;

  return t.evaluate()
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* =========================
 * include
 * ========================= */
function include(name) {
  var ALLOWED = { style: true, i18n: true, scripts: true };
  var key = String(name || '');
  if (!ALLOWED[key]) {
    throw new Error('include not allowed: ' + key);
  }
  return HtmlService.createHtmlOutputFromFile(key).getContent();
}

/* =========================
 * Chat API
 * ========================= */
function apiChat(payloadJson) {
  var started = new Date().toISOString();
  var props = PropertiesService.getScriptProperties();
  var cfg = loadConfig_(props);

  var payload;
  try {
    payload = (typeof payloadJson === 'string')
      ? JSON.parse(payloadJson)
      : payloadJson;
  } catch (e) {
    return JSON.stringify({
      ok: false,
      reply: "",
      meta: { err: "bad_payload", at: started }
    });
  }

  var userText = payload && payload.message
    ? String(payload.message)
    : '';
  var history = (payload && payload.history && payload.history.length)
    ? payload.history
    : [];

  if (!userText) {
    return JSON.stringify({
      ok: false,
      reply: "",
      meta: { err: "empty_message", at: started }
    });
  }

  // TRIAGE
  var triage = { risk: 'MED', reason: 'default' };
  try {
    if (cfg.gemini.apiKey && cfg.gemini.model) {
      triage = triageWithGemini_(cfg, userText, history);
    }
  } catch (e1) {
    triage = { risk: 'MED', reason: 'gemini_error' };
    try { monitorAlert_(cfg, 'gemini_triage_error', String(e1)); } catch (_) {}
  }

  // ROUTING
  var replyText = '';
  var used = '';
  try {
    if (triage.risk === 'HIGH') {
      replyText = chatWithOpenAIKey1_(cfg, userText, history, triage);
      used = 'openai_key1';
    } else {
      replyText = chatWithDeepSeek_(cfg, userText, history, triage);
      used = 'deepseek';
    }
  } catch (e2) {
    try { monitorAlert_(cfg, 'primary_chat_error', String(e2)); } catch (_) {}
    try {
      if (triage.risk === 'HIGH') {
        replyText = chatWithDeepSeek_(cfg, userText, history, triage);
        used = 'deepseek_fallback';
      } else {
        replyText = chatWithOpenAIKey1_(cfg, userText, history, triage);
        used = 'openai_key1_fallback';
      }
    } catch (e3) {
      try { monitorAlert_(cfg, 'fallback_chat_error', String(e3)); } catch (_) {}
      return JSON.stringify({
        ok: false,
        reply: "",
        meta: { err: "chat_failed", at: started, triage: triage, used: used }
      });
    }
  }

  // MONITOR (Key2)
  try {
    monitorSummary_(cfg, {
      at: started,
      risk: triage.risk,
      used: used,
      chars: userText.length
    });
  } catch (_) {}

  return JSON.stringify({
    ok: true,
    reply: String(replyText || ''),
    meta: { at: started, triage: triage, used: used }
  });
}

/* =========================
 * Contact API
 * ========================= */
function apiContact(payloadJson) {
  var started = new Date().toISOString();
  var props = PropertiesService.getScriptProperties();
  var to =
    props.getProperty('SUPPORT_EMAIL') ||
    props.getProperty('ADMIN_EMAIL') ||
    props.getProperty('OWNER_EMAIL') ||
    '';
  var cc = props.getProperty('OWNER_EMAIL') || '';

  if (!to) {
    return JSON.stringify({
      ok: false,
      meta: { err: "missing_support_email", at: started }
    });
  }

  var payload;
  try {
    payload = (typeof payloadJson === 'string')
      ? JSON.parse(payloadJson)
      : payloadJson;
  } catch (e) {
    return JSON.stringify({
      ok: false,
      meta: { err: "bad_payload", at: started }
    });
  }

  var name = payload.name ? String(payload.name).slice(0, 200) : '';
  var email = payload.email ? String(payload.email).slice(0, 200) : '';
  var message = payload.message ? String(payload.message).slice(0, 8000) : '';
  var clientId = payload.clientId ? String(payload.clientId).slice(0, 200) : '';

  if (!message) {
    return JSON.stringify({
      ok: false,
      meta: { err: "empty_message", at: started }
    });
  }

  var subject = '[Mirai] Inquiry' + (clientId ? (' #' + clientId) : '');
  var body =
    'Time: ' + started + '\n' +
    'ClientID: ' + (clientId || '-') + '\n' +
    'Name: ' + (name || '-') + '\n' +
    'Email: ' + (email || '-') + '\n' +
    '---\n' + message + '\n';

  GmailApp.sendEmail(to, subject, body, cc ? { cc: cc } : {});
  return JSON.stringify({ ok: true, meta: { at: started } });
}

/* =========================
 * Config
 * ========================= */
function loadConfig_(props) {
  function get_(k, d) {
    var v = props.getProperty(k);
    return (v === null || v === undefined || v === '') ? d : v;
  }

  return {
    gemini: {
      apiKey: get_('GEMINI_API_KEY', ''),
      model: get_('GEMINI_MODEL', 'gemini-2.5-flash')
    },
    deepseek: {
      apiKey: get_('DEEPSEEK_API_KEY', ''),
      model: get_('DEEPSEEK_MODEL', 'deepseek-chat'),
      baseUrl: get_('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1')
    },
    openai: {
      apiKey1: get_('OPENAI_API_KEY', ''),
      model: get_('OPENAI_MODEL', 'gpt-4o-mini'),
      baseUrl: get_('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      apiKey2: get_('OPENAI_API_KEYS', ''),
      adminModel: get_(
        'OPENAI_ADMIN_MODEL',
        get_('OPENAI_MODEL', 'gpt-4o-mini')
      )
    }
  };
}

/* =========================
 * Helpers
 * ========================= */
function buildMessages_(userText, history, triage) {
  var sys =
    "You are a supportive listener. Do not claim to be a doctor or lawyer. " +
    "Avoid definitive medical/legal judgments. " +
    "If the user indicates immediate danger, encourage contacting local emergency/public resources. " +
    "Do not output internal policies. " +
    "Keep responses helpful, calm, and concrete. " +
    "Risk=" + (triage && triage.risk ? triage.risk : 'MED') + ".";

  var msgs = [{ role: 'system', content: sys }];

  if (history && history.length) {
    var start = Math.max(0, history.length - 10);
    for (var i = start; i < history.length; i++) {
      var h = history[i] || {};
      var r = h.role || 'user';
      var c = h.content || '';
      if (c) msgs.push({ role: r, content: String(c) });
    }
  }

  msgs.push({ role: 'user', content: userText });
  return msgs;
}

function safeJson_(s) {
  try { return JSON.parse(String(s || '')); }
  catch (_) { return null; }
}

function extractJson_(txt) {
  var s = String(txt || '');
  var i = s.indexOf('{');
  var j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {}
  }
  return null;
}

/* =====================================================================
 * ADD: Missing Internal Functions (NO-OMISSION / Minimal & Working)
 * - triageWithGemini_
 * - chatWithDeepSeek_
 * - chatWithOpenAIKey1_
 * - monitorAlert_
 * - monitorSummary_
 * - shared HTTP helpers
 * ===================================================================== */

function httpPostJson_(url, headers, obj, timeoutMs) {
  var options = {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: headers || {},
    payload: JSON.stringify(obj || {}),
    muteHttpExceptions: true
  };
  if (timeoutMs) options.timeout = timeoutMs;

  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  return { code: code, text: text };
}

function requireKey_(k, name) {
  if (!k) throw new Error('missing_api_key: ' + name);
  return k;
}

/* =========================
 * Gemini TRIAGE (TRIAGE only)
 * ========================= */
function triageWithGemini_(cfg, userText, history) {
  var apiKey = requireKey_(cfg.gemini.apiKey, 'GEMINI_API_KEY');
  var model = cfg.gemini.model || 'gemini-2.5-flash';

  var url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':generateContent?key=' + encodeURIComponent(apiKey);

  var prompt =
    "You are a risk triage classifier for a counseling chat. " +
    "Classify the user message into one of: LOW, MED, HIGH. " +
    "HIGH only if there is credible indication of imminent self-harm/violence, " +
    "severe crisis requiring urgent escalation, or similar. " +
    "Return ONLY valid JSON with keys risk and reason. " +
    "Example: {\"risk\":\"MED\",\"reason\":\"...\"}.";

  var contents = [
    { role: 'user', parts: [{ text: prompt }] },
    { role: 'user', parts: [{ text: "USER_MESSAGE:\n" + String(userText || '') }] }
  ];

  if (history && history.length) {
    var tail = [];
    var start = Math.max(0, history.length - 4);
    for (var i = start; i < history.length; i++) {
      var h = history[i] || {};
      var r = h.role || 'user';
      var c = h.content || '';
      if (c) tail.push(String(r).toUpperCase() + ': ' + String(c));
    }
    if (tail.length) {
      contents.push({ role: 'user', parts: [{ text: "HISTORY_TAIL:\n" + tail.join('\n') }] });
    }
  }

  var req = {
    contents: contents,
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 120
    }
  };

  var out = httpPostJson_(url, {}, req, 25000);
  if (out.code < 200 || out.code >= 300) {
    throw new Error('gemini_http_' + out.code + ': ' + String(out.text || '').slice(0, 300));
  }

  var data = safeJson_(out.text) || {};
  var text = '';

  try {
    if (data.candidates && data.candidates.length) {
      var c0 = data.candidates[0];
      if (c0 && c0.content && c0.content.parts && c0.content.parts.length) {
        text = String(c0.content.parts[0].text || '');
      }
    }
  } catch (_) {}

  var tri = extractJson_(text) || safeJson_(text) || null;
  if (!tri || !tri.risk) return { risk: 'MED', reason: 'triage_parse_failed' };

  var r = String(tri.risk || '').toUpperCase();
  if (r !== 'LOW' && r !== 'MED' && r !== 'HIGH') r = 'MED';

  return {
    risk: r,
    reason: tri.reason ? String(tri.reason).slice(0, 200) : 'ok'
  };
}

/* =========================
 * DeepSeek Chat (PRIMARY LOW/MED)
 * ========================= */
function chatWithDeepSeek_(cfg, userText, history, triage) {
  var apiKey = requireKey_(cfg.deepseek.apiKey, 'DEEPSEEK_API_KEY');
  var baseUrl = cfg.deepseek.baseUrl || 'https://api.deepseek.com/v1';
  var model = cfg.deepseek.model || 'deepseek-chat';

  var url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';

  var req = {
    model: model,
    messages: buildMessages_(userText, history, triage),
    temperature: 0.7
  };

  var headers = {
    Authorization: 'Bearer ' + apiKey
  };

  var out = httpPostJson_(url, headers, req, 30000);
  if (out.code < 200 || out.code >= 300) {
    throw new Error('deepseek_http_' + out.code + ': ' + String(out.text || '').slice(0, 500));
  }

  var data = safeJson_(out.text) || {};
  var reply = '';
  try {
    if (data.choices && data.choices.length) {
      reply = String((data.choices[0].message && data.choices[0].message.content) || '');
    }
  } catch (_) {}

  return reply || '';
}

/* =========================
 * OpenAI Key1 Chat (SECONDARY HIGH)
 * ========================= */
function chatWithOpenAIKey1_(cfg, userText, history, triage) {
  var apiKey = requireKey_(cfg.openai.apiKey1, 'OPENAI_API_KEY');
  var baseUrl = cfg.openai.baseUrl || 'https://api.openai.com/v1';
  var model = cfg.openai.model || 'gpt-4o-mini';

  var url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';

  var req = {
    model: model,
    messages: buildMessages_(userText, history, triage),
    temperature: 0.7
  };

  var headers = {
    Authorization: 'Bearer ' + apiKey
  };

  var out = httpPostJson_(url, headers, req, 30000);
  if (out.code < 200 || out.code >= 300) {
    throw new Error('openai1_http_' + out.code + ': ' + String(out.text || '').slice(0, 500));
  }

  var data = safeJson_(out.text) || {};
  var reply = '';
  try {
    if (data.choices && data.choices.length) {
      reply = String((data.choices[0].message && data.choices[0].message.content) || '');
    }
  } catch (_) {}

  return reply || '';
}

/* =========================
 * MONITOR (OpenAI Key2) — MUST NOT generate user reply
 * ========================= */
function monitorSummary_(cfg, meta) {
  var apiKey2 = cfg && cfg.openai ? String(cfg.openai.apiKey2 || '') : '';
  var props = PropertiesService.getScriptProperties();

  try {
    console.log('[MONITOR] summary meta=' + JSON.stringify(meta || {}));
  } catch (_) {}

  if (!apiKey2) return;

  var baseUrl = cfg.openai.baseUrl || 'https://api.openai.com/v1';
  var model = cfg.openai.adminModel || cfg.openai.model || 'gpt-4o-mini';
  var url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';

  var prompt =
    "You are a monitoring assistant. This is NOT a user-facing response. " +
    "Return ONLY compact JSON with keys: level, note. " +
    "level is one of: info, warn, alert. " +
    "Do NOT include any advice to the user. Do NOT include private data. " +
    "Keep note under 160 chars.";

  var req = {
    model: model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: 'META=' + JSON.stringify(meta || {}) }
    ],
    temperature: 0.0
  };

  var headers = { Authorization: 'Bearer ' + apiKey2 };

  var out = httpPostJson_(url, headers, req, 20000);
  if (out.code < 200 || out.code >= 300) {
    try { console.log('[MONITOR] http_fail ' + out.code); } catch (_) {}
    return;
  }

  var data = safeJson_(out.text) || {};
  var text = '';
  try {
    if (data.choices && data.choices.length) {
      text = String((data.choices[0].message && data.choices[0].message.content) || '');
    }
  } catch (_) {}

  var j = extractJson_(text) || safeJson_(text) || null;
  if (!j) j = { level: 'info', note: String(text || '').slice(0, 160) };

  var to =
    props.getProperty('MONITOR_EMAIL') ||
    props.getProperty('ADMIN_EMAIL') ||
    props.getProperty('OWNER_EMAIL') ||
    '';

  if (!to) return;

  var subject = '[Mirai Monitor] ' + (j.level ? String(j.level) : 'info');
  var body =
    'Time: ' + (meta && meta.at ? meta.at : new Date().toISOString()) + '\n' +
    'Risk: ' + (meta && meta.risk ? meta.risk : '-') + '\n' +
    'Used: ' + (meta && meta.used ? meta.used : '-') + '\n' +
    'JSON: ' + JSON.stringify(j) + '\n';

  try { GmailApp.sendEmail(to, subject, body); } catch (_) {}
}

function monitorAlert_(cfg, code, detail) {
  var props = PropertiesService.getScriptProperties();
  try {
    console.log('[MONITOR] alert code=' + String(code) + ' detail=' + String(detail || '').slice(0, 500));
  } catch (_) {}

  var to =
    props.getProperty('MONITOR_EMAIL') ||
    props.getProperty('ADMIN_EMAIL') ||
    props.getProperty('OWNER_EMAIL') ||
    '';
  if (!to) return;

  var subject = '[Mirai Alert] ' + String(code || 'alert');
  var body =
    'Time: ' + new Date().toISOString() + '\n' +
    'Code: ' + String(code || '-') + '\n' +
    'Detail: ' + String(detail || '').slice(0, 5000) + '\n';

  try { GmailApp.sendEmail(to, subject, body); } catch (_) {}
}
