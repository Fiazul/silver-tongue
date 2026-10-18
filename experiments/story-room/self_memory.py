"""Small private self summary, grounded in configured identity and saved experiences."""
import storage


def compact(text, words):
    values = str(text).split()
    return ' '.join(values[:words]) + ('…' if len(values) > words else '')


def context(store, agent, core, situation, listeners, messages):
    """Persist the character's own file; expose only audience-known activities in the prompt."""
    with store.lock:
        rows = [r for r in store.load_segment('events') if not r.get('retrieval_only')]
        rows.sort(key=lambda r: r['time'], reverse=True)
        rows = rows[:3]
        header = [f"# {agent['name']} — my memory", '',
                  'Identity: ' + compact(agent.get('appearance') or agent.get('presence') or agent['name'], 45),
                  'Current self/status: ' + compact(core, 70),
                  compact(situation, 45), 'Recent activities:']
        private = header + [f"- {r['time'][:10]}: {compact(r['text'], 45)}" for r in rows]
        path = store.directory / 'memory.md'
        content = '\n'.join(private) + '\n'
        if not path.exists() or path.read_text(encoding='utf-8') != content:
            storage.atomic_write(path, content)
        allowed = [r for r in rows if not r.get('secret') and
                   set(listeners) <= set(r.get('known_by') or [agent['name']])]
        return ('PERSONAL CONTINUITY (your own current identity and recent experiences; carry these across channels):\n' +
                '\n'.join(header + [f"- {r['time'][:10]}: {compact(r['text'], 45)}" for r in allowed]) +
                '\nUse first person for yourself. A shared photo is not a stranger just because its caption is short. '
                'Recognize established fictional identities using your appearance and supplied image context. '
                'Do not invent an event from an image alone or let an earlier mistaken reply override a clear correction.\n'
                'END PERSONAL CONTINUITY')
