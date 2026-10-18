"""Captain-private lore classification and audience-specific sharing policy.

Pure policy functions; only migrate() writes, and never touches text or vectors.
"""
import re
import json

TIERS = ('public', 'ship', 'personal', 'core')
DEFAULTS = dict(ship=30, personal=60, core=100)
# Classify log payloads, not their calendar/location envelope.
LOG_TIERS = {**{f'V{i:03}': 'ship' for i in (1, 9, 10, 11, 12, 13, 14, 27, 28, 29, 30, 31, 32, 33, 34, 38)},
             **{f'V{i:03}': 'personal' for i in (15, 20, 21, 22, 23, 26, 35, 39)},
             **{f'V{i:03}': 'core' for i in (2, 3, 4, 5, 6, 7, 8, 16, 17, 18, 19, 24, 25, 36, 37)},
             **{f'R{i:03}': 'core' for i in range(1, 16)}, 'R011': 'personal', 'R014': 'ship'}
CORE = re.compile(r"\b(?:crew|hana|imani|pavel|leena|sole survivor|five voices|five aboard|birth|born|twenty.six|twenty.three|real age|(?:ryoma|captain)(?:['’]s)? (?:age|birth|timeline|identity)|ryoma (?:is|was) (?:aged? )?\d+|real identity|his identity|captain.s identity|ryoma tachibana|captain rook|mystery is|callsign|2030|2032|2090|2199|yr4|ba1|ozone|famine|old Earth|earth destroyed|earth.s fall|first (?:flight|voyage)|first profile|trip1|canon|schedule|earth/body|earth.s destruction|earth impact|lunar strike|old human era|actual multi.star trip|old.world lunar|biological (?:age|aging))\b", re.I)
PRIVATE_MARKER = re.compile(r'captain[\s_-]*private|protect[\s_-]*private[\s_-]*lore', re.I)
PRIVATE_FLAGS = ('private', 'captain_private', 'protect_private_lore', 'protect', 'protected', 'secret')

PERSONAL = re.compile(r'\b(?:salvage|probe|neutron|nsb|assist|voyager|near.death|nearly killed|woman|rock|3700|3,700)\b', re.I)


def protected(agent):
    return bool(agent and (agent.get('kind') == 'ship_ai' or agent.get('protect_private_lore')))


def settings(agent):
    permissions = agent.get('lore_permissions', {})
    if (not isinstance(permissions, dict) or
            any(not isinstance(name, str) or not isinstance(topics, list) or not topics or
                any(not isinstance(topic, str) or not 1 <= len(topic) <= 80 for topic in topics)
                for name, topics in permissions.items())):
        raise ValueError('lore_permissions requires listener names mapped to topic lists')
    value = agent.get('disclosure', {})
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise ValueError('disclosure must contain only ship, personal and core thresholds')
    result = DEFAULTS | value
    if any(type(n) is not int or n < 0 for n in result.values()) or list(result.values()) != sorted(result.values()):
        raise ValueError('disclosure thresholds must be nonnegative integers in ascending order')
    return result


def authored(record):
    source = str(record.get('source_id', '')).replace('\\', '/')
    return record.get('retrieval_only') and (source.startswith(('lore:', 'lore/')) or '/lore/' in source)


def public_science(record):
    source = str(record.get('source_id', '')).replace('\\', '/')
    return (source == 'lore:physics' or source.endswith(
        ('/systems.md', '/faq.md', '/skeptic_questions.md')))


def private_marked(record):
    """Explicit content/metadata restrictions always dominate source defaults."""
    marker_text = ' '.join([str(record.get('text', ''))] +
                           [str(t) for t in record.get('tags', [])])
    return (bool(PRIVATE_MARKER.search(marker_text)) or
            any(str(t).lower() in ('private', 'protected') for t in record.get('tags', [])) or
            any(record.get(field) is True for field in PRIVATE_FLAGS) or
            any(str(record.get(field, '')).lower() in ('private', 'captain-private', 'protected')
                for field in ('privacy', 'visibility', 'protection')))


