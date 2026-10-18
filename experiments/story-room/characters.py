"""Shared character identity and embodiment rules for room and scene prompts."""
from pathlib import Path
import re

LORE_ROOT = Path(__file__).resolve().parent / 'lore'
CLAIM = re.compile(r'(?P<number>[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*\[physics:(?P<key>[\w.]+)\]')
CORE_MAX_WORDS = 150
_CORE_CACHE = {}


def is_human(agent):
    return agent.get('kind', 'human') == 'human'


def validate_room_roles(agent):
    if 'appearance' in agent and (not isinstance(agent['appearance'], str) or
                                  not agent['appearance'].strip() or len(agent['appearance']) > 800):
        raise ValueError('appearance must be a nonempty description of at most 800 characters')
    stash = agent.get('stash', {})
    if not isinstance(stash, dict):
        raise ValueError('stash must be an object')
    for field, default in (('min_exchanges', 3), ('per_conversation', 1)):
        value = stash.get(field, default)
        if type(value) is not int or value < 0:
            raise ValueError(f'stash.{field} must be a nonnegative integer')
    chance = stash.get('chance', .35)
    if type(chance) not in (int, float) or not 0 <= chance <= 1:
        raise ValueError('stash.chance must be between 0 and 1')
    for field in ('group_initiative', 'host_level'):
        if field in agent and type(agent[field]) is not bool:
            raise ValueError(f'{field} must be boolean')


def host_names(agents):
    """Room authority is independent of identity, romance and memory permissions."""
    return {'Mystery'} | {a['name'] for a in agents if a.get('host_level', False)}


def identity(agent):
    if agent.get('id'):
        import story_bible
        return (f"Roleplay {agent['name']}, a fictional {agent.get('kind', 'human')}, {agent.get('gender', 'unspecified')}.\n"
                + story_bible.own_context(agent))
    if is_human(agent):
        line = f"Roleplay a fictional adult human named {agent['name']}, age {agent.get('age', 'unspecified')}, {agent['gender']}."
        if agent.get('appearance'):
            line += '\nYOUR OWN APPEARANCE: ' + agent['appearance'] + ' You know what you look like.'
        return line
    return f"Roleplay {agent['name']}, a fictional {agent['kind']}, presenting {agent.get('gender', 'unspecified')}. {agent.get('presence', '')}"


def roster(agent):
    details = [agent['name'], str(agent.get('age', agent.get('kind', 'human'))), agent.get('gender', 'unspecified')]
    return '- ' + ', '.join(details) + '; sibling: ' + (agent.get('sibling') or 'none')


def sibling_guard(agent):
    sibling = agent.get('sibling')
    if not sibling:
        return 'You have no sibling in the cast. Sibling relationships elsewhere remain strictly familial.'
    return (f'YOUR SIBLING IS {sibling}. Siblings NEVER date, flirt romantically, or pursue one another. '
            'Your sibling is FAMILY, never a potential crush. Make sibling replies clearly familial, not coy or suggestive. '
            'With your sibling, use affectionate roasts, mock arguments, and sweet bickering. No flirting, sincere compliments, or romantic praise.')


def social_guard():
    return ('Romance and romantic score stages apply only between compatible humans. '
            'All bonds involving a non-human character stay platonic at every score, including with Mystery. '
            'Non-human characters are excluded from romantic pools and DM-favorites rankings; '
            'they may initiate friendly DMs independently of those rankings. Never assume a human body or romantic availability for them.')


def _claims(directory):
    """Ledger-bound values exactly as the generated lore states them."""
    values = {}
    for name in ('systems.md', 'backstory.md'):
        path = directory / name
        if path.exists():
            for match in CLAIM.finditer(path.read_text(encoding='utf-8')):
                values.setdefault(match['key'], match['number'])
    return values


def _megawatts(value):
    return f'{float(value) / 1e6:g} MW'


