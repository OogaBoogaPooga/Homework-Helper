// language: JavaScript, file: homework-helper.js, runtime: browser console
// Homework Helper — Auto + Ask + Solve + Submit + History + Settings + OCR.
// Groq backend. Universal (Buzz, Canvas, Schoology, DeltaMath, IXL, Khan,
// Google Forms, generic radios/texts). OCR via Tesseract.js (lazy-loaded).

// ============================================================
// CORE
// ============================================================
(() => {
  'use strict';

  let KILLED = false;
  const __timers = new Set();
  const ABORT = new AbortController();
  const SIG = { signal: ABORT.signal };
  const clrAll = () => { for (const id of __timers) { clearTimeout(id); clearInterval(id); } __timers.clear(); };
  const sleep = ms => new Promise(res => {
    if (KILLED) return res();
    const id = setTimeout(() => { __timers.delete(id); res(); }, ms);
    __timers.add(id);
  });

  const killHooks = window.__helperKillHooks = window.__helperKillHooks || [];

  const LS = '__hh_cfg_v1';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } })();

  const CFG = {
    ai: {
      key: saved.key || 'PASTE_YOUR_REAL_KEY_HERE',
      model: saved.model || 'openai/gpt-oss-120b',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      temperature: saved.temperature ?? 0.2,
      maxTokens: 400
    },
    timing: {
      minThinkMs: 1400, maxThinkMs: 5200,
      minMoveMs: 220, maxMoveMs: 900,
      minBetweenChoicesMs: 600, maxBetweenChoicesMs: 1800,
      nextDelayMinMs: 1100, nextDelayMaxMs: 3400,
      jitterPx: 6
    },
    autoStart: false,
    dryRun: false,
    autoSubmitSec: saved.autoSubmitSec ?? 0,
    ocrEnabled: saved.ocrEnabled ?? true
  };
  const saveCfg = () => {
    try { localStorage.setItem(LS, JSON.stringify({
      key: CFG.ai.key, model: CFG.ai.model, temperature: CFG.ai.temperature,
      autoSubmitSec: CFG.autoSubmitSec, ocrEnabled: CFG.ocrEnabled
    })); } catch {}
  };

  const rand = (a, b) => Math.random() * (b - a) + a;
  const randInt = (a, b) => Math.floor(rand(a, b + 1));

  const S = {
    tab: 'auto', running: false, busy: false, processed: 0,
    lastAnswer: '—', lastQuestion: '—',
    log: [], history: [], chat: [],
    tokensIn: 0, tokensOut: 0, requests: 0,
    platform: 'unknown',
    consecutive429: 0
  };

  const log = (...a) => {
    if (KILLED) return;
    console.log('%c[hw-helper]', 'color:#e07b39;font-weight:bold', ...a);
    const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    S.log.push(line);
    if (S.log.length > 100) S.log.shift();
  };

  // ============================================================
  // PLATFORM DETECTION
  // ============================================================
  function detectPlatform() {
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    if (/agilixbuzz|buzz\.agilix/.test(host)) return 'buzz';
    if (/instructure\.com/.test(host) && !/accounts/.test(path)) return 'canvas';
    if (/schoology/.test(host)) return 'schoology';
    if (/deltamath/.test(host)) return 'deltamath';
    if (/ixl\.com/.test(host)) return 'ixl';
    if (/khanacademy/.test(host)) return 'khan';
    if (/docs\.google\.com/.test(host) && /\/forms/.test(path)) return 'gforms';
    if (/quizizz|kahoot|quizlet/.test(host)) return 'quizapp';
    return 'generic';
  }

  // ============================================================
  // ANTI-DETECTION
  // ============================================================
  function driftMouse() {
    try {
      const x = randInt(20, window.innerWidth - 20);
      const y = randInt(20, window.innerHeight - 20);
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
      document.dispatchEvent(new PointerEvent('pointermove', o));
      document.dispatchEvent(new MouseEvent('mousemove', o));
    } catch {}
  }
  function driftScroll() {
    try { window.scrollBy({ top: randInt(-40, 60), behavior: 'smooth' }); } catch {}
  }
  function tickHumanActivity() {
    if (KILLED) return;
    const r = Math.random();
    if (r < 0.55) driftMouse();
    else if (r < 0.75) { driftMouse(); driftScroll(); }
    else if (r < 0.85) driftScroll();
  }
  function idlePause() {
    if (Math.random() < 0.20) return sleep(randInt(2500, 7000));
    return Promise.resolve();
  }
  function fireKeystrokes(el, text) {
    try {
      el.focus();
      const n = Math.min(text.length, 25);
      for (let i = 0; i < n; i++) {
        const k = text[i];
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: k, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
      }
    } catch {}
  }
  function spoofFocus() {
    try {
      window.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      document.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    } catch {}
  }

  function humanClick(el) {
    if (!el || KILLED) return;
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 + rand(-CFG.timing.jitterPx, CFG.timing.jitterPx);
      const cy = r.top + r.height / 2 + rand(-CFG.timing.jitterPx, CFG.timing.jitterPx);
      const o = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
      el.dispatchEvent(new PointerEvent('pointerover', o));
      el.dispatchEvent(new MouseEvent('mouseover', o));
      el.dispatchEvent(new PointerEvent('pointermove', o));
      el.dispatchEvent(new MouseEvent('mousemove', o));
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.focus?.();
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
    } catch {
      try { el.click(); } catch {}
    }
  }

  // ============================================================
  // OCR (Tesseract.js, lazy-loaded)
  // ============================================================
  let OCR_LOADING = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (OCR_LOADING) return OCR_LOADING;
    OCR_LOADING = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error('Tesseract load failed'));
      document.head.appendChild(s);
      killHooks.push(() => { try { s.remove(); } catch {} });
    });
    return OCR_LOADING;
  }

  async function ocrPageImages() {
    if (!CFG.ocrEnabled || KILLED) return [];
    // find large images that look like documents (not icons/avatars)
    const candidates = [...document.querySelectorAll('img')].filter(img => {
      if (img.offsetParent === null) return false;
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) return false;
      // skip if tiny by natural size too
      if (img.naturalWidth && img.naturalWidth < 200) return false;
      return true;
    });
    if (!candidates.length) return [];
    log('OCR: found', candidates.length, 'candidate image(s)');
    let T;
    try { T = await loadTesseract(); }
    catch (e) { log('OCR disabled — Tesseract failed to load:', e.message); return []; }
    const results = [];
    for (const img of candidates) {
      if (KILLED) break;
      try {
        const { data: { text } } = await T.recognize(img.src, 'eng', { logger: () => {} });
        const clean = (text || '').replace(/\s+/g, ' ').trim();
        if (clean.length > 40) {
          results.push(clean);
          log('OCR: extracted', clean.length, 'chars from image');
        }
      } catch (e) { log('OCR fail on one image:', e.message); }
    }
    return results;
  }

  // ============================================================
  // BUZZ DOM
  // ============================================================
  const getQuestionBlocks = () => [...document.querySelectorAll('lib-question')].filter(b => b.offsetParent !== null);
  const getChoices = b => [...b.querySelectorAll('input.mdc-radio__native-control, input.mdc-checkbox__native-control')];
  const clickTargetFor = i => i.closest('label.mdc-form-field') || i.closest('label') || i.closest('mat-radio-button, mat-checkbox') || i;
  const getQuestionText = b => {
    const body = b.querySelector('lib-managed-html, .question-body');
    return (body?.textContent || b.textContent || '').replace(/\s+/g, ' ').trim();
  };
  function getChoiceText(input) {
    const lbl = input.getAttribute('aria-labelledby');
    if (lbl) {
      const parts = lbl.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
      if (parts.length) {
        const t = parts.map(p => p.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    }
    const tr = input.closest('tr');
    if (tr) {
      const cells = [...tr.querySelectorAll('td')].filter(td => !td.classList.contains('choice-input') && !td.contains(input));
      const t = cells.map(td => td.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const wrap = input.closest('mat-radio-button, mat-checkbox') || input.closest('label')?.parentElement;
    return (wrap?.textContent || '').replace(/\s+/g, ' ').trim();
  }
  const isMultiSelect = b => !!b.querySelector('input.mdc-checkbox__native-control');

  // ============================================================
  // GENERIC DOM HELPERS
  // ============================================================
  function isOurs(el) { return !!(el && el.closest && el.closest('#__hh_ui')); }

  function visibleEls(sel, root = document) {
    return [...root.querySelectorAll(sel)].filter(el => el.offsetParent !== null && !isOurs(el));
  }

  function labelTextForInput(input) {
    if (!input) return '';
    const id = input.id;
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab && lab.textContent.trim()) return lab.textContent.replace(/\s+/g, ' ').trim();
    }
    const wrapLab = input.closest('label');
    if (wrapLab) {
      const clone = wrapLab.cloneNode(true);
      const inp = clone.querySelector('input, textarea, select');
      if (inp) inp.remove();
      const t = clone.textContent.replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const al = input.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const alb = input.getAttribute('aria-labelledby');
    if (alb) {
      const t = alb.split(/\s+/).map(x => document.getElementById(x)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const sib = input.nextElementSibling;
    if (sib && sib.textContent.trim().length > 0 && sib.textContent.length < 300) {
      return sib.textContent.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  // broadened question-text resolver: nearest preceding text block > 80 chars
  function nearestPrecedingText(el) {
    let cur = el;
    for (let depth = 0; depth < 10 && cur; depth++) {
      let sib = cur.previousElementSibling;
      let hops = 0;
      while (sib && hops < 4) {
        const t = (sib.innerText || sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 80 && t.length < 1500) return t;
        sib = sib.previousElementSibling;
        hops++;
      }
      cur = cur.parentElement;
      if (!cur || cur.tagName === 'BODY') break;
    }
    // last resort: nearest heading before the element
    const all = [...document.querySelectorAll('h1, h2, h3, h4, legend, p')];
    const r = el.getBoundingClientRect();
    let best = null, bestDist = Infinity;
    for (const h of all) {
      const hr = h.getBoundingClientRect();
      if (hr.top > r.top) continue;
      const d = r.top - hr.bottom;
      if (d < bestDist && d < 600) { bestDist = d; best = h; }
    }
    if (best) {
      const t = (best.innerText || best.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 20) return t;
    }
    return '';
  }

  function questionTextForEl(el) {
    if (!el) return '';
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      let sib = cur.previousElementSibling;
      let hops = 0;
      while (sib && hops < 3) {
        const cls = (sib.className || '').toString().toLowerCase();
        const tag = sib.tagName.toLowerCase();
        const txt = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && txt.length > 8 && txt.length < 800 && (
          /question|prompt|stem|text|label|q-?text|problem|exercise/.test(cls) ||
          ['p', 'legend', 'h1', 'h2', 'h3', 'h4'].includes(tag)
        )) {
          return txt;
        }
        sib = sib.previousElementSibling;
        hops++;
      }
      const legend = cur.querySelector('legend');
      if (legend && legend.textContent.trim().length > 8) return legend.textContent.replace(/\s+/g, ' ').trim();
      cur = cur.parentElement;
      if (cur && cur.tagName === 'BODY') break;
    }
    const group = el.closest('[class*="question"], [class*="prompt"], [class*="problem"], fieldset, form');
    if (group) {
      const t = (group.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 8 && t.length < 1500) return t.slice(0, 600);
    }
    // NEW: nearest preceding text fallback
    const near = nearestPrecedingText(el);
    if (near) return near.slice(0, 600);
    return '';
  }

  function fireInput(el, value) {
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        el.focus();
        try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch {}
        fireKeystrokes(el, String(value).slice(0, 20));
        document.execCommand('insertText', false, String(value));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(value) }));
        return true;
      }
    } catch (e) { log('fireInput failed:', e.message); }
    return false;
  }

  function fireClick(el) {
    if (!el) return;
    try { el.click(); } catch {}
    try { humanClick(el); } catch {}
  }

  // ============================================================
  // GROQ
  // ============================================================
  async function groqCall(messages, opts = {}) {
    if (KILLED) throw new Error('killed');
    const stream = !!opts.stream;
    const onDelta = opts.onDelta || (() => {});
    const body = {
      model: CFG.ai.model, messages,
      temperature: opts.temperature ?? CFG.ai.temperature,
      max_tokens: opts.maxTokens ?? CFG.ai.maxTokens,
      stream
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    const res = await fetch(CFG.ai.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.ai.key },
      body: JSON.stringify(body),
      signal: ABORT.signal
    });
    if (KILLED) throw new Error('killed');
    if (!res.ok) {
      const t = await res.text();
      const err = new Error('groq ' + res.status + ' ' + t.slice(0, 240));
      err.status = res.status; err.body = t;
      if (res.status === 429) S.consecutive429++;
      else S.consecutive429 = 0;
      throw err;
    }
    S.consecutive429 = 0;
    S.requests++;
    if (!stream) {
      const j = await res.json();
      if (KILLED) throw new Error('killed');
      if (j.usage) { S.tokensIn += j.usage.prompt_tokens || 0; S.tokensOut += j.usage.completion_tokens || 0; }
      return j.choices?.[0]?.message?.content || '';
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      if (KILLED) throw new Error('killed');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onDelta(delta); }
        } catch {}
      }
    }
    return full;
  }

  // retry wrapper — 2 attempts with exponential backoff, then bail on 429 storm
  async function groqCallRetry(messages, opts = {}, maxAttempts = 2) {
    let lastErr = null;
    for (let i = 0; i < maxAttempts; i++) {
      if (KILLED) throw new Error('killed');
      try {
        return await groqCall(messages, opts);
      } catch (e) {
        lastErr = e;
        if (e.message === 'killed') throw e;
        if (S.consecutive429 >= 3) throw new Error('rate limited — stopping');
        if (i < maxAttempts - 1) {
          const wait = 1500 * Math.pow(2, i) + randInt(0, 800);
          log('retry in', Math.round(wait / 1000) + 's:', e.message.slice(0, 80));
          await sleep(wait);
        }
      }
    }
    throw lastErr;
  }

  async function groqJson(prompt, maxTokens) {
    async function attempt(useJson) {
      const body = {
        model: CFG.ai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.35,
        max_tokens: maxTokens || 4000
      };
      if (useJson) body.response_format = { type: 'json_object' };
      const res = await fetch(CFG.ai.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.ai.key },
        body: JSON.stringify(body),
        signal: ABORT.signal
      });
      if (KILLED) throw new Error('killed');
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error('groq ' + res.status + ' ' + txt.slice(0, 240));
        err.status = res.status; err.body = txt;
        if (res.status === 429) S.consecutive429++;
        else S.consecutive429 = 0;
        throw err;
      }
      S.consecutive429 = 0;
      S.requests++;
      const j = await res.json();
      if (j.usage) { S.tokensIn += j.usage.prompt_tokens || 0; S.tokensOut += j.usage.completion_tokens || 0; }
      return j.choices?.[0]?.message?.content || '';
    }
    try { return await attempt(true); }
    catch (e) {
      // broadened JSON-failure detection
      const jf = e.status === 400 && (
        /json_validate_failed|Failed to generate JSON|Invalid response format|response_format|must contain the word "json"/i
          .test(e.message || '') ||
        /json/i.test(e.body || '')
      );
      if (!jf) throw e;
      log('JSON mode rejected — retrying without response_format');
      return await attempt(false);
    }
  }

  // ============================================================
  // UNIVERSAL MCQ
  // ============================================================
  function collectGenericMCQs() {
    const radios = visibleEls('input[type="radio"], input[type="checkbox"]');
    const groups = {};
    for (const r of radios) {
      if (r.disabled) continue;
      if (r.closest('lib-question')) continue;
      const key = r.name || (r.getAttribute('data-group')) || (r.closest('fieldset') ? '__fs_' + (r.closest('fieldset').dataset.__hhId ||= Date.now() + '_' + Math.random()) : null) || '__single_' + (r.parentElement.dataset.__hhId ||= Date.now() + '_' + Math.random());
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    return Object.entries(groups)
      .filter(([_, g]) => g.length >= 2)
      .map(([key, g]) => ({
        key,
        inputs: g,
        choices: g.map(i => labelTextForInput(i)),
        question: questionTextForEl(g[0]),
        multi: g[0].type === 'checkbox'
      }));
  }

  async function answerGenericMCQ(group) {
    const choicesText = group.choices.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const prompt = `Answer this ${group.multi ? 'multiple-select' : 'multiple-choice'} question. Do not hedge.

Question: ${group.question || '(no question text)'}

Choices:
${choicesText}

Reply ONLY with JSON: {"picks":[${group.multi ? '1,3' : '2'}]}`;
    let raw;
    try {
      raw = await groqCallRetry([{ role: 'user', content: prompt }], { json: true, maxTokens: 200 });
    } catch (e) {
      log('generic MCQ failed:', e.message);
      return false;
    }
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) return false;
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return false; }
    const picks = (parsed.picks || []).map(Number).filter(n => n >= 1 && n <= group.inputs.length);
    if (!picks.length) return false;

    const pickedTexts = [];
    for (const idx of picks) {
      const input = group.inputs[idx - 1];
      if (!input) continue;
      const target = input.closest('label') || input.parentElement;
      fireClick(target);
      await sleep(randInt(200, 500));
      pickedTexts.push(group.choices[idx - 1]);
    }
    S.lastAnswer = pickedTexts.join(' | ').slice(0, 120);
    S.lastQuestion = (group.question || '').slice(0, 80);
    S.history.push({ ts: Date.now(), q: (group.question || '').slice(0, 300), pickedText: pickedTexts, why: '' });
    if (S.history.length > 200) S.history.shift();
    S.processed++;
    render();
    return true;
  }

  // ============================================================
  // UNIVERSAL TEXT INPUT
  // ============================================================
  function collectGenericTextInputs() {
    const sel = 'textarea, input[type="text"], input[type="number"], input[type="email"], input:not([type]), [contenteditable="true"]';
    const all = visibleEls(sel);
    const out = [];
    for (const el of all) {
      if (el.disabled || el.readOnly) continue;
      if (el.closest('lib-question')) continue;
      if (el.closest('form[action*="search"], form[role="search"]')) continue;
      if (el.type === 'hidden') continue;
      const v = (el.value ?? el.innerText ?? '').trim();
      if (v && v.length > 0 && !el.isContentEditable) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.width < 80) continue;
      out.push(el);
    }
    return out;
  }

  async function answerGenericTextInput(el) {
    const question = questionTextForEl(el);
    if (!question) return false;
    const placeholder = el.getAttribute('placeholder') || '';
    const aria = el.getAttribute('aria-label') || '';
    const prompt = `Answer this question with a short direct response. If it's numeric, reply with just the number.

Question: ${question}
${placeholder ? 'Hint: ' + placeholder : ''}
${aria ? 'Label: ' + aria : ''}

Reply with ONLY the answer text — nothing else. No "Answer:", no quotes.`;
    let raw;
    try {
      raw = await groqCallRetry([{ role: 'user', content: prompt }], { maxTokens: 300, temperature: 0.3 });
    } catch (e) {
      log('generic text failed:', e.message);
      return false;
    }
    let answer = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!answer) return false;
    const ok = fireInput(el, answer);
    if (!ok) return false;
    S.lastQuestion = question.slice(0, 80);
    S.lastAnswer = answer.slice(0, 120);
    S.processed++;
    render();
    return true;
  }

  // ============================================================
  // UNIVERSAL ADVANCE
  // ============================================================
  function findGenericAdvance() {
    const rx = /^(next|next question|continue|check|check answer|verify|submit|submit answer|submit quiz|finish|done|next page|→|›|>)$/i;
    const els = visibleEls('button, a, [role="button"], input[type="submit"]');
    for (const el of els) {
      if (el.disabled) continue;
      const t = (el.textContent || el.value || '').trim();
      const a = (el.getAttribute('aria-label') || '').trim();
      if (rx.test(t) || rx.test(a)) return el;
    }
    return null;
  }

  // ============================================================
  // AUTO (Buzz-specific MCQ)
  // ============================================================
  function buildAutoPrompt(question, choices, multi) {
    const list = choices.map((c, i) => `${i + 1}. ${getChoiceText(c)}`).join('\n');
    const inst = multi
      ? 'Select ALL correct. Reply ONLY JSON: {"picks":[1,3],"why":"one short sentence"}'
      : 'Select the single correct. Reply ONLY JSON: {"picks":[2],"why":"one short sentence"}';
    return `Answer this multiple-choice test question. Do not hedge. ${inst}

Question: ${question}

Choices:
${list}

Reply with JSON only.`;
  }
  function parseAuto(raw, max) {
    const jm = String(raw).match(/\{[\s\S]*\}/);
    if (jm) {
      try {
        const o = JSON.parse(jm[0]);
        const picks = (o.picks || []).map(Number).filter(n => n >= 1 && n <= max);
        if (picks.length) return { picks: [...new Set(picks)], why: (o.why || '').trim() };
      } catch {}
    }
    // fallback: pick the first digit in range — safer than grabbing all digits
    const m = String(raw).match(/\b([1-9])\b/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= max) return { picks: [n], why: '' };
    }
    return { picks: [], why: '' };
  }

  async function processQuestion(block) {
    if (KILLED) return false;
    const choices = getChoices(block);
    if (!choices.length) return true;
    const q = getQuestionText(block);
    const multi = isMultiSelect(block);
    S.lastQuestion = q.slice(0, 80);
    render();
    await sleep(randInt(CFG.timing.minThinkMs, CFG.timing.maxThinkMs));
    if (KILLED) return false;

    const prompt = buildAutoPrompt(q, choices, multi);
    let raw, parsed;
    try {
      raw = await groqCallRetry([{ role: 'user', content: prompt }], { json: true });
      parsed = parseAuto(raw, choices.length);
      if (!parsed.picks.length) throw new Error('no pick: ' + String(raw).slice(0, 100));
    } catch (e) {
      if (KILLED) return false;
      log('AI failed:', e.message);
      S.lastAnswer = 'AI error: ' + e.message;
      render();
      if (/rate limited/i.test(e.message)) { S.running = false; return false; }
      return false;
    }

    const picked = parsed.picks.map(i => choices[i - 1]).filter(Boolean);
    S.lastAnswer = picked.map(c => getChoiceText(c).slice(0, 50)).join(' | ');
    render();

    for (let p = 0; p < picked.length; p++) {
      if (!S.running || KILLED) return false;
      await sleep(randInt(CFG.timing.minMoveMs, CFG.timing.maxMoveMs));
      if (KILLED) return false;
      if (!CFG.dryRun) humanClick(clickTargetFor(picked[p]));
      log(`picked: ${getChoiceText(picked[p]).slice(0, 60)}`);
      if (p < picked.length - 1) await sleep(randInt(CFG.timing.minBetweenChoicesMs, CFG.timing.maxBetweenChoicesMs));
    }

    S.history.push({ ts: Date.now(), q: q.slice(0, 300), pickedText: picked.map(getChoiceText), why: parsed.why });
    if (S.history.length > 200) S.history.shift();
    S.processed++;
    render();
    return true;
  }

  const findNextButton = () => [...document.querySelectorAll('button.mdc-button--raised, button')].find(b =>
    b.offsetParent !== null && !b.disabled && /^\s*next\s*$/i.test((b.textContent || '').trim())) || null;
  const findReviewButton = () => [...document.querySelectorAll('button')].find(b =>
    b.offsetParent !== null && /^\s*review\s*$/i.test((b.textContent || '').trim())) || null;

  async function clickNext() {
    if (KILLED) return null;
    const btn = findNextButton();
    if (!btn) return findReviewButton() ? 'review' : null;
    await sleep(randInt(CFG.timing.nextDelayMinMs, CFG.timing.nextDelayMaxMs));
    if (KILLED) return null;
    if (!CFG.dryRun) humanClick(btn);
    log('→ next');
    return 'next';
  }

  async function loop() {
    if (S.busy || KILLED) return;
    if (CFG.ai.key === 'PASTE_YOUR_REAL_KEY_HERE') {
      const k = prompt('Paste your Groq API key (starts with gsk_). It will be saved.');
      if (k && k.trim()) { CFG.ai.key = k.trim(); saveCfg(); log('key saved'); render(); }
      else { log('no key — aborting'); return; }
    }
    S.busy = true; S.running = true; render();
    log('buzz quiz loop started');
    let guard = 0;
    while (S.running && !KILLED && guard++ < 500) {
      const blocks = getQuestionBlocks();
      if (!blocks.length) { log('no buzz questions'); break; }
      for (const b of blocks) {
        if (!S.running || KILLED) break;
        const ok = await processQuestion(b);
        if (KILLED) break;
        if (!ok) { log('aborting'); S.running = false; break; }
      }
      if (!S.running || KILLED) break;
      const r = await clickNext();
      if (KILLED) break;
      if (r !== 'next') { log('halt:', r || 'no next'); break; }
      await sleep(randInt(900, 2000));
    }
    S.running = false; S.busy = false;
    if (!KILLED) { render(); log('buzz quiz loop stopped'); }
  }

  async function universalLoop() {
    if (S.busy || KILLED) return;
    if (CFG.ai.key === 'PASTE_YOUR_REAL_KEY_HERE') {
      const k = prompt('Paste your Groq API key (starts with gsk_).');
      if (k && k.trim()) { CFG.ai.key = k.trim(); saveCfg(); }
      else return;
    }
    S.busy = true; S.running = true; render();
    log('universal loop started on', S.platform);
    let guard = 0;
    while (S.running && !KILLED && guard++ < 200) {
      const mcqs = collectGenericMCQs();
      const texts = collectGenericTextInputs();
      log('page scan —', mcqs.length, 'mcq groups,', texts.length, 'text inputs');

      if (!mcqs.length && !texts.length) {
        log('nothing to answer — trying advance');
        const adv = findGenericAdvance();
        if (adv) { humanClick(adv); await sleep(randInt(1800, 3200)); continue; }
        log('universal: no more answers, no advance');
        break;
      }

      for (const g of mcqs) {
        if (!S.running || KILLED) break;
        await sleep(randInt(CFG.timing.minThinkMs, CFG.timing.maxThinkMs));
        await answerGenericMCQ(g);
      }
      for (const t of texts) {
        if (!S.running || KILLED) break;
        await sleep(randInt(CFG.timing.minThinkMs, CFG.timing.maxThinkMs));
        await answerGenericTextInput(t);
      }

      if (!S.running || KILLED) break;
      await sleep(randInt(900, 1800));

      const adv = findGenericAdvance();
      if (adv) {
        log('advancing:', (adv.textContent || adv.value || '').trim().slice(0, 30));
        await sleep(randInt(CFG.timing.nextDelayMinMs, CFG.timing.nextDelayMaxMs));
        if (!CFG.dryRun) humanClick(adv);
        await sleep(randInt(1400, 2600));
      } else {
        log('no advance button found — stopping');
        break;
      }
    }
    S.running = false; S.busy = false;
    if (!KILLED) { render(); log('universal loop stopped'); }
  }

  const stop = () => { S.running = false; render(); };

  // ============================================================
  // FLASHCARD
  // ============================================================
  function detectFlashcards() { return document.querySelector('lib-flash-cards-player'); }
  function getActiveFlashcard() { return document.querySelector('lib-flash-cards-player .card-ct.active .flashcard'); }
  function getFlashcardNext() { return document.querySelector('lib-flash-cards-player .stack-actions button[aria-label="Next"]'); }
  function getStackIndex() {
    const el = document.querySelector('lib-flash-cards-player .stack-index');
    if (!el) return null;
    const m = (el.textContent || '').match(/(\d+)\s*of\s*(\d+)/i);
    return m ? { current: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
  }

  async function runCards() {
    if (!detectFlashcards()) { log('no cards detected'); return; }
    S.running = true; S.busy = true; render();
    log('card driver started');
    const total = getStackIndex()?.total || 0;
    let lastIdx = getStackIndex()?.current || 0;
    let stuck = 0, clicks = 0;
    const MAX = 500;
    while (S.running && !KILLED && clicks < MAX) {
      if (isAssignmentComplete() || findCompletionIndicator()) { log('checkmark — stopping cards'); break; }
      const card = getActiveFlashcard();
      if (!card) { log('no active card — done'); break; }
      await sleep(randInt(600, 1000));
      if (KILLED || !S.running) break;
      humanClick(card);
      await sleep(randInt(700, 1100));
      const next = getFlashcardNext();
      if (!next) { log('no Next button — done'); break; }
      humanClick(next);
      await sleep(randInt(600, 1000));
      const nowIdx = getStackIndex()?.current || 0;
      if (nowIdx === lastIdx) { stuck++; if (stuck > 3) { log('index stalled — reached last card'); break; } }
      else { stuck = 0; }
      lastIdx = nowIdx;
      clicks++;
      S.lastAnswer = `card ${nowIdx} of ${total || '?'}`;
      render();
      if (clicks % 5 === 0) log(`card ${nowIdx} of ${total}`);
    }
    S.running = false; S.busy = false;
    render();
    log(`card driver stopped after ${clicks} cards`);
    if (isAssignmentComplete() || findCompletionIndicator()) {
      await sleep(randInt(1500, 3200));
      const nav = findNextAssignmentNav();
      if (nav) { log('→ next assignment'); humanClick(nav); }
    }
  }

  // ============================================================
  // CLASSIFICATION + COMPLETION
  // ============================================================
  function classifyPage() {
    if (getQuestionBlocks().length) return 'buzz-quiz';
    if (detectFlashcards()) return 'buzz-cards';
    if (findMarkCompleteButton()) return 'buzz-lesson';

    const title = ((document.title || '') + ' ' + (document.querySelector('h1, [role="heading"]')?.textContent || '')).toLowerCase();
    const bodyHead = (document.body.innerText || '').slice(0, 2500).toLowerCase();

    const genericMCQs = collectGenericMCQs();
    const genericTexts = collectGenericTextInputs();
    if (genericMCQs.length >= 1 || genericTexts.length >= 2) return 'universal-quiz';

    if (/\b(assignment|submit|dropbox|rubric)\b/i.test(title)) return 'assignment';
    if (/\b(submit (your|this|the) assignment|dropbox|rubric|grading criteria)\b/i.test(bodyHead)) return 'assignment';

    const inputs = visibleEls('textarea, [contenteditable="true"], input[type="text"]');
    if (inputs.length) return 'assignment';

    if (document.querySelector('video')) return 'buzz-lesson';
    if (/\b(lesson|video|lecture|watch|reading)\b/i.test(title)) return 'buzz-lesson';
    if (bodyHead.length > 700 && !inputs.length) return 'buzz-lesson';

    return 'unknown';
  }

  function inTopLeft(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < 180 && r.left < 400;
  }

  function findCompletionIndicator() {
    const btns = [...document.querySelectorAll('button, [role="button"], mat-icon')]
      .filter(el => el.offsetParent !== null && inTopLeft(el));
    for (const b of btns) {
      const blob = ((b.className || '').toString() + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).toLowerCase();
      if (/complete|done|check_circle|check\b/.test(blob) && !/close|cancel|error/.test(blob)) return b;
      const kids = b.querySelectorAll('*');
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width > 22 || r.height > 22) continue;
        if (r.left > 120 || r.top > 120) continue;
        const bg = getComputedStyle(k).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) continue;
        const [_, r_, g_, b_] = m.map(Number);
        if (g_ > 120 && g_ > r_ + 30 && g_ > b_ + 30) return k;
      }
      const bg = getComputedStyle(b).backgroundColor || '';
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const [_, r_, g_, b_] = m.map(Number);
        if (g_ > 120 && g_ > r_ + 30 && g_ > b_ + 30) return b;
      }
    }
    for (const sel of ['[aria-label*="complete" i]', '[title*="complete" i]', '[class*="complete" i]']) {
      const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null && !/close|cancel/i.test(e.getAttribute('aria-label') || ''));
      if (el) return el;
    }
    return null;
  }

  function findMarkCompleteButton() {
    return [...document.querySelectorAll('button, a, [role="button"]')]
      .find(b => b.offsetParent !== null && !b.disabled && /^mark\s+(this\s+)?(activity|lesson|page|item)?\s*(as\s+)?complete$/i.test((b.textContent || '').trim())) || null;
  }

  function isAssignmentComplete() {
    const sels = ['.assignment-complete', '.completed-badge', '[aria-label*="complete" i]', '[title*="complete" i]'];
    for (const sel of sels) {
      const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null);
      if (el) return true;
    }
    return false;
  }

  function findNextAssignmentNav() {
    const sels = ['button[aria-label*="next" i]', 'a[aria-label*="next" i]', '[title*="next" i]', '[aria-label*="forward" i]'];
    for (const sel of sels) {
      const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null);
      if (el && !/previous|back|left/i.test((el.getAttribute('aria-label') || el.getAttribute('title') || ''))) return el;
    }
    const icons = [...document.querySelectorAll('mat-icon, i, span')].filter(e =>
      e.children.length === 0 && e.offsetParent !== null && /^chevron_right$/.test((e.textContent || '').trim()));
    if (icons.length) return icons[0].closest('button, a') || icons[0];
    return null;
  }

  function setupCompletionWatcher() {
    return new Promise(resolve => {
      let resolved = false;
      const done = el => { if (!resolved) { resolved = true; resolve(el); } };
      const probe = () => { const el = findCompletionIndicator(); if (el) done(el); };
      probe();
      const mo = new MutationObserver(probe);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-label', 'title', 'style'] });
      const iv = setInterval(probe, 2000);
      killHooks.push(() => { mo.disconnect(); clearInterval(iv); });
    });
  }

  // ---- lesson chain ----
  function looksLikeQuestions(text) {
    if (!text) return false;
    const q = (text.match(/\?/g) || []).length;
    return q >= 2 || /\b(reflect on|answer the following|consider the following|discuss the following|respond to the following|answer these)\b/i.test(text);
  }

  function stashLessonContext() {
    const body = (document.body.innerText || '').trim();
    if (!body || body.length < 40) return;
    const title = document.title || 'Lesson';
    try {
      localStorage.setItem('__hh_pending_lesson', JSON.stringify({ title, text: body.slice(0, 3000), ts: Date.now() }));
      log('stashed lesson context:', title);
    } catch {}
  }

  async function handlePassiveLesson() {
    const bodyTextEarly = document.body.innerText || '';
    const hasQuestions = looksLikeQuestions(bodyTextEarly) && !document.querySelector('video');
    if (hasQuestions) stashLessonContext();

    const markBtn = findMarkCompleteButton();
    if (markBtn) {
      log('found Mark Complete button — clicking');
      await sleep(randInt(800, 1500));
      if (!S.running || KILLED) return false;
      humanClick(markBtn);
      await sleep(2200);
      if (findCompletionIndicator() || isAssignmentComplete()) { log('marked complete'); return true; }
      log('no badge after mark — assuming done');
      return true;
    }

    if (findCompletionIndicator() || isAssignmentComplete()) { log('already complete'); return true; }

    if (hasQuestions) { log('instructions page — advancing in 6s'); await sleep(6000); return true; }

    const vid = document.querySelector('video');
    if (vid) {
      try {
        vid.muted = true;
        vid.playbackRate = 2;
        if (vid.paused) await vid.play().catch(() => {});
        log('video: muted, 2x');
      } catch (e) { log('video play failed:', e.message); }
    }

    log('waiting for checkmark…');
    const completion = await Promise.race([
      setupCompletionWatcher(),
      new Promise(res => {
        const iv = setInterval(() => { if (!S.running || KILLED) { clearInterval(iv); res(null); } }, 500);
        killHooks.push(() => clearInterval(iv));
      }),
      (async () => { await sleep(10 * 60 * 1000); return null; })()
    ]);

    if (completion) { log('checkmark arrived'); await sleep(randInt(1800, 3500)); return true; }
    log('no checkmark after 10 min — moving on anyway');
    return false;
  }

  async function runLessonChain() {
    S.running = true; S.busy = true; render();
    log('lesson chain started');
    const startedAt = Date.now();
    let advanced = 0;
    while (S.running && !KILLED) {
      if (Date.now() - startedAt > 2 * 60 * 60 * 1000) { log('chain timeout (2h)'); break; }
      const kind = classifyPage();
      S.lastAnswer = `page: ${kind} · advanced ${advanced}`;
      render();
      log('page:', kind);

      if (kind === 'buzz-quiz') { log('hit buzz quiz — stopping chain.'); break; }
      if (kind === 'buzz-cards') { log('hit flashcards — stopping chain.'); break; }
      if (kind === 'universal-quiz') { log('hit universal quiz — running universal loop'); await universalLoop(); return; }
      if (kind === 'assignment') {
        if (hasPendingLesson() && !needsFileUpload()) { log('hit fillable assignment — Fill mode'); await runFillAssignment(); return; }
        log('hit assignment — stopping chain. Run Solve.');
        break;
      }
      if (kind === 'unknown') { log('unknown page — stopping chain'); break; }

      await handlePassiveLesson();
      if (!S.running || KILLED) break;
      const nav = findNextAssignmentNav();
      if (!nav) { log('no next-lesson nav — chain stopped'); break; }
      humanClick(nav);
      advanced++;
      log(`→ advanced to lesson ${advanced + 1}`);
      await sleep(randInt(2200, 4200));
    }
    S.running = false; S.busy = false;
    render();
    log(`chain stopped after ${advanced} advances`);
  }

  // ============================================================
  // FILL MODE
  // ============================================================
  function hasPendingLesson() {
    try {
      const raw = localStorage.getItem('__hh_pending_lesson');
      if (!raw) return false;
      const p = JSON.parse(raw);
      return p && p.ts && (Date.now() - p.ts) < 60 * 60 * 1000;
    } catch { return false; }
  }
  function getPendingLesson() {
    try {
      const raw = localStorage.getItem('__hh_pending_lesson');
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || !p.ts || (Date.now() - p.ts) > 60 * 60 * 1000) return null;
      return p;
    } catch { return null; }
  }
  function needsFileUpload() {
    const text = (document.body.innerText || '').toLowerCase();
    if (/\b(upload (a )?file|attach (a )?file|turn in as (a )?file|submit as (a )?file|file upload)\b/.test(text)) return true;
    const fi = [...document.querySelectorAll('input[type="file"]')].find(el => el.offsetParent !== null);
    return !!fi;
  }

  async function openSubmissionBox() {
    const scan = () => visibleEls('textarea, [contenteditable="true"]')
      .find(el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 20; }) || null;

    let box = scan();
    if (box) { log('comment box already visible'); return box; }

    const tryEls = visibleEls('button, [role="button"], mat-icon, .material-icons, span').filter(el => {
      const t = (el.textContent || '').trim();
      const lbl = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
      return /^\+$/.test(t) || /^add$/i.test(t)
        || /add comment|add reply|add note|add response|write a comment|new comment|post comment/i.test(lbl)
        || /add comment|add reply|add note|start (writing|typing)/i.test(t);
    });

    for (const el of tryEls) {
      if (KILLED) return null;
      humanClick(el);
      await sleep(1200);
      box = scan();
      if (box) return box;
    }

    const commentLabel = [...document.querySelectorAll('*')].find(el =>
      el.children.length === 0 && el.offsetParent !== null && /^comments?$/i.test((el.textContent || '').trim()));
    if (commentLabel) {
      humanClick(commentLabel);
      await sleep(1200);
      box = scan();
      if (box) return box;
      const container = commentLabel.closest('section, div, mat-card');
      if (container) {
        const btn = container.querySelector('button, [role="button"], mat-icon, .material-icons');
        if (btn) { humanClick(btn); await sleep(1200); box = scan(); if (box) return box; }
      }
    }
    return null;
  }

  async function fillSubmissionBox(box, text) {
    if (!box) return false;
    try {
      if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
        const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      box.focus();
      try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch {}
      fireKeystrokes(box, text.slice(0, 40));
      await sleep(randInt(180, 520));
      const ok = document.execCommand('insertText', false, text);
      if (!ok) box.innerText = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      log('fill failed:', e.message);
      return false;
    }
  }

  function parseLengthRequirement(text) {
    const t = (text || '').toLowerCase();
    let m = t.match(/at\s+least\s+(\d+)\s+words?/); if (m) return { kind: 'words', min: parseInt(m[1], 10), max: null, raw: m[0] };
    m = t.match(/minimum\s+(?:of\s+)?(\d+)\s+words?/); if (m) return { kind: 'words', min: parseInt(m[1], 10), max: null, raw: m[0] };
    m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s+words?/); if (m) return { kind: 'words', min: parseInt(m[1], 10), max: parseInt(m[2], 10), raw: m[0] };
    m = t.match(/no\s+more\s+than\s+(\d+)\s+words?/); if (m) return { kind: 'words', min: null, max: parseInt(m[1], 10), raw: m[0] };
    m = t.match(/(\d+)\s+words?\s*(?:each|per|minimum|max|maximum)/); if (m) return { kind: 'words', min: parseInt(m[1], 10), max: null, raw: m[0] };
    m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s+sentences?/); if (m) return { kind: 'sentences', min: parseInt(m[1], 10), max: parseInt(m[2], 10), raw: m[0] };
    m = t.match(/at\s+least\s+(\d+)\s+sentences?/); if (m) return { kind: 'sentences', min: parseInt(m[1], 10), max: null, raw: m[0] };
    m = t.match(/(\d+)\s+sentences?\s*(?:each|per|minimum)/); if (m) return { kind: 'sentences', min: parseInt(m[1], 10), max: null, raw: m[0] };
    m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s+paragraphs?/); if (m) return { kind: 'paragraphs', min: parseInt(m[1], 10), max: parseInt(m[2], 10), raw: m[0] };
    m = t.match(/(\d+)\s+paragraphs?/); if (m) return { kind: 'paragraphs', min: parseInt(m[1], 10), max: parseInt(m[1], 10), raw: m[0] };
    return null;
  }
  function describeLength(req) {
    if (!req) return '';
    if (req.kind === 'words') {
      if (req.min && req.max) return `Each answer must be between ${req.min} and ${req.max} words.`;
      if (req.min) return `Each answer must be AT LEAST ${req.min} words.`;
      if (req.max) return `Each answer must be under ${req.max} words.`;
    }
    if (req.kind === 'sentences') {
      if (req.min && req.max) return `Each answer must be ${req.min} to ${req.max} sentences long.`;
      if (req.min) return `Each answer must be at least ${req.min} sentences long.`;
    }
    if (req.kind === 'paragraphs') {
      if (req.min && req.max) return `Each answer must be ${req.min} to ${req.max} paragraphs.`;
      if (req.min) return `Each answer must be at least ${req.min} paragraph(s).`;
    }
    return '';
  }

  async function generateAnswersForLesson(lesson, submissionText) {
    const lengthReq = parseLengthRequirement(lesson.text + '\n' + (submissionText || ''));
    const lengthLine = describeLength(lengthReq) || 'Match the length to what the question actually asks.';
    if (lengthReq) log('detected length requirement:', lengthReq.raw);

    const makePrompt = (sourceText, short) => `You are a real 11th grade student answering reflection questions for a class assignment. You write like a normal high schooler — not an adult, not a chatbot, not a resume.

VOICE:
- Plain words. Short sentences. No semicolons. No markdown. No bullet lists.
- Contractions: I'm, it's, doesn't, can't, won't.
- Say "it", "my project", "I". Never "the system" or "the AI application."
- Answer the actual question. Don't restate it.

REAL EXAMPLES ONLY:
- If the question asks for personal examples, use things a real high schooler actually touches every day. Spotify playlists. YouTube. TikTok. Instagram. Google Docs. Notes app. Phone camera roll. School email. A school Chromebook. Shared Google Slides. Discord.
- NEVER invent jobs, companies, paid work, sales figures, corporate datasets, APIs you built, or anything that sounds like an adult at a tech company.
- 2-3 short examples max. Don't stack to fill space.

FORMAT:
- Write one answer per question, in order, separated by blank lines.
- No headers, no labels, no "Question 1:", no "Answer:".

LENGTH MATCHING:
- If a word/sentence/paragraph count is stated → follow it exactly.
- Simple reflection, opinion, list, "name an example" → 2-3 sentences.
- "Explain," "describe," "summarize," "what is X" → 3-5 sentences.
- "Analyze," "compare," "discuss why," "evaluate," multi-part → 5-8 sentences.

BANNED:
- "For example, ..." as padding
- Closing wrap-ups ("In the end, ...", "Overall, ...")
- Restating the question
- Extra sub-points beyond what was asked

SOURCE QUESTIONS:
"""
${lesson.title}
${sourceText}
"""
${submissionText && !short ? `\nASSIGNMENT CONTEXT:\n"""\n${submissionText.slice(0, 800)}\n"""\n` : ''}
Return plain text only — answers separated by blank lines.`;

    const tryOnce = async (source, short, temp, tokens) => {
      try {
        const raw = await groqCall([{ role: 'user', content: makePrompt(source, short) }], { maxTokens: tokens, temperature: temp });
        return (raw || '').trim();
      } catch (e) { log('fill attempt failed:', e.message); return ''; }
    };

    let raw = await tryOnce(lesson.text.slice(0, 2800), false, 0.4, 6000);
    if (raw) return raw;
    log('attempt 1 empty — shorter context');
    raw = await tryOnce(lesson.text.slice(0, 1400), true, 0.3, 6000);
    if (raw) return raw;
    log('attempt 2 empty — minimal prompt');
    const minimal = `Write a student reflection answering the questions below. Plain first-person prose, one answer per question separated by blank lines. Use examples a real 11th grader would have.

Questions:
${lesson.text.slice(0, 1200)}

Answers:`;
    try { raw = await groqCall([{ role: 'user', content: minimal }], { maxTokens: 6000, temperature: 0.5 }); raw = (raw || '').trim(); } catch (e) { log('attempt 3 failed:', e.message); }
    if (raw) return raw;
    if (CFG.ai.model !== 'llama-3.3-70b-versatile') {
      log('trying llama-3.3-70b-versatile');
      const prev = CFG.ai.model;
      CFG.ai.model = 'llama-3.3-70b-versatile';
      try { raw = await groqCall([{ role: 'user', content: minimal }], { maxTokens: 6000, temperature: 0.4 }); raw = (raw || '').trim(); } catch (e) { log('llama failed:', e.message); }
      if (raw) return raw;
      CFG.ai.model = prev;
    }
    return '';
  }

  function showFillPopup(lesson, answers, boxFound) {
    return new Promise(resolve => {
      const el = document.createElement('div');
      el.id = '__hh_fill_popup';
      el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;width:min(720px,92vw);background:#1a1a1a;color:#f0f0f0;border:2px solid #e07b39;border-radius:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 12px 60px rgba(0,0,0,.8);overflow:hidden;`;
      const wc = (answers.match(/\S+/g) || []).length;
      const autoSubmit = CFG.autoSubmitSec > 0;
      el.innerHTML = `
        <div style="background:#e07b39;color:#1a1a1a;padding:10px 16px;font-weight:700;display:flex;justify-content:space-between;align-items:center;">
          <span>Review before submit</span>
          <span id="__hh_fill_x" style="cursor:pointer;font-size:20px;">×</span>
        </div>
        <div style="padding:14px 16px;max-height:60vh;overflow-y:auto;">
          <div style="font-size:11px;color:#888;margin-bottom:6px;font-weight:700;">SOURCE QUESTIONS</div>
          <div style="background:#0e0e0e;border-radius:6px;padding:10px;font-size:12px;color:#bbb;white-space:pre-wrap;max-height:140px;overflow-y:auto;margin-bottom:14px;">${(lesson.title + '\n\n' + lesson.text.slice(0,1000)).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div>
          <div style="font-size:11px;color:#888;margin-bottom:6px;font-weight:700;">GENERATED (${wc} words) ${boxFound ? '· pasted into box' : '· box not found'}</div>
          <div style="background:#0e0e0e;border-left:3px solid #e07b39;border-radius:6px;padding:10px;font-size:13px;color:#eee;white-space:pre-wrap;max-height:260px;overflow-y:auto;">${answers.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</div>
          <div style="margin-top:12px;font-size:11px;color:#888;">${autoSubmit ? `Auto-submit in <b id="__hh_fill_count">${CFG.autoSubmitSec}</b>s` : 'Confirm to submit. Cancel to stop.'}</div>
        </div>
        <div style="padding:12px 16px;background:#141414;border-top:1px solid #262626;display:flex;gap:8px;">
          <button id="__hh_fill_confirm" style="flex:1;padding:10px;border:0;border-radius:8px;background:#2e7d32;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">Confirm & Submit</button>
          <button id="__hh_fill_manual" style="padding:10px 16px;border:0;border-radius:8px;background:#333;color:#ddd;font-weight:600;font-size:13px;cursor:pointer;">Copy</button>
          <button id="__hh_fill_cancel" style="padding:10px 16px;border:0;border-radius:8px;background:#5a1e1e;color:#ffd6d6;font-weight:600;font-size:13px;cursor:pointer;">Cancel</button>
        </div>`;
      document.body.appendChild(el);
      let resolved = false; let autoIv = null;
      const cleanup = r => { if (resolved) return; resolved = true; if (autoIv) clearInterval(autoIv); try { el.remove(); } catch {} resolve(r); };
      document.getElementById('__hh_fill_x').onclick = () => cleanup('cancel');
      document.getElementById('__hh_fill_cancel').onclick = () => cleanup('cancel');
      document.getElementById('__hh_fill_manual').onclick = () => { try { navigator.clipboard.writeText(answers); } catch {} cleanup('manual'); };
      document.getElementById('__hh_fill_confirm').onclick = () => cleanup('confirm');
      if (autoSubmit) {
        let left = CFG.autoSubmitSec;
        const cEl = document.getElementById('__hh_fill_count');
        autoIv = setInterval(() => { left--; if (cEl) cEl.textContent = String(Math.max(left, 0)); if (left <= 0) { clearInterval(autoIv); autoIv = null; cleanup('confirm'); } }, 1000);
        killHooks.push(() => { if (autoIv) { clearInterval(autoIv); autoIv = null; } });
      }
    });
  }

  function findSubmitButton() {
    const rx = /^(submit|turn in|turn this in|turn it in|submit assignment|submit for grading|submit your work|save and submit|save & submit|finish|finish assignment|complete|mark complete|submit and close|hand in|hand it in|check|check answer|verify|submit quiz|submit answer)\b/i;
    const els = visibleEls('button, a, [role="button"], .mdc-button, [mat-flat-button], [mat-raised-button], [mat-stroked-button], input[type="submit"]');
    for (const el of els) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const t = ((el.textContent || '') + ' ' + (el.value || '')).trim();
      if (rx.test(t)) return el;
    }
    for (const el of els) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const lbl = (el.getAttribute('aria-label') || '').trim();
      if (rx.test(lbl)) return el;
    }
    return null;
  }

  async function runFillAssignment() {
    if (KILLED) return;
    if (CFG.ai.key === 'PASTE_YOUR_REAL_KEY_HERE') { const k = prompt('Paste your Groq API key:'); if (k && k.trim()) { CFG.ai.key = k.trim(); saveCfg(); } else return; }
    const lesson = getPendingLesson();
    if (!lesson) { log('no stashed lesson'); return; }
    S.running = true; S.busy = true; render();
    log('fill mode — generating for', lesson.title);
    const submissionText = document.body.innerText || '';
    let answers = '';
    try { answers = await generateAnswersForLesson(lesson, submissionText); } catch (e) { log('gen failed:', e.message); S.running = false; S.busy = false; render(); return; }
    if (!answers) { log('empty answer'); S.lastAnswer = 'Fill failed — model returned empty.'; S.running = false; S.busy = false; render(); return; }
    log('answers ready —', (answers.match(/\S+/g) || []).length, 'words');

    let box = await openSubmissionBox();
    let boxFilled = false;
    if (box) { boxFilled = await fillSubmissionBox(box, answers); log(boxFilled ? 'comment box filled' : 'could not fill box'); }
    else log('no comment box found');

    const choice = await showFillPopup(lesson, answers, boxFilled);
    try { localStorage.removeItem('__hh_pending_lesson'); } catch {}
    if (choice !== 'confirm') { S.running = false; S.busy = false; render(); return; }
    if (!boxFilled) { box = await openSubmissionBox(); if (box) boxFilled = await fillSubmissionBox(box, answers); }
    await sleep(700);
    let submit = findSubmitButton();
    if (!submit) { log('no submit — manual'); S.lastAnswer = 'No submit button found.'; S.running = false; S.busy = false; render(); return; }
    log('clicking submit:', (submit.textContent || submit.value || '').trim().slice(0, 40));
    humanClick(submit);
    await sleep(1800);
    const dialogScopes = ['mat-dialog-container', '[role="dialog"]', '.mat-mdc-dialog-surface', '.mdc-dialog', '.cdk-overlay-pane', '[class*="modal"]'];
    let confirmBtn = null;
    for (const scope of dialogScopes) {
      const root = document.querySelector(scope);
      if (!root || root.offsetParent === null) continue;
      confirmBtn = [...root.querySelectorAll('button, [role="button"]')].find(b => b.offsetParent !== null && !b.disabled &&
        /^(yes|confirm|ok|yes,?\s*(submit|turn in)|turn in|submit)\b/i.test((b.textContent || '').trim()));
      if (confirmBtn) break;
    }
    if (confirmBtn) { humanClick(confirmBtn); await sleep(2200); }
    await sleep(1200);
    const still = findSubmitButton();
    const submitted = !still || still.disabled || still.offsetParent === null;
    S.running = false; S.busy = false; render();
    if (!submitted) { log('submit didn\'t land'); S.lastAnswer = 'Submit failed — check manually.'; render(); return; }
    log('submit confirmed — advancing');
    await sleep(randInt(2000, 4000));
    const nav = findNextAssignmentNav();
    if (nav) { humanClick(nav); await sleep(3000); }
  }

  // ============================================================
  // CONTINUOUS MODE
  // ============================================================
  let __lastUrl = location.href;
  let __lastBodyLen = 0;
  let __continuous = false;
  let __continuousGuard = 0;

  async function continuousTick() {
    if (KILLED || !__continuous) return;
    if (S.running) return;
    if (__continuousGuard++ > 200) { log('continuous: guard hit'); __continuous = false; return; }

    const url = location.href;
    const bodyLen = (document.body.innerText || '').length;
    const urlChanged = url !== __lastUrl;
    const bodyChanged = Math.abs(bodyLen - __lastBodyLen) > 200;
    if (!urlChanged && !bodyChanged) return;

    __lastUrl = url;
    __lastBodyLen = bodyLen;
    S.platform = detectPlatform();

    await sleep(randInt(900, 2600));
    if (KILLED || !__continuous) return;
    await idlePause();
    if (KILLED || !__continuous) return;

    const kind = classifyPage();
    log('continuous →', kind, '(platform:', S.platform + ')');
    render();

    if (kind === 'unknown') { log('continuous: unknown — stopping'); __continuous = false; render(); return; }

    if (kind === 'buzz-lesson' && (findCompletionIndicator() || isAssignmentComplete())) {
      log('lesson already done, advancing');
      const nav = findNextAssignmentNav();
      if (nav) { humanClick(nav); await sleep(randInt(2200, 4000)); return; }
    }

    if (kind === 'buzz-quiz') { await loop(); return; }
    if (kind === 'buzz-cards') { await runCards(); return; }
    if (kind === 'buzz-lesson') { await runLessonChain(); return; }
    if (kind === 'universal-quiz') { await universalLoop(); return; }
    if (kind === 'assignment') {
      if (hasPendingLesson() && !needsFileUpload()) { await runFillAssignment(); return; }
      if (window.__solve?.run) {
        const t = document.querySelector('#__hh_panel .hh-tab[data-tab="solve"]');
        if (t) t.click();
        window.__solve.run();
      }
      return;
    }
  }

  function startContinuous() {
    __continuous = true;
    __continuousGuard = 0;
    __lastUrl = location.href;
    __lastBodyLen = (document.body.innerText || '').length;
    S.platform = detectPlatform();
    log('continuous ON · platform:', S.platform);
    render();
  }
  function stopContinuous() { __continuous = false; log('continuous OFF'); render(); }

  async function startSmart() {
    if (KILLED) return;
    if (S.running || __continuous) { stop(); stopContinuous(); return; }

    S.platform = detectPlatform();
    if (CFG.ai.key === 'PASTE_YOUR_REAL_KEY_HERE') {
      const k = prompt('Paste your Groq API key (starts with gsk_). It will be saved.');
      if (k && k.trim()) { CFG.ai.key = k.trim(); saveCfg(); log('key saved'); }
    }

    startContinuous();
    const kind = classifyPage();
    log('start →', kind, '·', S.platform);

    if (kind === 'buzz-quiz') { await loop(); return; }
    if (kind === 'buzz-cards') { await runCards(); return; }
    if (kind === 'buzz-lesson') { await runLessonChain(); return; }
    if (kind === 'universal-quiz') { await universalLoop(); return; }
    if (kind === 'assignment') {
      if (hasPendingLesson() && !needsFileUpload()) { await runFillAssignment(); return; }
      log('assignment — solve');
      if (window.__solve?.run) {
        const t = document.querySelector('#__hh_panel .hh-tab[data-tab="solve"]');
        if (t) t.click();
        window.__solve.run();
      } else { S.lastAnswer = 'Solve not loaded.'; render(); }
      return;
    }
    log('unknown page — nothing to do');
    S.lastAnswer = 'Unknown page. Nothing to run.';
    render();
  }

  async function sendChat(text) {
    if (KILLED || !text.trim()) return;
    S.chat.push({ role: 'user', content: text });
    render();
    const id = 'msg-' + Date.now();
    S.chat.push({ role: 'assistant', content: '', id, streaming: true });
    render();
    try {
      await groqCall([{ role: 'system', content: 'You are Homework Helper. Direct, sharp, no filler.' },
        ...S.chat.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content }))],
        { stream: true, maxTokens: 900,
          onDelta: d => { if (KILLED) return; const m = S.chat.find(x => x.id === id); if (m) { m.content += d; renderChat(); } } });
    } catch (e) {
      if (KILLED) return;
      const m = S.chat.find(x => x.id === id);
      if (m) m.content = 'Error: ' + e.message;
    }
    if (KILLED) return;
    const m = S.chat.find(x => x.id === id);
    if (m) m.streaming = false;
    render();
  }

  // ============================================================
  // UI
  // ============================================================
  const UI_ID = '__hh_ui';
  const PID = '__hh_panel';

  function ensureUI() {
    if (document.getElementById(UI_ID) || KILLED) return;
    const el = document.createElement('div');
    el.id = UI_ID;
    el.innerHTML = `
      <div id="${PID}" style="position:fixed;top:16px;right:16px;z-index:2147483647;width:340px;background:#1a1a1a;color:#f0f0f0;border:1px solid #e07b39;border-radius:10px;font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden;">
        <div id="${PID}_hdr" style="background:#e07b39;color:#1a1a1a;padding:8px 12px;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;">
          <span>Homework Helper</span>
          <span id="${PID}_x" style="cursor:pointer;font-size:16px;">×</span>
        </div>
        <div id="${PID}_tabs" style="display:flex;background:#141414;border-bottom:1px solid #262626;padding:4px 6px 0;gap:2px;">
          <button class="hh-tab" data-tab="auto" style="flex:1;background:#1a1a1a;border:0;color:#e07b39;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:600;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid #e07b39;">Auto</button>
          <button class="hh-tab" data-tab="ask" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">Ask</button>
          <button class="hh-tab" data-tab="solve" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">Solve</button>
          <button class="hh-tab" data-tab="hist" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">History</button>
          <button class="hh-tab" data-tab="cfg" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">Settings</button>
        </div>
        <div style="padding:10px 12px;max-height:480px;overflow-y:auto;">
          <div class="hh-view" data-view="auto">
            <div style="display:flex;gap:6px;margin-bottom:8px">
              <button id="${PID}_toggle" style="flex:1;padding:6px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;font-size:12px">Start</button>
              <button id="${PID}_skip" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Skip</button>
              <button id="${PID}_explain" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Explain</button>
            </div>
            <div style="font-size:11px;color:#aaa;margin-bottom:4px">Platform: <span id="${PID}_plat" style="color:#e07b39">—</span> · Status: <span id="${PID}_status" style="color:#4caf50">idle</span></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:4px">Processed: <span id="${PID}_count">0</span> · Req: <span id="${PID}_req">0</span></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:2px">Last Q: <span id="${PID}_lq" style="color:#ddd">—</span></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:6px;word-break:break-word">Last A: <span id="${PID}_la" style="color:#4caf50">—</span></div>
            <div id="${PID}_log" style="max-height:140px;overflow:auto;background:#0e0e0e;border-radius:6px;padding:6px;font:11px/1.4 ui-monospace,Menlo,monospace;color:#9ccc65;white-space:pre-wrap"></div>
          </div>
          <div class="hh-view" data-view="ask" style="display:none">
            <div id="${PID}_chat" style="display:flex;flex-direction:column;gap:6px;padding-bottom:6px;max-height:300px;overflow-y:auto"></div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <textarea id="${PID}_chatIn" placeholder="Ask anything…" style="flex:1;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;resize:none;height:40px"></textarea>
              <button id="${PID}_chatSend" style="padding:6px 10px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;font-size:12px">Send</button>
            </div>
          </div>
          <div class="hh-view" data-view="solve" style="display:none">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Type (blank = auto)</div>
            <select id="${PID}_fType" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
              <option value="">Auto-detect</option>
              <option value="written">Written (prose)</option>
              <option value="saq">Short Answer (SAQ / ACE format)</option>
              <option value="presentation">Presentation / slides</option>
              <option value="infographic">Infographic / poster</option>
              <option value="canva">Canva / visual design</option>
              <option value="flashcards">Flashcards</option>
              <option value="video">Video script</option>
              <option value="walkthrough">Website walkthrough</option>
            </select>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Project context (saved)</div>
            <textarea id="${PID}_fCtx" placeholder="One line about your project." style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px;resize:vertical;height:50px"></textarea>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Voice sample (saved)</div>
            <textarea id="${PID}_fStyle" placeholder="Paste a paragraph you wrote." style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px;resize:vertical;height:60px"></textarea>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <button id="${PID}_fGo" style="flex:1;padding:6px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;font-size:12px">Solve</button>
              <button id="${PID}_fOcr" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">OCR</button>
              <button id="${PID}_fCopy" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Copy</button>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:8px">
              <button id="${PID}_fSubmit" style="flex:2;padding:8px;border:0;border-radius:6px;background:#c47a1a;color:#fff;font-weight:700;cursor:pointer;font-size:12px">Submit to Page</button>
              <button id="${PID}_fDl" style="flex:1;padding:8px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">.txt</button>
            </div>
            <div style="font-size:11px;color:#aaa;margin-bottom:4px">Status: <span id="${PID}_fStatus">idle</span></div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 3px;font-weight:700">Scraped steps</div>
            <div id="${PID}_fSteps" style="background:#0a0a0a;border-radius:6px;padding:6px;font:10px/1.4 ui-monospace,Menlo,monospace;color:#9ccc65;max-height:130px;overflow-y:auto;white-space:pre-wrap">—</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 3px;font-weight:700">Deliverables</div>
            <div id="${PID}_fOut" style="display:flex;flex-direction:column;gap:6px"></div>
          </div>
          <div class="hh-view" data-view="hist" style="display:none">
            <div style="display:flex;gap:6px;margin-bottom:8px">
              <button id="${PID}_hExport" style="flex:1;padding:6px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Export</button>
              <button id="${PID}_hClear" style="flex:1;padding:6px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Clear</button>
            </div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Answers</div>
            <div id="${PID}_hQuiz" style="display:flex;flex-direction:column;gap:5px;max-height:140px;overflow-y:auto"></div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 3px;font-weight:700">Solve runs</div>
            <div id="${PID}_hForge" style="display:flex;flex-direction:column;gap:5px;max-height:140px;overflow-y:auto"></div>
          </div>
          <div class="hh-view" data-view="cfg" style="display:none">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Model</div>
            <input id="${PID}_m" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">API key</div>
            <input id="${PID}_k" type="password" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Temperature <span id="${PID}_tv" style="color:#e07b39"></span></div>
            <input id="${PID}_t" type="range" min="0" max="1" step="0.05" style="width:100%;accent-color:#e07b39">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 3px;font-weight:700">Auto-submit (0 = off)</div>
            <input id="${PID}_auto" type="number" min="0" max="120" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#aaa;margin:6px 0"><input id="${PID}_ocr" type="checkbox"> OCR images on page (Tesseract, slow first run)</label>
            <div style="font-size:10px;color:#666;margin-top:8px;text-align:center">Ctrl+Shift+H toggle · × closes & tears down</div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;padding:5px 12px;font:10px ui-monospace,monospace;color:#555;background:#0a0a0a;border-top:1px solid #1a1a1a">
          <span id="${PID}_fModel">—</span>
          <span id="${PID}_fTok">0 / 0</span>
        </div>
      </div>`;
    document.body.appendChild(el);
    wireUI();
    render();
  }

  const $ = suf => document.getElementById(PID + suf);

  function wireUI() {
    document.querySelectorAll('#' + PID + ' .hh-tab').forEach(btn => {
      btn.onclick = () => {
        if (KILLED) return;
        S.tab = btn.dataset.tab;
        document.querySelectorAll('#' + PID + ' .hh-tab').forEach(b => {
          const active = b === btn;
          b.style.background = active ? '#1a1a1a' : 'transparent';
          b.style.color = active ? '#e07b39' : '#8a8a8a';
          b.style.borderBottom = active ? '2px solid #e07b39' : '2px solid transparent';
          b.style.fontWeight = active ? '600' : '500';
        });
        document.querySelectorAll('#' + PID + ' .hh-view').forEach(v => {
          v.style.display = v.dataset.view === S.tab ? '' : 'none';
        });
        render();
      };
    });
    $('_toggle').onclick = startSmart;
    $('_skip').onclick = () => { const b = findNextButton(); if (b) { humanClick(b); log('skip'); } };
    $('_explain').onclick = async () => {
      if (KILLED || !S.lastQuestion || S.lastQuestion === '—') return;
      const t = document.querySelector('#' + PID + ' .hh-tab[data-tab="ask"]');
      if (t) t.click();
      await sendChat(`Explain the reasoning behind this answer in 3-4 sentences: ${S.lastQuestion}`);
    };
    $('_x').onclick = nuke;

    const hdr = $('_hdr'); const panel = document.getElementById(PID);
    let drag = null;
    hdr.addEventListener('mousedown', e => {
      if (e.target.id === PID + '_x') return;
      drag = { x: e.clientX, y: e.clientY, l: panel.offsetLeft, t: panel.offsetTop };
      e.preventDefault();
    }, SIG);
    document.addEventListener('mousemove', e => {
      if (!drag || KILLED) return;
      panel.style.left = (drag.l + e.clientX - drag.x) + 'px';
      panel.style.top = (drag.t + e.clientY - drag.y) + 'px';
      panel.style.right = 'auto';
    }, SIG);
    document.addEventListener('mouseup', () => { drag = null; }, SIG);

    const ci = $('_chatIn');
    ci.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(ci.value); ci.value = ''; }
    }, SIG);
    $('_chatSend').onclick = () => { sendChat(ci.value); ci.value = ''; };

    $('_hExport').onclick = () => {
      const blob = new Blob([JSON.stringify({ quiz: S.history, solve: window.__solve?.F?.history || [] }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'helper-history-' + Date.now() + '.json';
      a.click();
    };
    $('_hClear').onclick = () => {
      S.history = [];
      if (window.__solve?.F) window.__solve.F.history = [];
      try { localStorage.removeItem('__hh_forge_hist'); } catch {}
      render();
    };

    const m = $('_m'); m.value = CFG.ai.model;
    m.oninput = () => { CFG.ai.model = m.value.trim(); saveCfg(); render(); };
    const k = $('_k'); k.value = CFG.ai.key;
    k.oninput = () => { CFG.ai.key = k.value.trim(); saveCfg(); };
    const t = $('_t'); t.value = CFG.ai.temperature;
    t.oninput = () => { CFG.ai.temperature = parseFloat(t.value); saveCfg(); $('_tv').textContent = CFG.ai.temperature.toFixed(2); };
    $('_tv').textContent = CFG.ai.temperature.toFixed(2);
    const auto = $('_auto'); auto.value = CFG.autoSubmitSec;
    auto.oninput = () => { CFG.autoSubmitSec = parseInt(auto.value, 10) || 0; saveCfg(); };
    const ocr = $('_ocr'); ocr.checked = CFG.ocrEnabled;
    ocr.onchange = () => { CFG.ocrEnabled = !!ocr.checked; saveCfg(); };

    document.addEventListener('keydown', e => {
      if (KILLED) return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        e.preventDefault();
        const p = document.getElementById(PID);
        if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
      }
    }, SIG);
  }

  function nuke() {
    if (KILLED) return;
    KILLED = true;
    try { S.running = false; S.busy = false; __continuous = false; } catch {}
    try { ABORT.abort(); } catch {}
    try { clrAll(); } catch {}
    // drain killHooks — no accumulation across re-pastes
    try {
      const hooks = window.__helperKillHooks || [];
      for (const h of hooks) { try { h(); } catch {} }
      window.__helperKillHooks = [];
    } catch {}
    try { if (window.__helperForgeBoot) { clearInterval(window.__helperForgeBoot); window.__helperForgeBoot = null; } } catch {}
    try { document.getElementById(UI_ID)?.remove(); } catch {}
    try { document.getElementById('__hh_fill_popup')?.remove(); } catch {}
    try { if (window.__solve) delete window.__solve; } catch {}
    try { delete window.__cinder; } catch {}
    console.log('%c[hw-helper] closed — paste the loader again to reload.', 'color:#e07b39;font-weight:bold');
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderLog() {
    const el = $('_log');
    if (!el) return;
    el.innerHTML = S.log.slice(-40).map(l => {
      const cls = /err|fail/i.test(l) ? 'color:#ef5350' : 'color:#9ccc65';
      return `<div style="${cls}">${esc(l)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }
  function renderChat() {
    const el = $('_chat');
    if (!el) return;
    el.innerHTML = S.chat.map(m => {
      const u = m.role === 'user';
      const bg = u ? '#2c3e50' : '#1e1e1e';
      const color = u ? '#ecf0f1' : '#ddd';
      const align = u ? 'flex-end' : 'flex-start';
      const border = u ? '' : 'border-left:2px solid #e07b39;';
      const tail = m.streaming ? '<span style="color:#e07b39"> ▋</span>' : '';
      return `<div style="align-self:${align};background:${bg};color:${color};${border}padding:6px 10px;border-radius:8px;font-size:11px;line-height:1.45;max-width:92%;word-break:break-word;white-space:pre-wrap">${esc(m.content)}${tail}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }
  function renderHistory() {
    const q = $('_hQuiz');
    if (q) {
      q.innerHTML = S.history.length
        ? S.history.slice().reverse().slice(0, 20).map(h =>
            `<div style="background:#0e0e0e;border-radius:6px;padding:6px 8px;font-size:11px;border-left:2px solid #e07b39;color:#ccc"><b style="color:#e07b39">${esc((h.pickedText||[]).join(' | ').slice(0, 90))}</b></div>`
          ).join('')
        : '<div style="background:#0e0e0e;border-radius:6px;padding:6px 8px;font-size:11px;color:#666">none yet</div>';
    }
    const f = $('_hForge');
    if (f) {
      const H = window.__solve?.F?.history || [];
      f.innerHTML = H.length
        ? H.slice(0, 20).map(h =>
            `<div style="background:#0e0e0e;border-radius:6px;padding:6px 8px;font-size:11px;border-left:2px solid #e07b39;color:#ccc"><b style="color:#e07b39">${esc((h.title || 'assignment').slice(0, 60))}</b> — ${h.deliverables?.length || 0}</div>`
          ).join('')
        : '<div style="background:#0e0e0e;border-radius:6px;padding:6px 8px;font-size:11px;color:#666">none yet</div>';
    }
  }
  function render() {
    if (KILLED || !document.getElementById(PID)) return;
    const st = $('_status');
    if (st) {
      st.textContent = S.running ? 'running' : (__continuous ? 'continuous' : (S.busy ? 'stopping' : 'idle'));
      st.style.color = (S.running || __continuous) ? '#4caf50' : '#aaa';
    }
    const tg = $('_toggle');
    if (tg) {
      const active = S.running || __continuous;
      tg.textContent = active ? 'Stop' : 'Start';
      tg.style.background = active ? '#c62828' : '#2e7d32';
    }
    if ($('_plat')) $('_plat').textContent = S.platform || 'unknown';
    if ($('_count')) $('_count').textContent = S.processed;
    if ($('_req')) $('_req').textContent = S.requests;
    if ($('_lq')) $('_lq').textContent = S.lastQuestion;
    if ($('_la')) $('_la').textContent = S.lastAnswer;
    if ($('_fModel')) $('_fModel').textContent = CFG.ai.model;
    if ($('_fTok')) $('_fTok').textContent = S.tokensIn + ' in / ' + S.tokensOut + ' out';
    renderLog(); renderChat(); renderHistory();
  }

  window.__cinder = {
    CFG, S, log, esc, render,
    groqCall, groqJson, groqCallRetry,
    isKilled: () => KILLED,
    PID
  };

  S.platform = detectPlatform();
  ensureUI();
  log('helper ready · ' + CFG.ai.model + ' · platform: ' + S.platform);

  (function tick() {
    if (KILLED) return;
    setTimeout(async () => {
      try { tickHumanActivity(); await continuousTick(); }
      catch (e) { log('continuous err:', e.message); }
      tick();
    }, randInt(2200, 5200));
  })();

  spoofFocus();
  setInterval(spoofFocus, 30000);

  if (CFG.autoStart) startSmart();
})();

// ============================================================
// SOLVE (+ Submit)
// ============================================================
(() => {
  'use strict';

  const PID = '__hh_panel';
  let DEAD = false;
  const C = window.__cinder;
  const isDead = () => DEAD || !C || C.isKilled();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => { if (!isDead()) C.log('[solve]', ...a); };
  const $ = suf => document.getElementById(PID + suf);
  const esc = s => C.esc(s);

  (window.__helperKillHooks = window.__helperKillHooks || []).push(() => { DEAD = true; });

  const LS_CTX = '__hh_forge_ctx';
  const LS_STY = '__hh_forge_style';
  const LS_HIS = '__hh_forge_hist';
  const LS_TYP = '__hh_forge_type';

  const Ctx = {
    project: localStorage.getItem(LS_CTX) || '',
    style: localStorage.getItem(LS_STY) || '',
    typeOverride: localStorage.getItem(LS_TYP) || '',
    saveProject(v) { this.project = v; try { localStorage.setItem(LS_CTX, v); } catch {} },
    saveStyle(v) { this.style = v; try { localStorage.setItem(LS_STY, v); } catch {} },
    saveType(v) { this.typeOverride = v; try { localStorage.setItem(LS_TYP, v); } catch {} }
  };

  const F = {
    running: false, title: '', deliverables: [], scrapedSteps: [], ocrText: [],
    history: (() => { try { return JSON.parse(localStorage.getItem(LS_HIS) || '[]'); } catch { return []; } })()
  };

  const cleanText = t => String(t).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  const visibleEls = (sel, root = document) => [...root.querySelectorAll(sel)].filter(el => el.offsetParent !== null && !el.closest('#__hh_ui'));

  function detectType(text) {
    const t = (text || '').toLowerCase();
    if (/\b(infographic|one[\s-]?pager|poster|brochure|flyer)\b/i.test(t)) return 'infographic';
    if (/\b(canva|word|google\s*docs)\s+(to\s+)?(make|create|build|design)/i.test(t) && /\b(infographic|poster|brochure|flyer)\b/i.test(t)) return 'infographic';
    if (/\b(canva|canva\.com)\b/i.test(t) || /\buse\s+canva\b/i.test(t) || /\bopen\s+canva\b/i.test(t) || /\bcreate.*?\bin\s+canva\b/i.test(t)) return 'canva';
    if (/\b(saq|short[\s-]?answer|ace\s+format)\b/i.test(t)) return 'saq';
    if (/\b(slide|slides|presentation|powerpoint|google slides|deck|slideshow)\b/.test(t)) return 'presentation';
    if (/\b(flashcard|flash card|quizlet|anki|term and definition|vocab card)\b/.test(t)) return 'flashcards';
    if (/\b(record a video|loom|screencastify|voiceover|voice over|narrate)\b/.test(t)) return 'video';
    if (/\b(go to|visit|navigate to|sign up at|log in to|create an account on)\b/.test(t) && /https?:\/\/|\.com|\.org|\.net/.test(t)) return 'walkthrough';
    return 'written';
  }

  const TYPE_INSTRUCTIONS = {
    written: `OUTPUT SHAPE: Flowing prose. Multiple paragraphs okay. Tight, 60–120 words per deliverable unless a length is specified. No bullets unless the step itself is a list prompt.`,
            saq: `OUTPUT SHAPE: Short-answer response (SAQ). Use ACE: Answer directly, Cite evidence, Explain the connection.

CRITICAL RULE: Only quote or paraphrase lines that appear VERBATIM in the SOURCE TEXT below. Do NOT quote from your memory of the document — if the exact words are not in the source text block, do not use them. This is the single most important rule.

Every claim must use an ACTUAL line from the source. Put exact words in quotes. If you cannot find a line for a point, don't make that point.

Structure (4-6 sentences):
1. Direct answer to the question.
2. Quote an exact line from the source text.
3. A second exact quote from the source text (if available).
4. Explain how these quotes prove your answer.

No bullets, no headers, no "In conclusion".`,
    
    infographic: `OUTPUT SHAPE: ONE deliverable — a content plan. NOT steps like "open Canva". Give the CONTENT.

TITLE: <short, punchy title>

SECTION 1 — <section name>
Heading: <exact heading to type>
Text: <2-3 sentences>

SECTION 2 — <section name>
Heading: <exact heading to type>
Text: <2-3 sentences>

SECTION 3 — <section name>
Heading: <exact heading to type>
Text: <2-3 sentences>

VISUAL NOTES:
- Icon ideas per section
- Color palette (2-3 colors)
- Layout hint

ONE deliverable. Merge all steps if steps are listed.`,
    presentation: `OUTPUT SHAPE: Slide-by-slide.
Slide 1: <title>
- bullet
- bullet
Speaker notes: one sentence

Aim for 5–8 slides unless count specified. Bullets under 12 words.`,
    canva: `OUTPUT SHAPE: Numbered build steps:
1. Open Canva → search "<template>" → pick clean template.
2. Title text: "<exact text>"
3. Slide 2: <content>
4. Element to add: <icon/photo idea>
5. Colors: <2-3>
Give exact text to type.`,
    flashcards: `OUTPUT SHAPE: Numbered term/definition pairs.
1. Term: "<term>"
   Definition: "<one-sentence>"
Give 8–15 cards unless count specified.`,
    video: `OUTPUT SHAPE: Script.
[0:00] <what to say>
[0:15] <next beat>
Include what to show on screen.`,
    walkthrough: `OUTPUT SHAPE: Numbered navigation steps.
1. Go to <url>.
2. Click "<label>".
3. Enter <what>.
Keep each step one action.`
  };

  function findStepTabs() {
    return [...document.querySelectorAll('button, a, li, [role="tab"], .nav-item, .nav-link, .mdc-tab')]
      .filter(el => el.offsetParent !== null)
      .filter(el => /^(overview|step\s*\d+|introduction|summary|submit|part\s*\d+|section\s*\d+|lesson\s*\d+)$/i.test((el.textContent || '').trim()))
      .filter((el, i, arr) => arr.findIndex(x => x.textContent.trim() === el.textContent.trim()) === i);
  }

  function extractDelta(before, after) {
    const set = new Set(before.split('\n'));
    const lines = after.split('\n');
    const idx = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] && !set.has(lines[i])) idx.push(i);
    if (!idx.length) return after;
    return lines.slice(idx[0], idx[idx.length - 1] + 1).join('\n').trim();
  }

  // ---- Schoology-specific content extraction ----
  function scrapeSchoology() {
    const out = [];
    const INSTRUCTION_RX = /instructions?:|answer (one|the following|the question)|using the (document|text|passage)|read the (following|passage)/i;

    // Schoology's newer layout puts everything in #main-inner. Older layouts
    // use #assignment-content*. Try specific first, fall back to broad.
    const selectors = [
      '#main-inner',
      '#assignment-content-inner',
      '#assignment-content',
      '.assignment-content',
      '.assignment-description',
      'main',
    ];

    let best = null, bestScore = 0;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const txt = cleanText(el.innerText || '');
      if (txt.length < 80) continue;
      // prefer containers with instructions, and prefer smaller (more specific)
      const instrBoost = INSTRUCTION_RX.test(txt) ? 5000 : 0;
      const score = instrBoost - txt.length * 0.001;
      if (score > bestScore) { bestScore = score; best = { sel, txt }; }
    }

    if (best) {
      const stripped = stripNav(best.txt);
      log('schoology: matched', best.sel, '—', best.txt.length, '→', stripped.length, 'chars after strip');
      if (stripped.length > 80) {
        out.push({ label: 'Assignment', content: stripped.slice(0, 5000) });
        return out;
      }
    }

    // Deepest-container fallback
    const all = [...document.querySelectorAll('div, section, article')];
    const withInstr = all.filter(el => INSTRUCTION_RX.test(el.innerText || '') && (el.innerText || '').length > 300);
    if (withInstr.length) {
      withInstr.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const pick = withInstr[0];
      const stripped = stripNav(cleanText(pick.innerText));
      log('schoology: deepest container', stripped.length, 'chars');
      if (stripped.length > 80) {
        out.push({ label: 'Assignment', content: stripped.slice(0, 5000) });
        return out;
      }
    }

    return out;
  }

  function stripNav(text) {
    const noise = [
      /^Skip to Content$/i,
      /^Courses$/i, /^Groups$/i, /^Resources$/i, /^More$/i,
      /^Current Menu Item$/i,
      /^Materials( Dropdown)?$/i,
      /^(Updates|Grades|Mastery|Members|Information)$/i,
      /^CodeAI$/i, /^Microsoft OneDrive$/i, /^Newsela$/i,
      /^Teams Quick Meet$/i, /^Edpuzzle$/i,
      /^Grading period$/i, /^Sandbox$/i,
      /^PrevNext$/i, /^Folder\.$/i,
      /^Immersive Reader$/i,
      /^Grade:$/i, /^Grade:\s*N\/A$/i,
      /^N\/A$/i, /^\d+$/,
      /^APUSH:/i,
      /^Week \d+:/i,                     // folder label
    ];
    const lines = text.split('\n').map(l => l.trimEnd());
    // also strip leading "Week N Class Discussion" duplicate of title
    const filtered = lines.filter(line => {
      const t = line.trim();
      if (!t) return true;
      return !noise.some(rx => rx.test(t));
    });
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function extractQuotableLines(sourceText) {
    // split into sentence-ish chunks
    const chunks = String(sourceText)
      .split(/\n|(?<=[.?!])\s+(?=[A-Z"“])/)
      .map(l => l.trim())
      .filter(l => l.length > 40 && l.length < 400);
    // keep the ones that look like actual grievances / evidence
    const lines = chunks.filter(l =>
      /[""][^""]{30,}[""]/.test(l) ||
      /\bHe has\b|\bShe has\b|\bThey have\b|\bWe have\b/.test(l) ||
      /\bGovernment\b|\bLiberty\b|\bRights\b|\bTyranny\b|\bConsent\b/.test(l)
    );
    const seen = new Set();
    const out = [];
    for (const l of lines) {
      const key = l.slice(0, 60).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
      if (out.length >= 15) break;
    }
    return out;
  }
  
  async function scrapeAllSteps() {
    // Schoology path first — different DOM
    if (location.hostname.includes('schoology')) {
      const sch = scrapeSchoology();
      log('schoology scrape →', sch.length, 'block(s)');
      if (sch.length) return sch;
      // fall through to generic if Schoology selectors missed
    }

    const tabs = findStepTabs();
    log('found', tabs.length, 'step tabs');
    const out = [];
    if (!tabs.length) {
      out.push({ label: 'Page', content: cleanText(document.body.innerText) });
      return out;
    }
    const snap = () => cleanText(document.body.innerText);
    let prev = snap();
    const activeNow = tabs.find(t => /active|selected/i.test(t.className) || t.getAttribute('aria-selected') === 'true' || t.classList.contains('mdc-tab--active')) || tabs[0];
    for (const tab of tabs) {
      if (isDead()) return out;
      const label = tab.textContent.trim();
      tab.click();
      let now = prev;
      const start = Date.now();
      while (Date.now() - start < 2200) {
        await sleep(150);
        now = snap();
        if (now !== prev) break;
      }
      const content = extractDelta(prev, now);
      // skip tabs with essentially no content
      if (content.length >= 80) {
        out.push({ label, content });
        log('scraped:', label, content.length, 'chars');
      } else {
        log('skipped empty tab:', label);
      }
      prev = now;
    }
    activeNow.click();
    await sleep(300);

    // FALLBACK: if we got nothing useful, grab full body
    if (!out.length || out.every(s => s.content.length < 80)) {
      const body = cleanText(document.body.innerText);
      if (body.length > 60) {
        out.push({ label: 'Full Page', content: body.slice(0, 5000) });
        log('fallback: full body text', body.length, 'chars');
      }
    }
    return out;
  }

  function findEditableFields() {
    const tas = [...document.querySelectorAll('textarea')].filter(t => t.offsetParent !== null && (t.value || '').length > 20);
    const ces = [...document.querySelectorAll('[contenteditable="true"]')].filter(t => t.offsetParent !== null && (t.innerText || '').length > 20);
    return [...tas, ...ces].map(el => ({
      hint: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.closest('label')?.innerText || el.name || '').trim().slice(0, 120),
      value: (el.value ?? el.innerText ?? '').slice(0, 1400)
    }));
  }

  function buildPrompt(steps, ctx, style, fields, type, ocrText) {
    const stepBlob = steps.map(s => `### ${s.label}\n${s.content.slice(0, 1800)}`).join('\n\n');
    let pendingBlock = '';
    try {
      const raw = localStorage.getItem('__hh_pending_lesson');
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.ts && (Date.now() - p.ts) < 30 * 60 * 1000) {
          pendingBlock = `\n\nPRIOR LESSON CONTEXT:\n"""\n${p.title}\n---\n${p.text.slice(0, 2500)}\n"""\n`;
          localStorage.removeItem('__hh_pending_lesson');
          log('using stashed lesson context:', p.title);
        }
      }
    } catch {}

    const ocrBlock = (ocrText && ocrText.length)
      ? `\n\nTEXT EXTRACTED FROM IMAGES ON THE PAGE (OCR — treat as primary source):\n"""\n${ocrText.join('\n\n---\n\n').slice(0, 4000)}\n"""`
      : '';

    const ctxBlock = ctx && ctx.trim()
      ? `\n\nSTUDENT'S PROJECT:\n"""\n${ctx.trim().slice(0, 1200)}\n"""`
      : `\n\nNO PROJECT CONTEXT. If a step mentions "your project", output "[NEED PROJECT CONTEXT — paste in Solve tab]".`;
    const styleBlock = style && style.trim() ? `\n\nSTUDENT'S VOICE SAMPLE:\n"""\n${style.trim().slice(0, 1400)}\n"""` : '';
    const fieldsBlock = fields.length
      ? `\n\nEXISTING TEXT ON PAGE:\n` + fields.map((f, i) => `[field ${i + 1}${f.hint ? ' — ' + f.hint : ''}]\n${f.value}`).join('\n\n')
      : '';

    return `Respond with a single JSON object. First char {, last char }.

You are a real 11th grade student. Output is pasted verbatim. You write like a normal high schooler.

=== STRUCTURE ===
Steps: ${steps.map(s => s.label).join(' | ')}
Produce ONE deliverable per step.
EXCEPTION: infographic / presentation = ONE artifact. Merge ALL steps into one deliverable.
Skip "Overview"/"Introduction" if they only describe the assignment.
If a step is under 80 chars, ignore it and use the other steps.
Label each deliverable EXACTLY as step label.
If the assignment says "label which question you answer", pick ONE question (a, b, or c) and prefix the answer with that letter and a period, e.g. "a. The Declaration was written...". Do not answer more than one unless told to.

=== OUTPUT SHAPE ===
Type: ${type}
${TYPE_INSTRUCTIONS[type] || TYPE_INSTRUCTIONS.written}

=== CONTENT ===
Write the actual content the reader reads UNDER the heading.
Do not name the section, template, introduction, or document.
Do not describe what the section does.
Do not close with reflective meta-tails.
Every deliverable references the student's project.
Sub-questions answered in order inside the deliverable.
If a step says "include X, Y, Z," write X, Y, Z.

=== EXAMPLES ===
Use things a real high schooler touches: Spotify, YouTube, TikTok, Instagram, Google Docs, Notes app, camera roll, school email, Chromebook, shared Slides, Discord.
NEVER invent jobs, companies, paid work, sales figures, corporate datasets, APIs you built.
2-3 short examples max.
When unsure, generic ("a playlist app", "a school spreadsheet").

=== LENGTH ===
If a length is stated, obey it exactly. Otherwise 60-120 words.

=== VOICE ===
10th grade level. Plain words. Short sentences.
Contractions. One idea per sentence.
Say "it", "my project", "my AI" — never "the system" or "the platform".
No semicolons, no markdown headers, no bold.
Bullets only if the step is a list prompt.
Ban: furthermore, moreover, additionally, in conclusion, plays a crucial role, leverages, facilitates, underscores, optimal, robust.

=== ASSIGNMENT ===
The scraped text may contain Schoology navigation (Courses, Groups...). IGNORE all of it...
${stepBlob}${pendingBlock}${ocrBlock}${ctxBlock}${styleBlock}${fieldsBlock}

Schema:
{"assignment_title":"<inferred>","deliverables":[{"label":"<step>","answer":"<text>"}]}
JSON only.`;
  }

  function parse(raw) {
    let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON');
    const o = JSON.parse(m[0]);
    if (!Array.isArray(o.deliverables)) throw new Error('no deliverables');
    return o;
  }

  async function cleanDeliverables(deliverables) {
    if (!deliverables.length) return deliverables;
    const list = deliverables.map((d, i) => `[${i}]\n${d.answer}`).join('\n\n---\n\n');
    const prompt = `Rewrite each passage to remove meta-narration and fake adult examples.

Rules:
- Delete any sentence naming a section/document/template.
- Delete openings that describe the passage.
- Delete closings that describe the passage's effect.
- Replace fake adult examples (jobs, companies, paid work, datasets) with high schooler things (apps, school stuff, phone stuff).
- Keep every concrete fact, example, weakness, mitigation.
- Preserve word count as closely as possible.
- If a passage is already clean, return unchanged.

Schema: {"items":["<rewritten 0>","<rewritten 1>",...]}

Passages:
${list}`;
    try {
      const raw = await C.groqJson(prompt, 5000);
      let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) return deliverables;
      const o = JSON.parse(m[0]);
      if (!Array.isArray(o.items) || o.items.length !== deliverables.length) return deliverables;
      return deliverables.map((d, i) => {
        const rewritten = String(o.items[i] || '').trim();
        // only accept the rewrite if it's substantial — protects against the
        // model returning empty/whitespace/single-char strings
        return { ...d, answer: rewritten.length >= 20 ? rewritten : d.answer };
      });
    } catch (e) {
      log('cleanup failed:', e.message);
      return deliverables;
    }
  }

  async function forge() {
    if (F.running || isDead()) return;
    F.running = true; renderForge();
    const t0 = Date.now();
    try {
      const steps = await scrapeAllSteps();
      if (isDead()) return;
      F.scrapedSteps = steps;
      if (!steps.length || steps.every(s => s.content.length < 30)) {
        F.deliverables = [{ label: 'Error', answer: 'No assignment content detected.' }];
        renderForge(); return;
      }
      // OCR pass — pull text out of images on the page
      let ocrText = [];
      try { ocrText = await C.ocrPageImages?.() || []; } catch (e) { log('OCR skipped:', e.message); }
      F.ocrText = ocrText;
      if (ocrText.length) log('OCR contributed', ocrText.length, 'text block(s)');

      const fields = findEditableFields();
      const allText = steps.map(s => s.content).join('\n') + '\n' + ocrText.join('\n');
      const detectedType = Ctx.typeOverride || detectType(allText);
      log('type:', detectedType);
      const prompt = buildPrompt(steps, Ctx.project, Ctx.style, fields, detectedType, ocrText);
      log('prompt', prompt.length, 'chars');
      const raw = await C.groqJson(prompt, 5000);
      if (isDead()) return;
      log('[solve] raw response length:', raw.length);
      log('[solve] raw response head:', raw.slice(0, 400));
      const parsed = parse(raw);
      log('[solve] parsed deliverables:', parsed.deliverables.map(d => ({ label: d.label, answerLen: (d.answer || '').length })));
      F.title = parsed.assignment_title || document.title || 'Assignment';
      F.deliverables = parsed.deliverables;
      if (detectedType === 'written' || detectedType === 'saq') {
        log('cleanup pass');
        F.deliverables = await cleanDeliverables(F.deliverables);
        if (isDead()) return;
      }
      F.history.unshift({ ts: Date.now(), title: F.title, steps: steps.length, deliverables: F.deliverables });
      F.history = F.history.slice(0, 30);
      try { localStorage.setItem(LS_HIS, JSON.stringify(F.history)); } catch (e) { log('history save failed (quota?):', e.message); }
      log('solved', F.deliverables.length, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      if (isDead() || e.message === 'killed') return;
      log('solve failed:', e.message);
      F.deliverables = [{ label: 'Error', answer: 'Solve failed: ' + e.message }];
    } finally {
      F.running = false;
      if (!isDead()) renderForge();
    }
  }

  // ============================================================
  // SUBMIT — find submission box, paste plain text, confirm
  // ============================================================
  function findSubmissionBox() {
    // Look for a large textarea or contenteditable that could accept the answer
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter(el => el.offsetParent !== null && !el.closest('#__hh_ui'))
      .map(el => {
        const r = el.getBoundingClientRect();
        return { el, r };
      })
      .filter(x => x.r.width > 150 && x.r.height > 40);
    if (!cands.length) return null;
    // pick the largest (most likely the answer field, not a comment box)
    cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    return cands[0].el;
  }

  async function openSubmissionIfNeeded() {
    let box = findSubmissionBox();
    if (box) return box;
    // try common "start writing" triggers
    const rx = /add (submission|response|answer)|start (writing|typing)|write (a )?response|write (your )?answer|enter (your )?response|add comment|begin/i;
    const triggers = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(el => el.offsetParent !== null && !el.closest('#__hh_ui'))
      .filter(el => rx.test((el.textContent || '').trim()) || rx.test(el.getAttribute('aria-label') || ''));
    for (const t of triggers) {
      try { C.log('[solve] clicking trigger:', (t.textContent || '').trim().slice(0, 40)); } catch {}
      t.click();
      await sleep(900);
      box = findSubmissionBox();
      if (box) return box;
    }
    return null;
  }

  async function pastePlainText(box, text) {
    if (!box || !text) return false;
    try {
      box.focus();
      if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
        const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      // contenteditable: clear, then paste as plain text
      try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch {}
      // use execCommand insertText with plain string — avoids rich paste
      const ok = document.execCommand('insertText', false, text);
      if (!ok) box.innerText = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      log('paste failed:', e.message);
      return false;
    }
  }

  async function submitToPage() {
    if (isDead()) return;
    if (!F.deliverables.length) { log('nothing to submit'); return; }
    const text = F.deliverables.map(d => `[${d.label}]\n${d.answer}`).join('\n\n');
    log('submit: looking for box…');
    const box = await openSubmissionIfNeeded();
    if (!box) { log('no submission box found'); try { C.log('[solve] no box'); } catch {} return; }
    log('submit: pasting', text.length, 'chars');
    const ok = await pastePlainText(box, text);
    if (!ok) { log('paste failed'); return; }
    log('submit: paste ok — showing confirm');
    // reuse fill popup for confirmation
    const lesson = { title: F.title || 'Assignment', text: F.deliverables.map(d => d.label).join('\n') };
    const choice = await new Promise(resolve => {
      // inline: use C.showFillPopup if exposed, else fall back to confirm
      if (typeof window !== 'undefined' && C.showFillPopup) { C.showFillPopup(lesson, text, true).then(resolve); return; }
      // fallback popup
      const el = document.createElement('div');
      el.id = '__hh_fill_popup';
      el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;width:min(720px,92vw);background:#1a1a1a;color:#f0f0f0;border:2px solid #e07b39;border-radius:12px;font:13px/1.5 sans-serif;box-shadow:0 12px 60px rgba(0,0,0,.8);overflow:hidden';
      const wc = (text.match(/\S+/g) || []).length;
      el.innerHTML = `
        <div style="background:#e07b39;color:#1a1a1a;padding:10px 16px;font-weight:700;display:flex;justify-content:space-between">
          <span>Review before submit</span><span id="__hh_fill_x" style="cursor:pointer;font-size:20px;">×</span>
        </div>
        <div style="padding:14px 16px;max-height:60vh;overflow-y:auto">
          <div style="font-size:11px;color:#888;margin-bottom:6px;font-weight:700">PASTED INTO PAGE (${wc} words)</div>
          <div style="background:#0e0e0e;border-left:3px solid #e07b39;border-radius:6px;padding:10px;font-size:13px;color:#eee;white-space:pre-wrap;max-height:300px;overflow-y:auto">${C.esc(text)}</div>
        </div>
        <div style="padding:12px 16px;background:#141414;border-top:1px solid #262626;display:flex;gap:8px">
          <button id="__hh_fill_confirm" style="flex:1;padding:10px;border:0;border-radius:8px;background:#2e7d32;color:#fff;font-weight:700;font-size:13px;cursor:pointer">Submit on Page</button>
          <button id="__hh_fill_manual" style="padding:10px 16px;border:0;border-radius:8px;background:#333;color:#ddd;font-weight:600;font-size:13px;cursor:pointer">Copy</button>
          <button id="__hh_fill_cancel" style="padding:10px 16px;border:0;border-radius:8px;background:#5a1e1e;color:#ffd6d6;font-weight:600;font-size:13px;cursor:pointer">Cancel</button>
        </div>`;
      document.body.appendChild(el);
      const done = v => { try { el.remove(); } catch {} resolve(v); };
      document.getElementById('__hh_fill_x').onclick = () => done('cancel');
      document.getElementById('__hh_fill_cancel').onclick = () => done('cancel');
      document.getElementById('__hh_fill_manual').onclick = () => { try { navigator.clipboard.writeText(text); } catch {} done('manual'); };
      document.getElementById('__hh_fill_confirm').onclick = () => done('confirm');
    });
    if (choice !== 'confirm') { log('submit cancelled'); return; }
    // find and click the page's submit button
    const rx = /^(submit|turn in|submit assignment|submit for grading|save and submit|save & submit|hand in)\b/i;
    const submitBtn = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
      .filter(el => el.offsetParent !== null && !el.disabled && !el.closest('#__hh_ui'))
      .find(el => rx.test(((el.textContent || '') + ' ' + (el.value || '')).trim()) || rx.test(el.getAttribute('aria-label') || ''));
    if (!submitBtn) { log('no submit button found on page — text is in the box'); return; }
    log('clicking page submit:', (submitBtn.textContent || submitBtn.value || '').trim().slice(0, 40));
    submitBtn.click();
    await sleep(1500);
    // confirm dialog if one appears
    const dialogScopes = ['[role="dialog"]', '.mdc-dialog', '.cdk-overlay-pane', '[class*="modal"]'];
    for (const scope of dialogScopes) {
      const root = document.querySelector(scope);
      if (!root || root.offsetParent === null) continue;
      const cBtn = [...root.querySelectorAll('button, [role="button"]')].find(b => b.offsetParent !== null && !b.disabled &&
        /^(yes|confirm|ok|submit|turn in|yes, submit)\b/i.test((b.textContent || '').trim()));
      if (cBtn) { cBtn.click(); await sleep(1500); break; }
    }
    log('submit sequence done');
  }

  function inject() {
    if (isDead()) return;
    const tabsBar = $('_tabs');
    if (!tabsBar || tabsBar.dataset.forgeBound) return;
    tabsBar.dataset.forgeBound = '1';
    const btn = tabsBar.querySelector('[data-tab="solve"]');
    if (btn) btn.addEventListener('click', () => { if (!isDead()) renderForge(); });

    const ty = $('_fType');
    if (ty) { ty.value = Ctx.typeOverride || ''; ty.onchange = () => { Ctx.saveType(ty.value); }; }
    const ctx = $('_fCtx'); if (ctx) { ctx.value = Ctx.project; ctx.oninput = () => Ctx.saveProject(ctx.value); }
    const sty = $('_fStyle'); if (sty) { sty.value = Ctx.style; sty.oninput = () => Ctx.saveStyle(sty.value); }
    const go = $('_fGo'); if (go) go.onclick = forge;
    const cp = $('_fCopy'); if (cp) cp.onclick = copyAll;
    const dl = $('_fDl'); if (dl) dl.onclick = downloadTxt;
    const sub = $('_fSubmit'); if (sub) sub.onclick = submitToPage;
    const oc = $('_fOcr'); if (oc) oc.onclick = async () => {
      if (F.running) return;
      log('manual OCR triggered');
      try {
        const blocks = await C.ocrPageImages();
        F.ocrText = blocks;
        log('OCR got', blocks.length, 'text block(s)');
        // append into scraped steps view so user sees it
        if (blocks.length) {
          F.scrapedSteps = [...F.scrapedSteps, { label: 'OCR Image Text', content: blocks.join('\n\n') }];
          renderForge();
        }
      } catch (e) { log('OCR failed:', e.message); }
    };

    renderForge();
  }

  function renderForge() {
    if (isDead()) return;
    const st = $('_fStatus');
    if (st) st.textContent = F.running
      ? 'solving…'
      : (F.deliverables.length ? `done — ${F.deliverables.length} deliverable(s)${F.title ? ' · ' + F.title : ''}` : 'idle');
    const sEl = $('_fSteps');
    if (sEl) {
      sEl.innerHTML = F.scrapedSteps.length
        ? F.scrapedSteps.map(s => {
            const head = esc(s.content.slice(0, 80).replace(/\n/g, ' '));
            const col = s.content.length < 200 ? 'color:#ef5350' : 'color:#9ccc65';
            return `<div style="${col}">• <b>${esc(s.label)}</b> — ${s.content.length} chars<br><span style="color:#666;font-size:9px">${head}…</span></div>`;
          }).join('')
        : '—';
    }
    const out = $('_fOut');
    if (!out) return;
    if (!F.deliverables.length) { out.innerHTML = ''; return; }
    out.innerHTML = F.deliverables.map((d, i) => `
      <div style="background:#0e0e0e;border-left:3px solid #e07b39;border-radius:6px;padding:8px;font-size:11px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:6px">
          <b style="color:#e07b39;font-size:11px;flex:1;word-break:break-word">${esc(d.label)}</b>
          <button data-copy="${i}" style="padding:3px 7px;border:0;border-radius:4px;background:#333;color:#ddd;cursor:pointer;font-size:10px">Copy</button>
        </div>
        <div style="color:#ddd;white-space:pre-wrap;max-height:220px;overflow-y:auto;line-height:1.5">${esc(d.answer)}</div>
      </div>
    `).join('');
    out.querySelectorAll('[data-copy]').forEach(b => {
      b.onclick = () => {
        try { navigator.clipboard.writeText(F.deliverables[+b.dataset.copy].answer); } catch {}
        b.textContent = '✓';
        setTimeout(() => b.textContent = 'Copy', 900);
      };
    });
  }

  function bundle() {
    const parts = [];
    if (F.title) parts.push(F.title + '\n' + '='.repeat(F.title.length) + '\n');
    F.deliverables.forEach(d => parts.push(`--- ${d.label} ---\n${d.answer}\n`));
    return parts.join('\n');
  }
  function copyAll() {
    try { navigator.clipboard.writeText(bundle()); } catch {}
    const b = $('_fCopy'); if (b) { b.textContent = '✓'; setTimeout(() => b.textContent = 'Copy', 900); }
  }
  function downloadTxt() {
    const blob = new Blob([bundle()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (F.title || 'assignment').replace(/[^\w\-]+/g, '_').slice(0, 40) + '.txt';
    a.click();
  }

  const start = Date.now();
  window.__helperForgeBoot = setInterval(() => {
    if (isDead()) { clearInterval(window.__helperForgeBoot); window.__helperForgeBoot = null; return; }
    if (document.getElementById(PID)) {
      clearInterval(window.__helperForgeBoot);
      window.__helperForgeBoot = null;
      inject();
      log('solve ready.');
    } else if (Date.now() - start > 15000) {
      clearInterval(window.__helperForgeBoot);
      window.__helperForgeBoot = null;
    }
  }, 250);

  window.__solve = { run: forge, submit: submitToPage, F, scrape: scrapeAllSteps };
})();
