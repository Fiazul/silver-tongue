"""Audience knowledge comes from witnessed speech, never from another person's store."""
import re
import disclosure


RULE = (
    'KNOWLEDGE AND CONFIDING: Talk to people based on what THEY know. Introduce context '
    "when they don't know it; use Mystery with anyone who has not learned his name. "
    'Seeing a private fact yourself does not mean your friends know it. You may confide '
    'your own story or feelings to someone you trust. With close friends or siblings '
    '(net >=70), occasionally share a story, gossip, or seek advice in a DM or meetup; '
    'this is natural, not required every turn. Introduce an unfamiliar name when sharing. '
    'Never reveal what you were asked to keep private; respect its scope. A request '
    '"not in group" allows a private confidence only if the request explicitly allowed '
    "it; if unclear, don't. These rules also apply to core notes, pins and quoted history. "
    'In remember, attribute learned facts to the person who actually told you, and use '
    'source_id for the visible message that established each fact. Never infer shared '
    'knowledge or permission from closeness or scores. For learned names/aliases use '
    'a people record: "<chat label>\'s real name is <name>". Source message ids stay internal.'
)

# Conservative handling: the wording is preserved, so the actor can respect scope
# without treating "not in group" as blanket permission to tell a friend.
PRIVATE_REQUEST = re.compile(
    r"\b(?:(?:do\s+not|don't|don’t|never|not\s+to)\s+(?:ever\s+)?"
    r"(?:tell|reveal|share|mention|disclose|say|repeat)\b[^.!?\n]{0,180}|"
    r"keep\s+(?:this|that|it|[^.!?\n]{1,50}?)\s+(?:a\s+secret|private|secret|between\s+us)\b[^.!?\n]{0,100}|"
    r"(?:just|only)\s+between\s+us\b[^.!?\n]{0,100})", re.I)


def witnesses(source, owner=None):
    source = source or {}
    if source.get('channel') == 'dm':
        names = [source.get('name'), source.get('to')]
    else:
        names = source.get('known_by', source.get('participants'))
        if names is None:
            names = [source.get('name'), owner] + (['Mystery'] if source.get('channel') == 'group' else [])
    return sorted({n for n in names if isinstance(n, str) and n} or ({owner} if owner else set()))


def provenance(source, owner, text=''):
    source = source or {}
    value = dict(known_by=witnesses(source, owner),
                 source_channel=source.get('channel') if source.get('channel') in ('dm', 'scene', 'group') else 'dm')
    if source.get('name'):
        value['source_person'] = source['name']
    request = PRIVATE_REQUEST.search(source.get('text') or '') or PRIVATE_REQUEST.search(text if isinstance(text, str) else '')
    if request:
        value.update(secret=True, secret_from=request.group().strip())
    return value


def source_for(record, messages):
    if record.get('source_id') in (None, ''):
        return None
    return next((m for m in messages if str(m.get('id')) == str(record.get('source_id'))), None)


def known_by(record, messages, owner):
    knows = (set(record['known_by']) if isinstance(record.get('known_by'), list) else
             set(witnesses(source_for(record, messages), owner)))
    facts = set(aliases(record.get('text', ''), record.get('source_person', owner), record.get('about', [])))
    if not facts:
        return knows
    # A later, explicit introduction can teach the same name to more people.
    for message in messages:
        if facts.intersection(aliases(message.get('text', ''), message.get('name'), record.get('about', []))):
            knows.update(witnesses(message, owner))
    return knows


def marker(record, audience, messages, owner, extra_known=()):
    knows = known_by(record, messages, owner) | set(extra_known)
    parts = [f"({name} knows — they were there)" if name in knows else f"({name} doesn't know this)"
             for name in audience if name != owner and any(p not in (name, owner) for p in record.get('about', []))]
    secret = record.get('secret_from') if record.get('secret') else None
    if not secret:
        source = source_for(record, messages)
        request = PRIVATE_REQUEST.search((source or {}).get('text', '')) or PRIVATE_REQUEST.search(record.get('text', ''))
        secret = request.group() if request else None
    if secret:
        parts.append(f'(asked to keep private: {secret})')
    if record.get('source_person') and record['source_person'] != owner:
        parts.append(f"(told by {record['source_person']})")
    return ' '.join(parts)


# Explicit introductions/alias statements only; merely saying a name never
# teaches its association with Mystery. This applies equally to any cast label.
PERSONAL_NAME = r"[A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2}"


