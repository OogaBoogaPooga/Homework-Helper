// language: JavaScript, file: homework-helper.js, runtime: browser console on Buzz Angular
// Homework Helper — Auto (quiz/flashcards/lessons/fill) + Ask + Forge + History + Settings.
// Groq backend. Simple UI. × fully tears down.

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
    autoSubmitSec: saved.autoSubmitSec ?? 0
  };
  const saveCfg = () => {
    try { localStorage.setItem(LS, JSON.stringify({
      key: CFG.ai.key, model: CFG.ai.model, temperature: CFG.ai.temperature,
      autoSubmitSec: CFG.autoSubmitSec
    })); } catch {}
  };

  const rand = (a, b) => Math.random() * (b - a) + a;
  const randInt = (a, b) => Math.floor(rand(a, b + 1));

  const S = {
    tab: 'auto', running: false, busy: false, processed: 0,
    lastAnswer: '—', lastQuestion: '—',
    log: [], history: [], chat: [],
    tokensIn: 0, tokensOut: 0, requests: 0
  };

  const log = (...a) => { if (!KILLED) console.log('%c[hw-helper]', 'color:#e07b39;font-weight:bold', ...a); };

  // ---- quiz DOM ----
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

  function humanClick(el) {
    if (!el || KILLED) return;
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
  }

  // ---- anti-detection ----
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

  // ---- groq ----
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
      throw err;
    }
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
        throw err;
      }
      const j = await res.json();
      return j.choices?.[0]?.message?.content || '';
    }
    try { return await attempt(true); }
    catch (e) {
      const jsonFail = e.status === 400 && /json_validate_failed|Failed to generate JSON/i.test(e.message || '');
      if (!jsonFail) throw e;
      log('JSON mode failed — retry without response_format');
      return await attempt(false);
    }
  }

  // ---- auto MCQ ----
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
    const nums = String(raw).match(/\d+/g)?.map(Number) || [];
    return { picks: [...new Set(nums)].filter(n => n >= 1 && n <= max), why: '' };
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
      raw = await groqCall([{ role: 'user', content: prompt }], { json: true });
      parsed = parseAuto(raw, choices.length);
      if (!parsed.picks.length) throw new Error('no pick: ' + String(raw).slice(0, 100));
    } catch (e) {
      if (KILLED) return false;
      log('AI failed:', e.message);
      S.lastAnswer = 'AI error: ' + e.message;
      render();
      if (/429/.test(e.message)) { await sleep(20000); return true; }
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
    log('auto loop started');
    let guard = 0;
    while (S.running && !KILLED && guard++ < 500) {
      const blocks = getQuestionBlocks();
      if (!blocks.length) { log('no quiz questions'); break; }
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
    if (!KILLED) { render(); log('auto loop stopped'); }
  }
  const stop = () => { S.running = false; render(); };

  // ---- flashcard driver ----
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
      else { log('no next-assignment nav — advance manually'); }
    }
  }

  // ---- classification + completion detection ----
  function classifyPage() {
    if (getQuestionBlocks().length) return 'quiz';
    if (detectFlashcards()) return 'cards';
    if (findMarkCompleteButton()) return 'lesson';

    const title = (
      (document.title || '') + ' ' +
      (document.querySelector('h1, [role="heading"], .assignment-title')?.textContent || '')
    ).toLowerCase();
    const bodyHead = (document.body.innerText || '').slice(0, 2500).toLowerCase();

    if (/\b(assignment|submit|dropbox|rubric)\b/i.test(title)) return 'assignment';
    if (/\b(submit (your|this|the) assignment|dropbox|rubric|grading criteria)\b/i.test(bodyHead)) return 'assignment';

    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter(t => t.offsetParent !== null && !t.closest('#__hh_ui'));
    if (inputs.length) return 'assignment';

    if (document.querySelector('video')) return 'lesson';
    if (/\b(lesson|video|lecture|watch|reading)\b/i.test(title)) return 'lesson';
    if (bodyHead.length > 700 && !inputs.length) return 'lesson';

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
      const blob = (
        (b.className || '').toString() + ' ' +
        (b.getAttribute('aria-label') || '') + ' ' +
        (b.getAttribute('title') || '') + ' ' +
        (b.textContent || '')
      ).toLowerCase();
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
      .find(b =>
        b.offsetParent !== null &&
        !b.disabled &&
        /^mark\s+(this\s+)?(activity|lesson|page|item)?\s*(as\s+)?complete$/i.test((b.textContent || '').trim())
      ) || null;
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
    const sels = [
      'button[aria-label*="next" i]',
      'a[aria-label*="next" i]',
      '[title*="next" i]',
      '[aria-label*="forward" i]'
    ];
    for (const sel of sels) {
      const el = [...document.querySelectorAll(sel)].find(e => e.offsetParent !== null);
      if (el && !/previous|back|left/i.test((el.getAttribute('aria-label') || el.getAttribute('title') || ''))) return el;
    }
    const icons = [...document.querySelectorAll('mat-icon, i, span')].filter(e =>
      e.children.length === 0 &&
      e.offsetParent !== null &&
      /^chevron_right$/.test((e.textContent || '').trim())
    );
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
      mo.observe(document.body, {
        childList: true, subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-label', 'title', 'style']
      });

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
      localStorage.setItem('__hh_pending_lesson', JSON.stringify({
        title, text: body.slice(0, 3000), ts: Date.now()
      }));
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

      if (kind === 'quiz') { log('hit quiz — stopping chain. Click Start.'); break; }
      if (kind === 'cards') { log('hit flashcards — stopping chain. Click Start.'); break; }
      if (kind === 'assignment') {
        if (hasPendingLesson() && !needsFileUpload()) {
          log('hit fillable assignment — running Fill mode');
          await runFillAssignment();
          return;
        }
        log('hit assignment — stopping chain. Run Forge.');
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

  function findSubmissionBox() {
    const isOurs = el => !!el.closest('#__hh_ui');
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter(el => el.offsetParent !== null && !isOurs(el));
    return cands[0] || null;
  }

  function findSubmitButton() {
    const rx = /^(submit|turn in|turn this in|turn it in|submit assignment|submit for grading|submit your work|save and submit|save & submit|finish|finish assignment|complete|mark complete|submit and close|hand in|hand it in)\b/i;

    const els = [...document.querySelectorAll(
      'button, a, [role="button"], .mdc-button, [mat-flat-button], [mat-raised-button], [mat-stroked-button]'
    )];

    for (const el of els) {
      if (el.offsetParent === null) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.closest('#__hh_ui')) continue;
      const txt = (el.textContent || '').trim();
      if (rx.test(txt)) return el;
    }

    for (const el of els) {
      if (el.offsetParent === null) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.closest('#__hh_ui')) continue;
      const lbl = (el.getAttribute('aria-label') || '').trim();
      if (rx.test(lbl)) return el;
    }

    const section = [...document.querySelectorAll('section, div, mat-card')]
      .find(el =>
        el.offsetParent !== null &&
        /(submission|turn\s*in|submit|dropbox)/i.test((el.textContent || '').slice(0, 300))
      );
    if (section) {
      const btn = section.querySelector('button:not([disabled]), [role="button"]:not([disabled])');
      if (btn && !btn.closest('#__hh_ui')) return btn;
    }

    return null;
  }

  async function openSubmissionBox() {
    const isOurs = el => !!el.closest('#__hh_ui');

    const scan = () => [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter(el => el.offsetParent !== null && !isOurs(el))
      .find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 100 && r.height > 20;
      }) || null;

    let box = scan();
    if (box) { log('comment box already visible'); return box; }

    const tryEls = [
      ...document.querySelectorAll('button, [role="button"], mat-icon, .material-icons, span'),
    ].filter(el => {
      if (el.offsetParent === null) return false;
      if (el.closest('#__hh_ui')) return false;
      const t = (el.textContent || '').trim();
      const lbl = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
      return /^\+$/.test(t)
          || /^add$/i.test(t)
          || /add comment|add reply|add note|add response|write a comment|new comment|post comment/i.test(lbl)
          || /add comment|add reply|add note|start (writing|typing)/i.test(t);
    });

    log('trying', tryEls.length, 'potential openers');

    for (const el of tryEls) {
      if (KILLED) return null;
      log('clicking opener:', (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40));
      humanClick(el);
      await sleep(1200);
      box = scan();
      if (box) { log('box appeared after click'); return box; }
    }

    const commentLabel = [...document.querySelectorAll('*')]
      .find(el => el.children.length === 0 && el.offsetParent !== null && /^comments?$/i.test((el.textContent || '').trim()));
    if (commentLabel) {
      log('clicking Comments label');
      humanClick(commentLabel);
      await sleep(1200);
      box = scan();
      if (box) return box;

      const container = commentLabel.closest('section, div, mat-card');
      if (container) {
        const btn = container.querySelector('button, [role="button"], mat-icon, .material-icons');
        if (btn) {
          log('clicking inside Comments section');
          humanClick(btn);
          await sleep(1200);
          box = scan();
          if (box) return box;
        }
      }
    }

    log('could not open comment box');
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
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      } catch {}
      fireKeystrokes(box, text.slice(0, 40));
      await sleep(randInt(180, 520));
      const ok = document.execCommand('insertText', false, text);
      if (!ok) box.innerText = text;
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text
      }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      log('fill failed:', e.message);
      return false;
    }
  }

  // ---- length parsing ----
  function parseLengthRequirement(text) {
    const t = (text || '').toLowerCase();

    let m = t.match(/at\s+least\s+(\d+)\s+words?/);
    if (m) return { kind: 'words', min: parseInt(m[1], 10), max: null, raw: m[0] };

    m = t.match(/minimum\s+(?:of\s+)?(\d+)\s+words?/);
    if (m) return { kind: 'words', min: parseInt(m[1], 10), max: null, raw: m[0] };

    m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s+words?/);
    if (m) return { kind: 'words', min: parseInt(m[1], 10), max: parseInt(m[2], 10), raw: m[0] };

    m = t.match(/no\s+more\s+than\s+(\d+)\s+words?/);
    if (m) return { kind: 'words', min: null, max: parseInt(m[1], 10), raw: m[0] };

    m = t.match(/(\d+)\s+words?\s*(?:each|per|minimum|max|maximum)/);
    if (m) return { kind: 'words', min: parseInt(m[1], 10), max: null, raw: m[0] };

    m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s+sentences?/);
    if (m) return { kind: 'sentences', min: parseInt(m[1], 10), max: parseInt(m[2], 10), raw: m[0] };

    m = t.match(/at\s+least\s+(\d+)\s+sentences?/);
    if (m) return { kind: 'sentences', min: parseInt(m[1], 10), max: null, raw: m[0] };

    m = t.match(/(\d+)\s+sentences?\s*(?:each|per|minimum)/);
    if (m) return { kind: 'sentences', min: parseInt(m[1], 10), max: null, raw: m[0] };

    m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s+paragraphs?/);
    if (m) return { kind: 'paragraphs', min: parseInt(m[1], 10), max: parseInt(m[2], 10), raw: m[0] };

    m = t.match(/(\d+)\s+paragraphs?/);
    if (m) return { kind: 'paragraphs', min: parseInt(m[1], 10), max: parseInt(m[1], 10), raw: m[0] };

    return null;
  }

  function describeLength(req) {
    if (!req) return '';
    if (req.kind === 'words') {
      if (req.min && req.max) return `Each answer must be between ${req.min} and ${req.max} words. Aim for ${Math.round((req.min + req.max) / 2)} words.`;
      if (req.min) return `Each answer must be AT LEAST ${req.min} words. Do not go under this.`;
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
    const lengthLine = describeLength(lengthReq) || 'Match the length to what the question actually asks. See the LENGTH MATCHING rules below.';
    if (lengthReq) log('detected length requirement:', lengthReq.raw);

    const makePrompt = (sourceText, short) => `You are a real 11th grade student answering reflection questions for a class assignment. You write like a normal high schooler — not an adult, not a chatbot, not a resume.

LENGTH (hard rule):
${lengthLine}

VOICE:
- Plain words. Short sentences. No semicolons. No markdown. No bullet lists.
- Contractions: I'm, it's, doesn't, can't, won't.
- Say "it", "my project", "I". Never "the system" or "the AI application."
- Answer the actual question. Don't restate it.

REAL EXAMPLES ONLY — this is the most important rule:
- If the question asks for personal examples, use things a real high schooler actually touches every day. Spotify playlists. YouTube. TikTok. Instagram. Google Docs. Notes app. Phone camera roll. School email. A school Chromebook. A shared Google Slides deck for a group project. Classroom assignments. Discord. A school spreadsheet for a science lab.
- NEVER invent jobs, companies, paid work, sales figures, corporate datasets, APIs you built, professional projects, or anything that sounds like an adult at a tech company. A high schooler doesn't have those.
- Do NOT stack 5-6 examples just to fill space. 2-3 short ones is enough. Then answer the question.
- If you're unsure whether an example is real, use a more generic one ("a playlist app", "a school spreadsheet", "my camera roll") rather than something specific and made up.

TONE:
- Write like you're explaining this to a friend, not writing a report for a business.
- No filler phrases: "It's important to note", "plays a crucial role", "leverages", "facilitates".
- No "In conclusion" or "In summary."

FORMAT:
- Write one answer per question, in order, separated by blank lines.
- No headers, no labels, no "Question 1:", no "Answer:".
- Just the answers.

LENGTH MATCHING (read the question, pick the tier):
- If a word/sentence/paragraph count is stated → follow it exactly. Overrides everything below.
- Simple reflection, opinion, "what did you do," list-style, "name an example" → 2-3 sentences.
- "Explain," "describe," "summarize," "what is X" → 3-5 sentences. One short paragraph.
- "Analyze," "compare," "discuss why," "evaluate," "what would happen if," multi-part with 2+ sub-questions → 5-8 sentences. Still tight, still one paragraph, but more substance.
- "Write an essay," "long-form response," "3 paragraphs" → honor the size the assignment implies.

BANNED REGARDLESS OF TIER:
- "For example, ..." as a padding sentence
- Closing wrap-ups ("In the end, ...", "Overall, ...", "This shows that, ...")
- Restating the question
- Adding a 4th sub-point when the question asked for 2

SOURCE QUESTIONS:
"""
${lesson.title}
${sourceText}
"""
${submissionText && !short ? `\nASSIGNMENT CONTEXT:\n"""\n${submissionText.slice(0, 800)}\n"""\n` : ''}
Return plain text only — just the answers, separated by blank lines.`;

    const tryOnce = async (source, short, temp, tokens) => {
      try {
        const raw = await groqCall(
          [{ role: 'user', content: makePrompt(source, short) }],
          { maxTokens: tokens, temperature: temp }
        );
        return (raw || '').trim();
      } catch (e) {
        log('fill attempt failed:', e.message);
        return '';
      }
    };

    let raw = await tryOnce(lesson.text.slice(0, 2800), false, 0.4, 6000);
    if (raw) return raw;

    log('attempt 1 empty — retrying with shorter context');
    raw = await tryOnce(lesson.text.slice(0, 1400), true, 0.3, 6000);
    if (raw) return raw;

    log('attempt 2 empty — trying minimal prompt');
    const minimal = `Write a student reflection answering the questions below. ${lengthLine} Plain first-person prose, no headers, one answer per question separated by blank lines. Use examples a real 11th grader would have — apps, school stuff, phone stuff. Nothing corporate.

Questions:
${lesson.text.slice(0, 1200)}

Answers:`;
    try {
      raw = await groqCall([{ role: 'user', content: minimal }], { maxTokens: 6000, temperature: 0.5 });
      raw = (raw || '').trim();
    } catch (e) { log('attempt 3 failed:', e.message); }
    if (raw) return raw;

    if (CFG.ai.model !== 'llama-3.3-70b-versatile') {
      log('all attempts empty — trying llama-3.3-70b-versatile');
      const prev = CFG.ai.model;
      CFG.ai.model = 'llama-3.3-70b-versatile';
      try {
        raw = await groqCall([{ role: 'user', content: minimal }], { maxTokens: 6000, temperature: 0.4 });
        raw = (raw || '').trim();
      } catch (e) { log('llama fallback failed:', e.message); }
      if (raw) return raw;
      CFG.ai.model = prev;
    }

    return '';
  }

  function showFillPopup(lesson, answers, boxFound) {
    return new Promise(resolve => {
      const el = document.createElement('div');
      el.id = '__hh_fill_popup';
      el.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        z-index: 2147483647; width: min(720px, 92vw);
        background: #1a1a1a; color: #f0f0f0;
        border: 2px solid #e07b39; border-radius: 12px;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 12px 60px rgba(0,0,0,.8);
        overflow: hidden;
      `;
      const wordCount = (answers.match(/\S+/g) || []).length;
      const autoSubmit = CFG.autoSubmitSec > 0;
      el.innerHTML = `
        <div style="background:#e07b39;color:#1a1a1a;padding:10px 16px;font-weight:700;display:flex;justify-content:space-between;align-items:center;">
          <span>Review before submit</span>
          <span id="__hh_fill_x" style="cursor:pointer;font-size:20px;line-height:1;">×</span>
        </div>
        <div style="padding:14px 16px;max-height:60vh;overflow-y:auto;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700;">Source questions</div>
          <div style="background:#0e0e0e;border-radius:6px;padding:10px;font-size:12px;color:#bbb;white-space:pre-wrap;max-height:140px;overflow-y:auto;margin-bottom:14px;">${(lesson.title + '\n\n' + lesson.text.slice(0, 1000)).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700;">Generated answers (${wordCount} words) ${boxFound ? '· pasted into box' : '· box not found'}</div>
          <div style="background:#0e0e0e;border-left:3px solid #e07b39;border-radius:6px;padding:10px;font-size:13px;color:#eee;white-space:pre-wrap;max-height:260px;overflow-y:auto;">${answers.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
          <div style="margin-top:12px;font-size:11px;color:#888;" id="__hh_fill_hint">
            ${autoSubmit ? `Auto-submitting in <b id="__hh_fill_count">${CFG.autoSubmitSec}</b>s — click Confirm to submit now, or Cancel to stop.` : 'Confirm to paste (if needed) and click Submit / Turn in. Cancel to stop.'}
          </div>
        </div>
        <div style="padding:12px 16px;background:#141414;border-top:1px solid #262626;display:flex;gap:8px;">
          <button id="__hh_fill_confirm" style="flex:1;padding:10px;border:0;border-radius:8px;background:#2e7d32;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">Confirm & Submit</button>
          <button id="__hh_fill_manual" style="flex:0 0 auto;padding:10px 16px;border:0;border-radius:8px;background:#333;color:#ddd;font-weight:600;font-size:13px;cursor:pointer;">Copy Only</button>
          <button id="__hh_fill_cancel" style="flex:0 0 auto;padding:10px 16px;border:0;border-radius:8px;background:#5a1e1e;color:#ffd6d6;font-weight:600;font-size:13px;cursor:pointer;">Cancel</button>
        </div>
      `;
      document.body.appendChild(el);

      let resolved = false;
      let autoIv = null;
      const cleanup = (result) => {
        if (resolved) return;
        resolved = true;
        if (autoIv) clearInterval(autoIv);
        try { el.remove(); } catch {}
        resolve(result);
      };

      document.getElementById('__hh_fill_x').onclick = () => cleanup('cancel');
      document.getElementById('__hh_fill_cancel').onclick = () => cleanup('cancel');
      document.getElementById('__hh_fill_manual').onclick = () => {
        try { navigator.clipboard.writeText(answers); } catch {}
        cleanup('manual');
      };
      document.getElementById('__hh_fill_confirm').onclick = () => cleanup('confirm');

      if (autoSubmit) {
        let left = CFG.autoSubmitSec;
        const countEl = document.getElementById('__hh_fill_count');
        autoIv = setInterval(() => {
          left--;
          if (countEl) countEl.textContent = String(Math.max(left, 0));
          if (left <= 0) { clearInterval(autoIv); autoIv = null; cleanup('confirm'); }
        }, 1000);
        killHooks.push(() => { if (autoIv) { clearInterval(autoIv); autoIv = null; } });
      }
    });
  }

  async function runFillAssignment() {
    if (KILLED) return;
    if (CFG.ai.key === 'PASTE_YOUR_REAL_KEY_HERE') {
      const k = prompt('Paste your Groq API key (starts with gsk_).');
      if (k && k.trim()) { CFG.ai.key = k.trim(); saveCfg(); }
      else return;
    }

    const lesson = getPendingLesson();
    if (!lesson) { log('no stashed lesson — run Forge instead'); return; }

    S.running = true; S.busy = true; render();
    log('fill mode — generating answers for', lesson.title);

    const submissionText = document.body.innerText || '';

    let answers = '';
    try {
      answers = await generateAnswersForLesson(lesson, submissionText);
    } catch (e) {
      log('answer generation failed:', e.message);
      S.running = false; S.busy = false; render();
      return;
    }
    if (!answers) {
      log('empty answer after all attempts — check key + model in Settings');
      S.lastAnswer = 'Fill failed: model returned empty. Try Settings → Model.';
      render();
      S.running = false; S.busy = false; render();
      return;
    }
    log('answers ready —', answers.length, 'chars ·', (answers.match(/\S+/g) || []).length, 'words');

    let box = await openSubmissionBox();
    let boxFilled = false;
    if (box) {
      boxFilled = await fillSubmissionBox(box, answers);
      log(boxFilled ? 'comment box filled' : 'could not fill comment box');
    } else {
      log('no comment box found — you will need to paste manually');
    }

    const choice = await showFillPopup(lesson, answers, boxFilled);

    try { localStorage.removeItem('__hh_pending_lesson'); } catch {}

    if (choice !== 'confirm') {
      log('user chose:', choice);
      S.running = false; S.busy = false; render();
      return;
    }

    if (!boxFilled) {
      box = await openSubmissionBox();
      if (box) boxFilled = await fillSubmissionBox(box, answers);
    }

    await sleep(700);

    let submit = findSubmitButton();
    if (!submit) {
      log('no submit button found — staying on page for manual submit');
      S.lastAnswer = 'Submit button not found. Click it manually, then Start again.';
      render();
      S.running = false; S.busy = false; render();
      return;
    }

    log('clicking submit:', (submit.textContent || '').trim().slice(0, 40));
    humanClick(submit);
    await sleep(1800);

    const dialogScopes = [
      'mat-dialog-container', '[role="dialog"]', '.mat-mdc-dialog-surface',
      '.mdc-dialog', '.cdk-overlay-pane', '[class*="modal"]'
    ];
    let confirmBtn = null;
    for (const scope of dialogScopes) {
      const root = document.querySelector(scope);
      if (!root || root.offsetParent === null) continue;
      confirmBtn = [...root.querySelectorAll('button, [role="button"]')]
        .find(b => b.offsetParent !== null && !b.disabled &&
          /^(yes|confirm|ok|yes,?\s*(submit|turn in)|turn in|submit)\b/i.test((b.textContent || '').trim()));
      if (confirmBtn) break;
    }

    if (confirmBtn) {
      log('confirming dialog:', (confirmBtn.textContent || '').trim().slice(0, 40));
      humanClick(confirmBtn);
      await sleep(2200);
    } else {
      const anyConfirm = [...document.querySelectorAll('button, [role="button"]')]
        .find(b => b.offsetParent !== null && !b.disabled && !b.closest('#__hh_ui') &&
          /^(yes|confirm|ok|yes, submit|turn it in|turn in)$/i.test((b.textContent || '').trim()));
      if (anyConfirm) {
        log('confirming (fallback):', (anyConfirm.textContent || '').trim().slice(0, 40));
        humanClick(anyConfirm);
        await sleep(2200);
      }
    }

    await sleep(900);
    submit = findSubmitButton();
    if (submit && !submit.disabled && submit.offsetParent !== null) {
      log('submit still enabled — retrying click');
      humanClick(submit);
      await sleep(1800);
      const retryConfirm = [...document.querySelectorAll('button, [role="button"]')]
        .find(b => b.offsetParent !== null && !b.disabled && !b.closest('#__hh_ui') &&
          /^(yes|confirm|ok|yes, submit|turn it in|turn in)$/i.test((b.textContent || '').trim()));
      if (retryConfirm) { humanClick(retryConfirm); await sleep(2000); }
    }

    await sleep(1200);
    const stillThere = findSubmitButton();
    const submitted = !stillThere || stillThere.disabled || stillThere.offsetParent === null;

    S.running = false; S.busy = false; render();

    if (!submitted) {
      log('submit did not land — staying on this page');
      S.lastAnswer = 'Submit did not go through. Check manually, then Start again.';
      render();
      return;
    }

    log('submit confirmed — advancing');
    await sleep(randInt(2000, 4000));
    const nav = findNextAssignmentNav();
    if (nav) {
      log('→ advancing');
      humanClick(nav);
      await sleep(3000);

      const nextKind = classifyPage();
      log('next page:', nextKind);
      if (nextKind === 'lesson') { log('resuming lesson chain'); await runLessonChain(); }
      else if (nextKind === 'quiz') { log('resuming quiz auto'); await loop(); }
      else if (nextKind === 'cards') { log('resuming card driver'); await runCards(); }
      else if (nextKind === 'assignment') {
        if (hasPendingLesson() && !needsFileUpload()) { log('resuming fill mode'); await runFillAssignment(); }
        else if (window.__forge?.run) { log('resuming forge'); window.__forge.run(); }
      }
    } else {
      log('no next nav — click manually');
    }
  }

  // ---- continuous mode ----
  let __lastUrl = location.href;
  let __lastBodyLen = 0;
  let __continuous = false;
  let __continuousGuard = 0;

  async function continuousTick() {
    if (KILLED || !__continuous) return;
    if (S.running) return;
    if (__continuousGuard++ > 200) { log('continuous: guard hit, stopping'); __continuous = false; return; }

    const url = location.href;
    const bodyLen = (document.body.innerText || '').length;
    const urlChanged = url !== __lastUrl;
    const bodyChanged = Math.abs(bodyLen - __lastBodyLen) > 200;
    if (!urlChanged && !bodyChanged) return;

    __lastUrl = url;
    __lastBodyLen = bodyLen;

    await sleep(randInt(900, 2600));
    if (KILLED || !__continuous) return;
    await idlePause();
    if (KILLED || !__continuous) return;

    const kind = classifyPage();
    log('continuous → new page detected:', kind);

    if (kind === 'unknown') { log('continuous: unknown page, stopping'); __continuous = false; render(); return; }

    if (kind === 'lesson' && (findCompletionIndicator() || isAssignmentComplete())) {
      log('continuous: lesson already done, advancing');
      const nav = findNextAssignmentNav();
      if (nav) { humanClick(nav); await sleep(randInt(2200, 4000)); return; }
    }

    if (kind === 'quiz') { await loop(); return; }
    if (kind === 'cards') { await runCards(); return; }
    if (kind === 'lesson') { await runLessonChain(); return; }
    if (kind === 'assignment') {
      if (hasPendingLesson() && !needsFileUpload()) { await runFillAssignment(); return; }
      if (window.__forge?.run) {
        const t = document.querySelector('#__hh_panel .hh-tab[data-tab="forge"]');
        if (t) t.click();
        window.__forge.run();
      }
      return;
    }
  }

  function startContinuous() {
    __continuous = true;
    __continuousGuard = 0;
    __lastUrl = location.href;
    __lastBodyLen = (document.body.innerText || '').length;
    log('continuous mode ON');
    render();
  }
  function stopContinuous() {
    __continuous = false;
    log('continuous mode OFF');
    render();
  }

  // ---- smart start ----
  async function startSmart() {
    if (KILLED) return;
    if (S.running || __continuous) { stop(); stopContinuous(); return; }

    if (CFG.ai.key === 'PASTE_YOUR_REAL_KEY_HERE' && classifyPage() === 'assignment') {
      const k = prompt('Paste your Groq API key (starts with gsk_). It will be saved.');
      if (k && k.trim()) { CFG.ai.key = k.trim(); saveCfg(); log('key saved'); }
    }

    startContinuous();

    const kind = classifyPage();
    log('startSmart →', kind);

    if (kind === 'quiz') { log('quiz — auto'); loop(); return; }
    if (kind === 'cards') { log('flashcards — card driver'); await runCards(); return; }
    if (kind === 'lesson') { log('lesson — AFK chain'); await runLessonChain(); return; }
    if (kind === 'assignment') {
      if (hasPendingLesson() && !needsFileUpload()) {
        log('fill mode — answering stashed questions');
        await runFillAssignment();
        return;
      }
      log('assignment — forge');
      if (window.__forge?.run) {
        const t = document.querySelector('#__hh_panel .hh-tab[data-tab="forge"]');
        if (t) t.click();
        window.__forge.run();
      } else {
        S.lastAnswer = 'Forge not loaded. Wait 2s and retry.';
        render();
      }
      return;
    }
    log('unknown page — nothing to do');
    S.lastAnswer = 'Unknown page. Nothing to run.';
    render();
  }

  // ---- chat ----
  async function sendChat(text) {
    if (KILLED || !text.trim()) return;
    S.chat.push({ role: 'user', content: text });
    render();
    const id = 'msg-' + Date.now();
    S.chat.push({ role: 'assistant', content: '', id, streaming: true });
    render();
    try {
      await groqCall(
        [
          { role: 'system', content: 'You are Homework Helper. Direct, sharp, no filler. Answer the question actually asked.' },
          ...S.chat.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content }))
        ],
        {
          stream: true, maxTokens: 900,
          onDelta: d => {
            if (KILLED) return;
            const m = S.chat.find(x => x.id === id);
            if (m) { m.content += d; renderChat(); }
          }
        }
      );
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
      <div id="${PID}" style="
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        width: 320px; background: #1a1a1a; color: #f0f0f0;
        border: 1px solid #e07b39; border-radius: 10px;
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.5); overflow: hidden;">

        <div id="${PID}_hdr" style="
          background:#e07b39;color:#1a1a1a;padding:8px 12px;font-weight:700;
          display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;">
          <span>Homework Helper</span>
          <span id="${PID}_x" style="cursor:pointer;font-size:16px;line-height:1">×</span>
        </div>

        <div id="${PID}_tabs" style="display:flex;background:#141414;border-bottom:1px solid #262626;padding:4px 6px 0;gap:2px;">
          <button class="hh-tab" data-tab="auto" style="flex:1;background:#1a1a1a;border:0;color:#e07b39;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:600;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid #e07b39;">Auto</button>
          <button class="hh-tab" data-tab="ask" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">Ask</button>
          <button class="hh-tab" data-tab="forge" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">Forge</button>
          <button class="hh-tab" data-tab="hist" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">History</button>
          <button class="hh-tab" data-tab="cfg" style="flex:1;background:transparent;border:0;color:#8a8a8a;padding:7px 6px;cursor:pointer;font-size:11px;font-weight:500;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom:2px solid transparent;">Settings</button>
        </div>

        <div style="padding:10px 12px;max-height:440px;overflow-y:auto;">

          <div class="hh-view" data-view="auto">
            <div style="display:flex;gap:6px;margin-bottom:8px">
              <button id="${PID}_toggle" style="flex:1;padding:6px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;font-size:12px">Start</button>
              <button id="${PID}_skip" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Skip</button>
              <button id="${PID}_explain" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Explain</button>
            </div>
            <div style="font-size:11px;color:#aaa;margin-bottom:4px">Status: <span id="${PID}_status" style="color:#4caf50">idle</span> · Processed: <span id="${PID}_count">0</span> · Req: <span id="${PID}_req">0</span></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:2px">Last Q: <span id="${PID}_lq" style="color:#ddd">—</span></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:6px;word-break:break-word">Last A: <span id="${PID}_la" style="color:#4caf50">—</span></div>
            <div id="${PID}_log" style="max-height:120px;overflow:auto;background:#0e0e0e;border-radius:6px;padding:6px;font:11px/1.4 ui-monospace,Menlo,monospace;color:#9ccc65;white-space:pre-wrap"></div>
          </div>

          <div class="hh-view" data-view="ask" style="display:none">
            <div id="${PID}_chat" style="display:flex;flex-direction:column;gap:6px;padding-bottom:6px;max-height:300px;overflow-y:auto"></div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <textarea id="${PID}_chatIn" placeholder="Ask anything… Enter to send" style="flex:1;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;resize:none;height:40px"></textarea>
              <button id="${PID}_chatSend" style="padding:6px 10px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;font-size:12px">Send</button>
            </div>
          </div>

          <div class="hh-view" data-view="forge" style="display:none">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Assignment type (blank = auto)</div>
            <select id="${PID}_fType" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
              <option value="">Auto-detect</option>
              <option value="written">Written (prose)</option>
              <option value="presentation">Presentation / slides</option>
              <option value="canva">Canva / visual design</option>
              <option value="flashcards">Flashcards</option>
              <option value="video">Video script</option>
              <option value="walkthrough">Website walkthrough</option>
            </select>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Project context (saved)</div>
            <textarea id="${PID}_fCtx" placeholder="One line about your project." style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px;resize:vertical;height:50px"></textarea>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Voice sample (saved)</div>
            <textarea id="${PID}_fStyle" placeholder="Paste a paragraph you wrote." style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px;resize:vertical;height:60px"></textarea>
            <div style="display:flex;gap:6px;margin-bottom:8px">
              <button id="${PID}_fGo" style="flex:1;padding:6px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-weight:600;cursor:pointer;font-size:12px">Forge</button>
              <button id="${PID}_fCopy" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">Copy All</button>
              <button id="${PID}_fDl" style="padding:6px 10px;border:0;border-radius:6px;background:#333;color:#ddd;cursor:pointer;font-size:12px">.txt</button>
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
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Quiz answers</div>
            <div id="${PID}_hQuiz" style="display:flex;flex-direction:column;gap:5px;max-height:140px;overflow-y:auto"></div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 3px;font-weight:700">Forge runs</div>
            <div id="${PID}_hForge" style="display:flex;flex-direction:column;gap:5px;max-height:140px;overflow-y:auto"></div>
          </div>

          <div class="hh-view" data-view="cfg" style="display:none">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Model</div>
            <input id="${PID}_m" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">API key</div>
            <input id="${PID}_k" type="password" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-weight:700">Temperature <span id="${PID}_tv" style="color:#e07b39"></span></div>
            <input id="${PID}_t" type="range" min="0" max="1" step="0.05" style="width:100%;accent-color:#e07b39">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 3px;font-weight:700">Auto-submit timer (0 = off)</div>
            <input id="${PID}_auto" type="number" min="0" max="120" style="width:100%;background:#0e0e0e;color:#eee;border:1px solid #2a2a2a;border-radius:6px;padding:6px 9px;font:inherit;font-size:11px;margin-bottom:6px">
            <div style="font-size:10px;color:#666;margin-top:4px;line-height:1.5">If set, the fill popup auto-confirms after N seconds. 0 = wait for you.</div>
            <div style="font-size:10px;color:#666;margin-top:8px;text-align:center">Ctrl+Shift+H toggle · × closes & tears down</div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;padding:5px 12px;font:10px ui-monospace,monospace;color:#555;background:#0a0a0a;border-top:1px solid #1a1a1a">
          <span id="${PID}_fModel">—</span>
          <span id="${PID}_fTok">0 / 0</span>
        </div>
      </div>
    `;
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
      if (KILLED || !S.lastQuestion || S.lastQuestion === '—') { log('no current question'); return; }
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
      const blob = new Blob([JSON.stringify({ quiz: S.history, forge: window.__forge?.F?.history || [] }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'helper-history-' + Date.now() + '.json';
      a.click();
    };
    $('_hClear').onclick = () => {
      S.history = [];
      if (window.__forge?.F) window.__forge.F.history = [];
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
    try { for (const h of killHooks) { try { h(); } catch {} } } catch {}
    try { window.__helperKillHooks = []; } catch {}
    try { if (window.__helperForgeBoot) { clearInterval(window.__helperForgeBoot); window.__helperForgeBoot = null; } } catch {}
    try { document.getElementById(UI_ID)?.remove(); } catch {}
    try { document.getElementById('__hh_fill_popup')?.remove(); } catch {}
    try { if (window.__forge) delete window.__forge; } catch {}
    try { delete window.__cinder; } catch {}
    console.log('%c[hw-helper] closed — paste the loader again to reload.', 'color:#e07b39;font-weight:bold');
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderLog() {
    const el = $('_log');
    if (!el) return;
    el.innerHTML = S.log.slice(-30).map(l => {
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
            `<div style="background:#0e0e0e;border-radius:6px;padding:6px 8px;font-size:11px;border-left:2px solid #e07b39;color:#ccc"><b style="color:#e07b39">${esc(h.pickedText.join(' | ').slice(0, 90))}</b></div>`
          ).join('')
        : '<div style="background:#0e0e0e;border-radius:6px;padding:6px 8px;font-size:11px;color:#666">none yet</div>';
    }
    const f = $('_hForge');
    if (f) {
      const H = window.__forge?.F?.history || [];
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
    groqCall, groqJson,
    isKilled: () => KILLED,
    PID
  };

  ensureUI();
  log('helper ready · ' + CFG.ai.model);

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

  if (CFG.autoStart) loop();
})();

// ============================================================
// FORGE
// ============================================================
(() => {
  'use strict';

  const PID = '__hh_panel';
  let DEAD = false;
  const C = window.__cinder;
  const isDead = () => DEAD || !C || C.isKilled();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => { if (!isDead()) C.log('[forge]', ...a); };
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
    saveProject(v) { this.project = v; localStorage.setItem(LS_CTX, v); },
    saveStyle(v) { this.style = v; localStorage.setItem(LS_STY, v); },
    saveType(v) { this.typeOverride = v; localStorage.setItem(LS_TYP, v); }
  };

  const F = {
    running: false, title: '', deliverables: [], scrapedSteps: [],
    history: (() => { try { return JSON.parse(localStorage.getItem(LS_HIS) || '[]'); } catch { return []; } })()
  };

  const cleanText = t => String(t).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

  function detectType(text) {
    const t = (text || '').toLowerCase();
    if (/\bcanva\.com\b/i.test(t) || /\buse\s+canva\b/i.test(t) || /\bopen\s+canva\b/i.test(t) || /\bcreate.*?\bin\s+canva\b/i.test(t) || /\bcanva\s+(template|design|slide)/i.test(t)) return 'canva';
    if (/\b(slide|slides|presentation|powerpoint|google slides|deck)\b/.test(t)) return 'presentation';
    if (/\b(flashcard|flash card|quizlet|anki|term and definition|vocab card)\b/.test(t)) return 'flashcards';
    if (/\b(record a video|loom|screencastify|voiceover|voice over|narrate)\b/.test(t)) return 'video';
    if (/\b(go to|visit|navigate to|sign up at|log in to|create an account on)\b/.test(t) && /https?:\/\/|\.com|\.org|\.net/.test(t)) return 'walkthrough';
    return 'written';
  }

  const TYPE_INSTRUCTIONS = {
    written: `OUTPUT SHAPE: Flowing prose. Multiple paragraphs okay. Tight, 60–120 words per deliverable unless a length is specified. No bullets unless the step itself is a list prompt.`,
    presentation: `OUTPUT SHAPE: Slide-by-slide. For each deliverable:
Slide 1: <title>
- bullet
- bullet
Speaker notes: one sentence of what to say

Slide 2: <title>
...
Aim for 5–8 slides per deliverable unless the step specifies a count. Keep bullets under 12 words each.`,
    canva: `OUTPUT SHAPE: Numbered build steps for Canva. For each deliverable:
1. Open Canva → search "<template type>" → pick a clean template.
2. Title slide text: "<exact text>"
3. Slide 2: <what goes on it, exact text to type>
4. Element to add: <icon/photo/graphic idea>
5. Color scheme: <suggest 2–3 colors>
Give exact text the student types into each element.`,
    flashcards: `OUTPUT SHAPE: Numbered term/definition pairs. For each deliverable:
1. Term: "<term>"
   Definition: "<one-sentence plain-language definition>"
2. Term: "<term>"
   Definition: "<one-sentence plain-language definition>"
Give 8–15 cards per deliverable unless the step specifies a count. Definitions must be one sentence, no jargon.`,
    video: `OUTPUT SHAPE: Script. For each deliverable:
[0:00] <what to say, word for word>
[0:15] <next beat>
Include what to show on screen next to each beat. Aim for 1–2 minutes of script per deliverable.`,
    walkthrough: `OUTPUT SHAPE: Numbered navigation steps. For each deliverable:
1. Go to <url or site name>.
2. Click "<exact button label>".
3. Enter <what to type>.
4. On the next page, click "<exact label>".
Include exact button names and URLs. If an account is required, note it. Keep each step one action.`
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

  async function scrapeAllSteps() {
    const tabs = findStepTabs();
    log('found', tabs.length, 'step tabs');
    const out = [];
    if (!tabs.length) {
      out.push({ label: 'Page', content: cleanText(document.body.innerText) });
      return out;
    }
    const snap = () => cleanText(document.body.innerText);
    let prev = snap();
    const activeNow = tabs.find(t =>
      /active|selected/i.test(t.className) ||
      t.getAttribute('aria-selected') === 'true' ||
      t.classList.contains('mdc-tab--active')
    ) || tabs[0];

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
      out.push({ label, content });
      log('scraped:', label, content.length, 'chars');
      prev = now;
    }
    activeNow.click();
    await sleep(300);
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

  function buildPrompt(steps, ctx, style, fields, type) {
    const stepBlob = steps.map(s => `### ${s.label}\n${s.content.slice(0, 1800)}`).join('\n\n');

    let pendingBlock = '';
    try {
      const raw = localStorage.getItem('__hh_pending_lesson');
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.ts && (Date.now() - p.ts) < 30 * 60 * 1000) {
          pendingBlock = `\n\nPRIOR LESSON CONTEXT (the questions on this page refer back to this — use it as source material):\n"""\n${p.title}\n---\n${p.text.slice(0, 2500)}\n"""\n`;
          localStorage.removeItem('__hh_pending_lesson');
          log('using stashed lesson context:', p.title);
        }
      }
    } catch {}

    const ctxBlock = ctx && ctx.trim()
      ? `\n\nSTUDENT'S PROJECT — every deliverable is about THIS:\n"""\n${ctx.trim().slice(0, 1200)}\n"""`
      : `\n\nNO PROJECT CONTEXT. If any step mentions "your project", "your AI", "your proposal", output exactly "[NEED PROJECT CONTEXT — paste in Forge tab]" for that deliverable. Do NOT invent.`;
    const styleBlock = style && style.trim()
      ? `\n\nSTUDENT'S VOICE SAMPLE (match this exactly):\n"""\n${style.trim().slice(0, 1400)}\n"""`
      : '';
    const fieldsBlock = fields.length
      ? `\n\nEXISTING TEXT ON PAGE:\n` + fields.map((f, i) => `[field ${i + 1}${f.hint ? ' — ' + f.hint : ''}]\n${f.value}`).join('\n\n')
      : '';

    return `Respond with a single JSON object and nothing else. First char must be {, last must be }.

You are a real 11th grade student completing a class assignment. Output is pasted verbatim into a submission box. You write like a normal high schooler — not an adult, not a chatbot, not a resume.

=== STRUCTURE ===
Steps in order: ${steps.map(s => s.label).join(' | ')}
Produce ONE deliverable per step, same order.
Skip steps labeled "Overview" or "Introduction" if they only describe the assignment — those are navigation, not asks.
If a step's content is under 80 chars, write "[no content scraped]" — do NOT invent.
Label each deliverable EXACTLY as the step label.
Only merge steps whose labels are literally identical.

=== OUTPUT SHAPE ===
Assignment type: ${type}
${TYPE_INSTRUCTIONS[type] || TYPE_INSTRUCTIONS.written}

=== CONTENT ===
Imagine the reader is holding the finished document. They see the section heading. They want to read what's UNDER that heading.
Write that content.

Do not reference the document. Do not name the section. Do not say "the template," "the introduction," "the proposal," "this section," "the document," or any variation.
Do not describe what the section does, contains, or explains.
Do not open with "The [section name]..." or "This section..." or "My [document part]..."
Do not close with reflective lines about what the section accomplishes ("By stating these limits...", "This helps readers understand...", "This balance shows...").

Start with the actual first sentence of content. End on the actual point.
The label tells you where it goes. Do not write the label into the answer.
Every deliverable references the student's project by actual name or clear descriptor.
If a step has sub-questions, answer each inside that deliverable, in order.
If the assignment step itself says "in this section include X, Y, Z," write X, Y, Z as real sentences. Do not describe including them.
Also ban reflective meta-tails at the end of a deliverable: "By stating these limits...", "Readers will see...", "This helps the project...". End on the actual point.

=== EXAMPLES (this is the most important rule) ===
If the assignment asks for personal examples, use things a real high schooler actually touches every day. Spotify playlists. YouTube. TikTok. Instagram. Google Docs. Notes app. Phone camera roll. School email. A school Chromebook. A shared Google Slides deck. Classroom assignments. Discord.
Do NOT invent jobs, companies, paid work, sales figures, corporate datasets, APIs you built, professional projects, or anything that sounds like an adult at a tech company.
Do NOT stack 5-6 examples just to fill space. 2-3 short ones then answer the question.
When in doubt, use generic terms ("a playlist app", "a school spreadsheet") rather than specific and made-up.

=== LENGTH ===
If any step or prompt includes a length requirement (e.g. "100 words", "3-5 sentences", "at least 200 words"), obey it EXACTLY. Match the count. Do not fall short.
If no length is specified, keep each deliverable to 60-120 words.

=== VOICE ===
10th grade reading level. Plain words. Short sentences.
Contractions: I'm, it's, doesn't, can't, won't.
One idea per sentence. No sentence over 20 words unless it needs to be.
Say "it", "my project", "my AI" — NEVER "the system", "the platform", "the AI application".
No semicolons. No markdown headers. No **bold**. Plain prose.
Bullets only if the step itself is a list prompt.
Ban: furthermore, moreover, additionally, in conclusion, plays a crucial role, leverages, facilitates, underscores, optimal, robust.
Don't start two sentences the same way.

=== ASSIGNMENT CONTENT ===
${stepBlob}${pendingBlock}${ctxBlock}${styleBlock}${fieldsBlock}

Schema:
{
  "assignment_title": "<inferred>",
  "deliverables": [
    { "label": "<exact step label>", "answer": "<per length rule>" }
  ]
}
JSON only. No backticks. No commentary.`;
  }

  function parse(raw) {
    let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in reply');
    const o = JSON.parse(m[0]);
    if (!Array.isArray(o.deliverables)) throw new Error('no deliverables');
    return o;
  }

  async function cleanDeliverables(deliverables) {
    if (!deliverables.length) return deliverables;
    const list = deliverables.map((d, i) => `[${i}]\n${d.answer}`).join('\n\n---\n\n');
    const prompt = `Rewrite each numbered passage below so it contains ONLY the actual content — no references to any document, section, template, or introduction.

Rules:
- Delete any sentence that names a section, document, or template.
- Delete any opening that describes the passage.
- Delete any closing that describes the passage's effect.
- If any passage invents a fake adult experience (jobs, companies, paid work, datasets, corporate projects), replace with something a real high schooler would have (apps, school stuff, phone stuff). Keep it short.
- Keep every concrete fact, task, weakness, mitigation, and example.
- Keep first-person voice, plain language, contractions.
- Preserve the word count as closely as possible.
- If a passage is already clean, return it unchanged.

Schema — return STRICT JSON only:
{ "items": ["<rewritten passage 0>", "<rewritten passage 1>", ...] }

Passages:
${list}`;
    try {
      const raw = await C.groqJson(prompt, 5000);
      let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) return deliverables;
      const o = JSON.parse(m[0]);
      if (!Array.isArray(o.items) || o.items.length !== deliverables.length) return deliverables;
      return deliverables.map((d, i) => ({ ...d, answer: String(o.items[i] || d.answer).trim() }));
    } catch (e) {
      log('cleanup pass failed — using raw output:', e.message);
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
      const fields = findEditableFields();
      const allText = steps.map(s => s.content).join('\n');
      const detectedType = Ctx.typeOverride || detectType(allText);
      log('assignment type:', detectedType);
      const prompt = buildPrompt(steps, Ctx.project, Ctx.style, fields, detectedType);
      log('prompt', prompt.length, 'chars →', C.CFG.ai.model);
      const raw = await C.groqJson(prompt, 5000);
      if (isDead()) return;
      const parsed = parse(raw);
      F.title = parsed.assignment_title || document.title || 'Assignment';
      F.deliverables = parsed.deliverables;
      if (detectedType === 'written') {
        log('cleanup pass — stripping meta-narration + fake examples');
        F.deliverables = await cleanDeliverables(F.deliverables);
        if (isDead()) return;
      }
      F.history.unshift({ ts: Date.now(), title: F.title, steps: steps.length, deliverables: F.deliverables });
      F.history = F.history.slice(0, 30);
      try { localStorage.setItem(LS_HIS, JSON.stringify(F.history)); } catch {}
      log('forged', F.deliverables.length, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      if (isDead() || e.message === 'killed') return;
      log('forge failed:', e.message);
      F.deliverables = [{ label: 'Error', answer: 'Forge failed: ' + e.message }];
    } finally {
      F.running = false;
      if (!isDead()) renderForge();
    }
  }

  function inject() {
    if (isDead()) return;
    const tabsBar = $('_tabs');
    if (!tabsBar || tabsBar.dataset.forgeBound) return;
    tabsBar.dataset.forgeBound = '1';
    const btn = tabsBar.querySelector('[data-tab="forge"]');
    if (btn) btn.addEventListener('click', () => { if (!isDead()) renderForge(); });

    const ty = $('_fType');
    if (ty) { ty.value = Ctx.typeOverride || ''; ty.onchange = () => { Ctx.saveType(ty.value); }; }
    const ctx = $('_fCtx'); if (ctx) { ctx.value = Ctx.project; ctx.oninput = () => Ctx.saveProject(ctx.value); }
    const sty = $('_fStyle'); if (sty) { sty.value = Ctx.style; sty.oninput = () => Ctx.saveStyle(sty.value); }
    const go = $('_fGo'); if (go) go.onclick = forge;
    const cp = $('_fCopy'); if (cp) cp.onclick = copyAll;
    const dl = $('_fDl'); if (dl) dl.onclick = downloadTxt;

    renderForge();
  }

  function renderForge() {
    if (isDead()) return;
    const st = $('_fStatus');
    if (st) st.textContent = F.running
      ? 'forging… scraping + calling model'
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
        navigator.clipboard.writeText(F.deliverables[+b.dataset.copy].answer);
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
    navigator.clipboard.writeText(bundle());
    const b = $('_fCopy'); if (b) { b.textContent = '✓'; setTimeout(() => b.textContent = 'Copy All', 900); }
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
      log('forge ready.');
    } else if (Date.now() - start > 15000) {
      clearInterval(window.__helperForgeBoot);
      window.__helperForgeBoot = null;
    }
  }, 250);

  window.__forge = { run: forge, F, scrape: scrapeAllSteps };
})();
