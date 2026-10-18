const $ = s => document.querySelector(s);
let state = null, signature = '', hidden = false, busy = false, refreshing = false;
let allMessages = [], view = 'group', imageDraft = null;
let dmPerson='', dmPeer='';
const rememberedPeers=new Map();
let listenOn=false, voiceQueue=[], audioBusy=false, voiceGeneration=0, voiceObjectURL=null, voiceAbort=null;
const player=$('#voice-player');
const providerNames = {claude:'CLAUDE', codex:'CODEX', agy:'GEMINI', opencode:'MiMo', cursor:'CURSOR'};
const mysteryPortrait={name:'Mystery',avatar:null,color:'#b88d62',tagline:'The newcomer · your character'};
function el(tag, cls, text) {
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(text!==undefined)node.textContent=text;
 return node;
}
function renderScores(a){
 const section=$('#portrait-scores');section.replaceChildren();
 section.hidden=a.name==='Mystery';if(section.hidden)return;
 section.append(el('h3','','Personal interests'),el('p','score-note','Long-term bonds · mood fades over time · sibling scores are family feelings'));
 const people=[...state.agents.filter(p=>p.name!==a.name),{name:'Mystery'}];
 people.sort((x,y)=>{const sx=a.preferences?.[x.name],sy=a.preferences?.[y.name];return (sy?sy.like-sy.dislike:-101)-(sx?sx.like-sx.dislike:-101);});
 const table=el('table','score-table'),head=el('tr');
 for(const title of ['Person','Like','Dislike','Net','Mood'])head.append(el('th','',title));table.append(head);
 for(const person of people){const s=a.preferences?.[person.name],row=el('tr');row.append(el('td','',person.name+(person.name===a.sibling?' · sibling':'')),el('td','',s?s.like:'—'),el('td','',s?s.dislike:'—'),el('td','',s?s.like-s.dislike:'—'),el('td','score-mood',s?.mood?Object.entries(s.mood).filter(([,value])=>value>0).map(([key,value])=>`${key} ${value}`).join(' · ')||'calm':'—'));table.append(row);}
 section.append(table);
 if(!Object.keys(a.preferences||{}).length)section.append(el('p','score-note','No impressions recorded yet.'));
}
function avatarFor(a) {
 const node=el('div','avatar');
 node.append(facelessIcon());
 if(a){
  const button=el('button','portrait-open');button.type='button';
  button.setAttribute('aria-label',`See ${a.name}’s profile`);
  button.onclick=()=>{
   $('#portrait-name').textContent=a.name;$('#portrait-tagline').textContent=a.tagline;
   renderScores(a);$('#photo-stash').hidden=true;$('#portrait-dialog').showModal();
  };
  node.append(button);node.style.setProperty('--tint',a.color+'22');
 }
 return node;
}
async function api(path, options) {
 const r=await fetch(path,options), data=await r.json();
 if(!r.ok)throw new Error(data.error || `Request failed (${r.status})`);
 return data;
}
function renderCast() {
 const cast=$('#cast'),focused=document.activeElement?.dataset.retryKey;cast.replaceChildren();
 for(const a of state.agents) {
  const card=el('div','person'+(state.speaker===a.name?' speaking':'')+(!a.enabled?' away':''));
  card.title=`${a.name}${a.age != null?', '+a.age:''} · ${a.model}${a.sibling?' · '+a.sibling+"’s sibling":''}${a.away_reason?' · '+a.away_reason:''}`;
  const avatar=avatarFor(a);
  const info=el('div','person-info'),line=el('div','name-line');
  line.append(el('strong','',a.name));
  if(a.host_level)line.append(el('span','host-badge','host'));
  line.append(el('span','gender',a.gender==='male'?'♂':a.gender==='female'?'♀':''),el('span','provider',providerNames[a.provider]));
  const preview=el('button','voice-preview','♫');preview.type='button';preview.title=`Hear ${a.name}’s voice`;preview.setAttribute('aria-label',`Preview ${a.name}’s voice`);preview.disabled=!a.voice_ready;preview.onclick=()=>playVoice(`/api/voice/${encodeURIComponent(a.name)}.wav`,a.name);line.append(preview);
  info.append(line,el('div','tagline',a.tagline),el('div','sibling',`${a.sibling?'↳ '+a.sibling+'’s sibling':(a.kind||'human').replaceAll('_',' ')}${a.enabled?'':' · away'}`));
  if(a.away_reason)info.append(el('small','sibling',a.away_reason));
  if(a.busy)info.append(el('small','sibling',a.busy));
  const route=(state.providers||[]).find(r=>r.provider===a.provider&&r.model===a.model);
  if(route||a.retry_in_seconds)info.append(retryButton(route||{provider:a.provider,model:a.model},a.name));
  const talk=el('button','text-button private-chat-button','Chat privately');talk.type='button';talk.onclick=()=>{openMysteryConversation(a.name);$('#mystery-input').focus();};info.append(talk);
  const edit=el('a','text-button','Edit character');edit.href='/story#bible&character='+encodeURIComponent(a.name);info.append(edit);
  card.append(avatar,info);cast.append(card);
 }
 if(focused)Array.from(cast.querySelectorAll('[data-retry-key]')).find(button=>button.dataset.retryKey===focused)?.focus({preventScroll:true});
 $('#cast-count').textContent=String(state.agents.length).padStart(2,'0');
}
function pairKey(m){return [m.name,m.to].sort().join(' ↔ ');}
function dmContacts(person){
 return [...new Set(allMessages.filter(m=>m.channel==='dm'&&(m.name===person||m.to===person)).map(m=>m.name===person?m.to:m.name))].sort();
}
function selectedPrivate(m){return m.channel==='dm'&&!!dmPerson&&!!dmPeer&&pairKey(m)===pairKey({name:dmPerson,to:dmPeer});}
function syncMysteryRecipient(){
 const target=dmPerson==='Mystery'?dmPeer:dmPerson;
 $('#mystery-to').value=state.agents.some(a=>a.configured_enabled!==false&&a.name===target)?target:'';
}
function selectDmPerson(name){
 stopVoice();dmPerson=name;dmPeer=rememberedPeers.get(name)||'';renderMessages();syncMysteryRecipient();$('#feed').scrollTop=$('#feed').scrollHeight;
}
function selectDmPeer(name){
 stopVoice();dmPeer=name;rememberedPeers.set(dmPerson,name);renderMessages();syncMysteryRecipient();$('#feed').scrollTop=$('#feed').scrollHeight;
}
function openMysteryConversation(name){
 dmPerson='Mystery';dmPeer=name;rememberedPeers.set('Mystery',name);selectView('dm');syncMysteryRecipient();$('#feed').scrollTop=$('#feed').scrollHeight;
}
function renderDmNavigation(){
 const people=[...state.agents,mysteryPortrait];
 if(!people.some(p=>p.name===dmPerson))dmPerson=people.find(p=>dmContacts(p.name).length)?.name||people[0].name;
 const contacts=dmContacts(dmPerson);
 if(dmPerson==='Mystery'&&dmPeer&&state.agents.some(a=>a.name===dmPeer)&&!contacts.includes(dmPeer))contacts.push(dmPeer);
 if(!contacts.includes(dmPeer))dmPeer=contacts[0]||'';
 if(dmPeer)rememberedPeers.set(dmPerson,dmPeer);
 const sections=$('#dm-people');sections.replaceChildren();
 for(const person of people){
  const count=dmContacts(person.name).length,button=el('button','dm-person');button.type='button';button.dataset.person=person.name;
  button.setAttribute('aria-pressed',String(person.name===dmPerson));button.setAttribute('aria-label',`${person.name}’s private chats (${count})`);
  button.append(facelessIcon());
  button.append(el('span','',person.name),el('small','',String(count)));button.onclick=()=>selectDmPerson(person.name);sections.append(button);
 }
 $('#dm-heading').textContent=`${dmPerson}’s conversations`;
 const tabs=$('#dm-conversations');tabs.replaceChildren();
 for(const peer of contacts){const button=el('button','dm-conversation',peer);button.type='button';button.dataset.peer=peer;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(peer===dmPeer));button.setAttribute('aria-controls','feed');button.onclick=()=>selectDmPeer(peer);tabs.append(button);}
 $('#dm-note').textContent=contacts.length?'Each tab shows one private conversation. You always send messages as Mystery.':'No private conversations yet.';
}
function renderMessages() {
 const feed=$('#feed'),nearBottom=feed.scrollTop+feed.clientHeight>=feed.scrollHeight-90;
 renderDmNavigation();
 const messages=allMessages.filter(m=>view==='group'?m.channel!=='dm':selectedPrivate(m));
 feed.replaceChildren();
 if(!messages.length){
  const empty=el('div','empty');
  empty.append(el('span','empty-icon',view==='dm'?'💌':'🥂'),
   el('h3','',view==='dm'?`${dmPerson}’s private conversations`:'The chatroom is ready.'),
   el('p','',view==='dm'?(dmPeer?`No messages between ${dmPerson} and ${dmPeer} yet.`:`${dmPerson} hasn’t started a private conversation yet.`):'Send a message to the group or choose a character for a private chat.'),
   el('span','empty-flourish','♡  ✧  ♡'));
  feed.append(empty);
 }
 for(const m of messages) {
  const a=state.agents.find(a=>a.name===m.name)||(m.name==='Mystery'?mysteryPortrait:null);
  const row=el('div','message'+(m.kind==='error'?' error':'')),avatar=avatarFor(a,m.name==='Mystery'?'👤':'💌');
  if(a)avatar.style.setProperty('--tint',a.color+'22');
  const content=el('div','message-content'),meta=el('div','message-meta');
  meta.append(el('strong','',m.channel==='dm'?`${m.name} → ${m.to}`:m.name),
   el('span','',m.channel==='dm'?'PRIVATE':a?.provider?providerNames[a.provider]:m.name==='Mystery'?'UNKNOWN':'ROOM UPDATE'),
   el('span','',new Date(m.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})));
  if(m.served_by){const tag=el('small','provider',`via ${m.served_by}`);meta.append(tag);}
  if(m.alarm)meta.append(el('small','provider','⏰ alarm'));
  if(m.kind==='chat'&&a?.voice_ready){const play=el('button','message-play','▶ Listen');play.type='button';play.setAttribute('aria-label',`Listen to ${m.name}’s message`);play.onclick=()=>playVoice(`/api/audio/${encodeURIComponent(m.id)}.wav`,m.name);meta.append(play);}
  content.append(meta);
  if(m.reply_to){
   const original=allMessages.find(item=>item.id===m.reply_to&&(item.channel!=='dm'||(m.channel==='dm'&&pairKey(item)===pairKey(m)))),quote=el('blockquote','reply-quote');
   quote.append(el('strong','',original?`↳ ${original.name}`:'↳ Earlier message'),el('div','',original?original.text:'This message is outside the loaded conversation.'));
   content.append(quote);
  }
  content.append(el('div','message-body',m.text));

  row.append(avatar,content);feed.append(row);
 }
 if(hidden)addCurtain();
 if(nearBottom)feed.scrollTop=feed.scrollHeight;
}
function addCurtain(){
 const p=el('div','privacy');
 p.append(el('span','','🕯️'),el('h3','','A little space, a little spark.'),el('p','','Come back whenever you like.'));
 $('#feed').append(p);
}
async function retryRoute(route, button, name){
 button.disabled=true;button.textContent='Scheduling…';
 try{
  state=await api('/api/providers/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:route.provider,model:route.model,name})});
  renderCast();renderStatus();
 }catch(error){button.disabled=false;button.textContent='Retry now';$('#status').textContent=error.message;}
}
function retryButton(route,name){
 const button=el('button','provider-retry','Retry now');button.type='button';
 button.dataset.retryKey=`${name||''}|${route.provider}/${route.model}`;
 button.setAttribute('aria-label',`Retry ${name||route.provider+' '+route.model} now`);
 button.disabled=route.state==='trial in progress'||route.state==='trial pending';
 if(route.state==='trial pending')button.textContent='Trial pending';
 if(route.state==='trial in progress')button.textContent='Trying…';
 button.onclick=()=>retryRoute(route,button,name);return button;
}
function renderProviders(){
 const list=$('#provider-status'),focused=document.activeElement?.dataset.retryKey;list.replaceChildren();
 for(const route of state.providers||[]){
  const row=el('div','provider-state');row.append(el('span','',`${route.reason} · ${route.model}`),retryButton(route));list.append(row);
 }
 if(focused)Array.from(list.querySelectorAll('[data-retry-key]')).find(button=>button.dataset.retryKey===focused)?.focus({preventScroll:true});
}
function renderStatus(){
 renderProviders();
 const pending=!!state.speaker;
 $('#toggle').textContent=state.running?'Pause room':pending?'Finishing a reply…':'Start room';
 $('#toggle').disabled=busy||(!state.running&&pending);$('#limit').disabled=state.running||pending;
 const error=!state.running&&state.reason!=='The evening is yours to start.'&&/exited|timed out|error|failed|quota|unusable/i.test(state.reason);
 const quiet=$('#quiet');quiet.disabled=busy;quiet.setAttribute('aria-checked',String(!!state.quiet_room));
 quiet.textContent=`Reply only to you: ${state.quiet_room?'on':'off'}`;
 const badge=$('#badge');
 badge.textContent=state.running?'● THE ROOM IS LIVE':pending?'REPLY IN PROGRESS':error?'NEEDS ATTENTION':'PAUSED · SEND A MESSAGE OR START ROOM';
 badge.className='badge'+(state.running?' live':error?' error':'');
 $('#typing').textContent=pending?`${state.speaker} is finding the words…`:'';
 $('#status').textContent=`${state.turns} / ${state.limit} messages · ${state.quiet_room?'Quiet room on (hosts and direct replies) · ':''}${state.reason}`;
}
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{
  const [s,m,h]=await Promise.all([api('/api/status'),api('/api/messages'),api('/api/health')]);
  renderHealth(h);
  state=s;renderCast();renderStatus();
  const recipient=$('#mystery-to'),chosen=recipient.value;
  recipient.replaceChildren(new Option('Everyone · group chat',''),...s.agents.filter(a=>a.configured_enabled!==false).map(a=>new Option(a.name+' · private',a.name)));
  if(s.agents.some(a=>a.configured_enabled!==false&&a.name===chosen))recipient.value=chosen;$('#listen').disabled=!s.speech_available;
  const next=m.length+':'+(m.at(-1)?.id||'');
  if(next!==signature){const known=new Set(allMessages.map(x=>x.id));const fresh=signature?m.filter(x=>!known.has(x.id)):[];allMessages=m;renderMessages();signature=next;if(listenOn&&!hidden){voiceQueue.push(...fresh.filter(visibleForSpeech).slice(-5));drainVoiceQueue();}}
 }catch(e){$('#badge').textContent='DISCONNECTED';$('#badge').className='badge error';$('#status').textContent=e.message;$('#toggle').disabled=true;}
 finally{refreshing=false;}
}
function selectView(next){
 stopVoice();view=next;if(next==='group')$('#mystery-to').value='';$('#group-tab').setAttribute('aria-selected',String(view==='group'));
 $('#dm-tab').setAttribute('aria-selected',String(view==='dm'));$('#dm-tools').hidden=view!=='dm';
 renderMessages();if(next==='dm')syncMysteryRecipient();
}
$('#group-tab').onclick=()=>selectView('group');
$('#dm-tab').onclick=()=>selectView('dm');
$('#mystery-to').onchange=()=>{const name=$('#mystery-to').value;if(name)openMysteryConversation(name);else selectView('group');};
$('#toggle').onclick=async()=>{
 if(!state||busy)return;busy=true;renderStatus();
 try{state=await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running:!state.running,limit:Number($('#limit').value)})});renderStatus();}
 catch(e){$('#status').textContent=e.message;}
 finally{busy=false;if(state)$('#toggle').disabled=!state.running&&!!state.speaker;}
};
$('#quiet').onclick=async()=>{
 if(!state||busy)return;busy=true;renderStatus();
 let failure='';
 try{state=await api('/api/quiet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quiet:!state.quiet_room})});}
 catch(e){failure=e.message;}
 busy=false;renderStatus();if(failure)$('#status').textContent=failure;
};
$('#curtain').onclick=()=>{
 hidden=!hidden;if(hidden)stopVoice();$('#feed').classList.toggle('curtained',hidden);
 $('#curtain').setAttribute('aria-pressed',String(hidden));$('#curtain').textContent=hidden?'Peek back in ♡':'Give them space ♡';
 if(hidden)addCurtain();else document.querySelectorAll('.privacy').forEach(n=>n.remove());
};
function visibleForSpeech(m){
 return m.kind==='chat'&&state?.agents.some(a=>a.name===m.name&&a.voice_ready)&&(view==='group'?m.channel!=='dm':selectedPrivate(m));
}
function stopVoice(){
 voiceGeneration++;voiceAbort?.abort();voiceAbort=null;voiceQueue=[];audioBusy=false;player.pause();
 player.removeAttribute('src');player.load();player.hidden=true;
 if(voiceObjectURL){URL.revokeObjectURL(voiceObjectURL);voiceObjectURL=null;}
 $('#voice-status').textContent='A different voice for every heart.';
}
async function playVoice(path,name,automatic=false){
 if(!automatic)stopVoice();
 const generation=++voiceGeneration;audioBusy=true;voiceAbort=new AbortController();
 $('#voice-status').textContent=`Finding ${name}’s voice…`;
 try{
  const response=await fetch(path,{signal:voiceAbort.signal});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'Voice unavailable');}
  const blob=await response.blob();if(generation!==voiceGeneration)return;
  if(voiceObjectURL)URL.revokeObjectURL(voiceObjectURL);
  voiceObjectURL=URL.createObjectURL(blob);player.src=voiceObjectURL;player.hidden=false;
  await player.play();if(generation!==voiceGeneration)return;
  $('#voice-status').textContent=`Speaking · ${name}`;
 }catch(error){
  if(generation!==voiceGeneration||error.name==='AbortError')return;
  audioBusy=false;voiceQueue=[];
  if(automatic){listenOn=false;$('#listen').textContent='🔇 Auto-listen off';$('#listen').setAttribute('aria-pressed','false');}
  $('#voice-status').textContent=error.name==='NotAllowedError'?'Press play on the audio player to hear this voice.':error.message;
 }
}
function drainVoiceQueue(){
 if(audioBusy||!listenOn||hidden)return;
 const next=voiceQueue.shift();
 if(next&&visibleForSpeech(next))playVoice(`/api/audio/${encodeURIComponent(next.id)}.wav`,next.name,true);
}
player.onended=()=>{audioBusy=false;$('#voice-status').textContent='A different voice for every heart.';drainVoiceQueue();};
player.onerror=()=>{audioBusy=false;voiceQueue=[];$('#voice-status').textContent='Audio could not be played. Try Listen again.';};
$('#listen').onclick=()=>{
 listenOn=!listenOn;if(!listenOn)stopVoice();
 $('#listen').textContent=listenOn?'🔊 Auto-listen on':'🔇 Auto-listen off';$('#listen').setAttribute('aria-pressed',String(listenOn));
 $('#voice-status').textContent=listenOn?'New messages in this conversation will play aloud.':'A different voice for every heart.';
};
$('#mystery-form').onsubmit=async event=>{
 event.preventDefault();
 const input=$('#mystery-input'),button=$('#mystery-send'),text=input.value.trim();
 if((!text&&!imageDraft)||button.disabled)return;
 const recipient=$('#mystery-to').value||null,image=imageDraft;
 button.disabled=true;input.disabled=true;$('#mystery-image').disabled=true;$('#image-remove').disabled=true;$('#mystery-to').disabled=true;$('#mystery-status').textContent='Sending…';
 try{
  const result=await api('/api/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,to:recipient,image})});
  if(!result.message?.id)throw new Error('The server did not confirm your message.');
  if(!allMessages.some(m=>m.id===result.message.id))allMessages.push(result.message);
  if(recipient)openMysteryConversation(recipient);else selectView('group');input.value='';clearImage();
  if(!state?.running && $('#reply-on-send').checked){
   try{state=await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({running:true,limit:Number($('#limit').value)})});renderStatus();}
   catch(error){$('#mystery-status').textContent='Message saved. Could not start replies: '+error.message;return;}
  }
  $('#mystery-status').textContent=state?.running?'Sent. Waiting for their reply…':'Message saved. Start the room when you want replies.';
 }catch(error){$('#mystery-status').textContent=error.message;}
 finally{button.disabled=false;input.disabled=false;$('#mystery-image').disabled=false;$('#image-remove').disabled=false;$('#mystery-to').disabled=false;}
};
function clearImage(){imageDraft=null;$('#mystery-image').value='';$('#image-draft').hidden=true;$('#image-preview').removeAttribute('src');}
$('#image-remove').onclick=clearImage;
$('#mystery-image').onchange=async()=>{
 const file=$('#mystery-image').files[0];if(!file)return;
 if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>5*1024*1024){$('#mystery-status').textContent='Choose a PNG, JPEG, WebP, or GIF under 5 MB.';$('#mystery-image').value='';return;}
 try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read that image.'));reader.readAsDataURL(file);});imageDraft=data;$('#image-preview').src=data;$('#image-draft').hidden=false;$('#mystery-status').textContent='Image ready. Add a caption or send it as is.';}catch(error){$('#mystery-status').textContent=error.message;}
};
$('#mystery-input').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#mystery-form').requestSubmit();}};
$('#portrait-close').onclick=()=>$('#portrait-dialog').close();
$('#portrait-dialog').onclick=event=>{if(event.target===$('#portrait-dialog'))$('#portrait-dialog').close();};
refresh();setInterval(refresh,1800);

