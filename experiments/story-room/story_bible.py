"""Editable, independent game-world and per-character files used by live roleplay."""
import copy
import hashlib
import json
from pathlib import Path
import re

import storage

TEXT_FIELDS = {'tagline': 300, 'personality': 6000, 'backstory': 12000,
               'goals': 4000, 'dialogue_style': 4000, 'appearance': 800,
               'instructions': 8000, 'author_notes': 8000}


class EditError(ValueError):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


def read(path):
    raw = path.read_bytes()
    return dict(json.loads(raw), revision=hashlib.sha256(raw).hexdigest())


def profile(root, character_id):
    if not isinstance(character_id, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', character_id):
        raise EditError('Unknown character', 404)
    path = Path(root) / 'characters' / (character_id + '.json')
    if not path.is_file():
        raise EditError('Unknown character', 404)
    return read(path)


def world(root):
    path = Path(root) / 'world.json'
    return read(path) if path.exists() else {}


def overlay(root, config):
    result = copy.deepcopy(config)
    shared = world(root)
    if not shared:
        return result
    result['story_world'] = shared
    for agent in result['agents']:
        if agent.get('id'):
            agent.update(profile(root, agent['id']))
        agent['_world_context'] = '\n'.join([shared.get('setting', ''), shared.get('public_context', '')])
    return result


def save_profile(root, character_id, changes, revision):
    if not isinstance(changes, dict) or not changes or set(changes) - set(TEXT_FIELDS) - {'enabled'}:
        raise EditError('Choose character fields to edit')
    path = Path(root) / 'characters' / (character_id + '.json') if isinstance(character_id, str) else Path(root)
    # Validate the id before even constructing a lock or touching a file outside characters/.
    current = profile(root, character_id)
    with storage.lock_for(path):
        current = profile(root, character_id)
        if current['revision'] != revision:
            raise EditError('This character changed in another tab. Reload before saving.', 409)
        for key, value in changes.items():
            if key == 'enabled':
                if type(value) is not bool:
                    raise EditError('enabled must be true or false')
            elif not isinstance(value, str) or len(value) > TEXT_FIELDS[key] or (key == 'personality' and not value.strip()):
                raise EditError(f'{key} must be text of at most {TEXT_FIELDS[key]} characters')
        current.update(changes)
        if not current.get('appearance', '').strip():
            current.pop('appearance', None)
        import characters
        try:
            characters.validate_room_roles(current)
        except ValueError as exc:
            raise EditError(str(exc)) from exc
        current.pop('revision')
        storage.atomic_write(path, json.dumps(current, ensure_ascii=False, indent=2) + '\n')
    return profile(root, character_id)


def save_world(root, changes, revision):
    limits = {'title': 200, 'setting': 1000, 'public_context': 12000, 'premise': 12000, 'author_notes': 12000}
    if not isinstance(changes, dict) or not changes or set(changes) - set(limits) - {'unknowns', 'player_name', 'player_backstory'}:
        raise EditError('Choose world fields to edit')
    path = Path(root) / 'world.json'
    with storage.lock_for(path):
        current = world(root)
        if current.get('revision') != revision:
            raise EditError('The world changed in another tab. Reload before saving.', 409)
        for key, value in changes.items():
            if key == 'unknowns':
                if not isinstance(value, list) or len(value) > 30 or any(not isinstance(v, str) or len(v) > 3000 for v in value):
                    raise EditError('Unknowns must be at most 30 text entries')
                continue
            if key in ('player_name', 'player_backstory'):
                if not isinstance(value, str) or len(value) > (100 if key == 'player_name' else 12000):
                    raise EditError('Player details must be text')
                continue
            if not isinstance(value, str) or len(value) > limits[key] or (key in ('title', 'setting') and not value.strip()):
                raise EditError(f'{key} must be text of at most {limits[key]} characters')
        for key, value in changes.items():
            if key in ('player_name', 'player_backstory'):
                current.setdefault('player', {})['name' if key == 'player_name' else 'backstory'] = value
            else:
                current[key] = value
        current.pop('revision', None)
        storage.atomic_write(path, json.dumps(current, ensure_ascii=False, indent=2) + '\n')
    return world(root)


def own_context(agent):
    if not agent.get('id'):
        return ''
    parts = ['SHARED WORLD:\n' + agent.get('_world_context', '')]
    for key, title in [('backstory', 'YOUR BACKSTORY'), ('appearance', 'YOUR APPEARANCE'), ('goals', 'YOUR GOALS'),
                       ('dialogue_style', 'YOUR VOICE'), ('instructions', 'CHARACTER INSTRUCTIONS')]:
        if agent.get(key):
            parts.append(title + ':\n' + agent[key])
    examples = agent.get('examples', [])
    if examples:
        parts.append('SOURCE DIALOGUE EXAMPLES (voice reference, not new events):\n' + '\n'.join(
            f"{item['line']} — {item['meaning']}" for item in examples[:4]))
    return '\n\n'.join(parts)


def roleplay_prompt(host, agent, messages, agents, focus, config, recalled=None, scene=None, pins=''):
    """Retain the room's memory/privacy protocol with this game's actual fiction."""
    import characters
    import life_memory
    import knowledge
    import journey
    boundary = host['reset_boundaries']().get(agent['name'], 0)
    visible = life_memory.visible_messages(messages, agent['name'], boundary)
    labels = [a['name'] for a in agents] + ['Mystery']
    present = scene['participants'] + ['Mystery'] if scene else labels
    listeners = [n for n in present if n != agent['name']] if scene else knowledge.audience(agent['name'], focus, labels)
    store = host['life_store'](agent['name'], config)
    if recalled is None:
        recalled = life_memory.retrieval_context(store, visible, focus, names=present,
                    kind='human', agent=agent, scores=host['relationship_state']().get(agent['name'], {}))
    privacy = knowledge.prompt(store, visible, listeners, labels, getattr(recalled, 'records', ()),
                              agent=agent, scores=host['relationship_state']().get(agent['name'], {}), agents=agents)
    transcript = '\n'.join(f"[{m.get('channel', 'group')}{' to ' + m['to'] if m.get('to') else ''}] {m['name']}: {m['text']}"
                           for m in visible[-30:])
    template = Path(host['ROOT']) / 'prompts' / ('scene.md' if scene else 'chat.md')
    direction = template.read_text() if template.exists() else 'Remain in character and respond to the current conversation.'
    placement = (f"SCENE: {scene['title']}. Location: {scene['location']}. Present: {', '.join(present)}. "
                 'Accept the player’s scene narration and react in present tense; never control their decisions.' if scene else
                 'This is an author-operated group/private roleplay room, not a new unexplained place in the fiction. '
                 'It does not give anyone a smartphone or internet access in the year 2000.')
    target = 'null' if scene else json.dumps(focus['name'] if focus and focus.get('channel') == 'dm' and focus['name'] != agent['name'] else focus.get('to') if focus and focus.get('channel') == 'dm' else None)
    return f"""{characters.identity(agent)}
Personality: {agent['personality']}
{direction}
{placement}
Speak only as {agent['name']}. Every other character has their own knowledge and motives. Do not know another person's private backstory just because their name appears here.
ACTIVE CAST: {', '.join(present)}
The player uses the technical recipient label Mystery for software routing only. Do not address them as Mystery unless they explicitly introduce that name. Learn their personal name from what they actually say; never invent prior acquaintance or an identity they have not introduced.
{privacy}
{characters.sibling_guard(agent)}
Treat relationship scores as trust, fondness or irritation, not a dating objective. Ordinary conversation, work, family, tension and mysteries drive this story. Do not force flirting, romance or sexual topics.
{journey.context(host['ROOT'], agent)}
OWN CURRENT RECOLLECTION: {host['memories']().get(agent['name'], '(No personal conversation history yet.)')}
OWN RETRIEVED MEMORIES: {recalled.block}
{pins}
CURRENT RELATIONSHIPS: {json.dumps(host['relationship_state']().get(agent['name'], {}))}
{host['TIMEKEEPER'].prompt(agent['name'], config)}
Software reminder dates are real-world scheduling data; they do not change the fiction's year or technology.
RECENT CONVERSATION VISIBLE TO YOU:
{transcript or '(No one has spoken yet.)'}
Stay with the current conversation. When answering a private message, send the reply privately to its sender; suggested recipient: {target}.
Never reveal other people's private conversations publicly. The local author may read logs; do not claim technical secrecy.
Use the language the author is using unless asked to practice Korean. Any actual English ability, limitations and translation behavior must follow your own character instructions. Contribute a specific reply, action or observation rather than stock approval. Do not narrate others' actions or invent shared experiences.
Return ONLY JSON: {{"message":"your reply", "memory":"your updated personal core note, at most 120 words", "remember":[], "resolve":[], "to":null, "attachments":[], "scores":{{}}, "mood":{{}}, "thread_done":false, "calls":[]}}.
The memory field is REQUIRED and must contain a nonempty personal note on every turn. Keep your identity and important established facts; if nothing changed, retain your existing note or briefly restate who you are. Never return an empty string for memory. Do not invent events to fill it.
Set to to an exact active character name or Mystery for a DM; use null for a group message or in-person scene. Only message is spoken. No image attachments in this edition.
Remember up to three genuine durable facts using segment, about (exact names), text, tags (keywords), importance (1–5), status (open/resolved). Segments: {', '.join(life_memory.SEGMENTS)}. Preserve witness and privacy boundaries; do not turn guesses into established facts. Scores use exact names mapped to {{"like":0,"dislike":0}}; update only what this exchange changed.
"""


def handle_post(host, handler, path):
    match = re.fullmatch(r'/api/bible/characters/([a-z][a-z0-9_-]{0,63})', path)
    if not match and path != '/api/bible/world':
        return False
    try:
        size = int(handler.headers.get('Content-Length', 0))
        if not 1 <= size <= 262144:
            raise EditError('Invalid edit size')
        data = json.loads(handler.rfile.read(size))
        if not isinstance(data, dict):
            raise EditError('An edit must be a JSON object')
        with host['LOCK']:
            if match:
                result = save_profile(host['ROOT'], match[1], data.get('changes'), data.get('revision'))
            else:
                result = save_world(host['ROOT'], data.get('changes'), data.get('revision'))
        handler.send_json(result)
    except (ValueError, TypeError, OSError) as exc:
        handler.send_json({'error': str(exc)}, getattr(exc, 'code', 400))
    return True