def aliases(text, speaker, labels):
    result = []
    for subject in dict.fromkeys([speaker] + list(labels)):
        if not subject:
            continue
        label = re.escape(subject)
        patterns = [rf"\b{label}['’]s\s+(?:real\s+)?name\s+is\s+({PERSONAL_NAME})",
                    rf"\b{label}\s+(?:told|said\s+to)\s+\w+\s+(?:his|her|their)\s+(?:real\s+)?name\s+is\s+({PERSONAL_NAME})",
                    rf"\b{label}\s+(?:is\s+(?:really|actually)|is\s+(?:also\s+)?(?:called|named)|goes\s+by)\s+({PERSONAL_NAME})",
                    rf"\b{label}\s+introduced\s+(?:himself|herself|themselves)\s+as\s+({PERSONAL_NAME})",
                    rf"\b({PERSONAL_NAME})\s*[—–,:-]\s*(?:that['’]s|that\s+is)\s+{label}['’]s\s+(?:real\s+)?name"]
        if subject == speaker:
            patterns += [rf"\b[Mm]y\s+(?:real\s+)?name\s+is\s+({PERSONAL_NAME})",
                         rf"\b[Cc]all\s+me\s+({PERSONAL_NAME})",
                         rf"\bI(?:['’]m|\s+am)\s+({PERSONAL_NAME})(?=[.!?,;—–]|$)"]
        for pattern in patterns:
            for match in re.finditer(pattern, text):
                alias = match[1].strip()
                if alias not in ('Sorry', 'Fine', 'Okay', 'Here', 'Back', 'Ready', 'Happy', 'Good') and alias != subject and (subject, alias) not in result:
                    result.append((subject, alias))
    return result


def learned_names(store, messages=(), labels=()):
    """Read-only legacy recovery; new writes also maintain index.learned_names."""
    names = {n: list(a) for n, a in store.index().get('learned_names', {}).items()}
    owner = store.directory.name
    for segment in ('people', 'events', 'important', 'milestones'):
        for record in store.load_segment(segment):
            for subject, alias in aliases(record['text'], record.get('source_person', owner),
                                          list(labels) + record.get('about', [])):
                if alias not in names.setdefault(subject, []):
                    names[subject].append(alias)
    for message in messages:
        for subject, alias in aliases(message.get('text', ''), message.get('name'), labels):
            if alias not in names.setdefault(subject, []):
                names[subject].append(alias)
    return names


def validate(agent):
    if 'knows_mystery' not in agent:
        return
    value = agent['knows_mystery']
    if (not isinstance(value, dict) or not isinstance(value.get('names'), list) or
            not value['names'] or any(not isinstance(n, str) or not n.strip() for n in value['names'])):
        raise ValueError('knows_mystery requires a nonempty list of names')
    for field in ('address', 'relation'):
        if field in value and (not isinstance(value[field], str) or not value[field].strip()):
            raise ValueError(f'knows_mystery.{field} must be a nonempty string')


def mystery_identity(agent, stranger_rule):
    """Configured acquaintance belongs only to the character receiving this prompt."""
    value = agent.get('knows_mystery')
    if not value:
        return stranger_rule
    line = f"PRIOR ACQUAINTANCE: You already know Mystery as {', '.join(value['names'])}"
    if value.get('relation'):
        line += ' — ' + value['relation']
    if value.get('address'):
        line += '; address him as ' + value['address']
    return (line + '. He is not an unidentified stranger to you; use this established identity. '
            'This establishes no unstated age, consent, or permission to disclose private facts. '
            'The technical recipient and score key remain Mystery.')


def roster(store, messages=(), labels=(), agent=None):
    names = learned_names(store, messages, labels)
    mystery = names.pop('Mystery', [])
    value = (agent or {}).get('knows_mystery', {})
    if value:
        mystery = list(dict.fromkeys(value['names'] + mystery))
    detail = ', '.join(mystery)
    if value.get('relation'):
        detail += ' — ' + value['relation']
    if value.get('address'):
        detail += '; address him as ' + value['address']
    lines = [f"Mystery (you know him as {detail})" if mystery else 'Mystery (no personal name learned)']
    lines += [f"{subject} (you know them as {', '.join(values)})" for subject, values in names.items()]
    return '\n'.join(lines)


def source_hint(message):
    return f" [source_id: {message['id']}]" if message.get('id') else ''


def audience(owner, focus, labels):
    if focus and (focus.get('channel') == 'dm' or not labels):
        target = focus.get('to') if focus.get('name') == owner else focus.get('name')
        if target and target != owner:
            return [target]
    return [n for n in labels if n != owner]


