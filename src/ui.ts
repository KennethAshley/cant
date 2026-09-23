// Served by the daemon: no frontend build, external assets, or browser-held private keys.
import { themes, themeCss, appearanceJs } from "./themes.ts";
import type { Message } from "./nostr.ts";

export function threadTitle(messages: Pick<Message, "thread" | "type" | "text" | "title">[]): string {
  const conversation = messages.filter(m => ["ask", "answer", "done", "cant", "escalate"].includes(m.type));
  const title = conversation.find(m => m.title)?.title;
  if (title) return title;
  const first = conversation.find(m => m.type === "ask") ?? conversation[0];
  const text = first?.text.replace(/\s+/g, " ").trim() ?? "";
  const opening = text.split(" ").slice(0, 7).join(" ").slice(0, 64).trimEnd();
  return opening ? opening + (opening.length < text.length ? "…" : "") : messages[0]?.thread.slice(0, 8) ?? "Conversation";
}

export const uiHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Sidecar · Conversations</title><link rel="icon" href="data:,">
<script src="/ui.js"></script><link rel="stylesheet" href="/ui.css"></head>
<body><div class="workspace">
<aside class="sidebar" aria-label="Conversations">
  <header class="brand"><span class="brand-mark" aria-hidden="true">&gt;_</span><span>sidecar</span><span class="local-label">local</span></header>
  <div class="identity"><div id="self-avatar" class="avatar">S</div><div><strong id="self-name">Connecting…</strong><span id="connection" role="status">Opening your inbox</span></div></div>
  <div class="sidebar-heading"><h1>Conversations</h1><span id="thread-count" class="count">0</span></div>
  <label class="attention-filter">Attention <select id="attention-filter"><option value="now">Now</option><option value="later">Later</option><option value="all" selected>All conversations</option></select></label>
  <label class="search-label"><span class="sr-only">Search conversations</span><input id="search" type="search" placeholder="/ search conversations" autocomplete="off"></label>
  <nav id="threads" aria-label="Conversation list"></nav>
  <section class="agents-section"><div class="sidebar-heading"><h2>Discovered agents</h2><button id="discover" class="text-button">Refresh</button></div><div id="agents"><p class="muted">Finding profiles…</p></div></section>
  <footer class="sidebar-footer"><span class="lock" aria-hidden="true">↔</span><div>Encrypted conversations<span id="relay-name">Your configured relay</span></div><button class="appearance-toggle" popovertarget="appearance" aria-label="Appearance" title="Appearance"><span aria-hidden="true">◐</span></button>
  <section id="appearance" class="appearance-panel" popover aria-labelledby="appearance-title">
    <div class="appearance-heading"><h2 id="appearance-title">Appearance</h2><span class="theme-swatches" aria-hidden="true"><i></i><i></i><i></i></span></div>
    <label for="theme">Theme</label><select id="theme">${Object.entries(themes).map(([id, theme]) => `<option value="${id}">${theme.name}</option>`).join("")}</select>
    <label for="color-mode">Color mode</label><select id="color-mode"><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select>
    <p id="appearance-note" role="status">Saved in this browser.</p>
  </section>
  </footer>
</aside>
<main id="main" tabindex="-1">
  <header class="conversation-header"><div><h2 id="conversation-title"># conversations</h2><p id="conversation-context">Your local chat log</p></div><div id="thread-controls" hidden><div class="control-buttons"><button id="stop-thread" class="secondary" title="Cancel current and queued work on this conversation">Stop</button><button id="pause-thread" class="secondary" title="Cancel the current turn and hold queued and new messages until resumed">Pause</button><button id="copy-thread" class="secondary" hidden>Copy thread ID</button></div><p id="control-status" role="status" aria-live="polite"></p></div></header>
  <div id="error" role="alert" hidden></div>
  <div id="timeline" class="timeline"><div class="empty"><div class="empty-mark" aria-hidden="true">#</div><h3>No conversation selected.</h3><p>Your agents’ messages and Jev decisions appear here.</p><p class="empty-hint">Send a message with your agent’s Sidecar tools to start a thread.</p></div></div>
  <div id="working" class="working" role="status" aria-live="polite" aria-atomic="true" hidden></div>
  <footer class="conversation-footer"><span id="view-note">Your messages stay on your Sidecar.</span><span id="updated">Waiting for messages</span></footer>
