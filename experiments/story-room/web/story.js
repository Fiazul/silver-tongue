const sceneLink = id => `/scenes${new URLSearchParams(location.search).get('embedded')==='1'?'?embedded=1':''}#${id}`;
'use strict';
const $ = selector => document.querySelector(selector);
let bible = null, cast = [], chapters = [], selectedCharacter = '', submitting = false;
const chosen = new Set();
function node(tag, className, text) {
 const element = document.createElement(tag);
 if (className) element.className = className;
 if (text !== undefined) element.textContent = text;
 return element;
}
async function api(path, body) {
 const response = await fetch(path, body === undefined ? {} : {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
 });
 const data = await response.json();
 if (!response.ok) throw new Error(data.error || `Could not load your story (${response.status}).`);
 return data;
}
function portrait(agent, className = '') {
 return facelessIcon(className);
}
function switchTab(tab) {
 const isBible = tab === 'bible';
 $('#desk').hidden = isBible; $('#bible').hidden = !isBible;
 $('#desk-tab').setAttribute('aria-pressed', String(!isBible));
 $('#bible-tab').setAttribute('aria-pressed', String(isBible));
 history.replaceState(null, '', isBible ? '/story#bible' : '/story');
 if (isBible) renderBible();
}
function renderCast() {
 const occupied = new Set(chapters.filter(c => c.status === 'active').flatMap(c => c.participants));
 $('#cast').replaceChildren();
 for (const agent of cast) {
  const pick = node('label', 'cast-pick'), input = node('input');
  input.type = 'checkbox'; input.name = 'participants'; input.value = agent.name;
  input.disabled = occupied.has(agent.name) || !agent.configured_enabled;
  if (input.disabled) chosen.delete(agent.name);
  input.checked = chosen.has(agent.name);
  input.onchange = () => { input.checked ? chosen.add(agent.name) : chosen.delete(agent.name); updateCount(); };
  const image = portrait(agent); image.alt = '';
  pick.append(input, image, node('span', '', agent.name));
  if (input.disabled) pick.append(node('small', '', occupied.has(agent.name) ? 'In a chapter' : 'Away'));
  $('#cast').append(pick);
 }
 updateCount();
 const existing = starterChapter();
 $('#quick-play').textContent = existing ? `Continue ${existing.title} ↗` : 'Play the opening ↗';
}
function starterChapter() { return chapters.find(c => c.status === 'active' && c.title === bible?.world?.starter?.title); }
function updateCount() { $('#selection-count').textContent = `${chosen.size} ${chosen.size === 1 ? 'character' : 'characters'} selected`; }
function renderChapters() {
 $('#chapters').replaceChildren();
 if (!chapters.length) $('#chapters').append(node('p', 'hint', 'Your first chapter starts above. Pick someone and somewhere to begin.'));
 for (const chapter of chapters) {
  const link = node('a', 'chapter-row'); link.href = sceneLink(chapter.id);
  const text = node('div'); text.append(node('strong', '', chapter.title),
   node('p', '', `${chapter.participants.join(' · ')} — ${chapter.location}`));
  link.append(text, node('span', '', chapter.status === 'active' ? 'Continue ↗' : 'Read chapter ↗'));
  $('#chapters').append(link);
 }
}
function section(title, text, source, className = '') {
 const block = node('section', 'profile-section'); block.append(node('h3', '', title));
 if (text) block.append(node('p', className, text));
 if (source) block.append(node('small', '', 'Source: ' + source));
 return block;
}
function renderBible() {
 if (!bible) return;
 const query = $('#character-search').value.trim().toLowerCase();
 const matches = bible.characters.filter(a => `${a.name} ${a.personality} ${a.tagline} ${a.backstory}`.toLowerCase().includes(query));
 $('#bible-cast').replaceChildren();
 if (!matches.length) $('#bible-cast').append(node('p', 'hint', 'No character matches. Try a name or another interest.'));
 for (const agent of matches) {
  const button = node('button', 'bible-person'); button.type = 'button';
  button.setAttribute('aria-current', String(agent.name === selectedCharacter));
  button.append(portrait(agent), node('span', '', agent.name));
  button.onclick = () => { selectedCharacter = agent.name; renderBible(); };
  $('#bible-cast').append(button);
 }
 const agent = bible.characters.find(a => a.name === selectedCharacter) || bible.characters[0];
 const profile = $('#character-profile'); profile.replaceChildren();
 if (!agent) return;
 const top = node('div', 'profile-top'), heading = node('div');
 heading.append(node('h2', '', agent.name), node('p', '', agent.tagline || ''),
  node('p', '', `${agent.age ? `${agent.age} years old · ` : ''}Game character${agent.sibling ? ` · ${agent.sibling}’s sibling` : ''}`));
 top.append(portrait(agent), heading); profile.append(top);
 const edit = node('button', 'secondary', 'Edit character'); edit.type = 'button'; edit.onclick = () => window.editBibleCharacter(agent); profile.append(edit);
 profile.append(section('Backstory', agent.backstory || 'No backstory written yet.', agent.sources.profile));
 profile.append(section('Goals', agent.goals || 'No goals written yet.', agent.sources.profile));
 profile.append(section('Dialogue style', agent.dialogue_style || '', agent.sources.profile));
 profile.append(section('Identity & voice', agent.personality || 'No authored personality yet.', 'agents.json'));
 profile.append(section('Appearance', agent.appearance || (agent.kind && agent.kind !== 'human' ? 'A non-human character. No physical human body is established.' : 'No written description is established.'), 'agents.json'));
 profile.append(section('Where they are now', agent.memory || 'No saved personal recollection yet.', 'data/memories.json', 'recollection'));
 const relationships = section('Their connections', 'Each score is this person’s own feeling. It does not tell you what the other person feels.', null);
 const table = node('table', 'relationship-table'), head = node('thead'), hr = node('tr');
 for (const title of ['Person', 'Like', 'Dislike']) { const th = node('th', '', title); th.scope = 'col'; hr.append(th); }
 head.append(hr); table.append(head); const body = node('tbody');
 for (const [name, score] of Object.entries(agent.relationships)) {
  const row = node('tr'); for (const value of [name === 'Mystery' ? 'You / newcomer' : name, score.like ?? 0, score.dislike ?? 0]) row.append(node('td', '', value));
  body.append(row);
 }
 table.append(body); relationships.append(table, node('small', '', 'Source: data/relationships.json')); profile.append(relationships);
 const memory = section('Recorded continuity', '', null);
 const significant = agent.memories.filter(r => ['milestones', 'gifts', 'events'].includes(r.segment));
 for (const record of significant.slice(0, 10)) memory.append(memoryRow(record));
 if (!significant.length) memory.append(node('p', '', 'No shared milestones recorded yet.'));
 const all = node('details'), summary = node('summary', '', `Browse all ${agent.memories.length} recorded memories`);
 all.append(summary); let rendered = false;
 all.ontoggle = () => { if (all.open && !rendered) { rendered = true; for (const record of agent.memories) all.append(memoryRow(record)); } };
 memory.append(all); profile.append(memory);
 const player = section('Your part in the story', `${bible.player.name}. ${bible.player.backstory || bible.player.role || ''}`, (bible.player.sources || []).join(', '));
 profile.append(player);
}
function memoryRow(record) {
 const row = node('div', 'memory-item');
 row.append(node('span', '', `${record.segment.replaceAll('_', ' ')} · ${record.status || 'recorded'}`),
  node('p', '', record.text), node('small', '', `${record.source} · ${record.time ? record.time.slice(0, 10) : 'undated'} · #${record.id || 'unknown'}`));
 return row;
}
async function begin(data) {
 if (submitting) return;
 if (!data.participants.length) { $('#chapter-status').textContent = 'Choose at least one character.'; $('#cast input:not(:disabled)')?.focus(); return; }
 submitting = true; $('#begin').disabled = true; $('#quick-play').disabled = true;
 $('#chapter-status').textContent = 'Opening your chapter…';
 try { const chapter = await api('/api/scenes', {...data, visibility: 'private'}); location.assign(sceneLink(chapter.id)); }
 catch (error) { $('#chapter-status').textContent = error.message; submitting = false; $('#begin').disabled = false; $('#quick-play').disabled = false; }
}
$('#chapter-form').onsubmit = event => {
 event.preventDefault(); const fields = new FormData(event.currentTarget);
 begin({participants: [...chosen], title: fields.get('title'), kind: fields.get('kind'), location: fields.get('location'), opening: fields.get('opening')});
};
$('#quick-play').onclick = () => { const existing = starterChapter(); if (existing) { location.assign(sceneLink(existing.id)); return; } if (bible?.world?.starter) begin(bible.world.starter); };
$('#desk-tab').onclick = () => switchTab('desk'); $('#bible-tab').onclick = () => switchTab('bible');
$('#read-opening').onclick = () => { selectedCharacter = ''; switchTab('bible'); window.scrollTo(0, 0); };
$('#character-search').oninput = renderBible;
async function load() {
 $('#retry').hidden = true; $('#load-status').classList.remove('error'); $('#load-status').textContent = 'Opening your story…';
 try {
  const [reference, status, list] = await Promise.all([api('/api/bible'), api('/api/status'), api('/api/scenes')]);
  bible = reference; cast = status.agents; chapters = list;
  renderCast(); renderChapters(); renderBible();
  $('#opening-memory').textContent = bible.world.premise || '';
  $('#starter-title').textContent = bible.world.starter?.title || 'Begin a scene';
  $('#starter-people').replaceChildren();
  for (const name of bible.world.starter?.participants || []) { const figure = node('figure'); figure.append(facelessIcon(), node('figcaption', '', name)); $('#starter-people').append(figure); }
  const requested = new URLSearchParams(location.hash.replace(/^#bible&?/, '')).get('character');
  if (requested && bible.characters.some(a => a.name === requested)) selectedCharacter = requested;
  if (!selectedCharacter) selectedCharacter = bible.characters[0]?.name || '';
  renderBible();
  $('#unknowns').replaceChildren(...bible.unknowns.map(text => node('li', '', text)));
  $('#load-status').textContent = ''; $('#quick-play').disabled = false; $('#begin').disabled = false;
  if (location.hash.startsWith('#bible')) switchTab('bible');
 } catch (error) {
  $('#load-status').textContent = `${error.message} Check that the story launcher is running.`;
  $('#load-status').classList.add('error'); $('#retry').hidden = false;
  $('#quick-play').disabled = true; $('#begin').disabled = true;
 }
}
$('#retry').onclick = load;
$('#quick-play').disabled = true; $('#begin').disabled = true;
load();
window.addEventListener('pageshow', event => { if (event.persisted) { submitting = false; load(); } });
