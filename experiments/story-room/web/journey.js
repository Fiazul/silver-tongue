import {mergeSnapshots} from '/journey-state.js';
const $ = selector => document.querySelector(selector);
const game = $('#game-frame'), room = $('#room-frame');
const routes = {room:'/room?embedded=1',bible:'/story?embedded=1#bible',scenes:'/story?embedded=1'};
const titles = {room:'Private room',bible:'Character bible',scenes:'Scenes'};
let state, pending = null, syncing = null, failed = false, lastSent = '', opener;

async function api(path, body) {
 const response = await fetch(path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result = await response.json();
 if(!response.ok) throw new Error(result.error || 'Your progress could not be saved.');
 return result;
}
function notice(message) {
 $('#sync-notice').hidden = !message;
 $('#sync-message').textContent = message || '';
}
function renderState() {
 const current = state?.merchant || state?.door || state?.handoff;
 const chapter = state?.chapter === 'merchant' ? 'A place in town' : 'The arrival';
 $('#chapter-label').textContent = current?.player ? `${current.player} · ${chapter}` : chapter;
 $('#continuation').hidden = !(state?.chapter === 'door' && state?.door?.ready && !state?.handoff);
}
function queueSnapshot(snapshot) {
 if(JSON.stringify(snapshot) === lastSent && !pending) return;
 pending = mergeSnapshots(pending,snapshot);
 if(!failed) void flush();
}
async function flush() {
 if(syncing) { await syncing; return !failed; }
 syncing = (async () => {
  while(pending) {
   const snapshot = pending; pending = null;
   try {
    state = await api('/api/journey',snapshot);
    lastSent = JSON.stringify(snapshot);
    failed = false; notice(''); renderState();
    if(snapshot.chapter==='door' && state.handoff && game.src.includes('/game/door/')) {
     pending=null;lastSent='';game.title='Your story: a place in town';
     game.src='/game/merchant/?journey=1';
    }
   } catch(error) {
    pending = mergeSnapshots(snapshot,pending ?? snapshot); failed = true;
    notice('Keep this game tab open. Chat has not received your latest progress. '+error.message);
    break;
   }
  }
 })();
 try { await syncing; } finally { syncing = null; }
 return !failed;
}
function closePanel() {
 $('#room-panel').hidden = true;
 $('#workspace').classList.remove('panel-open');
 for(const button of document.querySelectorAll('[data-panel]')) button.setAttribute('aria-expanded','false');
 history.replaceState(null,'',location.pathname);
 opener?.focus();
}
function openPanel(kind, button) {
 if(!routes[kind]) return;
 opener = button;
 $('#room-panel').hidden = false;
 $('#workspace').classList.add('panel-open');
 $('#panel-title').textContent = titles[kind];
 room.title = titles[kind];
 if(room.dataset.kind !== kind) {room.src = routes[kind];room.dataset.kind = kind;}
 for(const candidate of document.querySelectorAll('[data-panel]')) candidate.setAttribute('aria-expanded',String(candidate.dataset.panel === kind));
 history.replaceState(null,'','#'+kind);
 $('#close-panel').focus();
}
for(const button of document.querySelectorAll('[data-panel]')) button.onclick = () => openPanel(button.dataset.panel,button);
$('#close-panel').onclick = closePanel;
addEventListener('keydown',event => {if(event.key==='Escape' && !$('#room-panel').hidden) closePanel();});
addEventListener('message', event => {
 if(event.origin !== location.origin) return;
 if(event.source === game.contentWindow && event.data?.type === 'journey:state') {
  const snapshot = event.data.snapshot;
  if(!snapshot || !['door','merchant'].includes(snapshot.chapter)) return;
  if(state?.chapter==='merchant' && snapshot.chapter==='door' && game.src.includes('/merchant/')) return;
  queueSnapshot(snapshot);
 } else if(event.source === room.contentWindow && event.data?.type === 'journey:close-panel') closePanel();
});
$('#retry-sync').onclick = () => {failed = false;void flush();};
$('#continue-story').onclick = async () => {
 const button = $('#continue-story');button.disabled = true;
 try {
  if(!await flush()) throw new Error('Save your latest progress before continuing.');
  state = await api('/api/journey/continue',{session:state.session});
  pending = null; lastSent = ''; notice(''); renderState();
  $('#game-loading').hidden = false;
  game.title = 'Your story: a place in town';game.src = '/game/merchant/?journey=1';
 } catch(error) {notice(error.message);}
 finally {button.disabled = false;}
};
game.onload = () => {$('#game-loading').hidden = true;};
try {
 state = await api('/api/journey');renderState();
 game.src = state.handoff ? '/game/merchant/?journey=1' : '/game/door/?journey=1';
 const panel = location.hash.slice(1);
 if(routes[panel]) openPanel(panel,document.querySelector(`[data-panel="${panel}"]`));
} catch(error) {
 $('#game-loading').textContent = 'Your story could not open. '+error.message;
 notice('Reload to try opening your saved journey again.');
 $('#retry-sync').onclick = () => location.reload();
}
