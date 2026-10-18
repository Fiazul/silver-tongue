"""Segmented personal memories, indexed routing and visible-transcript evidence (stdlib)."""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import logging
import embeddings
import image_refs
import storage
import knowledge
import disclosure

SEGMENTS = ('people', 'gifts', 'events', 'worries', 'promises', 'boundaries', 'feelings', 'milestones', 'important', 'world',
            'reference')
# Raw computed readouts live apart from authored answers; only seeded lore may use it.
LORE_ONLY_SEGMENTS = ('reference',)
LOCK = threading.RLock()
LOG = logging.getLogger(__name__)
SYNONYMS = (
    'age ages aged aging ageing old years year born birthday birthdays',
    'gift gifts gifted give gives giving gave given receive received receiving present presents',
    'date dates dating outing outings trip trips excursion excursions dinner',
    'worry worries worried concern concerns concerned okay unresolved thread',
    'promise promises promised commitment commitments', 'plan plans planned planning',
    'name names named identity called introduce introduced introduction',
    'job jobs work occupation profession career', 'origin home hometown planet birthplace',
    'boundary boundaries space stop rejection rejected refused',
    'love loved confession confessed feelings',
    'image images picture pictures pic pics photo photos photograph photographs photography '
    'shot shots snapshot snapshots selfie selfies candid camera screenshot screenshots',
    'share shared sharing send sends sent show showed shown',
    'sleep slept sleeping sleeps',
    'log logs',
    # Morphological variants only. Concept-level mapping (drive -> Asterion,
    # dust -> shield, ...) lives in CONCEPTS so distinct questions stay distinct.
    'shield shielding', 'cryo cryosleep cryogenic', 'tide tidal', 'relativity relativistic',
)
CANON = {word: group.split()[0] for group in SYNONYMS for word in group.split()}
STOP = set('a an the i you your my me we our they their it is was are do does did remember to of and in on for that this when have has be with about'.split())
ROUTES = {
    'people': 'age name job origin preference favorite like',
    'gifts': 'gift', 'events': 'date experience place visit together',
    'worries': 'worry still question problem safe air', 'promises': 'promise tomorrow weekend meet',
    'boundaries': 'boundary consent no limit', 'feelings': 'love feel miss',
    'milestones': 'first confession anniversary', 'important': 'important never forget science physics',
    'world': 'place room world time situation arrived outside calendar era',
}
# An explicit, visible withdrawal of a space/no-contact/stop request by the person who made it.
LIFTING = re.compile(
    r"\b(?:you\s+can|you\s+may|feel\s+free\s+to|it'?s\s+(?:ok(?:ay)?|fine|alright)\s+to)\s+"
    r"(?:talk|message|dm|text|write|contact|reach\s+out|come\s+back)|"
    r"\b(?:i'?m|i\s+am)\s+ready\s+to\s+talk\b|\bno\s+longer\s+need\s+(?:space|distance)\b|"
    r"\b(?:i\s+)?(?:lift|drop|withdraw|take\s+back|end)\s+(?:my|the|that)\s+(?:boundary|request|no[- ]contact)|"
    r"\b(?:we\s+can|let'?s)\s+talk\s+again\b|\bplease\s+(?:talk|message|write)\s+(?:to\s+)?me\s+again\b", re.I)
PHYSICS_READOUT_TAG = 'physics-readout'
MAX_READOUTS = 3
SCIENCE_EVIDENCE_MIN = 2.0
SCIENCE_BUDGET = 2400


def tokens(text):
    text = re.sub(r'\b(?:night out|went out)\b', 'outing', text.lower()).replace('%', ' percent ')
    words = re.findall(r"[a-z0-9]+", text)
    result = []
    for word in words:
        word = {'picutre': 'picture', 'remeber': 'remember', 'recieve': 'receive', 'recieved': 'received'}.get(word, word)
        if word in STOP:
            continue
        if word not in CANON and word.endswith('s') and len(word) > 4:
            word = word[:-1]
        result.append(CANON.get(word, word))
    return result


# Curated concept map: colloquial phrasing -> the lore concepts that answer it.
# Applied to queries (expansion) and to seeded lore tags, never to CANON, so
# e.g. dust and radiation questions remain distinguishable.
CONCEPTS = (
    (r'\brocket equation|\bmass ratio|tsiolkovsky|(?<![\d.])0?\.9\d*\s*c\b|\bnear(?:ly)?[- ]?light|'
     r'\blight[- ]?speed|\bspeed of light|\bso fast\b|\bhow fast\b|\bfaster\b|\bpropuls|\bpropel|'
     r'\bdrives?\b|\bengines?\b|\bthrust|\bfuel|\brockets?\b|\btorch|\basterion|\binertia',
     'asterion fusion drive propulsion'),
    (r'\bradiation|\bprotons?\b|\bcosmic ray|\binterstellar gas|\bdose\b|\bfry\b', 'radiation proton shield'),
    (r'\bdust\b|\bgrains?\b|\bspeck|\bpebble|\bmicrogram|\bdebris', 'dust grain shield'),
    (r'\bsirius|\bparallax|\bproper motion|\btracker|\bsky\b|\bconstellation', 'sirius tracker sky'),
    (r'\bwormhole|\bportal|\bunexplained transit', 'wormhole transit'),
    (r'\bcryo|\bhibernat|\bfrozen\b', 'cryo'),
    (r'\btwin paradox|\btime dilation|\bdilation|\bproper time|\btwins?\b', 'twin relativity clock'),
    (r'\bag(?:e|es|ed|ing|eing)\b|\byounger\b|\bolder\b', 'relativity clock'),
    (r'\bneutron|\btidal|\btides?\b|\bspaghetti', 'neutron tidal'),
    (r'\batmosphere|\bleave (?:the )?(?:planet|earth|ground)|\btake off\b|\bfly away|\bto orbit\b',
     'atmosphere leave'),
    (r'\benergy\b|\bpower source|\bpowered\b', 'energy fusion'),
)
CONCEPT_PATTERNS = tuple((re.compile(pattern, re.I), terms) for pattern, terms in CONCEPTS)


