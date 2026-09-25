// ==UserScript==
// @name         RSA Driving Test Watcher
// @namespace    mccoolsa.rsa-test-watcher
// @version      1.0
// @description  Checks the RSA driving test booking page every 7 minutes and alerts you when a test date shows up.
// @match        *://*.rsa.ie/*
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===== Settings =====
  const CHECK_EVERY_MIN = 7;       // how often to check (minutes)
  const BEEP_EVERY_SEC = 5;        // how often to beep when a date is found (seconds)
  const BOOK_WAIT_MS = 40000;      // wait this long for the booking page to load
  const OPEN_WAIT_MS = 2000;       // wait this long for the dropdown to open
  const RETRY_CLICK_MS = 15000;    // click a button again if nothing happened
  const FLOW_TIMEOUT_MS = 150000;  // give up and warn you if the booking page never loads
  const START_URL = 'https://myroadsafety.rsa.ie/portal/my-goals';

  // Optional: paste your Discord webhook URL here to get pinged on your phone.
  // Leave it as '' if you don't want Discord alerts.
  const DISCORD_WEBHOOK = '';
  const DISCORD_REPEAT_MIN = 5;    // ping again every 5 min until you press Silence

  // ===== Saved state =====
  const LS_KEY = 'rsaWatcherEnabled';
  const LS_NEXT = 'rsaWatcherNextCheckAt';
  const LS_FLOW = 'rsaWatcherFlow';
  let enabled = safeGet(LS_KEY) === '1';
  let nextCheckAt = Number(safeGet(LS_NEXT)) || Date.now() + 5000;
  let alarmTimer = null;
  let alarmKind = null;            // 'slot' or 'logout'
  let busy = false;
  let audioCtx = null;
  const origTitle = document.title;

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  const loadFlow = () => { try { return JSON.parse(safeGet(LS_FLOW)); } catch { return null; } };
  const saveFlow = (f) => safeSet(LS_FLOW, JSON.stringify(f));
  const clearFlow = () => safeSet(LS_FLOW, 'null');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toLocaleTimeString();

  // ===== Finding things on the page =====
  const inPanel = (el) => el.closest('#rsa-watcher-panel');

  function leafWithText(text) {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (inPanel(el)) continue;
      if (el.children.length === 0 && el.textContent.trim() === text && el.offsetParent !== null) out.push(el);
    }
    return out;
  }

  function findButton(text) {
    const want = text.toLowerCase();
    for (const el of document.querySelectorAll('a,button,[role="button"]')) {
      if (inPanel(el) || el.offsetParent === null) continue;
      if (el.textContent.trim().toLowerCase().startsWith(want)) return el;
    }
    return null;
  }

  function pressButton(el) {
    el.removeAttribute('target');
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  function findLocationField() {
    const label = leafWithText('Location')[0];
    if (!label) return null;
    const direct = label.closest('button,[role="button"],[role="combobox"],[aria-haspopup]');
    if (direct) return direct;
    let el = label;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (p.innerText.includes('Test Language') || p.getBoundingClientRect().height > 140) break;
      el = p;
    }
    return el;
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // Reads every centre in the open dropdown (works with any number of centres)
  function readRows() {
    const rows = [];
    for (const leaf of leafWithText('Next Date')) {
      let row = leaf;
      while (row.parentElement && (row.parentElement.innerText.match(/Next Date/g) || []).length === 1) row = row.parentElement;
      const lines = row.innerText.split('\n').map((s) => s.trim())
        .filter((s) => s && s !== 'Next Date' && !/^[✓✔]$/.test(s));
      if (lines.length >= 2) rows.push({ centre: lines[0], value: lines[lines.length - 1] });
    }
    return rows;
  }

  async function closeDropdown(field) {
    for (const t of [document.activeElement, document]) {
      t && t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
    await sleep(400);
    if (readRows().length && field) { realClick(field); await sleep(400); }
  }

  // ===== Checking the dropdown =====
  async function readDropdown(field) {
    if (alarmKind === 'logout') stopAlarm();
    realClick(field);
    await sleep(OPEN_WAIT_MS);
    const rows = readRows();
    await closeDropdown(field);

    if (!rows.length) { setStatus(`${now()} - opened the dropdown but couldn't read it`); return; }

    const hits = rows.filter((r) => !/no availability/i.test(r.value));
    console.log(`[RSA watcher] ${now()} ${rows.map((r) => `${r.centre}: ${r.value}`).join(' | ')}`);
    if (hits.length) {
      startAlarm('slot', hits.map((r) => `${r.centre}: ${r.value}`).join('\n'));
      setStatus(`${now()} - DATE FOUND! ${hits.map((r) => r.centre).join(', ')}`);
    } else {
      setStatus(`${now()} - ${rows.length} centres, all "No availability"`);
    }
  }

  // ===== Getting to the booking page =====
  // My Goals > View my steps > Book a driving test > wait > check dropdown
  async function runFlow() {
    if (busy) return;
    busy = true;
    try {
      while (enabled) {
        const flow = loadFlow();
        if (!flow) return;
        const t = Date.now();

        if (t - flow.startedAt > FLOW_TIMEOUT_MS) {
          clearFlow();
          setStatus(`${now()} - couldn't get to the booking page. Logged out?`);
          startAlarm('logout', "Couldn't get to the booking page. You might be logged out.");
          return;
        }

        const field = findLocationField();
        if (field) {
          if (!flow.fieldSeenAt) { flow.fieldSeenAt = t; saveFlow(flow); }
          const since = flow.bookAt || flow.fieldSeenAt;
          const left = BOOK_WAIT_MS - (t - since);
          if (left <= 0) { clearFlow(); await readDropdown(field); return; }
          setStatus(`${now()} - booking page loading, checking in ${Math.ceil(left / 1000)}s`);
        } else {
          const book = findButton('Book a driving test');
          const view = !book && findButton('View my steps');
          if (book) {
            if (!flow.bookAt || t - flow.bookAt > RETRY_CLICK_MS) {
              flow.bookAt = t; saveFlow(flow);
              setStatus(`${now()} - clicking "Book a driving test"`);
              pressButton(book);
            }
          } else if (view) {
            if (!flow.viewAt || t - flow.viewAt > RETRY_CLICK_MS) {
              flow.viewAt = t; saveFlow(flow);
              setStatus(`${now()} - clicking "View my steps"`);
              pressButton(view);
            }
          } else {
            setStatus(`${now()} - waiting for page`);
          }
        }
        await sleep(1000);
      }
    } catch (e) {
      setStatus(`${now()} - error: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  function scheduleNext(ms = CHECK_EVERY_MIN * 60 * 1000) {
    nextCheckAt = Date.now() + ms;
    safeSet(LS_NEXT, String(nextCheckAt));
  }

  function startCheck(fresh) {
    scheduleNext();
    saveFlow({ startedAt: Date.now() });
    if (fresh) location.href = START_URL;
    else runFlow();
  }

  // ===== Alerts =====
  function beep(kind) {
    if (!audioCtx) return;
    const freqs = kind === 'slot' ? [880, 1175, 880] : [330, 262];
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.25); t += 0.3;
    }
  }

  function notify(msg) {
    try { if (Notification.permission === 'granted') new Notification('RSA Test Watcher', { body: msg, requireInteraction: true }); } catch {}
  }

  function discord(text) {
    if (!DISCORD_WEBHOOK) return;
    const body = JSON.stringify({ content: `@everyone ${text}`, allowed_mentions: { parse: ['everyone'] } });
    const done = (ok, info) => console.log(`[RSA watcher] Discord ${ok ? 'sent' : 'FAILED'} ${info || ''}`);
    try {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url: DISCORD_WEBHOOK, headers: { 'Content-Type': 'application/json' }, data: body,
          onload: (r) => done(r.status < 300, r.status), onerror: () => done(false, 'network error'),
        });
      } else {
        const fd = new FormData(); fd.append('payload_json', body);
        fetch(DISCORD_WEBHOOK, { method: 'POST', mode: 'no-cors', body: fd }).then(() => done(true), (e) => done(false, e.message));
      }
    } catch (e) { done(false, e.message); }
  }

  function startAlarm(kind, msg) {
    if (alarmKind === kind) return;
    stopAlarm();
    alarmKind = kind;
    notify(msg);
    const discordMsg = kind === 'slot'
      ? `🚨 **Driving test date available!**\n${msg}\nBook now: ${START_URL}`
      : `⚠️ **RSA watcher: you might be logged out.** Log back in to keep watching.\n${START_URL}`;
    discord(discordMsg);
    let lastDiscordAt = Date.now();
    beep(kind);
    let flip = false;
    alarmTimer = setInterval(() => {
      if (Date.now() - lastDiscordAt >= DISCORD_REPEAT_MIN * 60 * 1000) {
        lastDiscordAt = Date.now();
        discord(`(reminder) ${discordMsg}`);
      }
      beep(kind);
      flip = !flip;
      document.title = flip ? (kind === 'slot' ? '🚨 DATE AVAILABLE' : '⚠️ LOGGED OUT?') : origTitle;
    }, BEEP_EVERY_SEC * 1000);
    panel.style.borderColor = kind === 'slot' ? '#0a0' : '#c00';
  }

  function stopAlarm() {
    clearInterval(alarmTimer); alarmTimer = null; alarmKind = null;
    document.title = origTitle;
    panel.style.borderColor = '#888';
  }

  // ===== The little box in the corner =====
  const panel = document.createElement('div');
  panel.id = 'rsa-watcher-panel';
  panel.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#fff;color:#111;border:3px solid #888;border-radius:8px;padding:8px 10px;font:12px/1.4 system-ui,sans-serif;width:280px;box-shadow:0 2px 10px rgba(0,0,0,.3)';
  panel.innerHTML = `
    <b>RSA Test Watcher</b> <small style="color:#666">v${typeof GM_info !== 'undefined' ? GM_info.script.version : '?'}</small> <span id="rw-next" style="float:right;color:#666"></span>
    <div id="rw-status" style="margin:6px 0;min-height:32px">Press Start to begin.</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap">
      <button id="rw-toggle"></button><button id="rw-now">Check now</button>
      <button id="rw-test">Test sound</button><button id="rw-silence">Silence</button>
      <button id="rw-discord">Test Discord</button>
    </div>`;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector('#' + id);
  function setStatus(s) { $('rw-status').textContent = s; }
  function renderToggle() { $('rw-toggle').textContent = enabled ? 'Stop' : 'Start'; }
  if (!DISCORD_WEBHOOK) $('rw-discord').style.display = 'none';

  // Browsers only allow sound after you click the page (or allow autoplay for the site)
  function armAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  armAudio();
  document.addEventListener('click', () => {
    armAudio();
    try { if (Notification.permission === 'default') Notification.requestPermission(); } catch {}
  }, true);
  const soundOk = () => audioCtx && audioCtx.state === 'running';

  $('rw-toggle').onclick = () => {
    enabled = !enabled; safeSet(LS_KEY, enabled ? '1' : '0'); renderToggle();
    if (enabled) { setStatus('Started.'); startCheck(false); }
    else { stopAlarm(); clearFlow(); setStatus('Stopped.'); }
  };
  $('rw-now').onclick = () => { if (enabled && !busy) startCheck(false); };
  $('rw-test').onclick = () => setTimeout(() => beep('slot'), 50);
  $('rw-silence').onclick = () => { stopAlarm(); scheduleNext(); };
  $('rw-discord').onclick = () => { discord('✅ RSA watcher test ping. Discord alerts are working.'); setStatus(`${now()} - Discord test sent`); };
  renderToggle();

  // Pick up where we left off after the page reloads
  const pending = loadFlow();
  if (enabled && pending) {
    if (Date.now() - pending.startedAt > FLOW_TIMEOUT_MS) { clearFlow(); setStatus('Running.'); }
    else runFlow();
  } else if (enabled) {
    setStatus('Running.');
  }

  // Main timer (paused while an alarm is going off)
  setInterval(() => {
    if (document.querySelectorAll('#rsa-watcher-panel').length > 1) {
      setStatus('⚠️ This script is installed more than once. Delete the extra copies in Tampermonkey.');
      panel.style.borderColor = '#f80';
    }
    if (!enabled) { $('rw-next').textContent = 'off'; return; }
    if (alarmKind) { $('rw-next').textContent = 'paused'; return; }
    const s = Math.max(0, Math.round((nextCheckAt - Date.now()) / 1000));
    $('rw-next').textContent = `${soundOk() ? '' : '🔇 '}next ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (Date.now() >= nextCheckAt && !busy) startCheck(true);
  }, 1000);
})();
