// language: JavaScript, file: cinder.js, runtime: browser console on Buzz Angular
// Homework Helper — core (auto-answer + chat + history + settings) + forge (classwork).
// Groq backend. Loads as one file. Core runs first, forge waits for it.

// ============================================================
// CORE
// ============================================================
(() => {
  'use strict';

  const CFG = {
    ai: {
      key: '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',
      model: 'openai/gpt-oss-120b',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      temperature: 0.2,
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
    explain: true,
    sound: true
  };

  const rand = (a, b) => Math.random() * (b - a) + a;
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const log = (...a) => console.log('%c[helper]', 'color:#e07b39;font-weight:bold', ...a);

  const S = {
    tab: 'auto', running: false, busy: false, processed: 0,
    lastAnswer: '—', lastQuestion: '—',
    log: [], history: [], chat: [],
    tokensIn: 0, tokensOut: 0, requests: 0,
    minimized: false, currentQ: null, currentChoices: [], beep: null
  };

  function ensureAudio() {
    if (S.beep) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      S.beep = () => {
        if (!CFG.sound) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.06, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
        o.start(); o.stop(ctx.currentTime + 0.13);
      };
    } catch {}
  }

  // ---- DOM scrape ----
  function getQuestionBlocks() {
    return [...document.querySelectorAll('lib-question')].filter(b => b.offsetParent !== null);
  }
  function getChoices(block) {
    return [...block.querySelectorAll('input.mdc-radio__native-control, input.mdc-checkbox__native-control')];
  }
  function clickTargetFor(input) {
    return input.closest('label.mdc-form-field') || input.closest('label')
        || input.closest('mat-radio-button, mat-checkbox') || input;
  }
  function getQuestionText(block) {
    const body = block.querySelector('lib-managed-html, .question-body');
    return (body?.textContent || block.textContent || '').replace(/\s+/g, ' ').trim();
  }
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
      const cells = [...tr.querySelectorAll('td')].filter(td =>
        !td.classList.contains('choice-input') && !td.contains(input)
      );
      const t = cells.map(td => td.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const wrap = input.closest('mat-radio-button, mat-checkbox') || input.closest('label')?.parentElement;
    return (wrap?.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function isMultiSelect(block) {
    return !!block.querySelector('input.mdc-checkbox__native-control');
  }
  function humanClick(el) {
    if (!el) return;
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

  // ---- Groq ----
  async function groqChat(messages, opts = {}) {
    const stream = !!opts.stream;
    const onDelta = opts.onDelta || (() => {});
    const body = {
      model: CFG.ai.model, messages,
      temperature: opts.temperature ?? CFG.ai.temperature,
      max_tokens: opts.maxTokens ?? CFG.ai.maxTokens,
      stream
    };
    const res = await fetch(CFG.ai.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.ai.key },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('groq ' + res.status + ' ' + t.slice(0, 200));
    }
    S.requests++;
    if (!stream) {
      const j = await res.json();
      if (j.usage) {
        S.tokensIn += j.usage.prompt_tokens || 0;
        S.tokensOut += j.usage.completion_tokens || 0;
      }
      return j.choices?.[0]?.message?.content || '';
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
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

  function buildAutoPrompt(question, choices, multi) {
    const list = choices.map((c, i) => `${i + 1}. ${getChoiceText(c)}`).join('\n');
    const inst = multi
      ? 'Select ALL correct answers. Reply ONLY with a JSON object: {"picks":[1,3],"why":"one short sentence"}. No prose.'
      : 'Select the single correct answer. Reply ONLY with a JSON object: {"picks":[2],"why":"one short sentence"}. No prose.';
    return `You are answering a multiple-choice test question. Use your knowledge. Do not hedge. ${inst}

Question: ${question}

Choices:
${list}

Reply with JSON only.`;
  }
  function parseAutoReply(raw, max) {
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

  // ---- auto loop ----
  async function processQuestion(block) {
    const choices = getChoices(block);
    if (!choices.length) return true;
    const q = getQuestionText(block);
    const multi = isMultiSelect(block);
    S.lastQuestion = q.slice(0, 80);
    S.currentQ = q;
    S.currentChoices = choices.map(getChoiceText);
    render();
    await sleep(randInt(CFG.timing.minThinkMs, CFG.timing.maxThinkMs));

    const prompt = buildAutoPrompt(q, choices, multi);
    let raw, parsed;
    try {
      raw = await groqChat([{ role: 'user', content: prompt }]);
      parsed = parseAutoReply(raw, choices.length);
      if (!parsed.picks.length) throw new Error('no pick parsed: ' + String(raw).slice(0, 120));
    } catch (e) {
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
      if (!S.running) return false;
      await sleep(randInt(CFG.timing.minMoveMs, CFG.timing.maxMoveMs));
      if (!CFG.dryRun) humanClick(clickTargetFor(picked[p]));
      log(`picked: ${getChoiceText(picked[p]).slice(0, 60)}`);
      if (p < picked.length - 1) {
        await sleep(randInt(CFG.timing.minBetweenChoicesMs, CFG.timing.maxBetweenChoicesMs));
      }
    }

    let why = parsed.why || '';
    if (CFG.explain && !why) {
      try {
        why = (await groqChat([
          { role: 'user', content: `In one short sentence, why is "${picked.map(getChoiceText).join(' / ')}" the correct answer to: "${q.slice(0, 300)}"?` }
        ], { maxTokens: 80 })).trim();
      } catch {}
    }

    S.history.push({
      ts: Date.now(), q: q.slice(0, 300),
      choices: S.currentChoices, picked: parsed.picks,
      pickedText: picked.map(getChoiceText), why
    });
    if (S.history.length > 500) S.history.shift();
    S.beep?.();
    S.processed++;
    render();
    return true;
  }

  function findNextButton() {
    return [...document.querySelectorAll('button.mdc-button--raised, button')].find(b =>
      b.offsetParent !== null && !b.disabled && /^\s*next\s*$/i.test((b.textContent || '').trim())
    ) || null;
  }
  function findReviewButton() {
    return [...document.querySelectorAll('button')].find(b =>
      b.offsetParent !== null && /^\s*review\s*$/i.test((b.textContent || '').trim())
    ) || null;
  }
  async function clickNext() {
    const btn = findNextButton();
    if (!btn) return findReviewButton() ? 'review' : null;
    await sleep(randInt(CFG.timing.nextDelayMinMs, CFG.timing.nextDelayMaxMs));
    if (!CFG.dryRun) humanClick(btn);
    log('→ next');
    return 'next';
  }

  async function loop() {
    if (S.busy) return;
    S.busy = true; S.running = true; render();
    log('auto loop started');
    let guard = 0;
    while (S.running && guard++ < 500) {
      const blocks = getQuestionBlocks();
      if (!blocks.length) { log('no quiz questions left'); break; }
      for (const b of blocks) {
        if (!S.running) break;
        const ok = await processQuestion(b);
        if (!ok) { log('aborting after failure'); S.running = false; break; }
      }
      if (!S.running) break;
      const r = await clickNext();
      if (r !== 'next') { log('halt:', r || 'no next'); break; }
      await sleep(randInt(900, 2000));
    }
    S.running = false; S.busy = false; render();
    log('auto loop stopped');
  }

  function stop() { S.running = false; render(); }

  // ---- smart start: auto-route quiz vs forge ----
  function startSmart() {
    ensureAudio();
    if (S.running) { stop(); return; }
    const quizBlocks = getQuestionBlocks();
    if (quizBlocks.length) {
      log(`found ${quizBlocks.length} quiz question(s) — running auto`);
      loop();
      return;
    }
    log('no quiz questions on this page — running Forge');
    if (window.__forge && typeof window.__forge.run === 'function') {
      // switch to forge tab visually
      const forgeTab = document.querySelector('#' + PID + ' .c-tab[data-tab="forge"]');
      if (forgeTab) forgeTab.click();
      window.__forge.run();
    } else {
      log('forge module not loaded — reload the page and try again');
      S.lastAnswer = 'No quiz on this page, and Forge is not loaded. Paste the loader again.';
      render();
    }
  }

  // ---- chat ----
  async function sendChat(text) {
    if (!text.trim()) return;
    S.chat.push({ role: 'user', content: text });
    render();
    const id = 'msg-' + Date.now();
    S.chat.push({ role: 'assistant', content: '', id, streaming: true });
    render();

    try {
      await groqChat(
        [
          { role: 'system', content: 'You are Homework Helper — direct, sharp, no filler. Answer the question actually asked. For test questions: give the answer and one short reason.' },
          ...S.chat.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content }))
        ],
        {
          stream: true, maxTokens: 800,
          onDelta: (d) => {
            const m = S.chat.find(x => x.id === id);
            if (m) { m.content += d; renderChat(); }
          }
        }
      );
    } catch (e) {
      const m = S.chat.find(x => x.id === id);
      if (m) m.content = 'Error: ' + e.message;
    }
    const m = S.chat.find(x => x.id === id);
    if (m) m.streaming = false;
    render();
  }

  // ---- UI ----
  const ID = '__helper_ui';
  const PID = '__helper_panel';

  function buildSkeleton() {
    return [
      '<div id="' + PID + '" class="h-panel">',
      '  <div class="h-hdr" id="' + PID + '_hdr">',
      '    <span class="h-title">◆ Homework Helper</span>',
      '    <div class="h-hdr-btns">',
      '      <button class="h-icon" id="' + PID + '_min" title="Minimize">–</button>',
      '      <button class="h-icon" id="' + PID + '_close" title="Close">×</button>',
      '    </div>',
      '  </div>',
      '  <div class="h-tabs" id="' + PID + '_tabs">',
      '    <button data-tab="auto" class="h-tab h-tab-active">Auto</button>',
      '    <button data-tab="ask" class="h-tab">Ask</button>',
      '    <button data-tab="history" class="h-tab">History</button>',
      '    <button data-tab="settings" class="h-tab">Settings</button>',
      '  </div>',
      '  <div class="h-body" id="' + PID + '_body">',
      '    <div class="h-view" data-view="auto">',
      '      <div class="h-row">',
      '        <button class="h-btn h-btn-primary" id="' + PID + '_toggle">Start</button>',
      '        <button class="h-btn h-btn-ghost" id="' + PID + '_skip">Skip Q</button>',
      '        <button class="h-btn h-btn-ghost" id="' + PID + '_explainNow">Explain</button>',
      '      </div>',
      '      <div class="h-status">',
      '        <span class="h-pill" id="' + PID + '_status">idle</span>',
      '        <span class="h-meta">Processed <b id="' + PID + '_count">0</b></span>',
      '        <span class="h-meta">Req <b id="' + PID + '_req">0</b></span>',
      '      </div>',
      '      <div class="h-progress"><div class="h-progress-bar" id="' + PID + '_prog"></div></div>',
      '      <div class="h-label">Current</div>',
      '      <div class="h-q" id="' + PID + '_lq">—</div>',
      '      <div class="h-label">Answer</div>',
      '      <div class="h-a" id="' + PID + '_la">—</div>',
      '      <div class="h-label">Log</div>',
      '      <div class="h-log" id="' + PID + '_log"></div>',
      '    </div>',
      '    <div class="h-view" data-view="ask" style="display:none">',
      '      <div class="h-chat" id="' + PID + '_chat"></div>',
      '      <div class="h-chat-input">',
      '        <textarea id="' + PID + '_chatInput" placeholder="Ask anything… (Enter to send, Shift+Enter newline)"></textarea>',
      '        <button class="h-btn h-btn-primary" id="' + PID + '_chatSend">Send</button>',
      '      </div>',
      '    </div>',
      '    <div class="h-view" data-view="history" style="display:none">',
      '      <div class="h-row">',
      '        <button class="h-btn h-btn-ghost" id="' + PID + '_export">Export JSON</button>',
      '        <button class="h-btn h-btn-ghost" id="' + PID + '_clearHist">Clear</button>',
      '      </div>',
      '      <div class="h-hist" id="' + PID + '_hist"></div>',
      '    </div>',
      '    <div class="h-view" data-view="settings" style="display:none">',
      '      <div class="h-label">Model</div>',
      '      <input class="h-input" id="' + PID + '_model">',
      '      <div class="h-label">API key</div>',
      '      <input class="h-input" id="' + PID + '_key" type="password">',
      '      <div class="h-label">Temperature <b id="' + PID + '_tempv">0.2</b></div>',
      '      <input class="h-range" id="' + PID + '_temp" type="range" min="0" max="1" step="0.05">',
      '      <div class="h-row">',
      '        <label class="h-check"><input type="checkbox" id="' + PID + '_dry"> Dry run</label>',
      '        <label class="h-check"><input type="checkbox" id="' + PID + '_sound"> Sound</label>',
      '        <label class="h-check"><input type="checkbox" id="' + PID + '_expl"> Explain</label>',
      '      </div>',
      '      <div class="h-help">Hotkey: Ctrl+Shift+H toggles panel</div>',
      '    </div>',
      '  </div>',
      '  <div class="h-foot" id="' + PID + '_foot">',
      '    <span id="' + PID + '_footModel">—</span>',
      '    <span id="' + PID + '_footTok">0 / 0</span>',
      '  </div>',
      '</div>'
    ].join('\n');
  }

  const CSS = `
    #${PID} {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      width: 340px; background: #121212; color: #eee;
      border: 1px solid #2a2a2a; border-radius: 12px;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 12px 40px rgba(0,0,0,.6); overflow: hidden;
    }
    #${PID} * { box-sizing: border-box; }
    #${PID}.h-min { width: 240px; }
    #${PID}.h-min .h-tabs, #${PID}.h-min .h-body, #${PID}.h-min .h-foot { display: none; }

    #${PID} .h-hdr {
      background: linear-gradient(135deg, #e07b39, #b35a1f);
      color: #1a1a1a; padding: 11px 14px;
      display: flex; justify-content: space-between; align-items: center;
      cursor: move; user-select: none; font-weight: 700;
    }
    #${PID} .h-title { letter-spacing: .3px; font-size: 13px; }
    #${PID} .h-hdr-btns { display: flex; gap: 4px; }
    #${PID} .h-icon {
      background: rgba(0,0,0,.15); border: 0; color: #1a1a1a;
      width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
      font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center;
    }
    #${PID} .h-icon:hover { background: rgba(0,0,0,.3); }

    #${PID} .h-tabs {
      display: flex; background: #161616;
      border-bottom: 1px solid #262626;
      padding: 4px 6px 0;
      gap: 2px;
    }
    #${PID} .h-tab {
      flex: 1; background: transparent; border: 0; color: #8a8a8a;
      padding: 9px 8px; cursor: pointer; font-size: 12px; font-weight: 500;
      border-top-left-radius: 8px; border-top-right-radius: 8px;
      border-bottom: 2px solid transparent;
      transition: color .15s, background .15s, border-color .15s;
    }
    #${PID} .h-tab:hover { color: #d0d0d0; background: #1c1c1c; }
    #${PID} .h-tab-active {
      color: #e07b39; background: #1a1a1a;
      border-bottom-color: #e07b39;
    }

    #${PID} .h-body { max-height: 480px; overflow-y: auto; padding: 12px 14px; }
    #${PID} .h-body::-webkit-scrollbar { width: 8px; }
    #${PID} .h-body::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }

    #${PID} .h-row { display: flex; gap: 6px; margin-bottom: 10px; }
    #${PID} .h-btn {
      flex: 1; padding: 8px 10px; border: 0; border-radius: 8px;
      font-weight: 600; font-size: 12px; cursor: pointer;
      transition: filter .15s, background .15s;
    }
    #${PID} .h-btn-primary { background: #2e7d32; color: #fff; }
    #${PID} .h-btn-primary:hover { filter: brightness(1.15); }
    #${PID} .h-btn-primary.h-stop { background: #c62828; }
    #${PID} .h-btn-ghost { background: #222; color: #ccc; }
    #${PID} .h-btn-ghost:hover { background: #2e2e2e; }

    #${PID} .h-status { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; font-size: 11px; }
    #${PID} .h-pill {
      padding: 2px 8px; border-radius: 999px; background: #2a2a2a; color: #aaa;
      font-weight: 600; text-transform: uppercase; letter-spacing: .5px; font-size: 10px;
    }
    #${PID} .h-pill.h-run { background: #1b5e20; color: #a5d6a7; }
    #${PID} .h-meta { color: #888; }
    #${PID} .h-meta b { color: #e07b39; }

    #${PID} .h-progress { height: 3px; background: #1a1a1a; border-radius: 2px; overflow: hidden; margin-bottom: 10px; }
    #${PID} .h-progress-bar { height: 100%; width: 0%; background: #e07b39; transition: width .3s; }

    #${PID} .h-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .6px; margin: 10px 0 4px; font-weight: 700; }
    #${PID} .h-q { font-size: 12px; color: #ccc; line-height: 1.4; max-height: 60px; overflow-y: auto; padding: 6px 8px; background: #0e0e0e; border-radius: 6px; }
    #${PID} .h-a { font-size: 12px; color: #a5d6a7; font-weight: 500; padding: 6px 8px; background: #0e0e0e; border-radius: 6px; word-break: break-word; }

    #${PID} .h-log {
      background: #0a0a0a; border-radius: 6px; padding: 8px;
      font: 11px/1.5 ui-monospace, Menlo, monospace; color: #9ccc65;
      max-height: 120px; overflow-y: auto; white-space: pre-wrap;
    }
    #${PID} .h-log div { padding: 1px 0; }
    #${PID} .h-log .h-err { color: #ef5350; }
    #${PID} .h-log .h-ok { color: #9ccc65; }

    #${PID} .h-chat { display: flex; flex-direction: column; gap: 8px; padding-bottom: 8px; }
    #${PID} .h-msg { padding: 8px 11px; border-radius: 10px; font-size: 12px; line-height: 1.45; max-width: 90%; word-break: break-word; white-space: pre-wrap; }
    #${PID} .h-msg-u { align-self: flex-end; background: #2c3e50; color: #ecf0f1; border-bottom-right-radius: 3px; }
    #${PID} .h-msg-a { align-self: flex-start; background: #1e1e1e; color: #ddd; border-bottom-left-radius: 3px; border-left: 2px solid #e07b39; }
    #${PID} .h-msg-a.h-streaming::after { content: '▋'; color: #e07b39; animation: h-blink 1s steps(2) infinite; }
    @keyframes h-blink { 50% { opacity: 0; } }

    #${PID} .h-chat-input { display: flex; gap: 6px; margin-top: 8px; }
    #${PID} .h-chat-input textarea {
      flex: 1; background: #0e0e0e; color: #eee; border: 1px solid #2a2a2a;
      border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 12px;
      resize: none; height: 44px; max-height: 120px;
    }
    #${PID} .h-chat-input textarea:focus { outline: none; border-color: #e07b39; }
    #${PID} .h-chat-input .h-btn { flex: 0 0 auto; }

    #${PID} .h-hist { display: flex; flex-direction: column; gap: 8px; }
    #${PID} .h-hist-item { background: #0e0e0e; border-radius: 8px; padding: 10px; font-size: 12px; border-left: 3px solid #e07b39; }
    #${PID} .h-hist-item .h-hist-q { color: #ccc; margin-bottom: 6px; }
    #${PID} .h-hist-item .h-hist-a { color: #a5d6a7; font-weight: 600; margin-bottom: 4px; }
    #${PID} .h-hist-item .h-hist-w { color: #888; font-size: 11px; font-style: italic; }
    #${PID} .h-hist-item .h-hist-ts { color: #555; font-size: 10px; margin-top: 4px; }

    #${PID} .h-input, #${PID} .h-range { width: 100%; }
    #${PID} .h-input {
      background: #0e0e0e; color: #eee; border: 1px solid #2a2a2a;
      border-radius: 6px; padding: 7px 10px; font: inherit; font-size: 12px; margin-bottom: 4px;
    }
    #${PID} .h-input:focus { outline: none; border-color: #e07b39; }
    #${PID} .h-range { accent-color: #e07b39; }
    #${PID} .h-check { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #ccc; flex: 1; }
    #${PID} .h-check input { accent-color: #e07b39; }
    #${PID} .h-help { font-size: 11px; color: #666; margin-top: 10px; text-align: center; }

    #${PID} .h-foot {
      display: flex; justify-content: space-between; padding: 6px 14px;
      font-size: 10px; color: #555; background: #0a0a0a; border-top: 1px solid #1a1a1a;
      font-family: ui-monospace, monospace;
    }
  `;

  function ensureUI() {
    if (document.getElementById(ID)) return;
    const style = document.createElement('style');
    style.id = ID + '_css';
    style.textContent = CSS;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.id = ID;
    wrap.innerHTML = buildSkeleton();
    document.body.appendChild(wrap);
    wireUI();
    render();
  }

  function $ (suffix) { return document.getElementById(PID + suffix); }

  function wireUI() {
    document.querySelectorAll('#' + PID + ' .h-tab').forEach(btn => {
      btn.onclick = () => {
        S.tab = btn.dataset.tab;
        document.querySelectorAll('#' + PID + ' .h-tab').forEach(b => b.classList.toggle('h-tab-active', b === btn));
        document.querySelectorAll('#' + PID + ' .h-view').forEach(v => {
          v.style.display = v.dataset.view === S.tab ? '' : 'none';
        });
        render();
      };
    });
    $('_toggle').onclick = startSmart;
    $('_skip').onclick = () => { const btn = findNextButton(); if (btn) { humanClick(btn); log('manual skip'); } };
    $('_explainNow').onclick = async () => {
      if (!S.currentQ) { log('no current question'); return; }
      S.tab = 'ask';
      document.querySelectorAll('#' + PID + ' .h-tab').forEach(b => b.classList.toggle('h-tab-active', b.dataset.tab === 'ask'));
      document.querySelectorAll('#' + PID + ' .h-view').forEach(v => { v.style.display = v.dataset.view === 'ask' ? '' : 'none'; });
      const prompt = `Question: ${S.currentQ}\n\nChoices:\n${S.currentChoices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nWhich is correct and why?`;
      await sendChat(prompt);
    };
    $('_min').onclick = () => {
      S.minimized = !S.minimized;
      document.getElementById(PID).classList.toggle('h-min', S.minimized);
    };
    $('_close').onclick = () => {
      document.getElementById(ID)?.remove();
      document.getElementById(ID + '_css')?.remove();
    };
    const hdr = $('_hdr');
    const panel = document.getElementById(PID);
    let drag = null;
    hdr.addEventListener('mousedown', e => {
      if (e.target.classList.contains('h-icon')) return;
      drag = { x: e.clientX, y: e.clientY, l: panel.offsetLeft, t: panel.offsetTop };
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = (drag.l + e.clientX - drag.x) + 'px';
      panel.style.top = (drag.t + e.clientY - drag.y) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = null; });
    const ci = $('_chatInput');
    ci.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(ci.value); ci.value = ''; }
    });
    $('_chatSend').onclick = () => { sendChat(ci.value); ci.value = ''; };
    $('_export').onclick = () => {
      const blob = new Blob([JSON.stringify(S.history, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'helper-history-' + Date.now() + '.json';
      a.click();
    };
    $('_clearHist').onclick = () => { S.history = []; render(); };
    const mi = $('_model'); mi.value = CFG.ai.model;
    mi.oninput = () => { CFG.ai.model = mi.value.trim(); render(); };
    const ki = $('_key'); ki.value = CFG.ai.key;
    ki.oninput = () => { CFG.ai.key = ki.value.trim(); };
    const ti = $('_temp'); ti.value = CFG.ai.temperature;
    ti.oninput = () => { CFG.ai.temperature = parseFloat(ti.value); $('_tempv').textContent = CFG.ai.temperature.toFixed(2); };
    $('_tempv').textContent = CFG.ai.temperature.toFixed(2);
    const dk = $('_dry'); dk.checked = CFG.dryRun; dk.onchange = () => { CFG.dryRun = dk.checked; };
    const sk = $('_sound'); sk.checked = CFG.sound; sk.onchange = () => { CFG.sound = sk.checked; };
    const ek = $('_expl'); ek.checked = CFG.explain; ek.onchange = () => { CFG.explain = ek.checked; };
  }

  function renderLog() {
    const el = $('_log');
    if (!el) return;
    el.innerHTML = S.log.slice(-30).map(l => {
      const cls = /err|fail/i.test(l) ? 'h-err' : 'h-ok';
      return '<div class="' + cls + '">' + escapeHtml(l) + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }
  function renderChat() {
    const el = $('_chat');
    if (!el) return;
    el.innerHTML = S.chat.map(m =>
      '<div class="h-msg h-msg-' + (m.role === 'user' ? 'u' : 'a') + (m.streaming ? ' h-streaming' : '') + '">' +
      escapeHtml(m.content) + '</div>'
    ).join('');
    el.parentElement.scrollTop = el.parentElement.scrollHeight;
  }
  function renderHistory() {
    const el = $('_hist');
    if (!el) return;
    if (!S.history.length) { el.innerHTML = '<div class="h-help">No answers yet.</div>'; return; }
    el.innerHTML = S.history.slice().reverse().map(h => {
      const t = new Date(h.ts).toLocaleTimeString();
      return '<div class="h-hist-item">' +
        '<div class="h-hist-q">' + escapeHtml(h.q) + '</div>' +
        '<div class="h-hist-a">→ ' + escapeHtml(h.pickedText.join(' | ')) + '</div>' +
        (h.why ? '<div class="h-hist-w">' + escapeHtml(h.why) + '</div>' : '') +
        '<div class="h-hist-ts">' + t + '</div>' +
      '</div>';
    }).join('');
  }
  function render() {
    if (!document.getElementById(PID)) return;
    const st = $('_status');
    if (st) {
      st.textContent = S.running ? 'running' : (S.busy ? 'stopping' : 'idle');
      st.classList.toggle('h-run', S.running);
    }
    const tg = $('_toggle');
    if (tg) { tg.textContent = S.running ? 'Stop' : 'Start'; tg.classList.toggle('h-stop', S.running); }
    if ($('_count')) $('_count').textContent = S.processed;
    if ($('_req')) $('_req').textContent = S.requests;
    if ($('_lq')) $('_lq').textContent = S.lastQuestion;
    if ($('_la')) $('_la').textContent = S.lastAnswer;
    if ($('_footModel')) $('_footModel').textContent = CFG.ai.model;
    if ($('_footTok')) $('_footTok').textContent = S.tokensIn + ' in / ' + S.tokensOut + ' out';
    if ($('_prog')) $('_prog').style.width = (S.running ? ((S.processed % 5) / 5 * 100) : 0) + '%';
    renderLog(); renderChat(); renderHistory();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
      e.preventDefault();
      const p = document.getElementById(PID);
      if (!p) return;
      p.style.display = p.style.display === 'none' ? '' : 'none';
    }
  });

  ensureUI();
  log('Homework Helper core ready');
  log('backend:', CFG.ai.model);
  log('hotkey Ctrl+Shift+H toggles panel');
  window.__cinder = { CFG, S, start: loop, stop, ask: sendChat, PID };
  if (CFG.autoStart) loop();
})();

// ============================================================
// FORGE (universal classwork forger)
// ============================================================
(() => {
  'use strict';

  const PID = '__helper_panel';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('%c[helper]', 'color:#e07b39;font-weight:bold', ...a);

  const LS_KEY = '__helper_forge_ctx';
  const LS_HIST = '__helper_forge_hist';

  const Ctx = {
    project: localStorage.getItem(LS_KEY) || '',
    save(v) { this.project = v; localStorage.setItem(LS_KEY, v); }
  };

  const F = {
    running: false,
    title: '',
    deliverables: [],
    scrapedSteps: [],
    history: (() => { try { return JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch { return []; } })()
  };

  const cleanText = t => String(t).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

  function findStepTabs() {
    return [...document.querySelectorAll('button, a, li, [role="tab"], .nav-item, .nav-link')]
      .filter(el => el.offsetParent !== null)
      .filter(el => /^(overview|step\s*\d+|introduction|summary|submit|part\s*\d+|section\s*\d+)$/i.test((el.textContent || '').trim()))
      .filter((el, i, arr) => arr.findIndex(x => x.textContent.trim() === el.textContent.trim()) === i);
  }
  function findContentRoot() {
    const sels = ['main', '[role="main"]', '.assignment-content', 'lib-managed-html', 'article', '.content-body', '#content'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && (el.innerText || '').length > 100) return el;
    }
    return document.body;
  }
  async function scrapeAllSteps() {
    const tabs = findStepTabs();
    log('found', tabs.length, 'step tabs');
    const out = [];
    if (!tabs.length) {
      out.push({ label: 'Page', content: cleanText(findContentRoot().innerText) });
      return out;
    }
    const activeNow = tabs.find(t =>
      t.classList.contains('active') ||
      t.getAttribute('aria-selected') === 'true' ||
      /active|selected/i.test(t.className)
    ) || tabs[0];
    for (const tab of tabs) {
      const label = tab.textContent.trim();
      tab.click();
      await sleep(450);
      out.push({ label, content: cleanText(findContentRoot().innerText) });
      log('scraped:', label, out[out.length - 1].content.length);
    }
    activeNow.click();
    await sleep(200);
    return out;
  }
  function findEditableFields() {
    const tas = [...document.querySelectorAll('textarea')].filter(t => t.offsetParent !== null && (t.value || '').length > 20);
    const ces = [...document.querySelectorAll('[contenteditable="true"]')].filter(t => t.offsetParent !== null && (t.innerText || '').length > 20);
    return [...tas, ...ces].map(el => ({
      hint: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.closest('label')?.innerText || el.name || '').trim().slice(0, 120),
      value: (el.value ?? el.innerText ?? '').slice(0, 1500)
    }));
  }

  function buildForgePrompt(steps, userCtx, existingFields) {
    const stepBlob = steps.map(s => `### ${s.label}\n${s.content.slice(0, 2600)}`).join('\n\n');
    const ctxBlock = userCtx && userCtx.trim()
      ? `\n\nSTUDENT'S ONGOING PROJECT CONTEXT (reference this when the assignment asks about "your project"):\n"""\n${userCtx.trim().slice(0, 1200)}\n"""`
      : `\n\nNo project context provided — if the assignment references "your project" or "your proposal", write generically but coherently.`;
    const fieldsBlock = existingFields.length
      ? `\n\nEXISTING EDITABLE TEXT ALREADY ON THE PAGE (match this voice; extend, don't contradict):\n` +
        existingFields.map((f, i) => `[field ${i + 1}${f.hint ? ' — ' + f.hint : ''}]\n${f.value}`).join('\n\n')
      : '';
    return `You are a student completing a class assignment. Your output will be pasted verbatim into a submission box. Write in first person, as the student. Be specific, concrete, and address the assignment's actual language. No hedging, no "as an AI", no meta commentary.

Read the assignment carefully. Then, for EVERY task, step, prompt, section, or question it asks for, produce ONE deliverable. Mirror the assignment's own structure — if it asks for 4 steps, return 4 deliverables named after those steps. If it's one essay prompt, return one deliverable. If it asks for a template section, return that section.

Assignment content (all steps already scraped):
${stepBlob}${ctxBlock}${fieldsBlock}

Return STRICT JSON only — no prose, no markdown fences, no preamble. Schema:
{
  "assignment_title": "<inferred from page>",
  "deliverables": [
    {
      "label": "<exact step / section / prompt name from the assignment>",
      "answer": "<the full text the student pastes. Plain prose. Multi-paragraph ok. 100–400 words per deliverable unless the step clearly wants more.>"
    }
  ]
}

Rules:
- One deliverable per distinct ask. Do not merge steps. Do not invent steps.
- If a step asks sub-questions, answer them inside that deliverable as flowing prose.
- Use the assignment's own vocabulary.
- Never include headings like "Step 1:" inside the answer — the label already carries that.
- Output JSON only. No backticks. No commentary outside the JSON.`;
  }
  function parseForge(raw) {
    let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in reply');
    const o = JSON.parse(m[0]);
    if (!Array.isArray(o.deliverables)) throw new Error('no deliverables array');
    return o;
  }
  async function groqJson(prompt, maxTokens) {
    const CFG = window.__cinder.CFG;
    const res = await fetch(CFG.ai.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.ai.key },
      body: JSON.stringify({
        model: CFG.ai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.45,
        max_tokens: maxTokens || 2600,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) throw new Error('groq ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }

  async function forge() {
    if (F.running) return;
    F.running = true; renderForge();
    const t0 = Date.now();
    try {
      const steps = await scrapeAllSteps();
      F.scrapedSteps = steps;
      if (!steps.length || steps.every(s => s.content.length < 30)) {
        F.deliverables = [{ label: 'Error', answer: 'No assignment content detected on this page.' }];
        renderForge(); return;
      }
      const fields = findEditableFields();
      const prompt = buildForgePrompt(steps, Ctx.project, fields);
      log('prompt', prompt.length, 'chars — calling', window.__cinder.CFG.ai.model);
      const raw = await groqJson(prompt);
      const parsed = parseForge(raw);
      F.title = parsed.assignment_title || document.title || 'Assignment';
      F.deliverables = parsed.deliverables;
      F.history.unshift({ ts: Date.now(), title: F.title, steps: steps.length, deliverables: F.deliverables });
      F.history = F.history.slice(0, 40);
      try { localStorage.setItem(LS_HIST, JSON.stringify(F.history)); } catch {}
      log('forged', F.deliverables.length, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      log('forge failed:', e.message);
      F.deliverables = [{ label: 'Error', answer: 'Forge failed: ' + e.message }];
    } finally {
      F.running = false; renderForge();
    }
  }

  function injectTab() {
    const tabsBar = document.querySelector('#' + PID + ' .h-tabs');
    if (!tabsBar || tabsBar.querySelector('[data-tab="forge"]')) return;
    const btn = document.createElement('button');
    btn.className = 'h-tab';
    btn.dataset.tab = 'forge';
    btn.textContent = 'Forge';
    btn.onclick = () => {
      document.querySelectorAll('#' + PID + ' .h-tab').forEach(b => b.classList.toggle('h-tab-active', b === btn));
      document.querySelectorAll('#' + PID + ' .h-view').forEach(v => {
        v.style.display = v.dataset.view === 'forge' ? '' : 'none';
      });
      renderForge();
    };
    tabsBar.insertBefore(btn, tabsBar.querySelector('[data-tab="history"]'));

    const body = document.querySelector('#' + PID + ' .h-body');
    const view = document.createElement('div');
    view.className = 'h-view';
    view.dataset.view = 'forge';
    view.style.display = 'none';
    view.innerHTML = `
      <div class="h-label">Your project context (saved — one line or a paragraph)</div>
      <textarea id="${PID}_forgeCtx" class="h-input" style="height:56px;font-size:11px;resize:vertical;" placeholder="e.g. My final project is a study companion app that generates practice questions from student notes."></textarea>
      <div class="h-row" style="margin-top:6px;">
        <button class="h-btn h-btn-primary" id="${PID}_forgeGo">Forge This Assignment</button>
        <button class="h-btn h-btn-ghost" id="${PID}_forgeCopyAll">Copy All</button>
      </div>
      <div class="h-row">
        <button class="h-btn h-btn-ghost" id="${PID}_forgeDl">Download .txt</button>
        <button class="h-btn h-btn-ghost" id="${PID}_forgeClear">Clear</button>
      </div>
      <div class="h-label">Status</div>
      <div class="h-a" id="${PID}_forgeStatus">idle</div>
      <div class="h-label">Detected Steps</div>
      <div class="h-log" id="${PID}_forgeSteps">—</div>
      <div class="h-label">Deliverables</div>
      <div id="${PID}_forgeOut" style="display:flex;flex-direction:column;gap:8px;"></div>
    `;
    body.appendChild(view);

    const ctxEl = document.getElementById(PID + '_forgeCtx');
    ctxEl.value = Ctx.project;
    ctxEl.oninput = () => Ctx.save(ctxEl.value);

    document.getElementById(PID + '_forgeGo').onclick = forge;
    document.getElementById(PID + '_forgeCopyAll').onclick = copyAll;
    document.getElementById(PID + '_forgeDl').onclick = downloadTxt;
    document.getElementById(PID + '_forgeClear').onclick = () => {
      F.deliverables = []; F.scrapedSteps = []; F.title = ''; renderForge();
    };
  }

  function renderForge() {
    const st = document.getElementById(PID + '_forgeStatus');
    if (!st) return;
    st.textContent = F.running
      ? 'forging… scraping steps + calling model'
      : (F.deliverables.length ? `done — ${F.deliverables.length} deliverable(s)${F.title ? ' — ' + F.title : ''}` : 'idle');

    const sEl = document.getElementById(PID + '_forgeSteps');
    if (sEl) {
      sEl.innerHTML = F.scrapedSteps.length
        ? F.scrapedSteps.map(s => `<div>• ${escapeHtml(s.label)} — ${s.content.length} chars</div>`).join('')
        : '<div>—</div>';
    }
    const out = document.getElementById(PID + '_forgeOut');
    if (!out) return;
    if (!F.deliverables.length) { out.innerHTML = ''; return; }

    out.innerHTML = F.deliverables.map((d, i) => `
      <div style="background:#0e0e0e;border-left:3px solid #e07b39;border-radius:8px;padding:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;">
          <b style="color:#e07b39;font-size:11px;flex:1;word-break:break-word;">${escapeHtml(d.label)}</b>
          <button class="h-btn h-btn-ghost" data-copy="${i}" style="flex:0 0 auto;padding:4px 8px;font-size:10px;">Copy</button>
        </div>
        <div style="color:#ddd;font-size:12px;white-space:pre-wrap;max-height:260px;overflow-y:auto;line-height:1.5;">${escapeHtml(d.answer)}</div>
      </div>`).join('');

    out.querySelectorAll('[data-copy]').forEach(btn => {
      btn.onclick = () => {
        navigator.clipboard.writeText(F.deliverables[+btn.dataset.copy].answer);
        btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy', 900);
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
    const b = document.getElementById(PID + '_forgeCopyAll');
    if (b) { b.textContent = 'Copied ✓'; setTimeout(() => b.textContent = 'Copy All', 900); }
  }
  function downloadTxt() {
    const blob = new Blob([bundle()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (F.title || 'assignment').replace(/[^\w\-]+/g, '_').slice(0, 40) + '.txt';
    a.click();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function whenReady(fn, timeoutMs) {
    const start = Date.now();
    const tick = setInterval(() => {
      const coreReady = !!window.__cinder;
      const panelReady = !!document.querySelector('#' + PID + ' .h-tabs');
      if (coreReady && panelReady) { clearInterval(tick); fn(); return; }
      if (Date.now() - start > (timeoutMs || 15000)) {
        clearInterval(tick);
        console.warn('[helper] forge timed out. core=', coreReady, 'panel=', panelReady);
      }
    }, 250);
  }
  whenReady(() => { injectTab(); log('forge tab injected.'); });

  window.__forge = { run: forge, F, scrape: scrapeAllSteps };
})();
