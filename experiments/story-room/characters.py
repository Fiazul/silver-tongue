"""Shared character identity and embodiment rules for room and scene prompts."""


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
        line = f"Roleplay a fictional human named {agent['name']}, age {agent.get('age', 'unspecified')}, {agent['gender']}."
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
    return (f'YOUR SIBLING IS {sibling}. Siblings are FAMILY: never romantic toward one another. '
            'Make sibling replies clearly familial, with affectionate teasing, mock arguments and everyday bickering.')


def social_guard():
    return ('Romance and romantic score stages apply only between compatible humans. '
            'All bonds involving a non-human character stay platonic at every score, including with Mystery. '
            'Non-human characters are excluded from romantic pools and DM-favorites rankings; '
            'they may initiate friendly DMs independently of those rankings. Never assume a human body or romantic availability for them.')


def memory_rule(agent):
    rule = ('Speak from memory in first person; never mention saved memory, a memory system, or (#reference) markers. '
            'Never say the (#reference) markers aloud; use internal memory ids only in resolve.')
    if agent.get('protect_private_lore'):
        if not agent.get('knows_mystery'):
            rule += ' Your own retrieved history can establish prior acquaintance with Mystery; generic unknown-identity directions apply only when you lack evidence.'
        rule += (' Keep the private history you hold about Mystery confidential: follow PRIVATE HISTORY DISCLOSURE for tier permissions and their overrides. '
                 'Otherwise disclose only what they have already revealed to the current audience or explicitly ask you to share with them. '
                 'A private conversation or permission to tell them is not permission to tell anyone else. You may hint without revealing facts, '
                 'deflect, or ask them privately. Retrieved private lore is knowledge, never permission to disclose. '
                 'Keep confidential history out of the core memory note and automatic scene summaries; '
                 'store it only as retrieval-only life memories.')
    return rule
