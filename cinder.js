// language: JavaScript, file: cinder.js, module: forge-universal, runtime: browser console on Buzz
// Universal classwork forger — any assignment shape. Extends the cinder panel.
(() => {
  'use strict';
  if (!window.__cinder) { console.warn('[forge] cinder core not loaded'); return; }

  const { CFG } = window.__cinder;
  const PID = '__cinder_panel';
  const $ = s => document.getElementById(PID + s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('%c[forge]', 'color:#e07b39;font-weight:bold', ...a);

  // ============================================================
  // PERSISTENT CONTEXT — your project info, saved across sessions
  // ============================================================
  const LS_KEY = '__cinder_forge_ctx';
  const LS_HIST = '__cinder_forge_hist';

  const Ctx = {
    project: localStorage.getItem(LS_KEY) || '',
    save(v) { this.project = v; localStorage.setItem(LS_KEY, v); }
  };

  const F = {
    running: false,
    title: '',
    deliverables: [],
    scrapedSteps: [],
    history: JSON.parse(localStorage.getItem(LS_HIST) || '[]')
  };

  // ============================================================
  // DETECTION
  // ============================================================
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

  function cleanText(t) {
    return String(t).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  // ============================================================
  // SCRAPE — walk every step tab, harvest the panel, restore
  // ============================================================
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
      const content = cleanText(findContentRoot().innerText);
      out.push({ label, content });
      log('scraped:', label, content.length);
    }
    activeNow.click();
    await sleep(200);
    return out;
  }

  function findEditableFields() {
    // Any textarea / contenteditable on the page — pass to the model so it can match voice
    const tas = [...document.querySelectorAll('textarea')].filter(t => t.offsetParent !== null && (t.value || '').length > 20);
    const ces = [...document.querySelectorAll('[contenteditable="true"]')].filter(t => t.offsetParent !== null && (t.innerText || '').length > 20);
    return [...tas, ...ces].map(el => ({
      hint: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.closest('label')?.innerText || el.name || '').trim().slice(0, 120),
      value: (el.value ?? el.innerText ?? '').slice(0, 1500)
    }));
  }

  // ============================================================
  // PROMPT — no hardcoded topic, no hardcoded shape
  // ============================================================
  function buildForgePrompt(steps, userCtx, existingFields) {
    const stepBlob = steps.map(s => `### ${s.label}\n${s.content.slice(0, 2600)}`).join('\n\n');

    const ctxBlock = userCtx && userCtx.trim()
      ? `\n\nSTUDENT'S ONGOING PROJECT CONTEXT (reference this when the assignment asks about "your project"):\n"""\n${userCtx.trim().slice(0, 1200)}\n"""`
      : `\n\nNo project context provided — if the assignment references "your project" or "your proposal", write generically but coherently and note in the label that context was missing.`;

    const fieldsBlock = existingFields.length
      ? `\n\nEXISTING EDITABLE TEXT ALREADY ON THE PAGE (match this voice; extend, don't contradict):\n` +
        existingFields.map((f, i) => `[field ${i + 1}${f.hint ? ' — ' + f.hint : ''}]\n${f.value}`).join('\n\n')
      : '';

    return `You are a student completing a class assignment. Your output will be pasted verbatim into a submission box. Write in first person, as the student. Be specific, concrete, and address the assignment's actual language. No hedging, no "as an AI", no meta commentary, no "I hope this helps".

Read the assignment carefully. Then, for EVERY task, step, prompt, section, or question it asks for, produce ONE deliverable. Mirror the assignment's own structure — if it asks for 4 steps, return 4 deliverables named after those steps. If it's one essay prompt, return one deliverable. If it asks for a template section, return that section.

If the assignment asks the student to include a "template section" (e.g. a rubric heading), produce that as a normal deliverable.

Assignment content (all steps already scraped):
${stepBlob}${ctxBlock}${fieldsBlock}

Return STRICT JSON only — no prose, no markdown fences, no preamble. Schema:
{
  "assignment_title": "<inferred from page>",
  "deliverables": [
    {
      "label": "<exact step / section / prompt name from the assignment>",
      "answer": "<the full text the student pastes. Plain prose. Multi-paragraph ok. Match the assignment's expected depth. 100–400 words per deliverable unless the step clearly wants more.>"
    }
  ]
}

Rules:
- One deliverable per distinct ask in the assignment. Do not merge steps. Do not invent steps.
- If a step asks sub-questions (bullets like "What can your AI handle?"), answer them inside that deliverable as flowing prose, not as restated bullet lists.
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

  async function groq(prompt, maxTokens) {
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

  // ============================================================
  // MAIN FLOW
  // ============================================================
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
      log('prompt', prompt.length, 'chars — calling', CFG.ai.model);
      const raw = await groq(prompt);
      const parsed = parseForge(raw);
      F.title = parsed.assignment_title || document.title || 'Assignment';
      F.deliverables = parsed.deliverables;
      F.history.unshift({
        ts: Date.now(),
        title: F.title,
        steps: steps.length,
        deliverables: F.deliverables
      });
      F.history = F.history.slice(0, 40);
      localStorage.setItem(LS_HIST, JSON.stringify(F.history));
      log('forged', F.deliverables.length, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      log('forge failed:', e.message);
      F.deliverables = [{ label: 'Error', answer: 'Forge failed: ' + e.message }];
    } finally {
      F.running = false; renderForge();
    }
  }

  // ============================================================
  // UI
  // ============================================================
  function injectTab() {
    const tabsBar = document.querySelector('#' + PID + ' .c-tabs');
    if (!tabsBar || tabsBar.querySelector('[data-tab="forge"]')) return;
    const btn = document.createElement('button');
    btn.className = 'c-tab';
    btn.dataset.tab = 'forge';
    btn.textContent = 'Forge';
    btn.onclick = () => {
      document.querySelectorAll('#' + PID + ' .c-tab').forEach(b => b.classList.toggle('c-tab-active', b === btn));
      document.querySelectorAll('#' + PID + ' .c-view').forEach(v => {
        v.style.display = v.dataset.view === 'forge' ? '' : 'none';
      });
      renderForge();
    };
    tabsBar.insertBefore(btn, tabsBar.querySelector('[data-tab="history"]'));

    const body = document.querySelector('#' + PID + ' .c-body');
    const view = document.createElement('div');
    view.className = 'c-view';
    view.dataset.view = 'forge';
    view.style.display = 'none';
    view.innerHTML = `
      <div class="c-label">Your project context (saved — one line or a paragraph)</div>
      <textarea id="${PID}_forgeCtx" class="c-input" style="height:56px;font-size:11px;resize:vertical;" placeholder="e.g. My final project is a study companion app that generates practice questions from student notes for high schoolers."></textarea>
      <div class="c-row" style="margin-top:6px;">
        <button class="c-btn c-btn-primary" id="${PID}_forgeGo">Forge This Assignment</button>
        <button class="c-btn c-btn-ghost" id="${PID}_forgeCopyAll">Copy All</button>
      </div>
      <div class="c-row">
        <button class="c-btn c-btn-ghost" id="${PID}_forgeDl">Download .txt</button>
        <button class="c-btn c-btn-ghost" id="${PID}_forgeClear">Clear</button>
      </div>
      <div class="c-label">Status</div>
      <div class="c-a" id="${PID}_forgeStatus">idle</div>
      <div class="c-label">Detected Steps</div>
      <div class="c-log" id="${PID}_forgeSteps">—</div>
      <div class="c-label">Deliverables</div>
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
          <button class="c-btn c-btn-ghost" data-copy="${i}" style="flex:0 0 auto;padding:4px 8px;font-size:10px;">Copy</button>
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

  // ============================================================
  // BOOT
  // ============================================================
  const boot = setInterval(() => {
    if (document.querySelector('#' + PID + ' .c-tabs')) {
      clearInterval(boot);
      injectTab();
      log('forge tab injected.');
    }
  }, 300);

  window.__forge = { run: forge, F, scrape: scrapeAllSteps };
})();