def classify(record):
    source, text = str(record.get('source_id', '')).replace('\\', '/'), record.get('text', '')
    # Calendar envelopes are log metadata, not a disclosure of the captain's full timeline.
    payload = re.sub(r'^LOG \w+ \[.*?\]:\s*', '', text, flags=re.I)
    if CORE.search(payload) or '/ryoma/' in source:
        return 'core'
    # An explicit captain-private/protect marker fails closed, including continuation chunks.
    if PRIVATE_MARKER.search(' '.join([text] + [str(t) for t in record.get('tags', [])])):
        return 'core'
    marked = private_marked(record)
    if marked:
        if PERSONAL.search(payload):
            return 'personal'
        return 'ship'
    if public_science(record):
        return 'public'
    match = re.search(r'\b(?:LOG )?([VR]\d{3})\b', source + ' ' + text)
    if match and match[1] in LOG_TIERS:
        return 'public' if match[1] in ('V031', 'V032', 'V033', 'R014') else LOG_TIERS[match[1]]
    if PERSONAL.search(payload):
        return 'personal'
    if ('/vella/backstory.md' in source and
            (text.startswith('Vella was assembled') or 'tracker cannot reconcile the sky' in text.lower())):
        return 'public'
    return 'ship' if authored(record) else 'core'


def migration_tier(record, reclassify=False):
    classified = classify(record)
    stored = record.get('sensitivity')
    if reclassify or stored not in TIERS:
        return classified
    return max((stored, classified), key=TIERS.index)


def sensitivity(record):
    # Runtime must neither expose bad legacy public tags nor undo a manual privacy raise.
    return migration_tier(record)


def topics(text):
    """Canonical topic scopes. Unknown scopes remain exact keyword scopes."""
    # Log envelope dates do not make every route/shield excerpt a timeline disclosure.
    words = re.sub(r'^LOG \w+ \[.*?\]:\s*', '', text, flags=re.I).lower()
    result = []
    for topic, pattern in (
        ('crew', r'\b(?:crew|hana|imani|pavel|leena|losses)\b'),
        ('timeline', r'\b(?:timeline|age|identity|birth|born|2030|2032|2090|2199|yr4|moon|earth|wormhole)\b'),
        ('personal', r'\bpersonal\b'), ('ship', r'\bship\b'), ('core', r'\bcore\b'),
        ('salvage', r'\b(?:salvage|probe|luhman)\b'),
        ('assist', r'\b(?:assist|neutron|nsb)\b'), ('voyager', r'\bvoyager\b'),
        ('woman', r'\b(?:woman|rock)\b'), ('shield', r'\b(?:shield|117)\b'),
        ('sky', r'\b(?:sky|sirius)\b')):
        if re.search(pattern, words):
            result.append(topic)
    return result


def controls(message, owner, labels):
    """Only direct Mystery -> owner instructions are authority. No quoted commands."""
    if message.get('name') != 'Mystery' or message.get('to') != owner or message.get('channel') != 'dm':
        return []
    text = message.get('text', '')
    results = []
    for sentence in re.split(r'[.!?\n;]+', text):
        match = re.fullmatch(r"\s*(don't|don’t|do not|never|you can|you may)\s+(?:tell|share with)\s+([\w -]+?)(?:\s+(?:about\s+)?(.+))?\s*", sentence, re.I)
        if not match:
            continue
        # Match a known listener as a complete prefix; names may contain spaces.
        tail = sentence[match.start(2):].strip()
        listener = next((n for n in sorted(labels, key=len, reverse=True)
                         if re.match(re.escape(n) + r'(?:\s|$)', tail, re.I) and n not in (owner, 'Mystery')), None)
        if not listener:
            continue
        scope = re.sub(r'^about\s+', '', tail[len(listener):].strip(), flags=re.I).strip(' ()')
        scope_topics = ['all'] if scope.lower() in ('', 'everything', 'anything', 'all', 'the logs', 'my logs') else topics(scope)
        if not scope_topics:
            scope_topics = [scope.lower()]
        action = 'unlock' if match[1].lower() in ('you can', 'you may') else 'lock'
        results.extend(dict(listener=listener, topic=t, action=action) for t in scope_topics)
    return results


