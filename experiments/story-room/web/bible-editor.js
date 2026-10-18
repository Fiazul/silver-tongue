'use strict';
(() => {
 const dialog = document.querySelector('#bible-editor');
 const fields = [
  ['tagline', 'Short description', 300, 2], ['backstory', 'Backstory', 12000, 8],
  ['personality', 'Personality', 6000, 5], ['goals', 'Goals', 4000, 3],
  ['dialogue_style', 'Dialogue style', 4000, 4], ['appearance', 'Written appearance', 800, 3],
  ['instructions', 'Character instructions & private knowledge', 8000, 6],
  ['author_notes', 'Your notes · kept out of character prompts', 8000, 4]
 ];
 function openEditor(title, record, definitions, endpoint, isWorld = false) {
  dialog.replaceChildren();
  const form = node('form', 'bible-edit-form');
  const heading = node('h2', '', title); heading.id = 'editor-title';
  form.append(heading, node('p', 'hint', 'Save to apply these changes to the next reply. Your conversation history stays intact.'));
  const inputs = new Map();
  for (const [key, label, max, rows] of definitions) {
   const field = node('label', '', label), input = node('textarea');
   input.name = key; input.maxLength = max; input.rows = rows; input.value = record[key] || '';
   if (key === 'personality' || key === 'setting' || key === 'title') input.required = true;
   field.append(input); form.append(field); inputs.set(key, input);
  }
  const status = node('p', 'editor-status'); status.setAttribute('role', 'status');
  const actions = node('div', 'editor-actions'), cancel = node('button', 'secondary', 'Cancel'), save = node('button', 'primary', 'Save changes');
  cancel.type = 'button'; save.type = 'submit'; cancel.onclick = () => dialog.close();
  actions.append(cancel, save); form.append(status, actions);
  form.onsubmit = async event => {
   event.preventDefault(); save.disabled = true; cancel.disabled = true; status.textContent = 'Saving…';
   const changes = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]));
   if (isWorld) changes.unknowns = changes.unknowns.split('\n').map(v => v.trim()).filter(Boolean);
   try {
    await api(endpoint, {changes, revision: record.revision});
    bible = await api('/api/bible'); renderBible(); dialog.close();
    document.querySelector('#bible-save-status').textContent = 'Saved. The next character reply uses your changes.';
   } catch (error) { status.textContent = error.message; }
   finally { save.disabled = false; cancel.disabled = false; }
  };
  dialog.append(form); dialog.showModal();
  form.querySelector('textarea')?.focus();
 }
 window.editBibleCharacter = agent => openEditor(`Edit ${agent.name}`, agent, fields, `/api/bible/characters/${agent.id}`);
 document.querySelector('#edit-world').onclick = () => {
  const current = {...bible.world, unknowns: (bible.world.unknowns || []).join('\n'),
                   player_name: bible.player.name, player_backstory: bible.player.backstory || ''};
  openEditor('Edit world & player', current, [
   ['title', 'Project title', 200, 2], ['setting', 'Place, period & environment', 1000, 4],
   ['public_context', 'Shared world facts · included in every character prompt', 12000, 6],
   ['premise', 'Story premise · author reference', 12000, 6],
   ['player_name', 'Player name · author reference', 100, 2], ['player_backstory', 'Player backstory · author reference', 12000, 5],
   ['unknowns', 'Open questions · one per line', 24000, 7], ['author_notes', 'Your world notes · kept out of character prompts', 12000, 7]
  ], '/api/bible/world', true);
 };
})();