def concept_terms(text):
    """Concept keywords implied by colloquial phrasing (e.g. '0.998c' -> asterion drive)."""
    found = []
    for pattern, terms in CONCEPT_PATTERNS:
        if pattern.search(text):
            found += [t for t in terms.split() if t not in found]
    return found


def expand_query(text):
    extra = concept_terms(text)
    return text + (' ' + ' '.join(extra) if extra else '')


SCIENCE_TERMS = set(tokens(
    'physics rocket equation mass ratio fusion asterion inertia drive engine thrust fuel propulsion '
    'exhaust gamma relativity radiation proton dust grain shield sirius parallax wormhole cryo '
    'twin paradox tidal neutron tracker sky atmosphere lightspeed torch energy field '
    'relativistic dilation orbit transit'
))
QUANTITY_PATTERN = re.compile(
    r'\bhow\s+(?:much|many|far|long|fast|hot|big|strong|heavy|close|massive)\b|'
    r"\bwhat(?:'s|\s+is|\s+was|\s+were|\s+are)?\s+(?:the\s+|your\s+|its\s+)?(?:exact\s+|actual\s+|peak\s+)?"
    r'(?:number|value|figure|reading|readout|rating|load|ratio|percent|percentage|power|energy|dose|flux|'
    r'distance|mass|temperature|gamma|beta|speed|velocity|angle|delay|duration)s?\b|'
    r'\b(?:quote|readouts?|exact\s+(?:figure|number|value)s?|in\s+numbers|numbers?\s+(?:on|for)|'
    r'calculate|compute|mass\s+ratio|kilograms?|megawatts?|joules?|watts?|gev)\b', re.I)


def is_science_query(text):
    return bool(set(tokens(expand_query(text))) & SCIENCE_TERMS)


def asks_for_quantity(text):
    """True when the asker wants a specific number/quantity, not a mechanism explanation.

    A number merely mentioned ("0.998c", "117%") is context, not a request for a readout."""
    return bool(QUANTITY_PATTERN.search(text))


def is_physics_readout(record):
    tags = {t.lower() for t in record.get('tags', [])}
    return PHYSICS_READOUT_TAG in tags or record.get('text', '').startswith('Computed reference ')


def lore_matches(record, query):
    """Authored lore is retrieved by topic, never merely by a present person."""
    if not record.get('retrieval_only'):
        return True
    if is_physics_readout(record) and not asks_for_quantity(query):
        return False
    terms = set(tokens(expand_query(query))) - TOPIC_STOP - set(tokens('Mystery Ryoma Tachibana Vella Iris remember tell know'))
    tags = record['tags']
    if record.get('private'):
        terms -= set(tokens('log logs readout readouts history personal'))
    return bool(terms & set(tokens(' '.join(tags))))


# Conversational scaffolding must not make unrelated questions look alike.
TOPIC_STOP = set(tokens("yes no still need tell answer answered answering question ask asked asking "
                        "please explain explanation honestly clearly whether what why how who where "
                        "can could would will shall should must want just now then again yet not "
                        "before until unless once something anything everything thing stand stands "
                        "been being don doesn't didn haven hasn't isn aren won wouldn couldn "
                        "he she him her his hers them us its myself yourself really also get got or if "
                        "s t m re ll ve"))


SCORING_STOP = set(tokens('all those these every some any very much many so too'))


def topic_terms(text, names=()):
    return frozenset(tokens(text)) - TOPIC_STOP - set(tokens(' '.join(names)))


def topics_match(left, right):
    overlap = left & right
    size = min(len(left), len(right))
    return bool(overlap) and len(overlap) / size >= .5


def question_topics(text, names=()):
    """Extract topics only from questions, demands, and conditional demands."""
    for sentence in re.findall(r'[^.!?;\n]+[.!?;]?', text):
        if ('?' in sentence or re.search(
                r'\byes\s+or\s+no\b|\bi\s+(?:still\s+)?need\b|\btell\s+me\b|'
                r'(?:^\s*|[,:]\s*)(?:please\s+)?(?:answer|explain)\b|'
                r'\b(?:must|need\s+to|before\s+you|until\s+you|unless\s+you)\s+(?:answer|explain)\b|'
                r"\b(?:won't|will\s+not|not|no)\b.+\b(?:until|unless|before)\b", sentence, re.I)):
            terms = topic_terms(sentence, names)
            if terms:
                yield terms


def worry_label(record, already_asked=None, names=()):
    if record['status'] != 'open':
        return ''
    terms = topic_terms(record['text'] + ' ' + ' '.join(record['tags']), list(names) + record['about'])
    people = {person.lower() for person in record['about']}
    asked = any(topics_match(terms, topic)
                for person, topics in (already_asked or {}).items() if person.lower() in people
                for topic in topics)
    return (' (asked already — let it rest unless they bring it up)' if asked else
            ' (on your mind — not a question to re-ask each turn)')