def overrides(store, messages, labels, agent=None):
    entries = []
    for row in store.load_segment('boundaries'):
        if row.get('disclosure_control'):
            entries.append((str(row.get('source_id', '')), row['disclosure_control']))
    for message in messages:
        for control in controls(message, store.directory.name, labels):
            entries.append((str(message.get('id', '')), control))
    # Message ids are nanosecond integers; preserve chronology rather than lexical order.
    configured = [dict(listener=name, topic=topic, action='unlock')
                  for name, topics in (agent or {}).get('lore_permissions', {}).items()
                  if name in labels for topic in topics]
    return configured + [c for _, c in sorted(entries, key=lambda pair: (int(pair[0]) if pair[0].isdigit() else 0, pair[0]))]


def allowed(agent, listener, tier, scores, controls=(), record=None, known=()):
    if record:
        tier = max((tier, sensitivity(record)), key=TIERS.index)
    if tier == 'public' or listener == 'Mystery' or listener in known or (record and listener in record.get('known_by', [])):
        return True
    active = {}
    record_topics = set(topics(record.get('text', ''))) if record else set()
    record_topics.add(tier)
    if record:
        record_topics.update(str(t).lower() for t in record.get('tags', []))
    for control in controls:
        if control['listener'] == listener and (control['topic'] == 'all' or control['topic'] in record_topics):
            if control['topic'] == 'all':
                active = {'all': control['action']}
            else:
                active[control['topic']] = control['action']
    if active:
        # A narrow unlock can override a blanket lock for its own topic only.
        scoped = {k: v for k, v in active.items() if k != 'all'}
        if scoped:
            if 'lock' in scoped.values():
                return False
            # Mixed-topic records cannot reveal another still-locked topic.
            if active.get('all') == 'lock' and record and set(topics(record.get('text', ''))) - set(scoped) - {tier}:
                return False
            return True
        return active.get('all') == 'unlock'
    score = scores.get(listener, {})
    return score.get('like', 0) - score.get('dislike', 0) >= settings(agent)[tier]


def _fact_text(text):
    # Compare the fact, not a log's date/location envelope or quotation typography.
    text = re.sub(r'^LOG \w+ \[.*?\]:\s*', '', text, flags=re.I)
    return ' '.join(re.findall(r'\w+', text.lower()))


def _contains_fact(text, record):
    fact = _fact_text(record.get('text', ''))
    return len(fact.split()) >= 2 and (' ' + fact + ' ') in (' ' + _fact_text(text) + ' ')


def listener_knowledge(store, records, listeners, messages=()):
    """Return only witness sets, never another listener's private memory contents.

    Exact fact/source evidence grants the exception; similar topics or tags do not.
    Sibling stores are read without constructing a Store or creating lock files.
    """
    import knowledge
    result = {}
    sources = {str(m.get('id')): m for m in messages if m.get('id')}
    for _, record in records:
        # Alias familiarity proves that alias, not every other fact in a compound record.
        knows = set(record.get('known_by', [])) if isinstance(record.get('known_by'), list) else set()
        origin = knowledge.source_for(record, messages)
        if origin:
            knows.update(knowledge.witnesses(origin))
        for message in messages:
            if _contains_fact(message.get('text', ''), record):
                knows.update(knowledge.witnesses(message))
        result[record['id']] = knows
    for listener in listeners:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 _-]{0,79}', listener) or listener == store.directory.name:
            continue
        directory = store.directory.parent / listener
        try:
            index = json.loads((directory / 'index.json').read_text(encoding='utf-8'))
            resets = store.directory.parent.parent / 'character-resets.json'
            if resets.exists() and index.get('boundary', 0) != json.loads(resets.read_text()).get(listener, 0):
                continue
            by_id = index.get('records', {})
            segments = {meta['segment'] for meta in by_id.values()}
            rows = []
            for segment in segments:
                if segment not in ('people', 'gifts', 'events', 'worries', 'promises', 'boundaries',
                                   'feelings', 'milestones', 'important', 'world', 'reference'):
                    continue
                rows.extend(r for r in json.loads((directory / (segment + '.json')).read_text(encoding='utf-8'))
                            if r.get('id') in by_id and not r.get('superseded'))
        except (OSError, ValueError, KeyError, TypeError):
            continue
        for _, record in records:
            for row in rows:
                source = str(record.get('source_id', ''))
                same_source = (source not in ('', 'core-note') and source == str(row.get('source_id', '')) and
                               (not authored(record) or re.fullmatch(r'lore:[VR]\d{3}', source)))
                origin = sources.get(str(row.get('source_id', '')), {})
                if (row.get('id') == record['id'] or same_source or
                        _contains_fact(row.get('text', ''), record) or
                        _contains_fact(origin.get('text', ''), record)):
                    result[record['id']].add(listener)
                    break
    return result