function renderHealth(health){
 $('#health-count').textContent=`${health.failures_last_hour} failures in the last hour`;
 const rows=health.events.slice().reverse().map(event=>{
  const row=document.createElement('div');row.className='health-event';
  const time=document.createElement('time');time.dateTime=event.time;time.textContent=new Date(event.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const detail=document.createElement('span');detail.textContent=[event.character,event.event.replaceAll('_',' '),event.reason].filter(Boolean).join(' · ');
  if(event.reset_at)detail.textContent+=` · reset ${new Date(event.reset_at*1000).toLocaleString()}`;
  row.append(time,detail);return row;
 });
 if(!rows.length){const empty=document.createElement('p');empty.textContent='No recent events.';rows.push(empty);}
 $('#health-events').replaceChildren(...rows);
}

let stashOwner='', stashGeneration=0;
async function openStash(a){
 $('#photo-stash').hidden=a.name==='Mystery';
 if(a.name==='Mystery'){stashOwner='';stashGeneration++;return;}
 stashOwner=a.name;stashGeneration++;$('#stash-form').reset();$('#stash-status').textContent='';
 const select=$('#stash-audience');select.replaceChildren();
 for(const name of [...state.agents.map(p=>p.name),'Mystery'].filter(n=>n!==a.name)){
  const option=el('option','',name);option.value=name;select.append(option);
 }
 await loadStash();
}
async function loadStash(){
 const owner=stashOwner,generation=stashGeneration,list=$('#stash-list');list.replaceChildren(el('p','','Loading photos…'));
 try{
  const items=await api(`/api/stash/${encodeURIComponent(owner)}`);
  if(generation!==stashGeneration)return;
  list.replaceChildren();
  if(!items.length)list.append(el('p','score-note','No photos yet. Add a candid moment below.'));
  for(const item of items){
   const row=el('article','stash-item'),img=el('img');img.src=`/api/stash/${encodeURIComponent(owner)}/${item.id}/image`;img.alt=item.description;img.loading='lazy';
   const details=el('div');details.append(el('p','',item.description),el('small','',`${item.audience.join(', ')||'Anyone'} · ${item.status}`));
   if(item.note)details.append(el('p','score-note',item.note));
   for(const [label,method,suffix] of [['Delete','DELETE',''],...(item.status==='dropped'?[['Reset to pending','POST','/reset']]:[])]){
    const button=el('button','text-button',label);button.type='button';button.onclick=async()=>{
     button.disabled=true;
     try{await api(`/api/stash/${encodeURIComponent(owner)}/${item.id}${suffix}`,{method,headers:{'Content-Type':'application/json'},body:method==='POST'?'{}':undefined});if(generation===stashGeneration)await loadStash();}
     catch(error){if(generation===stashGeneration)$('#stash-status').textContent=error.message;button.disabled=false;}
    };details.append(button);
   }
   row.append(img,details);list.append(row);
  }
 }catch(error){if(generation===stashGeneration){list.replaceChildren();$('#stash-status').textContent=error.message;}}
}
$('#stash-form').onsubmit=async event=>{
 event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),file=$('#stash-image').files[0],owner=stashOwner,generation=stashGeneration;
 if(!file)return;
 if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024){$('#stash-status').textContent='Choose a PNG, JPEG or WebP up to 10 MB';return;}
 button.disabled=true;$('#stash-status').textContent='Adding photo…';
 try{
  const description=$('#stash-description').value,note=$('#stash-note').value,audience=Array.from($('#stash-audience').selectedOptions,o=>o.value);
  const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read image'));reader.readAsDataURL(file);});
  await api(`/api/stash/${encodeURIComponent(owner)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,description,audience,note})});
  if(generation===stashGeneration){form.reset();$('#stash-status').textContent='Photo added';await loadStash();}
 }catch(error){if(generation===stashGeneration)$('#stash-status').textContent=error.message;}
 finally{button.disabled=false;}
};