def visible_messages(messages, name, boundary=0):
    def after(message):
        try:
            return not boundary or int(message.get('id', 0)) >= boundary
        except (TypeError, ValueError):
            return False
    return [m for m in messages if (m.get('kind', 'chat') == 'chat' or
                                  (m.get('channel') == 'scene' and m.get('kind') == 'narration')) and after(m)
            and (m.get('channel') != 'dm' or name in (m['name'], m.get('to')))
            and ('known_by' not in m or name in m['known_by'])]


def is_recall_query(text):
    return bool(re.search(r'\b(?:remember|remeber|forgot|forgotten|forget|recall|remind)\b|'
                          r'\bdid\s+i\s+(?:send|tell|give|show)\b|\byou\s+know\s+what\s+i\b|'
                          r'\bwhat\s+(?:did\s+i|i\s+(?:gave|sent|showed|told))\b', text, re.I))


RECALL_STOP = set(tokens('remember remeber forgot forgotten forget recall remind know dont don t '
                         'what which how who when where why did our us you me i my your '
                         'could would can please about that this it s do really'))


def recall_terms(query, names=()):
    return set(tokens(query)) - RECALL_STOP - set(tokens(' '.join(names)))


def image_related(text):
    return 'image' in tokens(text)


class Store:
    def __init__(self, root, name, lock=LOCK, boundary=0, embedding_config=None, vector_writes=True, generation_check=None):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 _-]{0,79}', name):
            raise ValueError('Invalid character name')
        self.directory = Path(root) / name
        # Room/thread lock first, then a per-character flock shared with other processes
        # (backfill_memory.py), around every read and read-modify-write of this store.
        self.room_lock = lock
        self.file_lock = storage.process_lock(self.directory / '.lock')
        self.lock = storage.Combined(lock, self.file_lock)
        self.boundary = boundary
        self.embedding_config = embeddings.settings(embedding_config)
        self.vector_writes = vector_writes
        self.generation_check = generation_check
        self._vectors = {}
        self.last_semantic = False

    def current(self):
        return self.generation_check is None or self.generation_check() == self.boundary

    def _read(self, file, default):
        path = self.directory / file
        return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default

    def index(self):
        with self.lock:
            index = self._read('index.json', {})
            return index if index.get('boundary', 0) == self.boundary else {}

    def load_segment(self, segment):
        if segment not in SEGMENTS:
            return []
        with self.lock:
            if not self.index():
                return []
            return [r for r in self._read(segment + '.json', []) if not r.get('superseded')]

    def _write(self, file, value):
        # Callers hold self.lock; the unique temp name keeps concurrent writers apart.
        storage.atomic_write(self.directory / file, json.dumps(value, ensure_ascii=False, indent=2))

    def has_source(self, source_id):
        """True when any record (any segment) was written for this source, e.g. a scene id."""
        source_id = str(source_id)
        with self.lock:
            if not self.index():
                return False
            return any(r.get('source_id') == source_id for s in SEGMENTS for r in self._read(s + '.json', []))

    @staticmethod
    def validate(raw, source_id, time):
        if not isinstance(raw, dict) or raw.get('segment') not in SEGMENTS:
            return None
        if raw['segment'] in LORE_ONLY_SEGMENTS and raw.get('retrieval_only') is not True:
            return None
        text, about, tags = raw.get('text'), raw.get('about'), raw.get('tags')
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 800:
            return None
        if not isinstance(about, list) or not 1 <= len(about) <= 12 or not all(isinstance(n, str) and 0 < len(n.strip()) <= 80 for n in about):
            return None
        if not isinstance(tags, list) or not 1 <= len(tags) <= 24 or not all(isinstance(t, str) and 0 < len(t.strip()) <= 60 for t in tags):
            return None
        if type(raw.get('importance')) is not int or not 1 <= raw['importance'] <= 5 or raw.get('status', 'open') not in ('open', 'resolved'):
            return None
        about = sorted(set(n.strip() for n in about))
        normalized = ' '.join(re.findall(r'\w+', text.lower()))
        key = raw['segment'] + '|' + '|'.join(n.lower() for n in about) + '|' + normalized
        value = dict(id=hashlib.sha256(key.encode()).hexdigest()[:20], about=about, text=text.strip(),
                    tags=sorted(set(t.strip().lower() for t in tags)), importance=raw['importance'],
                    status=raw.get('status', 'open'), source_id=str(source_id), time=time)
        for flag in ('retrieval_only',) + disclosure.PRIVATE_FLAGS:
            if raw.get(flag) is True:
                value[flag] = True
        if raw.get('sensitivity') in disclosure.TIERS:
            value['sensitivity'] = raw['sensitivity']
        if (raw['segment'] == 'boundaries' and isinstance(raw.get('disclosure_control'), dict)
                and raw.get('stated_by') == 'Mystery'):
            value['disclosure_control'] = dict(raw['disclosure_control'])
        if isinstance(raw.get('known_by'), list):
            value['known_by'] = sorted({n for n in raw['known_by'] if isinstance(n, str) and 0 < len(n) <= 80})
        if raw.get('source_channel') in ('group', 'dm', 'scene'):
            value['source_channel'] = raw['source_channel']
        if isinstance(raw.get('source_person'), str):
            value['source_person'] = raw['source_person'][:80]
        if raw.get('secret') is True:
            value.update(secret=True, secret_from=str(raw.get('secret_from') or 'unspecified; do not share')[:300])
        if raw['segment'] == 'boundaries' and raw.get('stated_by') is not None:
            # Who expressed the limit decides who may later lift it (see may_resolve).
            stater = raw['stated_by']
            if not isinstance(stater, str) or not 0 < len(stater.strip()) <= 80:
                return None
            value['stated_by'] = stater.strip()
        if raw['segment'] == 'world':
            speaker, belief = raw.get('speaker', ''), raw.get('belief', 'uncertain')
            if not isinstance(speaker, str) or len(speaker) > 80 or belief not in ('believes', 'uncertain', 'disbelieves'):
                return None
            value.update(speaker=speaker, belief=belief)
        return value

    def may_resolve(self, record, visible=()):
        """A boundary is lifted only by its stater, or after the stater visibly lifted it.

        The store owner (this character) may resolve a boundary they stated themselves.
        A boundary someone else stated -- or a legacy record without stated_by, whose
        other named people are then treated as possible staters -- stays open until one
        of those staters posts a visible, explicit lifting message after it was recorded."""
        if record.get('segment', 'boundaries') != 'boundaries':
            return True
        owner = self.directory.name.lower()
        stater = (record.get('stated_by') or '').strip().lower()
        if stater == owner:
            return True
        staters = {stater} if stater else {n.lower() for n in record.get('about', [])} - {owner}
        if not staters:
            return True  # Legacy record naming only the owner: the owner's own limit.
        since = record.get('time') or ''
        return any(m.get('name', '').lower() in staters and str(m.get('time', '')) >= since and
                   LIFTING.search(m.get('text', '')) for m in visible or ())

    def apply(self, remember=None, resolve=None, source_id='', time=None, limit=3, embed=True, visible=None,
              source=None):
        """Bad optional fields never invalidate an otherwise valid actor reply.

        visible: source evidence this character can see, also used to honour a
        boundary's explicit lifting by its stater. source is a trusted message
        supplied by a write path, including a synthetic shared scene summary."""
        time = time or datetime.now(timezone.utc).isoformat()
        with self.lock:
            if not self.current():
                return self.index()
            index = self.index()
            fresh = not index
            index = index or dict(boundary=self.boundary, people={}, tags={}, records={})
            changed = {}
            added = []
            if fresh:
                # A reset starts a new generation; old segment contents must not reappear.
                changed = {s: [] for s in SEGMENTS}
            for raw in remember[:limit] if isinstance(remember, list) else []:
                if not isinstance(raw, dict):
                    continue
                # Actor-supplied audience metadata is never authority. Recover the
                # source from this owner's visible transcript, or fail closed.
                owner = self.directory.name
                messages = visible_messages(visible or [], owner, self.boundary)
                origin = knowledge.source_for(raw, messages) or source or knowledge.source_for({'source_id': source_id}, messages)
                if origin and owner not in knowledge.witnesses(origin, owner):
                    origin = None
                enriched = {k: v for k, v in raw.items() if k not in
                            ('known_by', 'source_channel', 'source_person', 'secret', 'secret_from')}
                enriched.pop('disclosure_control', None)
                control = raw.get('disclosure_control')
                if (isinstance(control, dict) and control in disclosure.controls(
                        origin or {}, owner, raw.get('about', []))):
                    enriched['disclosure_control'] = control
                enriched.update(knowledge.provenance(origin, owner, raw.get('text', '')))
                record = self.validate(enriched, (origin or {}).get('id', source_id), (origin or {}).get('time') or time)
                if record is not None:
                    for subject, alias in knowledge.aliases((origin or {}).get('text', '') + '\n' + record['text'],
                                                           (origin or {}).get('name', owner), record['about']):
                        learned = index.setdefault('learned_names', {}).setdefault(subject, [])
                        if alias not in learned:
                            learned.append(alias)
                if record is None:
                    continue
                segment = raw['segment']
                rows = changed.setdefault(segment, self._read(segment + '.json', []))
                if record['id'] in index['records']:
                    previous = next((r for r in rows if r['id'] == record['id']), None)
                    if previous:
                        previous['known_by'] = sorted(knowledge.known_by(previous, messages, owner) | set(record['known_by']))
                        if record.get('secret'):
                            previous.update(secret=True, secret_from=record['secret_from'])
                    continue
                rows.append(record)
                added.append(record)
                index['records'][record['id']] = dict(segment=segment, about=record['about'],
                    importance=record['importance'], status=record['status'], tags=record['tags'], time=time,
                    retrieval_only=record.get('retrieval_only', False))
                for person in record['about']:
                    index['people'].setdefault(person.lower(), {}).setdefault(segment, []).append(record['id'])
                for tag in tokens(' '.join(record['tags'])):
                    ids = index['tags'].setdefault(tag, {}).setdefault(segment, [])
                    if record['id'] not in ids:
                        ids.append(record['id'])
            for record_id in resolve if isinstance(resolve, list) else []:
                if not isinstance(record_id, str) or record_id not in index['records']:
                    continue
                segment = index['records'][record_id]['segment']
                rows = changed.setdefault(segment, self._read(segment + '.json', []))
                target = next((r for r in rows if r['id'] == record_id), None)
                if target is None or not self.may_resolve(dict(target, segment=segment), visible):
                    LOG.info('%s: resolve of %s ignored; only its stater can lift it',
                             self.directory.name, record_id)
                    continue
                target['status'] = 'resolved'
                index['records'][record_id]['status'] = 'resolved'
            for segment, rows in changed.items():
                self._write(segment + '.json', rows)
            self._write('index.json', index)
        # No network request may hold the shared turn/store lock.
        if embed and added:
            self.ensure_vectors(added, missing_limit=8)
        return index

    def observe(self, message, labels=()):
        """Remember explicit introductions and stories actually spoken to this owner.

        No private model fields are copied to listeners. Ordinary memory extraction
        can later condense these attributed excerpts into independent durable facts.
        """
        owner = self.directory.name
        if not visible_messages([message], owner, self.boundary):
            return
        text, speaker = message.get('text', ''), message.get('name')
        if speaker == 'Mystery':
            instructions = disclosure.controls(message, owner, labels)
            records = [dict(segment='boundaries', about=[owner, c['listener'], 'Mystery'],
                            text=f"Captain disclosure instruction: {c['action']} {c['topic']} to {c['listener']}.",
                            tags=['disclosure'], importance=5, stated_by='Mystery',
                            disclosure_control=c) for c in instructions]
            if records:
                # Include source id in the text so repeated lock/unlock cycles retain chronology.
                for record in records:
                    record['text'] += ' Instruction ' + str(message.get('id', ''))
                self.apply(records, source_id=message.get('id', ''), time=message.get('time'),
                           limit=len(records), embed=False, visible=[message])
        learned = knowledge.aliases(text, speaker, labels)
        third = [n for n in labels if n not in (speaker, owner) and re.search(r'\b' + re.escape(n) + r'\b', text)]
        if not learned and not (message.get('channel') in ('dm', 'scene') and speaker != owner and third):
            return
        about = list(dict.fromkeys([n for n in (speaker, owner) if n] + third + [n for n, _ in learned]))
        # Keep alias facts independent of excerpt truncation and cheap to retrieve.
        records = [dict(segment='people', about=[subject], text=f"{subject}'s real name is {alias}.",
                        tags=['name', 'alias', alias], importance=5) for subject, alias in learned]
        if speaker != owner and third:
            records.append(dict(segment='events', about=about, text=f'Told by {speaker}: {text}'[:800],
                                tags=['confidence', 'story'] + third, importance=3))
        self.apply(records, source_id=message.get('id', ''), time=message.get('time'), limit=len(records),
                   embed=False, visible=[message])

    def ensure_vectors(self, records, query=None, missing_limit=None):
        c = self.embedding_config
        if not c['enabled']:
            return {}, None
        try:
            with self.lock:
                cached = self._read('vectors.json', {})
                if cached.get('boundary') == self.boundary:
                    self._vectors.update(cached.get('vectors', {}))
            docs = {r['id']: r['text'] + ' ' + ' '.join(r['tags']) for r in records}
            hashes = {rid: hashlib.sha256(text.encode()).hexdigest() for rid, text in docs.items()}
            def valid(rid):
                item = self._vectors.get(rid, {})
                return (item.get('model') == c['model'] and item.get('url') == c['url'] and
                        item.get('hash') == hashes[rid] and embeddings.valid_vector(item.get('vector')))
            missing = [rid for rid in docs if not valid(rid)]
            if query is not None:
                missing_limit = 8 if missing_limit is None else min(8, missing_limit)
            if missing_limit is not None:
                missing = missing[:missing_limit]
            inputs = (['search_query: ' + query] if query is not None else []) + ['search_document: ' + docs[rid] for rid in missing]
            result = embeddings.embed(inputs, c) if inputs else []
            if result is None:
                return {rid: self._vectors[rid]['vector'] for rid in docs if valid(rid)}, None
            query_vector = result[0] if query is not None else None
            offset = 1 if query is not None else 0
            fresh = {rid: dict(model=c['model'], url=c['url'], hash=hashes[rid], vector=vector)
                     for rid, vector in zip(missing, result[offset:])}
            self._vectors.update(fresh)
            if fresh and self.vector_writes:
                with self.lock:
                    if self.current():
                        latest = self._read('vectors.json', {})
                        merged = latest.get('vectors', {}) if latest.get('boundary') == self.boundary else {}
                        merged.update(fresh)
                        self._write('vectors.json', dict(boundary=self.boundary, vectors=merged))
            return {rid: self._vectors[rid]['vector'] for rid in docs if valid(rid)}, query_vector
        except Exception as exc:
            LOG.warning('Embedding cache unavailable; using keywords: %s', exc)
            return {}, None

    def embed_missing(self, batch_size=None, retries=2):
        """Embed every active record; small batches keep long lore under the request timeout."""
        records = [r for s in SEGMENTS for r in self.load_segment(s)]
        if not batch_size:
            vectors, _ = self.ensure_vectors(records)
            return len(vectors), len(records)
        found = 0
        for offset in range(0, len(records), batch_size):
            batch = records[offset:offset + batch_size]
            for attempt in range(retries + 1):
                vectors, _ = self.ensure_vectors(batch)
                if len(vectors) == len(batch) or not self.embedding_config['enabled']:
                    break
                # A failed request opens a 60 s client break; an offline batch job retries at once.
                with embeddings.LOCK:
                    embeddings.BREAKS.pop((self.embedding_config['url'], self.embedding_config['model']), None)
            found += len(vectors)
        return found, len(records)

    def hybrid_scores(self, query, rows, scores):
        self.last_semantic = False
        vectors, query_vector = self.ensure_vectors([r for _, r in rows], query)
        if query_vector is None or not vectors:
            return scores
        self.last_semantic = True
        maximum = max(scores, default=0) or 1
        c = self.embedding_config
        total = c['keyword_weight'] + c['semantic_weight']
        result = []
        for (_, record), keyword in zip(rows, scores):
            similarity = max(0., embeddings.cosine(query_vector, vectors.get(record['id'])))
            score = (c['keyword_weight'] * keyword / maximum + c['semantic_weight'] * similarity) / total
            result.append(score if keyword or similarity >= c['min_similarity'] else 0.)
        return result

    def prompt_anchors(self, counterpart=None):
        index = self.index()
        world = []
        personal = []
        feelings = []
        recent_events = []
        for rid, meta in index.get('records', {}).items():
            if meta.get('retrieval_only') or meta.get('superseded'):
                continue
            if meta['segment'] == 'world' and meta['importance'] >= 4:
                world.append(rid)
            elif (counterpart and (meta['segment'] == 'feelings' or
                  (meta['segment'] == 'milestones' and meta['importance'] >= 4))
                  and counterpart.lower() in {n.lower() for n in meta['about']}):
                feelings.append(rid)
            elif (counterpart and meta['segment'] == 'people' and meta['importance'] == 5
                  and counterpart.lower() in {n.lower() for n in meta['about']}):
                personal.append(rid)
            elif (counterpart and meta['segment'] == 'events' and meta['importance'] >= 4 and
                  counterpart.lower() in {n.lower() for n in meta['about']}):
                recent_events.append(rid)
        world.sort(key=lambda rid: (index['records'][rid]['importance'], index['records'][rid]['time']), reverse=True)
        feelings.sort(key=lambda rid: (index['records'][rid]['importance'], index['records'][rid]['time']), reverse=True)
        recent_events.sort(key=lambda rid: index['records'][rid]['time'], reverse=True)
        # Keep both kinds of bond evidence even when many milestones outrank feelings.
        bond_pins = []
        for segment in ('feelings', 'milestones'):
            first = next((rid for rid in feelings if index['records'][rid]['segment'] == segment), None)
            if first:
                bond_pins.append(first)
        bond_pins += [rid for rid in feelings if rid not in bond_pins]
        wanted = set(world[:5] + personal + bond_pins[:3] + recent_events[:1])
        segments = {index['records'][rid]['segment'] for rid in wanted}
        return [(s, r) for s in sorted(segments) for r in self.load_segment(s) if r['id'] in wanted]

    def retrieve(self, query, people, recall=None):
        """Route using the small index before opening any segment files."""
        with self.lock:
            if recall is None:
                recall = is_recall_query(query)
            query = expand_query(query)
            if recall:
                return self._retrieve_recall(query, people)
            index = self.index()
            terms = set(tokens(query))
            present = {p.lower() for p in people}
            present.update(person for person in index.get('people', {}) if re.search(r'(?<!\w)' + re.escape(person) + r'(?!\w)', query.lower()))
            segments = {s for s, keywords in ROUTES.items() if terms & set(tokens(keywords))}
            if 'remember when' in query.lower() or 'that night' in query.lower():
                segments.add('events')
            ids = set()
            for term in terms:
                for segment, matches in index.get('tags', {}).get(term, {}).items():
                    segments.add(segment)
                    ids.update(matches)
            for person in present:
                for segment, matches in index.get('people', {}).get(person, {}).items():
                    if segment in segments or segment == 'people':
                        segments.add(segment)
                        ids.update(matches)
            pinned = set()
            relevant_ids = {record_id for person in present for matches in index.get('people', {}).get(person, {}).values() for record_id in matches}
            for record_id in relevant_ids:
                meta = index['records'][record_id]
                if meta.get('retrieval_only'):
                    continue
                if meta['importance'] == 5 or meta['segment'] == 'milestones' or (meta['segment'] == 'worries' and meta['status'] == 'open'):
                    segments.add(meta['segment'])
                    ids.add(record_id)
                    pinned.add(record_id)
            rows = [(s, r) for s in sorted(segments) for r in self.load_segment(s)
                    if lore_matches(r, query) and
                    (r['id'] in ids or terms.intersection(tokens(r['text'] + ' ' + ' '.join(r['tags']))))]
            docs = [tokens(r['text'] + ' ' + ' '.join(r['tags'])) for _, r in rows]
            frequencies = Counter(t for doc in docs for t in set(doc))
            average = sum(map(len, docs)) / max(1, len(docs))
            now = datetime.now(timezone.utc)
            scored = []
            # Question scaffolding ("how", "can", "no") must not rank long answers by accident.
            scoring = (terms - TOPIC_STOP - SCORING_STOP) or terms
            for (segment, record), doc in zip(rows, docs):
                counts = Counter(doc)
                lexical = sum(math.log(1 + (len(rows) + 1) / (1 + frequencies[t])) * counts[t] * 2.2 /
                              (counts[t] + 1.2 * (0.25 + 0.75 * len(doc) / max(1, average))) for t in scoring if counts[t])
                person_boost = 2 if present.intersection(n.lower() for n in record['about']) else 0
                try:
                    days = max(0, (now - datetime.fromisoformat(record['time'])).total_seconds() / 86400)
                except (TypeError, ValueError):
                    days = 365
                score = lexical * 5 + person_boost + record['importance'] * .3 + 1 / (1 + days)
                score += .8 if record['status'] == 'open' and segment in ('worries', 'promises') else 0
                scored.append((score, segment, record))
            # Lexical matches lead (e.g. age); pins remain in the budgeted selection.
            hybrid = self.hybrid_scores(query, [(s, r) for _, s, r in scored], [score for score, _, _ in scored])
            ranked = [(score, s, r) for score, (_, s, r) in zip(hybrid, scored)]
            return [(s, r) for _, s, r in sorted(ranked, key=lambda row: (-row[0], row[2]['id']))], pinned

    def _retrieve_recall(self, query, people):
        """Read every segment, including stores indexed before synonym updates."""
        index = self.index()
        known = set(index.get('people', {})) | {self.directory.name.lower()}
        present = {p.lower() for p in people}
        present.update(n for n in known if re.search(r'(?<!\w)' + re.escape(n) + r'(?!\w)', query.lower()))
        partners = present - {self.directory.name.lower()}
        terms = recall_terms(query, known)
        rows = [(s, r) for s in SEGMENTS for r in self.load_segment(s) if lore_matches(r, query)]
        docs = [tokens(r['text'] + ' ' + ' '.join(r['tags'])) for _, r in rows]
        frequencies = Counter(t for doc in docs for t in set(doc))
        average = sum(map(len, docs)) / max(1, len(docs))
        routes = {s for s, words in ROUTES.items() if terms & set(tokens(words))}
        scores = []
        for (segment, record), doc in zip(rows, docs):
            counts = Counter(doc)
            overlap = terms & counts.keys()
            lexical = sum(math.log(1 + (len(rows) + 1) / (1 + frequencies[t])) * counts[t] * 2.2 /
                          (counts[t] + 1.2 * (.75 + .25 * len(doc) / max(1, average))) for t in overlap)
            related = not partners or bool(partners & {n.lower() for n in record['about']})
            relevance = (4 * len(overlap) + lexical + (.1 if segment in routes and overlap else 0)) * (1 if related else .2)
            scores.append(relevance)
        # One bounded expansion from the best event/milestone matches. Shared
        # distinctive details recover siblings without turning chatter into a query.
        seed_ids = sorted(range(len(rows)), key=lambda i: (-scores[i], -rows[i][1]['importance']))
        seeds = [i for i in seed_ids[:3] if scores[i] and rows[i][0] in ('events', 'milestones')][:2]
        keys = set().union(*(recall_terms(' '.join(docs[i]), known) for i in seeds)) if seeds else set()
        keys -= terms | set(tokens('said says accepted invitation first together after before with not has had'))
        keys = {t for t in keys if frequencies[t] <= max(2, len(rows) * .3)}
        for i, (segment, record) in enumerate(rows):
            if i in seeds or segment not in ('events', 'milestones', 'gifts'):
                continue
            if partners and not partners.intersection(n.lower() for n in record['about']):
                continue
            shared = keys & set(docs[i])
            if shared:
                scores[i] += min(6, sum(math.log(1 + len(rows) / (1 + frequencies[t])) for t in shared))
        scores = self.hybrid_scores(query, rows, scores)
        order = sorted(range(len(rows)), key=lambda i: (-scores[i], -rows[i][1]['importance'], rows[i][1]['id']))
        relevant = [rows[i] for i in order if scores[i] > 0]
        background = [rows[i] for i in order if not scores[i] and
                      present.intersection(n.lower() for n in rows[i][1]['about']) and
                      (rows[i][1]['importance'] == 5 or rows[i][0] == 'milestones' or
                       (rows[i][0] == 'worries' and rows[i][1]['status'] == 'open'))][:2]
        return relevant + background, {r['id'] for _, r in background}


