// language: JavaScript, file: homework-helper.js, runtime: browser console on Buzz Angular
// Homework Helper — Auto (quiz) + Ask (chat) + Forge (classwork) + History + Settings.
// Simple UI: orange header, no logos, no emojis. × fully tears down.

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
    dryRun: false
  };
  const saveCfg = () => {
    try { localStorage.setItem(LS, JSON.stringify({ key: CFG.ai.key, model: CFG.ai.model, temperature: CFG.ai.temperature })); } catch {}
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

  // ---- auto ----
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

  function startSmart() {
    if (KILLED) return;
    if (S.running) { stop(); return; }
    if (getQuestionBlocks().length) { log('quiz — auto'); loop(); return; }
    log('no quiz — forge');
    if (window.__forge?.run) {
      const t = document.querySelector('#__hh_panel .hh-tab[data-tab="forge"]');
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
    try { S.running = false; S.busy = false; } catch {}
    try { ABORT.abort(); } catch {}
    try { clrAll(); } catch {}
    try { for (const h of killHooks) { try { h(); } catch {} } } catch {}
    try { window.__helperKillHooks = []; } catch {}
    try { if (window.__helperForgeBoot) { clearInterval(window.__helperForgeBoot); window.__helperForgeBoot = null; } } catch {}
    try { document.getElementById(UI_ID)?.remove(); } catch {}
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
    if (st) { st.textContent = S.running ? 'running' : (S.busy ? 'stopping' : 'idle'); st.style.color = S.running ? '#4caf50' : '#aaa'; }
    const tg = $('_toggle');
    if (tg) { tg.textContent = S.running ? 'Stop' : 'Start'; tg.style.background = S.running ? '#c62828' : '#2e7d32'; }
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
CRITICAL — READ CAREFULLY:
Imagine the reader is holding the finished document. They see the section heading. They want to read what's UNDER that heading.
Your job is to write that content.

Do not reference the document. Do not name the section. Do not say "the template," "the introduction," "the proposal," "this section," "the document," or any variation.
Do not describe what the section does, contains, or explains.
Do not open with "The [section name]..." or "This section..." or "My [document part]..."
Do not close with reflective lines about what the section accomplishes ("By stating these limits...", "This helps readers understand...", "This balance shows...").

Start with the actual first sentence of content. End on the actual point.
The label tells you where it goes. Do not write the label into the answer.
Every deliverable references the student's project by actual name or clear descriptor.
If a step has sub-questions, answer each inside that deliverable, in order.
60–120 words per deliverable. Shorter is better. Cut every sentence that doesn't add a fact, a reason, or an example. No padding, no restating, no transitions like "another key point" or "it's also worth noting". If a step can be answered in three tight sentences, do that.
If the assignment step itself says "in this section include X, Y, Z" or "your introduction should explain X," that is NOT permission to describe the section. Write X, Y, Z and the explanation of X directly.
Also ban reflective meta-tails at the end of a deliverable: "By stating these limits...", "Readers will see...", "This helps the project...", "This balance shows...". End on the actual point, not on a sentence describing the effect of the writing.

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
  async function cleanDeliverables(deliverables, steps) {
    if (!deliverables.length) return deliverables;
    const list = deliverables.map((d, i) => `[${i}]\n${d.answer}`).join('\n\n---\n\n');
    const prompt = `Rewrite each numbered passage below so it contains ONLY the actual content — no references to any document, section, template, or introduction.

Rules:
- Delete any sentence that names a section, document, or template ("In the X section...", "The Y section of my template...", "My introduction...").
- Delete any opening that describes the passage ("Reviewing my project, I...", "Looking at my...", "This section covers...").
- Delete any closing that describes the passage's effect ("By doing this, I...", "This shows readers...", "This balance helps...").
- Keep every concrete fact, task, weakness, mitigation, and example.
- Keep first-person voice, plain language, contractions.
- Do not add anything new. Do not summarize. Just remove the meta.
- If a passage is already clean, return it unchanged.
Also check the final sentence of each passage. If it describes what the passage does or what the reader will understand from it ("By doing X, this shows...", "This helps readers see...", "Readers will understand..."), delete it and end on the last substantive claim.

Schema — return STRICT JSON only:
{ "items": ["<rewritten passage 0>", "<rewritten passage 1>", ...] }

Passages:
${list}`;
    try {
      const raw = await C.groqJson(prompt, 4000);
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
    if (!tabsBar || tabsBar.dataset.forgeBound) return;
    tabsBar.dataset.forgeBound = '1';
    const btn = tabsBar.querySelector('[data-tab="forge"]');
    if (btn) btn.addEventListener('click', () => { if (!isDead()) renderForge(); });

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