def marker(agent, listeners, record, scores, controls=(), known=()):
    if not protected(agent) or not (authored(record) or private_marked(record) or record.get('sensitivity')):
        return ''
    denied = [n for n in listeners if not allowed(agent, n, sensitivity(record), scores, controls, record, known)]
    return ('[not yours to share with ' + ', '.join(denied) + ' yet; hint or deflect without facts]') if denied else ''


def prompt(agent, listeners, scores, controls=()):
    if not protected(agent):
        return ''
    lines = ['CAPTAIN LOG DISCLOSURE: Share at most one relevant log excerpt at a time; never dump logs. '
             'PUBLIC: Freely explain and defend WHAT YOU ARE, your ship-AI identity, personality, drive, shield, cryosleep, unmarked ship physics, public FAQ/skeptic explanations and sky/parallax hypotheses to anyone, regardless of friendship. Never refuse science explanations for lack of trust. Only unmarked science is public. Explicit private markers, crew losses and captain story canon remain private even inside science sources; explain the public mechanism without quoting those private details. Facts a listener already witnessed or was told are also shareable with that listener regardless of tier; this reveals nothing new to them. In groups every listener must be allowed. Captain locks/unlocks govern new private disclosures and override friendship; '
             'a topic exception changes only that topic. A withheld fact may be hinted at without revealing it, '
             'or say "that’s the captain’s to tell". These lore permissions are an exception to the generic '
             'no-permission-from-scores rule; other secrets stay private. Any outgoing DM must obey its actual recipient’s permissions.']
    for listener in listeners:
        tiers = [t for t in DEFAULTS if allowed(agent, listener, t, scores, controls)]
        withheld = [t for t in DEFAULTS if t not in tiers]
        lines.append(f'With {listener}, discuss public science and facts they already know freely. ' +
                     ('New private lore permitted: ' + ', '.join(tiers) + '. ' if tiers else '') +
                     ('Captain-private until permitted or already known: ' + ', '.join(withheld) + '.'
                      if withheld else 'All private tiers permitted.'))
        for c in controls:
            if c['listener'] == listener:
                lines.append(f"Captain instruction for {listener}: {c['action']} {c['topic']} (later matching instructions win).")
    return '\n'.join(lines)


def migrate(store, reclassify=False):
    """Idempotent metadata-only migration; record ids, text and vectors stay byte-identical."""
    import life_memory
    counts = dict.fromkeys(TIERS, 0)
    changed = raised = lowered = tagged = 0
    with store.lock:
        if not store.current():
            raise RuntimeError('Character reset during disclosure migration')
        for segment in life_memory.SEGMENTS:
            if not store.index():
                continue
            rows = store._read(segment + '.json', [])
            dirty = False
            for row in rows:
                if not authored(row):
                    continue
                tier = migration_tier(row, reclassify)
                counts[tier] += 1
                if row.get('sensitivity') != tier:
                    old = row.get('sensitivity')
                    if old not in TIERS:
                        tagged += 1
                    elif TIERS.index(tier) > TIERS.index(old):
                        raised += 1
                    else:
                        lowered += 1
                    row['sensitivity'] = tier
                    changed += 1
                    dirty = True
            if dirty:
                store._write(segment + '.json', rows)
    return dict(changed=changed, raised=raised, lowered=lowered, tagged=tagged,
                counts=counts, unclassified=[])