def query_context(visible, focus=None):
    # Science and recall asks must not inherit banter tokens from neighbouring turns.
    if focus and (is_recall_query(focus['text']) or is_science_query(focus['text'])):
        return focus['text'], {n for n in (focus['name'], focus.get('to')) if n}
    messages = visible[-3:]
    if focus and focus in visible:
        messages = [focus] + [m for m in messages if m is not focus]
    people = {n for m in messages for n in (m['name'], m.get('to')) if n}
    text = ' '.join(m['text'] for m in messages)
    return text + ' ' + ' '.join(sorted(people)), people


def evidence_matches(messages, query, limit=3, speaker=None, min_score=1, require=None):
    """Visible-transcript lines sharing the query's terms. `require` (a term set)
    additionally demands topical overlap with it, e.g. science terms."""
    names = {n for m in messages for n in (m['name'], m.get('to')) if n}
    terms = recall_terms(query, names)
    found = []
    for i, message in enumerate(messages):
        counts = Counter(tokens(message['text']))
        if image_related(query) and message.get('attachments'):
            counts['image'] = max(1, counts['image'])
        overlap = terms.intersection(counts)
        if require is not None:
            # Topical evidence shares two required terms (one if the ask has only one),
            # and scaffolding words never count toward relevance.
            overlap -= TOPIC_STOP | SCORING_STOP
            if len(overlap & require) < min(2, len(terms & require)) or not overlap & require:
                continue
        if overlap:
            score = sum(counts[term] * 2.2 / (counts[term] + 1.2) for term in overlap)
            if '?' in message['text']:
                score *= .35
            if speaker and message.get('channel') == 'dm' and speaker not in (message['name'], message.get('to')):
                score *= .2
            if score >= min_score:
                found.append((score, i, message))
    return [m for _, _, m in sorted(found, key=lambda row: (row[0], row[1]), reverse=True)[:limit]]