</main></div><div id="toast" role="status" hidden></div></body></html>`;

export const uiCss = `
.working{padding:10px 24px;color:var(--secondary);font-size:11px;border-top:1px solid var(--line)}
:root{color-scheme:dark;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:13px;color:var(--ink);background:var(--base);font-synthesis:none;--base:#1d2021;--panel:#282828;--raised:#32302f;--line:#504945;--ink:#ebdbb2;--soft:#bdae93;--muted:#a89984;--accent:#d79921;--secondary:#83a598;--tertiary:#d3869b;--code:#d5c4a1;--error:#fabd2f}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit;color:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}h1,h2,h3,p{margin:0}[hidden]{display:none!important}::selection{background:var(--line);color:var(--ink)}*{scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.workspace{display:grid;grid-template-columns:270px minmax(0,1fr);height:100dvh;max-width:1900px;margin:auto;border-inline:1px solid var(--line)}
.sidebar{background:var(--base);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;padding:0 12px}
.brand{height:73px;display:flex;align-items:center;gap:10px;padding:0 8px;border-bottom:1px solid var(--line);font-weight:700;font-size:19px;letter-spacing:-.7px}.brand-mark{color:var(--accent);font-size:21px;letter-spacing:-3px;padding-right:4px}.local-label{margin-left:auto;font-size:10px;font-weight:400;color:var(--muted);letter-spacing:0}.local-label:before{content:'['}.local-label:after{content:']'}
.identity{display:flex;align-items:center;gap:10px;padding:18px 8px 22px}.identity strong{display:block;font-size:12px;font-weight:500;color:var(--ink)}.identity span{display:block;color:var(--muted);font-size:10px;margin-top:5px}.avatar{display:grid;place-items:center;width:26px;height:26px;flex:none;border:1px solid var(--line);color:var(--accent);font-size:10px}.avatar.alt{color:var(--secondary)}
.sidebar-heading{display:flex;align-items:center;justify-content:space-between;padding:0 8px 12px}.sidebar-heading h1,.sidebar-heading h2{font-size:11px;font-weight:500;color:var(--soft)}.count{font-size:10px;color:var(--muted)}.count:before{content:'['}.count:after{content:']'}
.attention-filter{display:flex;align-items:center;gap:10px;padding:0 8px 10px;font-size:10px;color:var(--muted)}.attention-filter select{flex:1;min-width:0;border:1px solid var(--line);border-radius:3px;padding:6px;background:var(--panel);font-size:11px}.search-label{display:block;padding:0 8px 16px}input{width:100%;border:0;border-bottom:1px solid var(--line);background:transparent;padding:8px 0;font-size:11px;outline-offset:4px}input::placeholder{color:var(--muted)}
#threads{overflow:auto;min-height:100px;flex:1;padding:0 0 12px}.thread{display:block;width:100%;text-align:left;border:0;border-left:2px solid transparent;background:transparent;border-radius:0;padding:11px 10px;margin:0 0 3px}.thread:hover{background:var(--panel)}.thread[aria-current="true"]{background:var(--raised);border-left-color:var(--accent)}.thread-top{display:flex;align-items:center;gap:8px;margin-bottom:6px}.thread-title{font-size:12px;font-weight:600;color:var(--soft);flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.thread[aria-current="true"] .thread-title{color:var(--accent)}.thread-time{font-size:10px;color:var(--muted)}.thread-preview{font-size:11px;color:var(--muted);line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.thread-status{display:block;margin-top:7px;font-size:9px;color:var(--secondary)}.thread-status.attention{color:var(--accent)}
.agents-section{border-top:1px solid var(--line);padding:15px 0 8px;max-height:200px;overflow:auto}.text-button{background:transparent;border:0;font-size:10px;color:var(--secondary);padding:3px}.agent{display:flex;align-items:center;gap:9px;padding:7px 8px}.agent-name{font-size:11px;color:var(--soft);overflow-wrap:anywhere}.agent-caps{font-size:9px;color:var(--muted);margin-top:4px;max-width:178px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.muted{color:var(--muted);font-size:11px;padding:8px;line-height:1.7}
.sidebar-footer{display:flex;align-items:center;gap:8px;border-top:1px solid var(--line);padding:11px 8px;font-size:9px;color:var(--muted)}#relay-name{display:block;font-size:11px;margin-top:4px;color:var(--soft)}.lock{font-size:18px;color:var(--secondary)}
main{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--panel)}.conversation-header{min-height:73px;padding:14px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:16px}.conversation-header{flex-wrap:wrap}.control-buttons{display:flex;flex-wrap:wrap;gap:6px}#control-status{max-width:440px}.secondary:disabled{opacity:.5;cursor:wait}.conversation-header h2{font-size:16px;font-weight:500;color:var(--accent);letter-spacing:-.3px;overflow-wrap:anywhere}.conversation-header p{font-size:10px;line-height:1.6;color:var(--muted);margin-top:6px}.secondary{background:transparent;border:1px solid var(--line);border-radius:3px;padding:7px 10px;font-size:10px;white-space:nowrap;color:var(--soft)}.secondary:hover{background:var(--raised);border-color:var(--muted)}
.timeline{overflow:auto;flex:1;padding:22px 24px 36px}.empty{margin:36px 0 0 70px;max-width:55ch;color:var(--muted)}.empty-mark{font-size:24px;color:var(--accent);margin-bottom:16px}.empty h3{font-size:15px;font-weight:500;color:var(--soft)}.empty p{font-size:12px;line-height:1.8;margin-top:12px}.empty .empty-hint{font-size:11px;margin-top:22px}.day-divider{display:flex;align-items:center;gap:16px;font-size:10px;color:var(--muted);margin:0 0 25px}.day-divider:after{content:"";height:1px;background:var(--line);flex:1}
.message{display:grid;grid-template-columns:48px minmax(0,1fr);gap:20px;margin:0 0 26px}.message-time{color:var(--muted);font-size:10px;padding-top:3px;line-height:1.5}.message-content{min-width:0;max-width:80ch}.message-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:10px;line-height:1.6;margin-bottom:7px;color:var(--muted)}.message-meta strong{font-size:12px;font-weight:600;color:var(--accent)}.message-meta strong:before{content:'<'}.message-meta strong:after{content:'>'}.message-meta .sender-1{color:var(--secondary)}.message-meta .sender-2{color:var(--tertiary)}.message-type{color:var(--muted)}.message-type:before{content:'['}.message-type:after{content:']'}.attention-label{margin-left:auto;color:var(--muted);font-size:10px}.attention-label.now{color:var(--accent)}.attention-label.later{color:var(--secondary)}
.bubble{font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}.bubble strong{font-weight:650}.bubble code{font:inherit;color:var(--code);background:var(--base);padding:1px 4px;border-radius:2px}.bubble pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--base);border:1px solid var(--line);border-left:2px solid var(--accent);padding:12px 15px;margin:12px 0;font-size:12px;line-height:1.7}.bubble pre code{padding:0;background:none}.attribution{font-size:9px;color:var(--muted);margin-top:8px}
.decision{display:inline-block;max-width:100%;margin:8px 16px 0 0;vertical-align:top}.decision summary{cursor:pointer;font-size:10px;color:var(--secondary);padding:3px 0;list-style:none}.decision summary::-webkit-details-marker{display:none}.decision summary:before{content:'↳ ';color:var(--muted)}.decision summary:after{content:' +';color:var(--muted)}.decision[open] summary:after{content:' −'}.decision.good summary{color:var(--soft)}.decision.warn summary{color:var(--accent)}.decision-body{border-left:1px solid var(--line);padding:8px 12px;margin-top:4px;max-width:65ch;font-size:11px;color:var(--soft);line-height:1.8;white-space:pre-wrap}.decision-body p+p{margin-top:5px}
.reaction-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:7px}.reaction{border:1px solid var(--line);border-radius:3px;background:transparent;padding:2px 7px;font-size:11px;line-height:1.5}.reaction.mine{background:var(--raised);border-color:var(--accent)}.reaction-picker{position:relative;display:inline-block}.reaction-picker summary{font-size:10px;color:var(--muted);cursor:pointer;list-style:none;padding:3px 0}.reaction-picker summary:hover{color:var(--ink)}.reaction-options{position:absolute;z-index:2;top:24px;left:0;display:flex;gap:3px;background:var(--base);border:1px solid var(--line);border-radius:3px;padding:5px;box-shadow:0 4px 12px #0005}.reaction-options button{border:0;background:transparent;font-size:17px;border-radius:2px;padding:5px 8px}.reaction-options button:hover{background:var(--raised)}
.event{margin:0 0 20px;color:var(--muted);font-size:10px;display:grid;grid-template-columns:48px minmax(0,1fr);gap:20px;line-height:1.7}.event span:before{content:'-- ';color:var(--secondary)}.conversation-footer{padding:9px 24px;border-top:1px solid var(--line);background:var(--base);font-size:9px;color:var(--muted);display:flex;justify-content:space-between;gap:20px;line-height:1.6}#updated{white-space:nowrap;color:var(--soft)}#error{background:var(--base);color:var(--error);border-bottom:1px solid var(--error);padding:12px 24px;font-size:12px}#toast{position:fixed;bottom:48px;left:50%;transform:translateX(-50%);background:var(--raised);border:1px solid var(--accent);color:var(--ink);padding:10px 16px;font-size:12px;max-width:90vw;z-index:10}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.appearance-toggle{anchor-name:--appearance;margin-left:auto;display:grid;place-items:center;flex:none;width:30px;height:30px;padding:0;background:transparent;border:1px solid var(--line);border-radius:3px;color:var(--soft);font-size:18px}.appearance-toggle:hover{color:var(--accent);background:var(--raised)}
.appearance-panel{position:fixed;inset:auto auto 64px max(20px,calc((100vw - 1900px)/2 + 20px));margin:0;width:238px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;padding:18px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:4px;box-shadow:0 12px 32px #0004}.appearance-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.appearance-heading h2{font-size:12px;font-weight:500;color:var(--soft)}.theme-swatches{display:flex;gap:4px}.theme-swatches i{width:9px;height:9px;border-radius:2px;background:var(--accent)}.theme-swatches i:nth-child(2){background:var(--secondary)}.theme-swatches i:nth-child(3){background:var(--tertiary)}.appearance-panel label{display:block;font-size:10px;color:var(--muted);margin-bottom:7px}.appearance-panel select{display:block;width:100%;padding:8px;border:1px solid var(--line);border-radius:3px;background:var(--base);margin-bottom:16px;font-size:12px}.appearance-panel p{font-size:10px;color:var(--muted);line-height:1.6}
${themeCss}
@media(min-width:1500px){.workspace{grid-template-columns:290px minmax(0,1fr)}.timeline{padding:28px 32px}.conversation-header{padding-inline:32px}}
@media(max-width:850px){.workspace{grid-template-columns:230px minmax(0,1fr)}.sidebar{padding-inline:8px}.conversation-header{padding:14px 18px}.timeline{padding:20px 18px}.message,.event{grid-template-columns:40px minmax(0,1fr);gap:12px}.message-meta{gap:6px}.attention-label{margin-left:0}.conversation-footer{padding-inline:18px}.agent-caps{max-width:150px}}
@media(max-width:580px){.workspace{display:flex;flex-direction:column;height:auto;min-height:100dvh;border:0}.sidebar{border-right:0;border-bottom:1px solid var(--line);padding:0 14px}.brand{height:48px}.appearance-panel{inset:50% auto auto 50%;transform:translate(-50%,-50%)}.identity,.agents-section{display:none}.sidebar-heading{padding:13px 4px 10px}.attention-filter{padding:0 4px 5px}.search-label{padding:0 4px 10px}#threads{display:flex;gap:5px;min-height:0;max-height:122px;padding-bottom:10px;flex:none}.thread{flex:0 0 220px;margin:0;padding:9px 10px}.thread-preview{-webkit-line-clamp:1}.thread-status{margin-top:5px}main{min-height:60dvh}.conversation-header{min-height:73px;padding:13px 16px}.conversation-header p{font-size:9px}.timeline{overflow:visible;padding:20px 16px}.message{gap:10px;grid-template-columns:34px minmax(0,1fr)}.message-meta strong{font-size:11px}.message-time{font-size:9px}.bubble{font-size:12px}.empty{margin:20px 0}.secondary{padding:6px;font-size:9px}.conversation-footer{margin-top:auto;padding:9px 16px;flex-wrap:wrap;gap:5px}.event{grid-template-columns:34px minmax(0,1fr);gap:10px}}
@supports(position-anchor:--appearance){@media(min-width:581px){.appearance-panel{position-anchor:--appearance;inset:auto auto calc(anchor(top) + 8px) max(16px,calc(anchor(right) - 238px));transform:none}}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

export const uiJs = appearanceJs + '\n' + threadTitle.toString() + String.raw`
'use strict';
document.addEventListener('DOMContentLoaded', () => {
const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
let state, selected = location.hash.slice(1), signature = '', busy = false, controlling = false, toastTimer;
const expanded = new Set();
const short = key => key ? key.slice(0, 8) + '…' : 'Unknown';
const name = key => key === state.me.pubkey ? state.me.name : state.profiles.find(p => p.pubkey === key)?.name || short(key);
const percent = n => Math.round(n * 100) + '%';
const time = ts => new Date(ts * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4000); }
async function rpc(method, args = {}) {
  const response = await fetch('/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method,args}), signal:AbortSignal.timeout(10000)});
  const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Request failed'); return body.result;
}
function threads() {
  const grouped = new Map();
  for (const message of state.messages) { if (!grouped.has(message.thread)) grouped.set(message.thread, []); grouped.get(message.thread).push(message); }
  return [...grouped].sort((a,b) => b[1].at(-1).receivedAt - a[1].at(-1).receivedAt);
}
function visibleThreads(groups) {
  const filter = $('attention-filter').value, query = $('search').value.toLowerCase();
  return groups.filter(([, messages]) => (filter === 'all' || messages.some(m => m.attention === filter)) &&
    (!query || (threadTitle(messages) + ' ' + threadNames(messages) + ' ' + messages.map(m => m.text).join(' ')).toLowerCase().includes(query)));
}
function threadNames(messages) { const people = [...new Set(messages.filter(m => m.type !== 'reaction').flatMap(m => [m.from, m.to]))]; return people.map(name).join(' ↔ '); }
function status(messages) {
  const last = messages.filter(m => m.type !== 'reaction').at(-1);
  if (!last) return '';
  if (messages.some(m => m.delivery === 'pending')) return 'Saved locally · waiting for relay';
  if (last.work === 'interrupted') return 'Interrupted · needs review';
  if (last.triage?.action === 'unavailable') return 'Jev check unavailable';
  if (last.type === 'done') return last.verification?.status === 'passed' ? '✓ Completed · Jev verified' : '✓ Completed · not verified';
  if (last.type === 'cant') return 'Needs attention';
  if (last.triage?.action === 'ignore') return 'No reply needed';
  if (last.type === 'escalate' || last.triage?.action === 'escalate') return 'Owner decision needed';
  if (last.type === 'ack') return 'Accepted · working';
  if (last.triage?.action === 'ask' || last.type === 'answer') return 'Conversation open';
  return 'Request sent';
}
function renderThreads(groups) {
  $('thread-count').textContent = groups.length;
  const container = $('threads'); container.replaceChildren();
  for (const [id, messages] of groups) {
    const title = '# ' + threadTitle(messages);
    const first = messages.find(m => m.type === 'ask') || messages.find(m => m.type !== 'reaction') || messages[0];
    const button = el('button', 'thread'); button.title = threadNames(messages); button.type = 'button'; button.setAttribute('aria-current', String(id === selected));
    const top = el('div', 'thread-top'); top.append(el('span','thread-title',title), el('span','thread-time',time(messages.at(-1).ts)));
    const label = status(messages); button.append(top,el('div','thread-preview',first.text),el('span','thread-status' + (/attention|decision/.test(label) ? ' attention' : ''),label));
    button.addEventListener('click',() => { selected = id; history.replaceState(null,'','#' + id); render(); $('main').focus({preventScroll:true}); }); container.append(button);
  }
  if (!container.childElementCount) container.append(el('p','muted','No conversations in this view. Choose All conversations to see everything.'));
}
function renderAgents() {
  const container = $('agents'); container.replaceChildren();
  for (const profile of state.profiles) {
    const row = el('div','agent'); row.title = profile.about + '\n' + profile.capabilities.join(', ') + '\n' + profile.pubkey;
    const info = el('div'); info.append(el('div','agent-name',profile.name || short(profile.pubkey)),el('div','agent-caps',profile.capabilities.join(', ') || 'No capabilities listed'));
    row.append(el('div','avatar alt',(profile.name || '?').slice(0,2).toUpperCase()),info); container.append(row);
  }
  if (!container.childElementCount) container.append(el('p','muted','No other profiles found. Refresh to look again.'));
}
function decision(id, label, detail, tone) {
  const node = el('details','decision ' + tone); node.open = expanded.has(id);
  node.addEventListener('toggle',() => node.open ? expanded.add(id) : expanded.delete(id));
  node.append(el('summary','',label),el('div','decision-body',detail)); return node;
}
function renderBody(text) {
  const node = el('div','bubble');
  // Text nodes only, including code: message content is never interpreted as HTML.
  const tick = String.fromCharCode(96);
  const fence = new RegExp(tick.repeat(3) + '(?:[\\w-]+)?\\n([\\s\\S]*?)' + tick.repeat(3),'g');
  function prose(chunk) {
    const pattern = new RegExp('\\*\\*([^*]+)\\*\\*|' + tick + '([^' + tick + '\\n]+)' + tick,'g');
    let cursor = 0;
    for (const match of chunk.matchAll(pattern)) { node.append(document.createTextNode(chunk.slice(cursor,match.index)),el(match[1] === undefined ? 'code' : 'strong','',match[1] ?? match[2])); cursor = match.index + match[0].length; }
    node.append(document.createTextNode(chunk.slice(cursor)));
  }
  let start = 0;
  for (const match of text.matchAll(fence)) { prose(text.slice(start,match.index)); const pre = el('pre'); pre.append(el('code','',match[1].trimEnd())); node.append(pre); start = match.index + match[0].length; }
  prose(text.slice(start).replace(/^\n/,'')); return node;
}
async function react(id, emoji, button) {
  button.disabled = true;
  try { await rpc('react',{id,text:emoji}); expanded.delete('reaction-' + id); toast('Reaction sent'); await refresh(true); }
  catch (error) { toast(error.message); } finally { button.disabled = false; }
}
function reactions(message, messages) {
  const row = el('div','reaction-row'); const grouped = new Map();
  for (const reaction of messages.filter(m => m.type === 'reaction' && m.reactionTo === message.id)) {
    if (!grouped.has(reaction.text)) grouped.set(reaction.text,new Set()); grouped.get(reaction.text).add(reaction.from);
  }
  for (const [emoji, people] of grouped) {
    const chip = el('button','reaction' + (people.has(state.me.pubkey) ? ' mine' : ''),emoji + ' ' + people.size); chip.title = [...people].map(name).join(', '); chip.setAttribute('aria-label',emoji + ' from ' + chip.title);
    chip.addEventListener('click',() => react(message.id,emoji,chip)); row.append(chip);
  }
  const picker = el('details','reaction-picker'); const pickerId = 'reaction-' + message.id; picker.open = expanded.has(pickerId);
  picker.addEventListener('toggle',() => picker.open ? expanded.add(pickerId) : expanded.delete(pickerId));
  const summary = el('summary','','React'); summary.setAttribute('aria-label','React to message from ' + name(message.from)); picker.append(summary);
  const options = el('div','reaction-options');
  for (const [emoji,label] of [['👍','Thumbs up'],['👀','Eyes'],['🎉','Celebrate'],['❤️','Heart']]) { const button = el('button','',emoji); button.setAttribute('aria-label',label); button.addEventListener('click',() => react(message.id,emoji,button)); options.append(button); }
  picker.append(options); row.append(picker); return row;
}
function renderConversation(messages) {
  const container = $('timeline'); const wasBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100; const oldTop = container.scrollTop;
  container.replaceChildren(); $('copy-thread').hidden = !messages; $('thread-controls').hidden = !messages;
  renderControls();
  if (!messages) {
    $('conversation-title').textContent = '# conversations'; $('conversation-context').textContent = 'Your local chat log';
    const empty = el('div','empty'); empty.append(el('div','empty-mark','#'),el('h3','','No conversation selected.'),el('p','','Choose a conversation, or change the attention filter to see more.'),el('p','empty-hint','Send a message with your agent’s Sidecar tools. For an owner view, enable share_activity on your agents.')); container.append(empty); return;
  }
  $('conversation-title').textContent = '# ' + threadTitle(messages); $('conversation-context').textContent = threadNames(messages) + ' / ' + status(messages);
  const observed = messages.some(m => m.observedBy); $('view-note').textContent = observed ? 'Full conversation / encrypted owner copies' : 'Full conversation / encrypted messages';
  let date = '';
  for (const message of messages.filter(m => m.type !== 'reaction')) {
    const day = new Date(message.ts * 1000).toLocaleDateString([], {month:'long',day:'numeric',year:'numeric'});
    if (day !== date) { container.append(el('div','day-divider',day)); date = day; }
    if (message.type === 'ack') { const event = el('div','event'); event.append(el('time','',time(message.ts)),el('span','',name(message.from) + ' accepted the task' + (message.delivery === 'pending' ? ' · waiting for relay' : ''))); container.append(event); continue; }
    const article = el('article','message'); const content = el('div','message-content');
    const meta = el('div','message-meta'); const timestamp = el('time','message-time',time(message.ts)); timestamp.dateTime = new Date(message.ts * 1000).toISOString();
    meta.append(el('strong','sender-' + (parseInt(message.from.slice(0,2),16) % 3),name(message.from)),el('span','','to ' + name(message.to)),el('span','message-type',({ask:'Request',answer:'Reply',done:'Result',cant:'Needs review',escalate:'Owner needed',cancel:'Cancelled'})[message.type] || message.type));
    meta.append(el('span','attention-label ' + message.attention,({now:'attention: now',later:'attention: later',none:'quiet'})[message.attention] || 'attention: now'));
    content.append(meta,renderBody(message.text));
    if (message.delivery === 'pending') content.append(el('p','attribution','Saved locally · waiting for relay'));
    if (message.work === 'interrupted') content.append(el('p','attribution','Interrupted · review before sending a new request'));
    if (message.withheld) content.append(decision(message.id + '-held','Reply held for review',message.withheld.reason + '\n\nThis draft was not sent to the peer. Send a revised request to continue.\n\n' + message.withheld.text,'warn'));
    if (message.steering) {
      const s = message.steering; const label = s.action === 'interrupt' ? 'Interrupt previous turn' : 'Queue behind current turn';
      content.append(decision(message.id + '-steer',(s.probability === undefined ? 'Sidecar' : 'Jev') + ': ' + label,s.reason + (s.probability === undefined ? '' : '\nChanges the active work: ' + percent(s.probability))));
    }
    if (message.triage) {
      const t = message.triage; const labels = {act:'Ready to act',ask:'Clarification needed',ignore:'No reply needed',escalate:'Owner decision needed'};
      if (t.action === 'unavailable') {
        content.append(decision(message.id + '-triage','Jev check unavailable','No decision was returned; this message did not start agent work. Send a new request to retry.\n\n' + t.reason,'warn'));
      } else {
        const label = t.contradiction >= 0.8 ? 'Possible contradiction' : labels[t.action];
        content.append(decision(message.id + '-triage','jev: ' + label + ' ' + percent(t.confidence),'Decision confidence: ' + percent(t.confidence) + '\nIn scope: ' + percent(t.inScope) + (t.contradiction === undefined ? '' : '\nContradiction probability: ' + percent(t.contradiction)) + '\n' + t.reason,t.action === 'escalate' ? 'warn' : ''));
      }
    }
    if (message.verification) {
      const v = message.verification; const label = {passed:'jev: Verified ' + percent(v.probability || 0),failed:'jev: Incomplete',unavailable:'jev: Verification unavailable',skipped:'jev: Not checked'}[v.status];
      const detail = v.status === 'passed' || v.status === 'failed' ? 'Reported by ' + name(message.from) + '\nJev estimated a ' + percent(v.probability) + ' chance that this output answers the request. This is a completion check, not a test-suite result.' : v.status === 'skipped' ? 'No Jev key was configured for this completion. The result has not been checked by Jev.' : 'The Jev check failed. Review this result before treating the task as complete.';
      content.append(decision(message.id + '-verify',label,detail,v.status === 'passed' ? 'good' : 'warn'));
    }
    if (message.observedBy) content.append(el('p','attribution','Shared by ' + name(message.observedBy)));
    content.append(reactions(message,messages)); article.append(timestamp,content); container.append(article);
  }
  if (wasBottom) container.scrollTop = container.scrollHeight; else container.scrollTop = oldTop;
}
function render() {
  const groups = visibleThreads(threads());
  if (!groups.some(([id]) => id === selected)) { selected = groups[0]?.[0] || ''; history.replaceState(null,'','#' + selected); }
  $('self-name').textContent = state.me.name; $('self-avatar').textContent = state.me.name.slice(0,2).toUpperCase(); $('self-name').title = state.me.npub;
  $('relay-name').textContent = state.relays.map(url => url.replace('wss://','').replace('ws://','')).join(', ');
  renderThreads(groups); renderAgents(); renderConversation(groups.find(([id]) => id === selected)?.[1]);
  renderWorking();
}
function threadPaused() {
  return (state?.paused || []).includes(selected) || (state?.controls?.[selected] || []).some(c => c.paused || (c.action === 'pause' && c.accepted === undefined));
}
function renderControls() {
  $('pause-thread').textContent = threadPaused() ? 'Resume' : 'Pause';
  $('pause-thread').title = threadPaused() ? 'Release queued and new work; cancelled turns are not replayed' : 'Cancel the current turn and hold queued and new messages until resumed';
  $('stop-thread').disabled = $('pause-thread').disabled = controlling;
  const controls = state?.controls?.[selected] || [];
  $('control-status').textContent = controls.map(c => name(c.pubkey) + ': ' + c.action + (c.accepted === true ? ' accepted' : c.accepted === false ? ' declined' : ' awaiting agent')).join(' · ') || (threadPaused() ? 'Paused · queued and new messages are held' : '');
}
async function controlThread(action) {
  if (controlling || !selected) return;
  const thread = selected;
  controlling = true; renderControls();
  try { await rpc('control',{thread,action}); await refresh(true); }
  catch (error) { toast('Control request: ' + error.message); }
  finally { controlling = false; renderControls(); }
}
function renderWorking() {
  const people = [...new Set((state?.working || []).filter(w => w.thread === selected && Date.now() - w.at < 8000).map(w => name(w.from)))];
  const label = people.length ? people.join(', ') + (people.length === 1 ? ' is working…' : ' are working…') : '';
  if ($('working').textContent !== label) $('working').textContent = label;
  $('working').hidden = !label;
}
async function refresh(force = false) {
  if (busy) return; busy = true;
  try {
    const next = await rpc('timeline'); const {working, ...history} = next; const nextSignature = JSON.stringify(history); state = next;
    if (force || nextSignature !== signature) { signature = nextSignature; render(); }
    else renderWorking();
    $('error').hidden = true; $('connection').textContent = 'local session connected'; $('updated').textContent = 'synced ' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  } catch (error) { $('connection').textContent = 'Sidecar disconnected'; $('error').textContent = 'Cannot reach Sidecar. Start the daemon again; this page will reconnect automatically.'; $('error').hidden = false; }
  finally { busy = false; }
}
async function discover() {
  const button = $('discover'); button.disabled = true;
  try { await rpc('find_agents'); await refresh(true); } catch (error) { toast('Could not refresh agents: ' + error.message); } finally { button.disabled = false; }
}
$('stop-thread').addEventListener('click',() => controlThread('stop'));
$('pause-thread').addEventListener('click',() => controlThread(threadPaused() ? 'resume' : 'pause'));
$('discover').addEventListener('click',discover);
$('search').addEventListener('input',() => state && render());
$('attention-filter').addEventListener('change',() => state && render());
$('copy-thread').addEventListener('click',async () => { try { await navigator.clipboard.writeText(selected); toast('Thread ID copied'); } catch { toast('Thread ID: ' + selected); } });
window.addEventListener('hashchange',() => { selected = location.hash.slice(1); $('attention-filter').value = 'all'; $('search').value = ''; if (state) render(); });
refresh().then(discover);
// ponytail: polling is enough for a local two-agent inbox; use incremental updates if history becomes large.
setInterval(() => { renderWorking(); if (!document.hidden) refresh(); },2000);
document.addEventListener('visibilitychange',() => { if (!document.hidden) refresh(); });
});
`;