def prompt(store, messages, listeners, labels=(), records=(), agent=None, scores=None, agents=()):
    """Summaries use only the speaker's evidence about each listener."""
    owner = store.directory.name
    rows = [r for segment in ('people', 'events', 'important', 'milestones') for r in store.load_segment(segment)]
    lines = [RULE, 'YOUR LEARNED NAMES: ' + roster(store, messages, labels, agent)]
    policy_controls = disclosure.overrides(store, messages, labels, agent) if disclosure.protected(agent) else []
    policy_listeners = list(dict.fromkeys(listeners + [n for n in labels if n != owner]))
    policy = disclosure.prompt(agent, policy_listeners, scores or {}, policy_controls)
    if policy:
        lines.append(policy)
    audience_knows = (disclosure.listener_knowledge(store, records, listeners, messages)
                      if disclosure.protected(agent) else {})
    facts = {}
    for record in rows:
        for subject, alias in aliases(record['text'], record.get('source_person', owner), list(labels) + record.get('about', [])):
            entry = facts.setdefault((subject, alias), dict(knows=set(), secret=[]))
            entry['knows'].update(known_by(record, messages, owner))
            if record.get('secret'):
                entry['secret'].append(record['secret_from'])
    # Immediate visible introductions can precede an actor's first remember entry.
    for message in messages:
        for subject, alias in aliases(message.get('text', ''), message.get('name'), labels):
            entry = facts.setdefault((subject, alias), dict(knows=set(), secret=[]))
            entry['knows'].update(witnesses(message, owner))
            request = PRIVATE_REQUEST.search(message.get('text', ''))
            if request:
                entry['secret'].append(request.group())
    acquaintances = {a['name']: a['knows_mystery'] for a in agents if a.get('knows_mystery')}
    viewer_knows_name = bool((agent or {}).get('knows_mystery') or
                             learned_names(store, messages, labels).get('Mystery'))
    for listener in listeners:
        acquaintance = acquaintances.get(listener)
        if acquaintance:
            detail = f'{listener} knew Mystery before this room'
            if viewer_knows_name:
                detail = f"{listener} has known him for years as {', '.join(acquaintance['names'])}"
                if acquaintance.get('relation'):
                    detail += f" ({acquaintance['relation']})"
            lines.append(f'WHAT {listener} KNOWS ABOUT Mystery: {detail}.')
        for (subject, alias), entry in facts.items():
            if subject in (owner, listener):
                continue
            if subject == 'Mystery' and acquaintance:
                continue
            familiar = [a for (s, a), e in facts.items() if s == subject and listener in e['knows']]
            detail = (f'{listener} knows the name {alias}' if listener in entry['knows'] else
                      f"{listener} knows {subject} as {', '.join(familiar)}; {listener} doesn't know his full name is {alias}"
                      if subject == 'Mystery' and familiar else
                      f"{listener} knows {subject} only as '{subject}'; {listener} doesn't know his name is {alias}"
                      if subject == 'Mystery' else f"{listener} doesn't know {subject}'s alias is {alias}")
            scope = '; '.join(dict.fromkeys(entry['secret']))
            state = (f'({listener} knows — they were there)' if listener in entry['knows'] else
                     f"({listener} doesn't know this)")
            lines.append(f'WHAT {listener} KNOWS ABOUT {subject}: {detail}. {state}' +
                         (f' (asked to keep private: {scope})' if scope else ''))
        topics = set()
        for _, record in records:
            for subject in record.get('about', []):
                if subject in (owner, listener) or subject in topics or (record.get('retrieval_only') and not record.get('private')):
                    continue
                if subject == 'Mystery' and acquaintance and any(
                        s == 'Mystery' for s, _ in aliases(record.get('text', ''),
                            record.get('source_person', owner), labels)):
                    continue
                topics.add(subject)
                detail = 'knows' if listener in (known_by(record, messages, owner) | audience_knows.get(record['id'], set())) else "hasn't learned"
                lines.append(f"WHAT {listener} KNOWS ABOUT {subject}: {detail}: {record['text'][:140]} " +
                             marker(record, [listener], messages, owner, audience_knows.get(record['id'], ())) + ' ' +
                             disclosure.marker(agent, [listener], record, scores or {}, policy_controls,
                                               audience_knows.get(record['id'], ())))
                if len(topics) >= 3:
                    break
            if len(topics) >= 3:
                break
    return '\n'.join(lines)
