"""Operator-facing story desk and source-based bible. No provider calls or writes."""
from datetime import datetime, timezone
import json
from pathlib import Path

EDITION = 'make-it-in-china-room'
SEGMENTS = ('milestones', 'events', 'gifts', 'people', 'feelings', 'promises',
            'worries', 'boundaries', 'important', 'world')
ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/story': ('story.html', 'text/html; charset=utf-8'),
    '/chat-room.css': ('chat-room.css', 'text/css; charset=utf-8'),
    '/bible-editor.js': ('bible-editor.js', 'text/javascript; charset=utf-8'),
    '/story.js': ('story.js', 'text/javascript; charset=utf-8'),
    '/story.css': ('story.css', 'text/css; charset=utf-8'),
    '/faceless.js': ('faceless.js', 'text/javascript; charset=utf-8'),
    '/faceless.css': ('faceless.css', 'text/css; charset=utf-8'),
    '/room': ('index.html', 'text/html; charset=utf-8'),
}


def read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def build_bible(root, config):
    root = Path(root)
    data = root / 'data'
    notes = read_json(data / 'memories.json', {})
    scores = read_json(data / 'relationships.json', {})
    resets = read_json(data / 'character-resets.json', {})
    characters = []
    for agent in config['agents']:
        name = agent['name']
        directory = data / 'life' / name
        records = []
        boundary = resets.get(name, 0)
        index = read_json(directory / 'index.json', {})
        valid_store = not boundary or index.get('boundary') == boundary
        for segment in SEGMENTS if valid_store else ():
            source = f'data/life/{name}/{segment}.json'
            for record in read_json(root / source, []):
                if record.get('superseded') or not record.get('text'):
                    continue
                source_id = str(record.get('source_id', ''))
                if boundary and source_id.isdecimal() and int(source_id) < int(boundary):
                    continue
                records.append(dict(record, segment=segment, source=source))
        records.sort(key=lambda r: (r.get('time', ''), r.get('importance', 0)), reverse=True)
        profile = {k: agent.get(k) for k in ('id', 'name', 'age', 'gender', 'kind', 'face', 'avatar',
                   'tagline', 'sibling', 'personality', 'appearance', 'presence', 'attracted_to',
                   'knows_mystery', 'routine', 'backstory', 'goals', 'dialogue_style', 'instructions',
                   'author_notes', 'sources', 'revision', 'examples')}
        characters.append(dict(profile, source_files=agent.get('sources', []), memory=notes.get(name, ''),
                               relationships=scores.get(name, {}), memories=records,
                               sources={'profile': f"characters/{agent['id']}.json" if agent.get('id') else 'agents.json', 'memory': 'data/memories.json',
                                        'relationships': 'data/relationships.json'}))
    captain = next((a.get('knows_mystery', {}) for a in config['agents']
                    if a.get('knows_mystery', {}).get('names')), {})
    return dict(edition=EDITION, generated_at=datetime.now(timezone.utc).isoformat(),
                description='Authored profiles and attributed recollections from this independent story. '
                            'A memory is its owner’s account, not an omniscient fact. '
                            'Other characters do not receive this operator reference.',
                world=config.get('story_world', {}),
                player=config.get('story_world', {}).get('player') or dict(name=next(iter(captain.get('names', [])), 'Player'),
                            aliases=captain.get('names', ['Mystery']),
                            role='You play as Mystery. Characters use the names they have actually learned.',
                            sources=['agents.json', 'lore/ryoma/', 'lore/vella/']),
                unknowns=config.get('story_world', {}).get('unknowns', []),
                characters=characters)


def markdown(bible):
    lines = ['# ' + bible.get('world', {}).get('title', 'Story Room') + ' · Character Bible', '', bible['description'], '',
             f"Updated: {bible['generated_at']}", '', '## The player', '',
             bible['player']['name'], '', bible['player'].get('backstory', bible['player'].get('role', '')), '',
             'Sources: ' + ', '.join(bible['player'].get('sources', [])), '', '## Open mysteries', '']
    lines.extend('- ' + text for text in bible['unknowns'])
    for character in bible['characters']:
        lines += ['', '## ' + character['name'], '',
                  f"Age: {character.get('age') or 'not established'} · "
                  f"Kind: {character.get('kind') or 'human'} · "
                  f"Sibling: {character.get('sibling') or 'none established'}", '',
                  '### Backstory', '', character.get('backstory') or 'Not established.', '',
                  '### Authored identity and voice', '', character.get('personality') or 'Not established.', '',
                  'Goals: ' + (character.get('goals') or 'Not established.'), '',
                  'Dialogue style: ' + (character.get('dialogue_style') or 'Not established.'), '',
                  'Instructions: ' + (character.get('instructions') or 'None.'), '',
                  'Appearance: ' + (character.get('appearance') or 'No written appearance established.'), '',
                  'Attracted to: ' + ', '.join(character.get('attracted_to') or ['no romantic targets established']), '',
                  'Source: ' + character['sources']['profile'], '', '### Current personal recollection', '',
                  character['memory'] or 'Not established in a saved core note.', '',
                  'Source: data/memories.json', '', '### Their relationships', '',
                  'Scores describe this character’s feelings; they do not establish reciprocity or consent.', '',
                  '| Person | Like | Dislike |', '| --- | ---: | ---: |']
        for name, score in character['relationships'].items():
            lines.append(f"| {name} | {score.get('like', 0)} | {score.get('dislike', 0)} |")
        lines += ['', 'Source: data/relationships.json', '', '### Recorded continuity', '']
        if not character['memories']:
            lines.append('No structured recollections established.')
        for record in character['memories']:
            lines += [f"- [{record['segment']}; {record.get('status', 'recorded')}; "
                      f"{record.get('time', 'undated')}] {record['text']}",
                      f"  Source: {record['source']} · record {record.get('id', 'unknown')}"]
    return '\n'.join(lines) + '\n'


def handle(host, handler, path):
    if path not in ASSETS and path not in ('/api/edition', '/api/bible', '/character-bible.md'):
        return False
    if path == '/api/edition':
        handler.send_json({'edition': EDITION, 'instance': str(host['ROOT'])})
    elif path in ('/api/bible', '/character-bible.md'):
        with host['LOCK']:
            bible = build_bible(host['ROOT'], host['load_config']())
        if path == '/api/bible':
            handler.send_json(bible)
        else:
            handler.send_payload(markdown(bible).encode(), 'text/markdown; charset=utf-8')
    else:
        filename, mime = ASSETS[path]
        handler.send_payload((host['ROOT'] / 'web' / filename).read_bytes(), mime)
    return True
