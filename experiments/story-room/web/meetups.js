'use strict';
// Shared invitations and live-scene links on the room and scene pages.
(() => {
 const root = document.querySelector('#meetups');
 const badge = document.querySelector('#meetup-badge');
 if (!root) return;
 let busy = false, signature = '', refreshing = false;
 const el = (tag, text, cls) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (cls) item.className = cls;
  return item;
 };
 const message = el('p', '', 'form-status'); message.setAttribute('role', 'status');
 async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
   method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not update this invitation.');
  return data;
 }
 function link(scene, text) {
  const item = el('a', text); item.href = `/scenes#${encodeURIComponent(scene.id)}`;
  item.onclick = () => window.dispatchEvent(new CustomEvent('meetup-select', {detail: scene.id}));
  return item;
 }
 async function answer(invite, answer) {
  if (busy) return;
  busy = true; root.querySelectorAll('button').forEach(b => { b.disabled = true; });
  message.textContent = answer === 'accept' ? 'Opening your scene…' : 'Declining invitation…';
  try {
   const result = await request(`/api/meetups/invites/${invite.id}/reply`, {answer});
   message.textContent = answer === 'accept' ? 'Accepted. Your scene is ready.' : 'Declined. Your choice is respected.';
   signature = '';
   if (result.scene_id) {
    const target = {id: result.scene_id};
    message.append(document.createTextNode(' '), link(target, 'Open scene →'));
    window.dispatchEvent(new CustomEvent('meetup-select', {detail: result.scene_id}));
   }
  } catch (error) { message.textContent = error.message; }
  finally { busy = false; signature = ''; await refresh(); }
 }
 function render(data) {
  const pending = data.invites.filter(i => i.to === 'Mystery' && i.status === 'pending');
  if (badge) {
   badge.hidden = !pending.length && !data.live.length;
   badge.textContent = [pending.length ? `${pending.length} invitation${pending.length > 1 ? 's' : ''}` : '',
    data.live.length ? 'Meetup live' : ''].filter(Boolean).join(' · ') + ' ↗';
  }
  root.replaceChildren();
  if (data.live.length) {
   root.append(el('h2', 'Happening now'));
   for (const scene of data.live) {
    const row = el('p'); row.append(link(scene, `${scene.participants.join(' & ')} · ${scene.location} →`)); root.append(row);
   }
  }
  if (pending.length) {
   root.append(el('h2', 'Invitations for Mystery'));
   for (const invite of pending) {
    const row = el('article', undefined, 'scene-choice');
    row.append(el('strong', `${invite.from} invited you · ${invite.kind.replace('_', ' ')}`),
     el('p', `${invite.where} · ${invite.when}${invite.note ? ' — ' + invite.note : ''}`));
    for (const value of ['accept', 'decline']) {
     const button = el('button', value === 'accept' ? 'Accept' : 'Decline', 'secondary');
     button.type = 'button'; button.disabled = busy; button.onclick = () => answer(invite, value); row.append(button);
    }
    root.append(row);
   }
  }
  if (document.body.classList.contains('scenes-page') && data.invites.length) {
   const history = el('details'); history.append(el('summary', 'Recent invitations'));
   for (const invite of data.invites.slice(-8).reverse()) {
    const row = el('p', `${invite.from} → ${invite.to}: ${invite.kind.replace('_', ' ')} · ${invite.status}`);
    if (invite.scene_id) row.append(document.createTextNode(' · '), link({id: invite.scene_id}, 'Watch scene'));
    history.append(row);
   }
   root.append(history);
  }
  root.append(message);
 }
 async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
   const data = await request('/api/meetups'); const next = JSON.stringify(data);
   if (next !== signature) { render(data); signature = next; }
  } catch (error) { message.textContent = error.message; if (!message.isConnected) root.append(message); }
  finally { refreshing = false; }
 }
 refresh(); setInterval(refresh, 1500);
})();
