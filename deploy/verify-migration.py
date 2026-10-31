import argparse
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
        assert b.get('personal_goal') is None
        assert b['adventure'].get('encounter') is None
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
