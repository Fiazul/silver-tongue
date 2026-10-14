import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createMarketGame, restoreMarketState, type MarketContent, type MarketInput, type MarketLine, type MarketMessage, type MarketScenario, type MarketStory } from '@silver-tongue/core/market';
import { createExperimentStore, shouldSend } from './session';

interface Content extends MarketContent {
  title: string; subtitle: string; locale: string; uiLocale: string; currency: string; intro: string[];
  endingPlace: string;
  ui: Record<string, string> & { parts: string[] };
  cast: Record<string, string>; places: Record<string, string>; resources: Record<string, string>;
  phrases: Exclude<MarketLine, string>[];
  audio?: Record<string, string>;
  story: (MarketStory & { context?: string; objective: string; words?: Exclude<MarketLine, string>[] })[];
  preparation: (MarketContent['preparation'][number] & { description: string })[];
  scenarios: (MarketScenario & { label: string; rival: string; hintMeanings: string[] })[];
}
const root = document.getElementById('app')!;
const store = createExperimentStore({ getItem: k => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) });

function App({ c }: { c: Content }) {
  const initial = useRef(store.load());
  const invalid = useRef(!!initial.current.save && !restoreMarketState(c, initial.current.save.state));
  const game = useRef(createMarketGame(c, initial.current.save?.state));
  const [s, setState] = useState(game.current.state);
  const [support, setSupport] = useState(initial.current.save?.support ?? true);
  const [pronunciation, setPronunciation] = useState(initial.current.save?.pronunciation ?? true);
  const [sound, setSound] = useState(initial.current.save?.sound ?? true);
  const [audioFailed, setAudioFailed] = useState(false);
  const [saved, setSaved] = useState(true);
  const [open, setOpen] = useState<'journal' | 'help' | 'restart' | null>(null);
  const [name, setName] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const composing = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const ui = c.ui;
  const money = (n: number) => `${c.currency}${n.toLocaleString()}`;
  const send = (input: MarketInput) => setState(game.current.send(input));
  const stage = c.story[s.storyIndex];
  const scenario = c.scenarios[s.scenario];
  const hasDeal = s.deals.some(d => !d.fulfilled);
  const isMarket = ['prep', 'town', 'merchant'].includes(s.phase);
  const place = ['ending', 'complete'].includes(s.phase) ? c.places[c.endingPlace] : isMarket ? c.places.square : c.places[stage.place];
  const goal = s.phase === 'prep' ? ui.prepTitle : s.phase === 'town' ? (s.pending ? ui.resumeOffer : hasDeal ? ui.fulfill : s.day === s.visitDay ? ui.talk : ui.nextVisit) : s.phase === 'merchant' ? scenario.label : ['ending', 'complete'].includes(s.phase) ? ui.resultTitle : stage.objective;

  useEffect(() => {
    document.documentElement.lang = c.uiLocale;
    if (invalid.current) { store.backup(); invalid.current = false; }
  }, []);
  useEffect(() => setSaved(store.save({ state: s, support, pronunciation, sound })), [s, support, pronunciation, sound]);
  useEffect(() => { if (s.phase === 'merchant') composer.current?.focus(); else if (s.phase !== 'opening') heading.current?.focus(); }, [s.phase, s.storyIndex, s.endingIndex]);
  useEffect(() => { const el = conversation.current; if (el) el.scrollTop = el.scrollHeight; }, [s.messages.length]);

  const hear = (text: string) => {
    const file = c.audio?.[text.replaceAll('{player}', s.player)];
    if (!file) return;
    if (!audio.current) audio.current = new Audio();
    audio.current.pause(); audio.current.src = `audio/${file}`;
    setAudioFailed(false);
    void audio.current.play().catch(() => setAudioFailed(true));
  };
  useEffect(() => {
    if (!sound) { audio.current?.pause(); return; }
    const last = s.phase === 'story' ? (typeof stage.text === 'string' ? undefined : stage.text.text) : s.messages.at(-1)?.speaker === 'npc' ? s.messages.at(-1)?.text : undefined;
    if (last) hear(last);
  }, [s.phase, s.storyIndex, s.messages.length, sound]);
  useEffect(() => () => audio.current?.pause(), []);

  const line = (value: MarketLine, large = false, listen = false) => {
    const l = typeof value === 'string' ? { text: value } : value;
    const replace = (text: string) => text.replaceAll('{player}', s.player);
    return <div class={large ? 'spoken large' : 'spoken'}>
      <p class="spoken-text" lang={l.meaning ? c.locale : c.uiLocale}>{replace(l.text)}</p>
      {l.reading && pronunciation && <p class="reading">{replace(l.reading)}</p>}
      {l.meaning && support && <p class="meaning">{replace(l.meaning)}</p>}
      {listen && c.audio?.[replace(l.text)] && <button type="button" class="listen" onClick={() => hear(l.text)}>{ui.listen}</button>}
    </div>;
  };
  const messages = (rows: readonly MarketMessage[]) => rows.map((m, i) => <div key={i} class={`message ${m.speaker}`}>
    {m.speaker === 'player' && <span class="speaker">{s.player}</span>}
    {line(m, false, m.speaker === 'npc')}
  </div>);
  const offer = s.pending;
  const submit = () => {
    if (composing.current) return;
    send({ type: 'text', text: composer.current?.value ?? s.draft });
    composer.current?.focus();
  };
  const insert = (phrase: string) => {
    send({ type: 'assist' });
    send({ type: 'draft', text: phrase });
    setOpen(null);
    setTimeout(() => composer.current?.focus(), 0);
  };
  const reset = () => {
    store.backup();
    game.current = createMarketGame(c);
    setState(game.current.state); setName(''); setOpen(null);
  };

  return <div class={`game ${s.phase}`}>
    <header class="masthead">
      <span class="brand">{c.title}</span>
      <span class="subtle">{c.subtitle}</span>
    </header>
    {s.phase !== 'opening' && <div class="calendar" aria-label={ui.notice}>
      <span>{place} · {ui.day} {s.day}, {ui.parts[s.slot]}</span>
      <span>{ui.money} {money(s.wallet)}</span>
    </div>}
    <main>
      {s.phase === 'opening' ? <section class="arrival">
        <h1>{c.subtitle}</h1>
        {c.intro.map(text => <p>{text}</p>)}
        <form class="name-form" onSubmit={e => { e.preventDefault(); send({ type: 'name', text: name }); }}>
          <label for="player-name">{ui.name}</label>
          <input id="player-name" name="given-name" autoComplete="given-name" maxLength={24} value={name} onInput={e => setName(e.currentTarget.value)} />
          <button class="primary" disabled={!name.trim()}>{ui.begin}</button>
        </form>
      </section> : <>
        <div class="objective"><span>{ui.objective}</span><h1 ref={heading} tabIndex={-1}>{goal}</h1></div>
        {(initial.current.recovered || invalid.current) && <p role="status" class="notice">{ui.recovered}</p>}
        {s.notice && !['ending', 'complete'].includes(s.phase) && <div class="notice" role="status">{line(s.notice)}</div>}
        {audioFailed && <p role="status" class="small subtle">{ui.audioFailed}</p>}

        {s.phase === 'story' && <section class="story-beat">
          {stage.context && <p class="context">{stage.context}</p>}
          {stage.npc && <p class="speaker">{c.cast[stage.npc]}</p>}
          {line(stage.text, true, true)}
          {stage.choices?.length ? <div class="choices">
            {stage.choices.map(choice => <button class="reply" onClick={() => send({ type: 'choose', id: choice.id })}>{line(choice)}</button>)}
          </div> : <button class="primary advance" onClick={() => send({ type: 'continue' })}>{ui.continue} <span aria-hidden="true">→</span></button>}
        </section>}

        {s.phase === 'reaction' && <section class="reaction-beat">
          <div aria-live="polite">{messages(s.messages)}</div>
          <button class="primary advance" onClick={() => send({ type: 'continue' })}>{ui.next} <span aria-hidden="true">→</span></button>
        </section>}

        {s.phase === 'prep' && <section>
          <p class="context">{ui.prepIntro}</p>
          <p class="time-budget"><strong>{Math.max(0, 2 - s.preparations.length)}</strong> {ui.prepLeft}</p>
          <p class="subtle">{ui.prepEstimate}</p>
          <Preparation c={c} selected={s.preparations} onChoose={id => send({ type: 'prepare', id })} />
          <button class="secondary advance" onClick={() => send({ type: 'wait' })}>{ui.arrive} <span aria-hidden="true">→</span></button>
          <p class="small subtle">{ui.waitExplanation}</p>
        </section>}

        {s.phase === 'town' && <section>
          {hasDeal && !s.pending && <div class="reserved">
            <p>{ui.fulfillHint}</p>
            <button class="primary" onClick={() => send({ type: 'fulfill' })}>{ui.fulfill} <span aria-hidden="true">→</span></button>
          </div>}
          {s.day === s.visitDay ? <>
            <p class="time-budget"><strong>{4 - s.slot}</strong> {ui.actions}</p>
            {s.slot === 3 && <p class="last-call">{ui.lastCall}</p>}
            <p class="context">{ui.visitEstimate}</p>
            <button class="primary advance" onClick={() => send({ type: 'talk' })}>{s.pending ? ui.resumeOffer : ui.talk} <span aria-hidden="true">→</span></button>
            <ResourceList c={c} resources={s.resources} />
            {s.pending ? <p class="small subtle">{ui.pausedOffer}</p> : <>
              <Preparation c={c} selected={s.preparations} onChoose={id => send({ type: 'prepare', id })} />
              <button class="text-action" onClick={() => send({ type: 'wait' })}>{ui.skipVisit}</button>
            </>}
          </> : <>
            <h2>{ui.departed}</h2><p class="context">{ui.returnHint}</p>
            <button class="primary advance" onClick={() => send({ type: 'wait' })}>{ui.nextVisit} <span aria-hidden="true">→</span></button>
            <p class="small subtle">{ui.waitExplanation}</p>
          </>}
        </section>}

        {s.phase === 'merchant' && <section class="negotiation">
          <div class="market-facts">
            <p>{scenario.rival} · {ui.rival} <strong>{money(scenario.rivalPrice)}</strong></p>
            <p class="small subtle">{ui.rivalHint}</p>
            {s.slot === 3 && <p class="last-call">{ui.lastCall}</p>}
            <ResourceList c={c} resources={s.resources} />
          </div>
          <p class="speaker">{c.cast.trader}</p>
          <div class="conversation" ref={conversation} aria-label={ui.history}>{messages(s.messages)}</div>
          <span class="sr-only" role="status" aria-live="polite">{s.messages.at(-1)?.meaning ?? s.messages.at(-1)?.text}</span>
          {offer && <section class="terms" aria-label={ui.offerTitle}>
            <h2>{ui.offerTitle}</h2>
            <dl><dt>{ui.item}</dt><dd>{scenario.label}</dd><dt>{ui.quantity}</dt><dd>{offer.quantity}</dd><dt>{ui.price}</dt><dd>{money(offer.price)}</dd><dt>{ui.cost}</dt><dd>{money(scenario.cost)}</dd><dt>{ui.profit}</dt><dd>{money(offer.price - scenario.cost)}</dd><dt>{ui.deadline}</dt><dd>{ui.parts[3]}</dd></dl>
            <p class="small">{ui.offerHint}</p>
            <button class="primary" onClick={() => send({ type: 'confirm' })}>{ui.confirm}</button>
          </section>}
          <form class="composer" onSubmit={e => { e.preventDefault(); submit(); }}>
            <label class="sr-only" for="reply">{ui.draft}</label>
            <textarea ref={composer} id="reply" value={s.draft} rows={2} maxLength={240} placeholder={ui.draft} lang={c.locale} autoComplete="off" autoCapitalize="off" spellcheck={false} enterkeyhint="send"
              onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
              onInput={e => send({ type: 'draft', text: e.currentTarget.value })}
              onKeyDown={e => { if (!composing.current && shouldSend(e)) { e.preventDefault(); submit(); } }} />
            <div class="composer-actions"><button type="button" class="secondary" onClick={() => setOpen('help')}>{ui.help}</button><button class="primary" disabled={!s.draft.trim()}>{ui.send} <span aria-hidden="true">→</span></button></div>
          </form>
          <button class="text-action" onClick={() => send({ type: 'leave' })}>{ui.leave}</button>
          <p class="small subtle">{ui.leaveHint}</p>
        </section>}

        {s.phase === 'ending' && <section class="ending-story">
          {line(c.ending[s.endingIndex], true)}
          <button class="primary advance" onClick={() => send({ type: 'continue' })}>{ui.continue} <span aria-hidden="true">→</span></button>
        </section>}
        {s.phase === 'complete' && <section class="complete-story">
          <p class="context">{ui.resultBody}</p>
          <p class="closing-line">{ui.nextTown}</p>
          <p>{ui.nextTownHint}</p>
          <p class="small subtle">{s.deals.some(d => d.assisted) ? ui.assistRecord : ui.soloRecord}</p>
          <button class="secondary advance" onClick={() => setOpen('restart')}>{ui.practiceAgain}</button>
        </section>}
      </>}
    </main>
    <footer>
      <div class="footer-actions"><button onClick={() => setOpen('journal')}>{ui.journal}</button>{s.phase !== 'opening' && <button onClick={() => setOpen('help')}>{ui.help}</button>}</div>
      <span class={saved ? 'save-status subtle' : 'save-status'} role="status">{saved ? ui.saved : ui.unsaved}</span>
    </footer>
    {open && <Modal label={ui[open === 'restart' ? 'restart' : open]} closeLabel={ui.close} onClose={() => setOpen(null)}>
      {open === 'restart' ? <><p>{ui.newConfirm}</p><div class="modal-actions"><button class="secondary" onClick={() => setOpen(null)}>{ui.cancel}</button><button class="primary" onClick={reset}>{ui.restart}</button></div></> : open === 'journal' ? <>
        <h2>{ui.recap}</h2><p>{goal}</p>
        <div class="journal">{s.journal.length ? messages(s.journal) : c.intro.map(text => <p>{text}</p>)}</div>
        <button class="text-action" onClick={() => setOpen('restart')}>{ui.newGame}</button>
      </> : <>
        <div class="settings"><label><input type="checkbox" checked={support} onChange={e => setSupport(e.currentTarget.checked)} />{ui.meanings}</label><label><input type="checkbox" checked={pronunciation} onChange={e => setPronunciation(e.currentTarget.checked)} />{ui.readings}</label>{c.audio && <label><input type="checkbox" checked={sound} onChange={e => setSound(e.currentTarget.checked)} />{ui.sound}</label>}</div>
        <p class="small subtle">{ui.supportHint}</p>
        {s.phase === 'merchant' ? <>
          <h2>{ui.hintQuestions}</h2>
          <div class="phrase-list">{c.phrases.map(p => <button class="phrase" onClick={() => insert(p.text)}>{line(p)}</button>)}</div>
          <h2>{ui.hintOffers}</h2>
          <div class="phrase-list">{scenario.hints.map((text, i) => <button class="phrase" onClick={() => insert(text)}>{line({ text, meaning: scenario.hintMeanings[i] })}</button>)}</div>
        </> : <div class="word-list">{c.story.slice(0, s.storyIndex + 1).flatMap(b => b.words ?? []).map(word => line(word, false, true))}</div>}
      </>}
    </Modal>}
  </div>;
}

