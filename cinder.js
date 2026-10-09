// language: JavaScript, file: homework-helper.js, runtime: browser console on Buzz Angular
// Homework Helper — Auto (quiz) + Ask (chat) + Forge (classwork) + History + Settings.
// Compact UI, persisted settings, retry-on-JSON-fail. Groq backend.

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

  // ---- persisted config ----
  const LS = '__hh_cfg_v1';
  const loadCfg = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
  const saved = loadCfg();

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
    explain: true,
    sound: false
  };
  const saveCfg = () => {
    try { localStorage.setItem(LS, JSON.stringify({
      key: CFG.ai.key, model: CFG.ai.model, temperature: CFG.ai.temperature
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

  const log = (...a) => { if (!KILLED) console.log('%c[helper]', 'color:#e07b39;font-weight:bold', ...a); };

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

  // JSON-robust variant — retries without response_format on 400
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

  // ---- auto loop ----
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

  // ---- smart start ----
  function startSmart() {
    if (KILLED) return;
    if (S.running) { stop(); return; }
    if (getQuestionBlocks().length) { log('quiz detected — auto'); loop(); return; }
    log('no quiz — running Forge');
    if (window.__forge?.run) {
      const t = document.querySelector('#__hh_panel .h-tab[data-tab="forge"]');
      if (t) t.click();
      window.__forge.run();
    } else {
      S.lastAnswer = 'Forge not loaded. Wait 2s and retry.';
      render();
    }
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
          { role: 'system', content: 'You are Homework Helper — direct, sharp, no filler. Answer the question actually asked.' },
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
  // UI — compact orange-header, tabs
  // ============================================================
  const UI_ID = '__hh_ui';
  const PID = '__hh_panel';

  function ensureUI() {
    if (document.getElementById(UI_ID) || KILLED) return;
    const el = document.createElement('div');
    el.id = UI_ID;
    el.innerHTML = `
      <div id="${PID}" class="hh">
        <div class="hh-hdr" id="${PID}_hdr">
          <span>◆ Homework Helper</span>
          <span class="hh-x" id="${PID}_x" title="Close & teardown">×</span>
        </div>
        <div class="hh-tabs" id="${PID}_tabs">
          <button class="hh-tab hh-active" data-tab="auto">Auto</button>
          <button class="hh-tab" data-tab="ask">Ask</button>
          <button class="hh-tab" data-tab="forge">Forge</button>
          <button class="hh-tab" data-tab="hist">History</button>
          <button class="hh-tab" data-tab="cfg">⚙</button>
        </div>
        <div class="hh-body" id="${PID}_body">
          <div class="hh-view" data-view="auto">
            <div class="hh-row">
              <button class="hh-btn hh-green" id="${PID}_toggle">Start</button>
              <button class="hh-btn" id="${PID}_skip">Skip</button>
              <button class="hh-btn" id="${PID}_explain">Explain</button>
            </div>
            <div class="hh-meta">Status <span id="${PID}_status" class="hh-ok">idle</span> · Done <b id="${PID}_count">0</b> · Req <b id="${PID}_req">0</b></div>
            <div class="hh-lbl">Last Q</div>
            <div class="hh-box" id="${PID}_lq">—</div>
            <div class="hh-lbl">Last A</div>
            <div class="hh-box hh-ok" id="${PID}_la">—</div>
            <div class="hh-lbl">Log</div>
            <div class="hh-log" id="${PID}_log"></div>
          </div>

          <div class="hh-view" data-view="ask" style="display:none">
            <div class="hh-chat" id="${PID}_chat"></div>
            <div class="hh-chat-input">
              <textarea id="${PID}_chatIn" placeholder="Ask anything… (Enter to send, Shift+Enter newline)"></textarea>
              <button class="hh-btn hh-green" id="${PID}_chatSend">Send</button>
            </div>
          </div>

          <div class="hh-view" data-view="forge" style="display:none">
            <div class="hh-lbl">Project context (saved)</div>
            <textarea id="${PID}_fCtx" class="hh-input" style="height:50px" placeholder="One line or short paragraph about your project."></textarea>
            <div class="hh-lbl">Voice sample (saved)</div>
            <textarea id="${PID}_fStyle" class="hh-input" style="height:60px" placeholder="Paste a paragraph you wrote. Model matches your voice."></textarea>
            <div class="hh-row" style="margin-top:6px">
              <button class="hh-btn hh-green" id="${PID}_fGo">Forge</button>
              <button class="hh-btn" id="${PID}_fCopy">Copy All</button>
              <button class="hh-btn" id="${PID}_fDl">.txt</button>
            </div>
            <div class="hh-meta">Status <span id="${PID}_fStatus">idle</span></div>
            <div class="hh-lbl">Scraped steps</div>
            <div class="hh-log" id="${PID}_fSteps">—</div>
            <div class="hh-lbl">Deliverables</div>
            <div id="${PID}_fOut" style="display:flex;flex-direction:column;gap:6px"></div>
          </div>

          <div class="hh-view" data-view="hist" style="display:none">
            <div class="hh-row">
              <button class="hh-btn" id="${PID}_hExport">Export</button>
              <button class="hh-btn" id="${PID}_hClear">Clear</button>
            </div>
            <div class="hh-lbl">Quiz answers</div>
            <div class="hh-hist" id="${PID}_hQuiz"></div>
            <div class="hh-lbl">Forge runs</div>
            <div class="hh-hist" id="${PID}_hForge"></div>
          </div>

          <div class="hh-view" data-view="cfg" style="display:none">
            <div class="hh-lbl">Model</div>
            <input class="hh-input" id="${PID}_m">
            <div class="hh-lbl">API key</div>
            <input class="hh-input" id="${PID}_k" type="password">
            <div class="hh-lbl">Temperature <b id="${PID}_tv"></b></div>
            <input class="hh-input" id="${PID}_t" type="range" min="0" max="1" step="0.05">
            <div class="hh-help">Ctrl+Shift+H toggle · × closes & tears down</div>
          </div>
        </div>
        <div class="hh-foot">
          <span id="${PID}_fModel">—</span>
          <span id="${PID}_fTok">0 / 0</span>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    const css = document.createElement('style');
    css.id = UI_ID + '_css';
    css.textContent = `
      #${PID}.hh {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        width: 330px; background: #1a1a1a; color: #f0f0f0;
        border: 1px solid #e07b39; border-radius: 10px;
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,.5); overflow: hidden;
      }
      #${PID} * { box-sizing: border-box; }
      #${PID} .hh-hdr {
        background: linear-gradient(135deg, #e07b39, #c96b2a);
        color: #1a1a1a; padding: 8px 12px; font-weight: 700;
        display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none;
      }
      #${PID} .hh-x { cursor: pointer; font-size: 16px; line-height: 1; opacity: .8; }
      #${PID} .hh-x:hover { opacity: 1; }
      #${PID} .hh-tabs {
        display: flex; background: #141414; border-bottom: 1px solid #262626;
        padding: 4px 6px 0; gap: 2px;
      }
      #${PID} .hh-tab {
        flex: 1; background: transparent; border: 0; color: #8a8a8a;
        padding: 7px 6px; cursor: pointer; font-size: 11px; font-weight: 500;
        border-top-left-radius: 6px; border-top-right-radius: 6px;
        border-bottom: 2px solid transparent;
      }
      #${PID} .hh-tab:hover { color: #d0d0d0; background: #1c1c1c; }
      #${PID} .hh-active { color: #e07b39; background: #1a1a1a; border-bottom-color: #e07b39; }
      #${PID} .hh-body { padding: 10px 12px; max-height: 440px; overflow-y: auto; }
      #${PID} .hh-body::-webkit-scrollbar { width: 6px; }
      #${PID} .hh-body::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
      #${PID} .hh-row { display: flex; gap: 6px; margin-bottom: 8px; }
      #${PID} .hh-btn {
        flex: 1; padding: 6px 10px; border: 0; border-radius: 6px;
        background: #2a2a2a; color: #ddd; font-weight: 600; font-size: 11px; cursor: pointer;
      }
      #${PID} .hh-btn:hover { background: #333; }
      #${PID} .hh-green { background: #2e7d32; color: #fff; }
      #${PID} .hh-green:hover { background: #378f3a; }
      #${PID} .hh-red { background: #c62828; color: #fff; }
      #${PID} .hh-meta { font-size: 11px; color: #aaa; margin-bottom: 6px; }
      #${PID} .hh-meta b { color: #e07b39; }
      #${PID} .hh-ok { color: #6cc24a; }
      #${PID} .hh-err { color: #ef5350; }
      #${PID} .hh-lbl {
        font-size: 10px; color: #666; text-transform: uppercase;
        letter-spacing: .5px; margin: 8px 0 3px; font-weight: 700;
      }
      #${PID} .hh-box {
        background: #0e0e0e; border-radius: 6px; padding: 6px 8px;
        font-size: 11px; color: #ccc; max-height: 60px; overflow-y: auto; word-break: break-word;
      }
      #${PID} .hh-log {
        background: #0a0a0a; border-radius: 6px; padding: 6px;
        font: 10px/1.4 ui-monospace, Menlo, monospace; color: #9ccc65;
        max-height: 130px; overflow-y: auto; white-space: pre-wrap;
      }
      #${PID} .hh-input {
        width: 100%; background: #0e0e0e; color: #eee; border: 1px solid #2a2a2a;
        border-radius: 6px; padding: 6px 9px; font: inherit; font-size: 11px;
        margin-bottom: 4px; resize: vertical;
      }
      #${PID} .hh-input:focus { outline: none; border-color: #e07b39; }
      #${PID} .hh-help { font-size: 10px; color: #666; margin-top: 8px; text-align: center; }
      #${PID} .hh-chat { display: flex; flex-direction: column; gap: 6px; padding-bottom: 6px; max-height: 280px; overflow-y: auto; }
      #${PID} .hh-msg { padding: 6px 10px; border-radius: 8px; font-size: 11px; line-height: 1.45; max-width: 92%; word-break: break-word; white-space: pre-wrap; }
      #${PID} .hh-msg-u { align-self: flex-end; background: #2c3e50; color: #ecf0f1; }
      #${PID} .hh-msg-a { align-self: flex-start; background: #1e1e1e; color: #ddd; border-left: 2px solid #e07b39; }
      #${PID} .hh-msg-a.hh-streaming::after { content: '▋'; color: #e07b39; animation: hhb 1s steps(2) infinite; }
      @keyframes hhb { 50% { opacity: 0; } }
      #${PID} .hh-chat-input { display: flex; gap: 6px; margin-top: 6px; }
      #${PID} .hh-chat-input textarea {
        flex: 1; background: #0e0e0e; color: #eee; border: 1px solid #2a2a2a;
        border-radius: 6px; padding: 6px 9px; font: inherit; font-size: 11px;
        resize: none; height: 40px;
      }
      #${PID} .hh-chat-input textarea:focus { outline: none; border-color: #e07b39; }
      #${PID} .hh-chat-input .hh-btn { flex: 0 0 auto; }
      #${PID} .hh-hist { display: flex; flex-direction: column; gap: 5px; max-height: 150px; overflow-y: auto; }
      #${PID} .hh-hist-item {
        background: #0e0e0e; border-radius: 6px; padding: 6px 8px;
        font-size: 11px; border-left: 2px solid #e07b39; color: #ccc;
      }
      #${PID} .hh-hist-item b { color: #e07b39; }
      #${PID} .hh-foot {
        display: flex; justify-content: space-between; padding: 5px 12px;
        font: 10px ui-monospace, monospace; color: #555;
        background: #0a0a0a; border-top: 1px solid #1a1a1a;
      }
      #${PID} .hh-deliv {
        background: #0e0e0e; border-left: 3px solid #e07b39; border-radius: 6px;
        padding: 8px; font-size: 11px;
      }
      #${PID} .hh-deliv-head {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 4px; gap: 6px;
      }
      #${PID} .hh-deliv-head b { color: #e07b39; font-size: 11px; flex: 1; word-break: break-word; }
      #${PID} .hh-deliv-head .hh-btn { flex: 0 0 auto; padding: 3px 7px; font-size: 10px; }
      #${PID} .hh-deliv-body {
        color: #ddd; white-space: pre-wrap; max-height: 220px; overflow-y: auto; line-height: 1.5;
      }
    `;
    document.head.appendChild(css);

    wireUI();
    render();
  }

  const $ = suf => document.getElementById(PID + suf);

  function wireUI() {
    document.querySelectorAll('#' + PID + ' .hh-tab').forEach(btn => {
      btn.onclick = () => {
        if (KILLED) return;
        S.tab = btn.dataset.tab;
        document.querySelectorAll('#' + PID + ' .hh-tab').forEach(b => b.classList.toggle('hh-active', b === btn));
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

    // drag
    const hdr = $('_hdr'); const panel = document.getElementById(PID);
    let drag = null;
    hdr.addEventListener('mousedown', e => {
      if (e.target.classList.contains('hh-x')) return;
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

    // chat
    const ci = $('_chatIn');
    ci.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(ci.value); ci.value = ''; }
    }, SIG);
    $('_chatSend').onclick = () => { sendChat(ci.value); ci.value = ''; };

    // history
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

    // settings
    const m = $('_m'); m.value = CFG.ai.model;
    m.oninput = () => { CFG.ai.model = m.value.trim(); saveCfg(); render(); };
    const k = $('_k'); k.value = CFG.ai.key;
    k.oninput = () => { CFG.ai.key = k.value.trim(); saveCfg(); };
    const t = $('_t'); t.value = CFG.ai.temperature;
    t.oninput = () => { CFG.ai.temperature = parseFloat(t.value); saveCfg(); $('_tv').textContent = CFG.ai.temperature.toFixed(2); };
    $('_tv').textContent = CFG.ai.temperature.toFixed(2);

    // hotkeys
    document.addEventListener('keydown', e => {
      if (KILLED) return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
        e.preventDefault();
        const p = document.getElementById(PID);
        if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
      }
    }, SIG);
  }

  // ---- full teardown ----
  function nuke() {
    if (KILLED) return;
    KILLED = true;
    try { S.running = false; S.busy = false; } catch {}
    try { ABORT.abort(); } catch {}
    try { clrAll(); } catch {}
    try { for (const h of killHooks) { try { h(); } catch {} } } catch {}
    try { window.__helperKillHooks = []; } catch {}
    try { if (window.__helperForgeBoot) { clearInterval(window.__helperForgeBoot); window.__helperForgeBoot = null; } } catch {}
    try { document.getElementById(UI_ID + '_css')?.remove(); } catch {}
    try { document.getElementById(UI_ID)?.remove(); } catch {}
    try { if (window.__forge) delete window.__forge; } catch {}
    try { delete window.__cinder; } catch {}
    console.log('%c[helper] closed — paste the loader again to reload.', 'color:#e07b39;font-weight:bold');
  }

  // ---- render ----
  function renderLog() {
    const el = $('_log');
    if (!el) return;
    el.innerHTML = S.log.slice(-30).map(l => {
      const cls = /err|fail/i.test(l) ? 'hh-err' : 'hh-ok';
      return `<div class="${cls}">${esc(l)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }
  function renderChat() {
    const el = $('_chat');
    if (!el) return;
    el.innerHTML = S.chat.map(m =>
      `<div class="hh-msg hh-msg-${m.role === 'user' ? 'u' : 'a'}${m.streaming ? ' hh-streaming' : ''}">${esc(m.content)}</div>`
    ).join('');
    el.scrollTop = el.scrollHeight;
  }
  function renderHistory() {
    const q = $('_hQuiz');
    if (q) {
      q.innerHTML = S.history.length
        ? S.history.slice().reverse().slice(0, 20).map(h => `<div class="hh-hist-item"><b>${esc(h.pickedText.join(' | ').slice(0, 90))}</b></div>`).join('')
        : '<div class="hh-hist-item" style="opacity:.5">none yet</div>';
    }
    const f = $('_hForge');
    if (f) {
      const H = window.__forge?.F?.history || [];
      f.innerHTML = H.length
        ? H.slice(0, 20).map(h => `<div class="hh-hist-item"><b>${esc((h.title || 'assignment').slice(0, 60))}</b> — ${h.deliverables?.length || 0} deliverable(s)</div>`).join('')
        : '<div class="hh-hist-item" style="opacity:.5">none yet</div>';
    }
  }
  function render() {
    if (KILLED || !document.getElementById(PID)) return;
    const st = $('_status');
    if (st) { st.textContent = S.running ? 'running' : (S.busy ? 'stopping' : 'idle'); st.className = S.running ? 'hh-ok' : ''; }
    const tg = $('_toggle');
    if (tg) { tg.textContent = S.running ? 'Stop' : 'Start'; tg.className = 'hh-btn ' + (S.running ? 'hh-red' : 'hh-green'); }
    if ($('_count')) $('_count').textContent = S.processed;
    if ($('_req')) $('_req').textContent = S.requests;
    if ($('_lq')) $('_lq').textContent = S.lastQuestion;
    if ($('_la')) $('_la').textContent = S.lastAnswer;
    if ($('_fModel')) $('_fModel').textContent = CFG.ai.model;
    if ($('_fTok')) $('_fTok').textContent = S.tokensIn + ' in / ' + S.tokensOut + ' out';
    renderLog(); renderChat(); renderHistory();
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // expose some bits for forge module
  window.__cinder = {
    CFG, S, log,
    groqCall, groqJson,
    isKilled: () => KILLED,
    PID,
    esc,
    render
  };

  ensureUI();
  log('helper ready · ' + CFG.ai.model);
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

  const Ctx = {
    project: localStorage.getItem(LS_CTX) || '',
    style: localStorage.getItem(LS_STY) || '',
    saveProject(v) { this.project = v; localStorage.setItem(LS_CTX, v); },
    saveStyle(v) { this.style = v; localStorage.setItem(LS_STY, v); }
  };

  const F = {
    running: false, title: '', deliverables: [], scrapedSteps: [],
    history: (() => { try { return JSON.parse(localStorage.getItem(LS_HIS) || '[]'); } catch { return []; } })()
  };

  const cleanText = t => String(t).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

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

  function buildPrompt(steps, ctx, style, fields) {
    const stepBlob = steps.map(s => `### ${s.label}\n${s.content.slice(0, 1800)}`).join('\n\n');
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

You are a real student completing a class assignment. Output is pasted verbatim into a submission box.

=== STRUCTURE ===
Steps in order: ${steps.map(s => s.label).join(' | ')}
Produce ONE deliverable per step, same order.
Skip steps labeled "Overview" or "Introduction" if they only describe the assignment — those are navigation, not asks.
If a step's content is under 80 chars, write "[no content scraped]" — do NOT invent.
Label each deliverable EXACTLY as the step label.
Only merge steps whose labels are literally identical.

=== CONTENT ===
CRITICAL: Write the ACTUAL CONTENT, not a description of it.
Never start with "In this section I...", "I list...", "I add...", "I note...", "I explain...", "I suggest...".
If the step says "include X, Y, Z," just WRITE X, Y, Z as real sentences.
Every deliverable references the student's project by actual name or clear descriptor.
If a step has sub-questions, answer each inside that deliverable, in order.
100–250 words per deliverable. Don't pad, don't repeat.

=== VOICE ===
10th grade reading level. Plain words. Short sentences.
Contractions: I'm, it's, doesn't, can't, won't.
Say "it", "my project", "my AI" — NEVER "the system", "the platform", "the AI application".
No semicolons. No markdown headers. No **bold**. Plain prose.
Bullets only if the step itself is a list prompt.
Ban: furthermore, moreover, additionally, in conclusion, plays a crucial role, leverages, facilitates, underscores, optimal, robust.
Don't start two sentences the same way.

=== ASSIGNMENT CONTENT ===
${stepBlob}${ctxBlock}${styleBlock}${fieldsBlock}

Schema:
{
  "assignment_title": "<inferred>",
  "deliverables": [
    { "label": "<exact step label>", "answer": "<100–250 words>" }
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
      const prompt = buildPrompt(steps, Ctx.project, Ctx.style, fields);
      log('prompt', prompt.length, 'chars →', C.CFG.ai.model);
      const raw = await C.groqJson(prompt, 4000);
      if (isDead()) return;
      const parsed = parse(raw);
      F.title = parsed.assignment_title || document.title || 'Assignment';
      F.deliverables = parsed.deliverables;
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
    if (!tabsBar || tabsBar.querySelector('[data-tab="forge"]')) return;
    // toggle handlers for the forge tab + its view already exist in the HTML
    const btn = tabsBar.querySelector('[data-tab="forge"]');
    btn.addEventListener('click', () => { if (!isDead()) renderForge(); });

    const ctx = $('_fCtx'); if (ctx) { ctx.value = Ctx.project; ctx.oninput = () => Ctx.saveProject(ctx.value); }
    const sty = $('_fStyle'); if (sty) { sty.value = Ctx.style; sty.oninput = () => Ctx.saveStyle(sty.value); }
    $('_fGo').onclick = forge;
    $('_fCopy').onclick = copyAll;
    $('_fDl').onclick = downloadTxt;

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
            const bad = s.content.length < 200 ? ' style="color:#ef5350"' : '';
            return `<div${bad}>• <b>${esc(s.label)}</b> — ${s.content.length} chars<br><span style="color:#666;font-size:9px">${head}…</span></div>`;
          }).join('')
        : '—';
    }
    const out = $('_fOut');
    if (!out) return;
    if (!F.deliverables.length) { out.innerHTML = ''; return; }
    out.innerHTML = F.deliverables.map((d, i) => `
      <div class="hh-deliv">
        <div class="hh-deliv-head">
          <b>${esc(d.label)}</b>
          <button class="hh-btn" data-copy="${i}">Copy</button>
        </div>
        <div class="hh-deliv-body">${esc(d.answer)}</div>
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

  // boot: wait for core panel
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
