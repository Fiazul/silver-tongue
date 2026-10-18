'use strict';
// Character-scheduled alarms: wake-up notifications/voice for Mystery and the portrait "Scheduled" list.
(() => {
 const dialog = document.querySelector('#portrait-dialog');
 const toolbar = document.querySelector('.voice-toolbar');
 let alarms = [], seen = null, refreshing = false;
 const el = (tag, text, cls) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (cls) item.className = cls;
  return item;
 };
 async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
   method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Alarm request failed');
  return data;
 }

 // Browser wake-ups: Notification permission is requested only on an explicit click.
 const allow = el('button', '⏰ Allow wake-ups', 'text-button');
 allow.type = 'button';
 allow.title = 'Lets characters wake you with a notification and their voice when an alarm they set for you goes off.';
 function renderAllow() {
  if (!('Notification' in window)) { allow.textContent = '⏰ Wake-ups: voice only'; allow.disabled = true; return; }
  const granted = Notification.permission === 'granted';
  allow.textContent = granted ? '⏰ Wake-ups on' : Notification.permission === 'denied' ? '⏰ Wake-ups blocked' : '⏰ Allow wake-ups';
  allow.disabled = granted || Notification.permission === 'denied';
 }
 allow.onclick = async () => {
  // The click also counts as user activation, so later wake-up audio may autoplay.
  try { await Notification.requestPermission(); } catch (_) { /* unsupported */ }
  renderAllow();
 };
 if (toolbar) { toolbar.prepend(allow); renderAllow(); }

 const wakePlayer = new Audio();
 function wake(message) {
  if ('Notification' in window && Notification.permission === 'granted') {
   try { new Notification(`⏰ ${message.name}`, {body: message.text, tag: `alarm-${message.id}`}); } catch (_) { /* ignore */ }
  }
  // Alarm messages play regardless of the Auto-listen toggle.
  wakePlayer.src = `/api/audio/${encodeURIComponent(message.id)}.wav`;
  wakePlayer.play().catch(() => {
   const status = document.querySelector('#voice-status');
   if (status) status.textContent = `⏰ ${message.name} sent you a wake-up. Press Listen on their message to hear it.`;
  });
 }

 // Portrait dialog: pending alarms for that character. Intent is private; the operator may expand it.
 const section = el('section', undefined, 'portrait-alarms');
 section.id = 'portrait-alarms';
 section.style.cssText = 'border-top:1px solid #eadbcf;margin-top:12px;padding-top:8px;text-align:left;font-size:11px';
 if (dialog) dialog.append(section);
 function renderSchedule() {
  if (!dialog || !dialog.open) return;
  const name = document.querySelector('#portrait-name')?.textContent || '';
  const mine = alarms.filter(a => a.owner === name);
  section.replaceChildren(el('h3', 'Scheduled', ''));
  section.querySelector('h3').style.cssText = 'font-size:12px;font-weight:500;margin:0 0 5px';
  if (!mine.length) { section.append(el('p', 'Nothing scheduled.', 'score-note')); return; }
  const list = el('ul'); list.style.cssText = 'list-style:none;padding:0;margin:0';
  for (const alarm of mine) {
   const row = el('li'); row.style.cssText = 'padding:5px 0;border-bottom:1px solid #eee3da';
   row.append(el('strong', `${alarm.at_local} → ${alarm.to}`), el('span', ` · ${alarm.channel}${alarm.status === 'firing' ? ' · going off now' : ''} `));
   const cancel = el('button', 'Cancel', 'text-button'); cancel.type = 'button';
   cancel.disabled = alarm.status !== 'pending';
   cancel.onclick = async () => {
    cancel.disabled = true;
    try { await request(`/api/alarms/${encodeURIComponent(alarm.id)}/cancel`, {}); await refresh(); }
    catch (error) { cancel.disabled = false; cancel.textContent = error.message; }
   };
   const details = el('details'); details.append(el('summary', 'Private intent'), el('p', alarm.intent));
   row.append(cancel, details); list.append(row);
  }
  section.append(list);
 }
 if (dialog) new MutationObserver(renderSchedule).observe(dialog, {attributes: true, attributeFilter: ['open']});

 async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
   const data = await request('/api/alarms');
   alarms = data.alarms || [];
   const ids = (data.wakeups || []).map(m => m.id);
   if (seen === null) seen = new Set(ids); // Never replay wake-ups that predate this page load.
   for (const message of data.wakeups || []) {
    if (!seen.has(message.id)) { seen.add(message.id); wake(message); }
   }
   if (!section.contains(document.activeElement)) renderSchedule();
  } catch (_) { /* The main page reports connectivity. */ }
  finally { refreshing = false; }
 }
 refresh(); setInterval(refresh, 3000);
})();