function Preparation({ c, selected, onChoose }: { c: Content; selected: string[]; onChoose(id: string): void }) {
  return <div class="preparations">{c.preparation.filter(p => !selected.includes(p.id)).map(p => <button class="prep-option" onClick={() => onChoose(p.id)}><strong>{p.text}</strong><span>{p.description}</span></button>)}</div>;
}
function ResourceList({ c, resources }: { c: Content; resources: Record<string, number> }) {
  return <p class="resource-list"><span>{c.ui.resources}: </span>{Object.entries(resources).filter(([, n]) => n > 0).map(([id, n]) => `${c.resources[id]} ×${n}`).join(' · ') || '—'}</p>;
}
function Modal({ label, closeLabel, onClose, children }: { label: string; closeLabel: string; onClose(): void; children: preact.ComponentChildren }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onClose={onClose} aria-label={label}>
    <div class="dialog-head"><h1>{label}</h1><button onClick={() => dialog.current?.close()}>{closeLabel}</button></div>
    <div class="dialog-body">{children}</div>
  </dialog>;
}

fetch('content.json', { cache: 'no-cache' }).then(res => {
  if (!res.ok) throw new Error(`Content: ${res.status}`);
  return res.json();
}).then((content: Content) => render(<App c={content} />, root)).catch(() => {
  root.textContent = 'The town could not load. Reload to try again.';
});
