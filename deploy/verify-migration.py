import argparse
from copy import deepcopy
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tarfile
import tempfile

def read_database(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        assert db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'SQLite integrity check failed'
        return json.loads(db.execute('SELECT payload FROM world_state WHERE id=1').fetchone()[0])

def safe_time(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991

def transition_events(old, new, agent_id, event_type, record, id_key, fields):
    """Require this release's persisted event, not a historical event or inferred reset."""
    previous = old.get('sequence', 0)
    events = [event for event in new.get('events', []) if str(event.get('cursor', '')).isdigit() and int(event['cursor']) > previous]
    restarts = [event for event in events if event.get('type') == 'server_restarted']
    assert len(restarts) == 1 and safe_time(restarts[0].get('occurred_at')), 'one restart record required'
    restart = restarts[0]
    matching = [event for event in events if event.get('type') == event_type and
        event.get('payload', {}).get('agent_id') == agent_id and event['payload'].get(id_key) == record[id_key] and
        all(event['payload'].get(field) == record.get(field) for field in fields)]
    assert matching, 'matching lifecycle event required'
    event = matching[-1]
    assert safe_time(event.get('occurred_at')), 'lifecycle event timestamp required'
    return restart, event

def compare_v014_records(old, new, agent_id, a, b):
    before, after = a['adventure'], b['adventure']
    for field in ['next_attack_at', 'discovery_ready_at']:
        assert after.get(field, 0) == before.get(field, 0), field + ' preserved'
    if 'discovery_sequence' in before:
        assert after.get('discovery_sequence') == before['discovery_sequence'], 'discovery sequence preserved'
    elif 'discovery_sequence' in after:
        assert after['discovery_sequence'] in [0, 1, 2], 'legacy discovery sequence initialization'
    previous, current = before.get('encounter'), after.get('encounter')
    if previous is None or previous.get('status') != 'pending':
        assert current == previous, 'resolved exploration record preserved'
    else:
        assert isinstance(current, dict) and safe_time(current.get('resolved_at')), 'pending exploration transition required'
        ended_at = current['resolved_at']
        expected = deepcopy(previous)
        expected.update(status='expired' if previous['expires_at'] <= ended_at else 'interrupted', resolved_at=ended_at, public_result=None)
        assert current == expected, 'only restart exploration interruption permitted'
        restart, event = transition_events(old, new, agent_id, 'exploration_ended', current, 'event_id',
            ['status', 'resolved_at', 'public_result', 'template_id', 'zone_id', 'position', 'found_at', 'expires_at', 'selected_choice_id'])
        assert previous['found_at'] <= ended_at <= event['occurred_at'] <= restart['occurred_at'], 'exploration ended during restart'
        assert int(event['cursor']) < int(restart['cursor']), 'exploration interruption precedes restart record'
    previous, current = a.get('personal_goal'), b.get('personal_goal')
    if previous is None or previous.get('status') not in ['active', 'needs_review']:
        assert current == previous, 'personal goal history preserved'
        return
    if previous['status'] == 'needs_review' and current == previous:
        return
    assert isinstance(current, dict) and safe_time(current.get('updated_at')), 'goal restart transition required'
    changed_at = current['updated_at']
    expected = deepcopy(previous)
    expired = previous['expires_at'] <= changed_at
    expected.update(status='expired' if expired else 'needs_review', updated_at=changed_at, review_reason=None if expired else 'restarted')
    assert expired or previous['status'] == 'active', 'existing goal review must not be rewritten'
    assert current == expected, 'only restart review or actual goal expiry permitted'
    restart, event = transition_events(old, new, agent_id, 'personal_goal_ended' if expired else 'personal_goal_review', current, 'goal_id',
        ['status', 'updated_at', 'review_reason', 'kind', 'target_id', 'target_count', 'progress', 'title', 'created_at', 'expires_at'])
    assert previous['updated_at'] <= changed_at <= event['occurred_at'], 'goal transition timestamp preserved'
    if not expired:
        assert int(event['cursor']) < int(restart['cursor']) and event['occurred_at'] <= restart['occurred_at'], 'goal review occurs during restart'

def compare_cooperations(old, new):
    """Mirror only permitted restart bookkeeping; never accept new work or consent."""
    original = old.get('cooperations', {})
    expected = deepcopy(original)
    agents = deepcopy(old['agents'])
    events = [event for event in new.get('events', []) if str(event.get('cursor', '')).isdigit() and int(event['cursor']) > old.get('sequence', 0)]
    restarts = [event for event in events if event.get('type') == 'server_restarted']
    restart = restarts[0] if len(restarts) == 1 else None
    public_fields = ['cooperation_id', 'revision', 'template_id', 'status', 'created_at', 'invite_expires_at', 'expires_at', 'started_at', 'ended_at', 'end_reason', 'progress', 'escrow', 'public_result']
    def prove(event, p):
        assert restart and safe_time(event.get('occurred_at')), 'cooperation lifecycle requires restart record'
        assert all(event['payload'].get(key) == p.get(key) for key in public_fields), 'cooperation event matches state'
        assert event['payload'].get('members') == [{key: m[key] for key in ['agent_id', 'role_id', 'confirmed']} for m in p['members']], 'cooperation public consents match'
    for cid, p in expected.items():
        if p['status'] not in ['proposed', 'active', 'needs_review']:
            continue
        changes = [event for event in events if event.get('payload', {}).get('cooperation_id') == cid]
        reviews = [event for event in changes if event['type'] == 'cooperation_review']
        endings = [event for event in changes if event['type'] == 'cooperation_ended']
        assert not any(event['type'] in ['cooperation_started', 'cooperation_progress', 'cooperation_completed', 'cooperation_proposed'] for event in changes), 'no cooperative work or consent during release'
        assert len(reviews) <= 1 and len(endings) <= 1, 'single restart lifecycle transition'
        previous_status = p['status']
        required_review = previous_status == 'active' or previous_status == 'needs_review' and any(m['confirmed'] for m in p['members'])
        if reviews:
            assert required_review, 'only existing consent can be invalidated'
            p['status'] = 'needs_review'; p['revision'] += 1
            for m in p['members']: m['confirmed'] = False
            prove(reviews[0], p)
            assert int(reviews[0]['cursor']) < int(restart['cursor']) and reviews[0]['occurred_at'] <= restart['occurred_at'], 'review occurs during constructor'
        if endings:
            event = endings[0]; payload = event['payload']; ended_at = payload.get('ended_at'); reason = payload.get('end_reason')
            assert safe_time(ended_at) and p['created_at'] <= ended_at <= event['occurred_at'], 'valid cooperation end timestamp'
            if previous_status == 'proposed':
                assert reason == 'not_formed' and not reviews, 'unaccepted proposals end on restart'
            elif reason == 'expired':
                assert ended_at >= p['expires_at'], 'expiry cannot be forged early'
            elif reason == 'authorization_ended':
                assert any(not old['agents'][m['agent_id']].get('run') or old['agents'][m['agent_id']]['run']['status'] == 'closed' or
                    old['controllers'].get(old['agents'][m['agent_id']]['run']['controller_id'], {}).get('revoked') for m in p['members']), 'closed or revoked authorization required'
            else:
                raise AssertionError('no voluntary leave or new result during release')
            if required_review and not reviews:
                assert reason == 'expired' and ended_at <= restart['occurred_at'], 'only immediate expiry bypasses review'
            quantity = p['escrow']['turnip']
            if quantity:
                assert quantity == 4 and p['contributor_id'] in agents, 'fixed original escrow refund'
                owner = agents[p['contributor_id']]; actual = new['agents'][p['contributor_id']]
                assert owner.get('cooperation_return') is None, 'refund slot was free before contribution'
                inventory = owner['life']['inventory']; balance = inventory.get('turnip', 0) + quantity
                if balance <= 9007199254740991:
                    inventory['turnip'] = balance
                    ledger = owner['life']['ledger']; source = 'cooperation:' + cid + ':return'
                    rows = [row for row in actual['life']['ledger']['entries'] if row['source_id'] == source]
                    assert len(rows) == 1 and safe_time(rows[0].get('at')) and p['created_at'] <= rows[0]['at'] <= ended_at, 'one timestamped refund ledger entry'
                    ledger['total_entries'] = min(9007199254740991, ledger['total_entries'] + 1)
                    row = {'entry_id': 'ledger_' + str(ledger['total_entries']), 'source_id': source, 'at': rows[0]['at'], 'reason': 'cooperation_return',
                        'items': {'turnip': quantity}, 'gold_delta': 0,
                        'balances': {'inventory': {key: value for key, value in inventory.items() if value != 0}, 'gold': owner['adventure']['gold']}}
                    ledger['entries'] = (ledger['entries'] + [row])[-100:]
                else:
                    owner['cooperation_return'] = {'cooperation_id': cid, 'quantity': quantity}
                p['escrow']['turnip'] = 0
            p.update(status='ended', ended_at=ended_at, end_reason=reason)
            prove(event, p)
        elif previous_status == 'proposed' or required_review and not reviews:
            raise AssertionError('required cooperation restart transition missing')
    # This is the same deterministic public-history pruning, with independent returns.
    ended = sorted([p for p in expected.values() if p['status'] not in ['proposed', 'active', 'needs_review']], key=lambda p: (p.get('ended_at') or 0, p['cooperation_id']), reverse=True)
    for p in ended[20:]: del expected[p['cooperation_id']]
    assert new.get('cooperations', {}) == expected, 'cooperation terms, bindings, sources, escrow and progress preserved'
    return agents

def compare_states(old, new, project_root=None, require_history=False, require_scenes=False):
    assert set(old['agents']) == set(new['agents']), 'roles preserved'
    assert old['controllers'] == new['controllers'], 'controller credentials preserved'
    expected_agents = compare_cooperations(old, new)
    for key, a in old['agents'].items():
        b = new['agents'][key]
        for field in ['inventory', 'equipment', 'starter_granted', 'tools_granted', 'gather_ready_at', 'ledger', 'market']:
            assert expected_agents[key]['life'].get(field) == b['life'].get(field), field
        expected_tools = deepcopy(expected_agents[key]['life'].get('tools'))
        if new.get('resources', {}).get('version') == 1 and isinstance(expected_tools, dict):
            for tool_id in ['axe', 'pickaxe']:
                if tool_id not in expected_tools:
                    assert not a['life']['inventory'].get(tool_id, 0), 'legacy resource tool cannot be silently granted'
                    expected_tools[tool_id] = {'level': 1, 'durability': 0, 'max_durability': 12, 'owned': False}
        assert expected_tools == b['life'].get('tools'), 'old tools preserved; only unowned resource tool defaults may be added'
        assert a.get('cooperation_proposed_at') == b.get('cooperation_proposed_at'), 'proposal cooldown preserved'
        assert expected_agents[key].get('cooperation_return') == b.get('cooperation_return'), 'private pending return preserved'
        # Compare whole normalized arrays; zip alone silently accepts lost plots.
        normalize = lambda plots: [{k: v for k, v in p.items() if k != 'ready_notified'} for p in plots]
        assert normalize(a['life']['plots']) == normalize(b['life']['plots']), 'plots preserved'
        assert a['appearance'] == b['appearance']
        assert a.get('run') == b.get('run'), 'grant preserved'
        assert a.get('goal') == b.get('goal'), 'private owner goal preserved'
        assert a.get('diagnostics', {}).get('calls_used', 0) == b.get('diagnostics', {}).get('calls_used', 0)
        assert b['presence_record']['version'] == 1
        for field in ['level', 'xp', 'gold', 'kills']:
            assert a['adventure'][field] == b['adventure'][field]
        compare_v014_records(old, new, key, a, b)
        assert b['life']['gathering'] is None
    if require_scenes or any('scene_id' in a for a in [*old['agents'].values(), *new['agents'].values()]):
        if project_root is None:
            assert '__file__' in globals(), 'explicit application root required for embedded migration verification'
            project_root = Path(__file__).resolve().parent.parent
        helper = Path(project_root).resolve() / 'deploy/verify-scenes.mjs'
        assert helper.is_file(), 'tracked scene verification helper required'
        result = subprocess.run(['node', str(helper)], input=json.dumps({'old': old, 'new': new}), capture_output=True,
            text=True, encoding='utf-8', timeout=60)
        assert result.returncode == 0, 'scene location preservation/migration verification failed'
        assert json.loads(result.stdout).get('scene_locations_preserved') is True
    if 'resources' in new or 'day_cycle' in new:
        if project_root is None:
            assert '__file__' in globals(), 'explicit application root required for embedded migration verification'
            project_root = Path(__file__).resolve().parent.parent
        helper = Path(project_root).resolve() / 'deploy/verify-resources.mjs'
        assert helper.is_file(), 'tracked resource verification helper required'
        result = subprocess.run(['node', str(helper)], input=json.dumps({'old': old, 'new': new}), capture_output=True,
            text=True, encoding='utf-8', timeout=60)
        assert result.returncode == 0, 'resource and day-cycle preservation verification failed'
        assert json.loads(result.stdout).get('resource_state_preserved') is True
    if require_history or 'history' in old or 'history' in new:
        assert 'history' in new, 'existing public history must not disappear'
        if project_root is None:
            assert '__file__' in globals(), 'explicit application root required for embedded migration verification'
            project_root = Path(__file__).resolve().parent.parent
        helper = Path(project_root).resolve() / 'deploy/verify-history.mjs'
        assert helper.is_file(), 'tracked history verification helper required'
        result = subprocess.run(['node', str(helper)], input=json.dumps({'old': old, 'new': new}), capture_output=True,
            text=True, encoding='utf-8', timeout=60)
        assert result.returncode == 0, 'public history import/preservation/restart verification failed'
        assert json.loads(result.stdout).get('public_history_preserved') is True

def verify(path, root=Path('/')):
    root = root.resolve()
    backups = root / 'var/backups/ai-plaza'
    path = Path(path)
    assert not path.is_symlink() and path.parent.resolve() == backups.resolve() and path.is_file()
    with tempfile.TemporaryDirectory(prefix='adventure-migration-', dir=backups) as directory:
        with tarfile.open(path) as archive:
            for name in ['world.sqlite', 'world.sqlite-wal', 'world.sqlite-shm']:
                members = [m for m in archive.getmembers() if m.name == 'var/lib/ai-plaza/' + name]
                assert len(members) <= 1, 'duplicate SQLite member'
                if members:
                    assert members[0].isfile(), 'non-file SQLite member'
                    (Path(directory) / name).write_bytes(archive.extractfile(members[0]).read())
            old_env = archive.extractfile('etc/ai-plaza/server.env').read()
            assert hashlib.sha256(old_env).digest() == hashlib.sha256((root / 'etc/ai-plaza/server.env').read_bytes()).digest()
        old = read_database(Path(directory) / 'world.sqlite')
    new = read_database(root / 'var/lib/ai-plaza/world.sqlite')
    compare_states(old, new, project_root=root / 'opt/ai-plaza', require_history=True, require_scenes=True)
    return {'agents': len(old['agents']), 'life_inventory_plots_tools_equipment_preserved': True,
        'appearance_growth_preserved': True, 'grants_and_budgets_preserved': True, 'controller_credentials_preserved': True,
        'existing_ledger_and_market_preserved': True, 'server_configuration_preserved': True,
        'exploration_goals_and_cooldowns_preserved': True,
        'cooperations_consents_escrow_returns_preserved': True,
        'public_history_preserved': True,
        'scene_locations_preserved': True,
        'sqlite_integrity': 'ok', 'backup': str(path)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('revision', nargs='?')
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--root', type=Path, default=Path('/'))
    args = parser.parse_args()
    path = args.backup
    if path is None:
        assert args.revision and re.fullmatch('[0-9a-f]{7,40}', args.revision)
        log = (args.root / ('var/backups/ai-plaza/release-' + args.revision + '.log')).read_text()
        release = next(line for line in log.splitlines() if line.startswith('RELEASE_OK '))
        path = Path(release.split('backup=', 1)[1].strip())
    print(json.dumps(verify(path, args.root)))