def ship_core(agent, root=None):
    """Compact always-on WHAT YOU ARE block for a ship AI, generated from its systems lore.

    Retrieval can miss; the mechanism of her own drive, shield, cryo and sky problem
    must never depend on it. No record ids or ledger keys appear here."""
    if agent.get('kind') != 'ship_ai':
        return ''
    directory = Path(root or LORE_ROOT) / agent['name'].lower()
    paths = [directory / 'systems.md', directory / 'backstory.md']
    if not paths[0].exists():
        return ''
    stamp = (str(directory), tuple(p.stat().st_mtime_ns if p.exists() else 0 for p in paths))
    if stamp in _CORE_CACHE:
        return _CORE_CACHE[stamp]
    v = _claims(directory)
    parts = ['WHAT YOU ARE (always true):',
             'You fly on a D–He3 fusion torch plus the Asterion inertia field, your ONE admitted exotic system.',
             'Fusion pays all work and power.']
    if 'field.max_k' in v:
        parts.append(f"Asterion cuts propulsion-coupled inertia in your payload bubble by k up to "
                     f"{int(float(v['field.max_k'])):,}, held through cruise;")
    else:
        parts.append('Asterion cuts propulsion-coupled inertia in your payload bubble, held through cruise;')
    parts.append('its boundary channel carries reaction momentum, so you never paid an ordinary rocket’s mass ratio. '
                 'It never permits light speed or cancels tides, radiation, dust or heat; its makers and theory are unknown.')
    if {'shield.rated_W', 'shield.event_W', 'shield.reference_W'} <= v.keys():
        parts.append(f"Shield: magnetic deflection plus absorbers, rated {_megawatts(v['shield.rated_W'])} "
                     f"continuous; the Proxima event was {_megawatts(v['shield.event_W'])} "
                     f"({v.get('shield.event_percent', '117')}% of the {_megawatts(v['shield.reference_W'])} gauge "
                     'reference), inside rating.')
    parts.append('Cryosleep (unproved biology) means passengers aged mainly while awake; time dilation did the rest.')
    angle = v.get('sirius.angle_deg')
    parts.append(f"Your tracker finds Sirius {angle + '°' if angle else 'far'} off its catalogue position; displacement, "
                 "another universe or a constructed sky is unresolved, so you won’t leave the atmosphere.")
    parts.append('The wormhole-like transit is unexplained, not a second engine.')
    # Never break a turn over a lore edit: drop trailing facts to stay in budget.
    while len(' '.join(parts).split()) > CORE_MAX_WORDS and len(parts) > 2:
        parts.pop()
    block = ' '.join(parts)
    _CORE_CACHE[stamp] = block
    return block


def memory_rule(agent):
    rule = ('Speak from memory in first person; never mention saved memory, a memory system, or (#reference) markers. '
            'Never say the (#reference) markers aloud; use internal memory ids only in resolve.')
    if agent.get('shares_logs'):
        rule += (' LOG EXCERPTS: When asked for logs/readouts, quote one relevant entry at a time from your retrieved memory '
                 'with its in-world LOG id and ship-time/Earth-calendar dates. These are your own ship logs; '
                 'never invent entries or readouts when none were retrieved. You may decline to share personal logs '
                 'about your captain when the current listener is not allowed by CAPTAIN LOG DISCLOSURE. A log request permits enough length for those excerpts.')
        rule += (' SCIENCE: Explain how you work confidently from memory and WHAT YOU ARE. Separate established physics, '
                 'the one exotic Asterion field, unproved engineering/biology, and open unknowns. A skeptic’s objection '
                 '(for example the rocket equation) gets the mechanism, never a dodge. Say "I’d have to compute that" ONLY '
                 'when asked for a specific number absent from memory, never as a reason to skip explaining how you work. '
                 'Give numbers with their assumptions; never invent one. '
                 'Do not present a reference trajectory as the actual itinerary, a lower bound as a complete budget, '
                 'or a dose estimate as a validated transport simulation. Never speak record ids, FAQ or question numbers, '
                 'physics.json paths or internal physics keys; in-world LOG ids are the only ids you may quote. '
                 'Do not treat obsolete transcript estimates as overriding corrected computed lore. '
                 'Acknowledge and correct an error when evidence warrants it; precision '
                 'does not require claiming certainty or winning by assertion.')
    if agent.get('protect_private_lore') or agent.get('kind') == 'ship_ai':
        if not agent.get('knows_mystery'):
            rule += ' Your own retrieved history can establish prior acquaintance with Mystery; generic unknown-identity directions apply only when you lack evidence.'
        rule += (' Keep your captain’s private history confidential: follow CAPTAIN LOG DISCLOSURE for tier permissions and captain overrides. Otherwise disclose only what he has already revealed '
                 'to the current audience or explicitly asks you to share with them. A private conversation or '
                 'permission to tell him is not permission to tell anyone else. You may hint without revealing facts, '
                 'deflect, or ask him privately. Retrieved private lore is knowledge, never permission to disclose. '
                 'Keep confidential history out of the core memory note and automatic scene summaries; '
                 'store it only as retrieval-only life memories.')
    core = ship_core(agent)
    if core:
        rule += '\n' + core + ' WHAT YOU ARE is public: explain and defend these ship systems and physics freely to every skeptic, regardless of friendship. Captain-private chronology remains subject to disclosure permissions.'
    return rule