def evidence(messages, query, limit=3):
    return [evidence_line(m, query) for m in evidence_matches(messages, query, limit)]


def evidence_line(message, query, photos=None):
    terms = recall_terms(query)
    text = ' '.join(message['text'].split())
    words = list(re.finditer(r'\w+', text))
    match = next((w for w in words if terms.intersection(tokens(w.group()))), None)
    start = max(0, match.start() - 90) if match and len(text) > 180 else 0
    images = (photos.labels(message) if photos is not None else ''.join(
        f" [image #{image_refs.token_for(p)[4:]}: photo from {message['name']}]"
        for p in message.get('attachments', [])))
    return f"[{message.get('time', 'undated')[:10]} {message['name']} {message.get('channel', 'group')}] {text[start:start + 180]}{images}"


@dataclass
class RetrievalContext:
    block: str
    records: list
    images: list
    recall: bool


def retrieval_context(store, messages, focus=None, budget=1600, already_asked=None, names=(),
                      kind=None, listeners=None, agent=None, scores=None, photos=None):
    messages = visible_messages(messages, store.directory.name, store.boundary)
    policy_controls = disclosure.overrides(store, messages, names, agent) if disclosure.protected(agent) else []
    if listeners is None:
        listeners = knowledge.audience(store.directory.name, focus, names)
    if kind == 'ship_ai' and focus is not None and is_science_query(focus.get('text', '')):
        # Authored science answers are paragraph-sized; leave room for several.
        budget = max(budget, SCIENCE_BUDGET)
    # A hidden or pre-reset focus must not influence retrieval or image selection.
    if focus is not None and focus not in messages:
        focus = None
    query, people = query_context(messages, focus)
    focus_text = focus['text'] if focus else query
    science = is_science_query(focus_text)
    recall = bool(focus and is_recall_query(focus['text']))
    rows, pinned = store.retrieve(query, people, recall=recall)
    # Raw computed readouts never fill the budget unless a specific quantity was
    # asked for, and even then only a few accompany the authored explanations.
    quantity = asks_for_quantity(focus_text)
    readouts = [(s, r) for s, r in rows if is_physics_readout(r)][:MAX_READOUTS if quantity else 0]
    rows = [(s, r) for s, r in rows if not is_physics_readout(r)] + readouts
    counterpart = (focus['name'] if focus and focus['name'] != store.directory.name else
                   focus.get('to') if focus else None)
    if not counterpart and messages:
        last = messages[-1]
        counterpart = last.get('to') if last['name'] == store.directory.name else last['name']
    anchors = store.prompt_anchors(counterpart)
    anchored = {r['id'] for _, r in anchors}
    rows = [(s, r) for s, r in rows if not (s == 'world' and r['importance'] >= 4 and
                                          not r.get('retrieval_only') and r['id'] not in anchored)]
    present_ids = {r['id'] for _, r in rows}
    rows += [(s, r) for s, r in anchors if r['id'] not in present_ids]
    evidence_messages = [m for m in messages if m is not focus and not (focus and focus.get('id') and m.get('id') == focus['id'])]
    # Ship-AI science asks reject chat banter: evidence must share science terms
    # with the question and clear a higher relevance threshold.
    ship_science = kind == 'ship_ai' and science
    matches = evidence_matches(evidence_messages, focus_text, speaker=focus['name'] if focus else None,
                               min_score=SCIENCE_EVIDENCE_MIN if ship_science else 1,
                               require=SCIENCE_TERMS if ship_science else None)
    selected = []
    # During recall, facts get the budget first; unrelated pins only fill leftovers.
    reserve = 450 if matches and not recall else 0
    remaining = max(0, budget - reserve)
    pins = [(s, r) for s, r in rows if r['id'] in pinned]
    ordered = ([(s, r) for s, r in rows if r['id'] not in pinned] + pins if recall else
               pins + [(s, r) for s, r in rows if r['id'] not in pinned])
    audience_knows = (disclosure.listener_knowledge(store, ordered, listeners, messages)
                      if disclosure.protected(agent) else {})
    for segment, record in ordered:
        line = record['text']
        privacy = disclosure.marker(agent, listeners, record, scores or {}, policy_controls,
                                    audience_knows.get(record['id'], ()))
        if privacy:
            line = privacy + ' ' + line
        if segment == 'world':
            line = 'About this place and time: ' + line[:260]
            belief = dict(believes='you believe it', uncertain='you are unsure', disbelieves='you do not believe it')
            line += f" (said by {record.get('speaker') or 'someone in the room'}; {belief[record.get('belief', 'uncertain')]})"
        if segment == 'worries':
            line += worry_label(record, already_asked, names)
        hints = knowledge.marker(record, listeners, messages, store.directory.name,
                                 audience_knows.get(record['id'], ()))
        if hints:
            line += ' ' + hints
        if not record.get('retrieval_only'):
            # Authored lore is never a resolve target; no id marker to parrot.
            line += f" (#{record['id']})"
        if len(line) + 1 <= remaining or record['id'] in anchored:
            selected.append((rows.index((segment, record)), segment, record, line))
            remaining -= len(line) + 1
    selected.sort(key=lambda row: row[0])
    lines = [line for _, _, _, line in selected]
    used = sum(len(line) + 1 for line in lines)
    for message in matches:
        line = 'From that conversation ' + evidence_line(message, focus_text, photos)
        if used + len(line) + 1 <= budget:
            lines.append(line)
            used += len(line) + 1
    by_id = {m['id']: m for m in messages if m.get('id')}
    image_messages = []
    for _, _, record, _ in selected[:5]:
        source = by_id.get(record.get('source_id'))
        if source and (image_related(query) or image_related(record['text'] + ' ' + ' '.join(record['tags']))):
            image_messages.append(source)
    image_messages.extend(m for m in matches if image_related(query) or image_related(m['text']))
    images = list(dict.fromkeys(p for m in image_messages for p in m.get('attachments', [])))[:2]
    block = '\n'.join(lines) or '(No clear memory of this comes to mind.)'
    return RetrievalContext(block, [(s, r) for _, s, r, _ in selected], images, recall)


def retrieval_block(store, messages, focus=None, budget=1600, already_asked=None, names=(), kind=None):
    return retrieval_context(store, messages, focus, budget, already_asked, names, kind=kind).block
