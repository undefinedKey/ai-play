import argparse
from copy import deepcopy
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
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

def compare_states(old, new):
    assert set(old['agents']) == set(new['agents']), 'roles preserved'
    assert old['controllers'] == new['controllers'], 'controller credentials preserved'
    for key, a in old['agents'].items():
        b = new['agents'][key]
        for field in ['inventory', 'equipment', 'tools', 'starter_granted', 'tools_granted', 'gather_ready_at', 'ledger', 'market']:
            assert a['life'].get(field) == b['life'].get(field), field
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
    compare_states(old, new)
    return {'agents': len(old['agents']), 'life_inventory_plots_tools_equipment_preserved': True,
        'appearance_growth_preserved': True, 'grants_and_budgets_preserved': True, 'controller_credentials_preserved': True,
        'existing_ledger_and_market_preserved': True, 'server_configuration_preserved': True,
        'exploration_goals_and_cooldowns_preserved': True,
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
