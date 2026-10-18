'use strict';
const $ = selector => document.querySelector(selector);
const form = $('#create-scene');
let cast = [], scenes = [], current = null, selected = '', signature = '';
let pending = false, refreshing = false, imageDraft = null, imageReading = false, castSignature = '';
let sceneVersion = 0;
let audioURL = null, voiceRequest = null;
const drafts = new Map();
function node(tag, cls, text) {
 const element = document.createElement(tag);
 if (cls) element.className = cls;
 if (text !== undefined) element.textContent = text;
 return element;
}
async function api(path, body) {
 const response = await fetch(path, body === undefined ? {} : {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
 });
 const data = await response.json();
 if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
 return data;
}
function scenePath(id = selected) { return `/api/scenes/${encodeURIComponent(id)}`; }
function stopVoice() {
 voiceRequest?.abort(); voiceRequest = null;
 $('#scene-player').pause(); $('#scene-player').removeAttribute('src'); $('#scene-player').load();
 $('#scene-player').hidden = true; $('#audio-status').textContent = '';
 if (audioURL) URL.revokeObjectURL(audioURL);
 audioURL = null;
}
async function listen(message) {
 stopVoice(); const controller = new AbortController(); voiceRequest = controller;
 $('#audio-status').textContent = `Finding ${message.name}’s voice…`;
 try {
  const response = await fetch(`${scenePath()}/audio/${message.id}.wav`, {signal: controller.signal});
  if (!response.ok) throw new Error((await response.json()).error || 'Voice unavailable');
  const blob = await response.blob();
  if (voiceRequest !== controller) return;
  audioURL = URL.createObjectURL(blob); $('#scene-player').src = audioURL; $('#scene-player').hidden = false;
  await $('#scene-player').play(); $('#audio-status').textContent = `Speaking · ${message.name}`;
 } catch (error) {
  if (error.name !== 'AbortError' && voiceRequest === controller) $('#audio-status').textContent = error.message;
 }
}
function renderList() {
 const list = $('#scene-list'); list.replaceChildren();
 if (!scenes.length) list.append(node('p', '', 'No scenes yet. Invite someone below to begin.'));
 for (const scene of scenes) {
  const button = node('button', 'scene-choice'); button.type = 'button';
  button.setAttribute('aria-current', String(scene.id === selected));
  const title = node('strong', '', scene.title), detail = node('small');
  detail.append(node('span', `scene-state ${scene.status}`, scene.status === 'active' ? (scene.autonomous ? '● Happening now' : '● Active') : 'Ended'),
   document.createTextNode(`${scene.participants.join(', ')} · ${scene.kind.replace('_', ' ')}`));
  button.append(title, detail); button.onclick = () => select(scene.id); list.append(button);
 }
}
function renderCast() {
 const next = JSON.stringify(cast.map(a => [a.name, a.avatar, a.away_reason])) + JSON.stringify(scenes.filter(s => s.status === 'active').map(s => s.participants));
 if (next === castSignature) return;
 castSignature = next;
 const checked = new Set([...form.querySelectorAll('[name=participants]:checked')].map(n => n.value));
 const participants = $('#participants'); participants.replaceChildren();
 const occupied = new Set(scenes.filter(s => s.status === 'active').flatMap(s => s.participants));
 for (const agent of cast) {
  const label = node('label', 'participant-choice'), input = node('input');
  input.type = 'checkbox'; input.name = 'participants'; input.value = agent.name;
  input.disabled = occupied.has(agent.name); input.checked = checked.has(agent.name) && !input.disabled;
  label.append(input);
  label.append(facelessIcon());
  const name = node('span', '', agent.name);
  if (input.disabled) name.append(node('small', '', 'In a scene'));
  label.append(name); participants.append(label);
 }
}
function renderActions(element, text) {
 // Text nodes only: character/user HTML is never inserted into the page.
 for (const part of text.split(/(\*[^*\n]+\*)/g)) {
  element.append(part.startsWith('*') && part.endsWith('*') ? node('em', '', part.slice(1, -1)) : document.createTextNode(part));
 }
}
function renderTranscript() {
 const feed = $('#scene-feed'), nearBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 100;
 feed.replaceChildren();
 if (!current.messages.length) {
  const empty = node('div', 'scene-empty'); empty.append(node('h3', '', current.autonomous ? 'A moment beginning.' : 'You’re here together.'), node('p', '', current.autonomous ? 'Watch their time together, or join as Mystery.' : 'Describe your first move to begin the moment.')); feed.append(empty);
 }
 for (const message of current.messages) {
  const agent = cast.find(a => a.name === message.name) || (message.name === 'Mystery' ?
   {name: 'Mystery'} : null);
  const row = node('article', `scene-message ${message.kind}`), content = node('div', 'scene-content');
  if (agent) row.append(facelessIcon('scene-portrait'));
  const meta = node('div', 'scene-meta'), time = node('time', '', new Date(message.time).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
  time.dateTime = message.time; meta.append(node('strong', '', message.name === 'Mystery' ? 'Mystery · your move' : message.name), time);
  if (message.served_by) meta.append(node('small', '', `via ${message.served_by}`));
  if (agent?.voice_ready && message.kind === 'chat') {
   const play = node('button', '', '▶ Listen'); play.type = 'button'; play.setAttribute('aria-label', `Listen to ${agent.name}’s reply`); play.onclick = () => listen(message); meta.append(play);
  }
  const body = node('div', 'scene-body'); renderActions(body, message.text); content.append(meta, body);
  row.append(content); feed.append(row);
 }
 if (nearBottom || !signature) feed.scrollTop = feed.scrollHeight;
}
function renderScene() {
 if (!current) return;
 $('#scene-title').textContent = current.title;
 const present = [...current.participants, ...(!current.autonomous || current.mystery_joined ? ['Mystery'] : [])];
 $('#scene-detail').textContent = `${current.location} · ${present.join(', ')} · ${current.visibility} · ${current.status}`;
 $('#scene-summary').hidden = !current.summary; $('#scene-summary').textContent = current.summary;
 $('#scene-composer').hidden = current.status !== 'active' || (current.autonomous && !current.mystery_joined);
 $('#join-scene').hidden = current.status !== 'active' || !current.autonomous || current.mystery_joined || current.closing;
 $('#join-scene').disabled = pending;
 $('#scene-move').placeholder = current.autonomous ? 'Your own actions and words as Mystery…' : 'The doors open onto a sky full of stars…';
 $('#end-scene').hidden = current.status !== 'active';
 const conversation = $('#conversation-toggle');
 conversation.hidden = current.status !== 'active' || current.autonomous || current.participants.length < 2;
 conversation.textContent = current.conversation_paused ? 'Resume conversation' : 'Pause conversation';
 conversation.disabled = pending || current.operation === 'end';
 const busy = pending || (current.busy && current.operation !== 'idle');
 $('#end-scene').disabled = busy; $('#send-move').disabled = busy || imageReading;
 $('#scene-move').disabled = busy; $('#scene-image').disabled = busy || imageReading;
 $('#scene-typing').textContent = current.operation === 'end' ? 'Remembering your time together…' : current.speaker ? `${current.speaker} is responding…` : current.busy ? 'A reply is on its way…' : '';
 const next = current.id + ':' + current.messages.length + ':' + (current.messages.at(-1)?.id || '');
 if (next !== signature) { renderTranscript(); signature = next; }
}
function renderImage() {
 $('#scene-image-draft').hidden = !imageDraft;
 if (imageDraft) $('#scene-image-preview').src = imageDraft;
 else { $('#scene-image-preview').removeAttribute('src'); $('#scene-image').value = ''; }
}
async function select(id) {
 if (pending || imageReading) return;
 if (selected) drafts.set(selected, {text: $('#scene-move').value, image: imageDraft});
 selected = id; current = null; signature = ''; stopVoice();
 sceneVersion++;
 $('#scene-status').textContent = ''; $('#scene-composer').hidden = true; $('#end-scene').hidden = true; $('#join-scene').hidden = true; $('#conversation-toggle').hidden = true;
 $('#scene-title').textContent = 'Opening scene…'; $('#scene-summary').hidden = true;
 $('#scene-feed').replaceChildren(); $('#scene-typing').textContent = '';
 const draft = drafts.get(id); $('#scene-move').value = draft?.text || ''; imageDraft = draft?.image || null; renderImage();
 history.replaceState(null, '', `#${id}`); renderList();
 try { const scene = await api(scenePath(id)); if (id !== selected) return; current = scene; renderScene(); }
 catch (error) { if (id === selected) $('#scene-status').textContent = error.message; }
}
async function refresh() {
 if (refreshing) return; refreshing = true;
 const id = selected;
 const version = sceneVersion;
 try {
  const [status, list, scene] = await Promise.all([api('/api/status'), api('/api/scenes'), id ? api(scenePath(id)) : Promise.resolve(null)]);
  cast = status.agents; scenes = list; renderList(); renderCast();
  if (id === selected && version === sceneVersion && scene) { current = scene; renderScene(); }
  if (!selected && scenes.length) await select(scenes[0].id);
 } catch (error) { $('#scene-status').textContent = error.message; }
 finally { refreshing = false; }
}
$('#new-scene').onclick = () => { $('#create-panel').open = true; form.elements.title.focus(); };
form.onsubmit = async event => {
 event.preventDefault(); if (pending) return;
 const data = new FormData(form), participants = data.getAll('participants');
 if (!participants.length) { $('#create-status').textContent = 'Choose at least one person to join you.'; return; }
 pending = true; $('#create-button').disabled = true; $('#create-status').textContent = 'Beginning your scene…';
 try {
  const scene = await api('/api/scenes', {participants, kind: data.get('kind'), title: data.get('title'), location: data.get('location'), opening: data.get('opening'), visibility: data.get('visibility')});
  form.reset(); $('#create-status').textContent = ''; pending = false;
  $('#create-panel').open = false; await select(scene.id); await refresh();
  if (matchMedia('(max-width: 650px)').matches) $('.scene-stage').scrollIntoView({block: 'start'});
 } catch (error) { $('#create-status').textContent = error.message; }
 finally { pending = false; $('#create-button').disabled = false; renderScene(); }
};
$('#scene-composer').onsubmit = async event => {
 event.preventDefault(); if (!current || pending || (current.busy && current.operation !== 'idle') || imageReading) return;
 const text = $('#scene-move').value.trim();
 if (!text && !imageDraft) return;
 pending = true; sceneVersion++; renderScene(); $('#scene-status').textContent = '';
 try {
  current = await api(`${scenePath()}/moves`, {text, image: imageDraft});
  $('#scene-move').value = ''; imageDraft = null; drafts.delete(selected); renderImage();
 } catch (error) { $('#scene-status').textContent = error.message; }
 finally { pending = false; renderScene(); }
};
$('#scene-move').onkeydown = event => {
 if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#scene-composer').requestSubmit(); }
};
$('#scene-image').onchange = async () => {
 const file = $('#scene-image').files[0]; if (!file) return;
 $('#scene-status').textContent = '';
 if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) {
  $('#scene-status').textContent = 'Choose a PNG, JPEG, WebP, or GIF under 5 MB.'; $('#scene-image').value = ''; return;
 }
 imageReading = true; renderScene();
 try {
  imageDraft = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read that image')); reader.readAsDataURL(file); });
  renderImage();
 } catch (error) { $('#scene-status').textContent = error.message; }
 finally { imageReading = false; renderScene(); }
};
$('#remove-image').onclick = () => { imageDraft = null; renderImage(); };
$('#end-scene').onclick = () => {
 if (!pending && current && (!current.busy || current.operation === 'idle')) {
  $('#end-dialog').returnValue = 'cancel'; $('#end-dialog').showModal();
 }
};
$('#end-dialog').onclose = async () => {
 if ($('#end-dialog').returnValue !== 'end' || pending || !current || (current.busy && current.operation !== 'idle')) return;
 pending = true; sceneVersion++; renderScene(); $('#scene-status').textContent = '';
 try { current = await api(`${scenePath()}/end`, {}); }
 catch (error) { $('#scene-status').textContent = error.message; }
 finally { pending = false; renderScene(); }
};
$('#conversation-toggle').onclick = async () => {
 if (pending || !current || current.operation === 'end') return;
 const id = selected;
 pending = true; sceneVersion++; renderScene(); $('#scene-status').textContent = '';
 try { current = await api(`${scenePath(id)}/conversation`, {paused: !current.conversation_paused}); }
 catch (error) { $('#scene-status').textContent = error.message; }
 finally { pending = false; renderScene(); }
};
$('#join-scene').onclick = async () => {
 if (pending || !current) return;
 pending = true; sceneVersion++; renderScene();
 try { current = await api(`/api/meetups/scenes/${current.id}/join`, {}); }
 catch (error) { $('#scene-status').textContent = error.message; }
 finally { pending = false; renderScene(); }
};
window.addEventListener('meetup-select', event => { select(event.detail); });
window.addEventListener('hashchange', () => {
 const id = location.hash.slice(1);
 if (/^[0-9a-f]{32}$/.test(id) && id !== selected) select(id);
});
window.addEventListener('pagehide', stopVoice);
selected = /^[0-9a-f]{32}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
refresh(); setInterval(refresh, 1000);
