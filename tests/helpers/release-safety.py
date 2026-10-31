"""Local release fault drills: actual Bash/Python/files/SQLite, simulated services/Git/network.
Every installation path is rewritten beneath one temporary directory before execution.
No SSH, production environment files or real services are accessed.
"""
import copy
from contextlib import closing
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
BASH = sys.argv.pop(1)

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

RECOVERY = module(REPO / 'deploy/release-data.py', 'release_data')
MIGRATION = module(REPO / 'deploy/verify-migration.py', 'migration_check')

def write_db(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS world_state(id INTEGER PRIMARY KEY,payload TEXT)')
        db.execute('INSERT OR REPLACE INTO world_state VALUES(1,?)', (json.dumps(payload),))

def read_db(path):
    with closing(sqlite3.connect(path)) as db: return json.loads(db.execute('SELECT payload FROM world_state').fetchone()[0])

def template():
    return {'agents': {'a': {'life': {'inventory': {'wood': 3}, 'equipment': {}, 'tools': {}, 'plots': [{'plot_id': 'plot_1'}, {'plot_id': 'plot_2'}],
        'ledger': {'entries': []}, 'market': {}, 'gathering': None, 'gather_ready_at': {'wood': 1234}}, 'appearance': {'seed': 'same'},
        'run': {'run_id': 'same-run', 'max_calls': 20, 'expires_at': 9999999999999, 'status': 'active'}, 'goal': 'FIXTURE PRIVATE GOAL',
        'diagnostics': {'calls_used': 7}, 'presence_record': {'version': 1},
        'personal_goal': {'goal_id': 'goal_fixture', 'kind': 'collect_item', 'target_id': 'wood', 'target_count': 3, 'progress': 3,
            'title': 'Fixture completed goal', 'status': 'completed', 'created_at': 100, 'updated_at': 200, 'expires_at': 10000,
            'review_reason': None, 'sources': ['fixture-reward'], 'run_id': 'same-run', 'session_epoch': 1},
        'adventure': {'level': 1, 'xp': 2, 'gold': 3, 'kills': 0, 'next_attack_at': 888, 'discovery_ready_at': 300200, 'discovery_sequence': 2,
            'encounter': {'event_id': 'encounter_fixture', 'template_id': 'supply_cache', 'zone_id': 'forest', 'position': {'x': 4, 'y': 11},
                'status': 'resolved', 'found_at': 100, 'expires_at': 150100, 'selected_choice_id': 'wood', 'resolved_at': 200,
                'public_result': {'items': {'wood': 2}, 'hp': 0, 'energy': -4, 'text': 'Fixture reward'}, 'run_id': 'same-run', 'session_epoch': 1}}}},
        'controllers': {'c': {'fixture_only': True}}, 'events': [], 'sequence': 0}

def remote_literal():
    return (REPO / 'deploy/release-orchestrator.py.tmpl').read_text(encoding='utf-8')

FAKE_COMMAND = r'''#!/usr/bin/env python3
import json,os,sys,sqlite3,shutil
from contextlib import closing
from pathlib import Path
r=Path(os.environ['FIXTURE_ROOT']); stage=os.environ['FAIL_STAGE']; cmd=Path(sys.argv[0]).name; args=sys.argv[1:]
state_file=r/'services.json'; s=json.loads(state_file.read_text())
def save(): state_file.write_text(json.dumps(s))
def log(value):
    with (r/'trace.log').open('a') as f: f.write(value+'\n')
def version(): return json.loads((r/'opt/ai-plaza/package.json').read_text())['version']
if cmd=='git':
    if 'clone' in args: shutil.copytree(r/'candidate',Path(args[-1]))
    elif 'rev-parse' in args: print('a'*40)
    elif 'show' in args: print((r/'candidate/deploy/release.sh').read_text())
elif cmd=='npm':
    assert s['bridge']; log('prepare:npm')
elif cmd=='node':
    source=args[args.index('-e')+1] if '-e' in args else ''
    if 'console.log' in source: print(version())
    elif 'for await' in source:
        h=json.loads(sys.stdin.read()); sys.exit(0 if h['ok'] and h['version']==args[-1] else 1)
    elif '--test' in args:
        assert s['bridge']; log('prepare:tests')
        if stage=='prepare': sys.exit(1)
    elif 'check-live.mjs' in ' '.join(args):
        log('new:health')
        if stage=='health': sys.exit(1)
    elif 'verify-history.mjs' in ' '.join(args):
        # Node/model behavior remains simulated in this release fault drill.
        # The real projector and SQLite migration run in migration-v016.test.js.
        print(json.dumps({'public_history_preserved':True}))
    elif 'verify-scenes.mjs' in ' '.join(args):
        # Real scene migration runs separately against Node and SQLite.
        print(json.dumps({'scene_locations_preserved':True}))
    else: log('prepare:node')
elif cmd=='curl': print(json.dumps({'ok':s['server'],'version':version(),'mode':'accounts'}))
elif cmd=='runuser':
    if 'show' in args: print(('0' if not s['bridge'] else '123') if '--property=MainPID' in args else ('active' if s['bridge'] else 'inactive'))
    if 'is-active' in args: print('active' if s['bridge'] else 'inactive');sys.exit(0 if s['bridge'] else 3)
    if 'stop' in args:
        s['bridge']=False; save();log('bridge:stop')
        if stage=='bridge-stop' and not s.get('bridge_stop_failed'):
            s['bridge_stop_failed']=True;save();sys.exit(1)
    if 'start' in args: s['bridge']=True;save();log('bridge:start')
elif cmd=='systemctl':
    if 'show' in args: print(('123' if s['server'] or s.get('lingering') else '0') if '--property=MainPID' in args else ('deactivating' if s.get('lingering') else 'active' if s['server'] else 'inactive'))
    if 'is-active' in args: sys.exit(0 if s['server'] else 3)
    if 'stop' in args:
        s['server']=False;save();log('server:stop')
        if stage=='lingering': s['lingering']=True;save()
        if stage=='server-stop' and not s.get('server_stop_failed'):
            s['server_stop_failed']=True;save();sys.exit(1)
    if 'start' in args:
        s['server']=True;save();log('server:start:'+version())
        if version()=='0.19.0':
            with closing(sqlite3.connect(r/'var/lib/ai-plaza/world.sqlite')) as db, db:
                v=json.loads(db.execute('SELECT payload FROM world_state').fetchone()[0]);v['migrated_fixture']=True
                v['history']={'version':1,'archive_id':'archive_00000000-0000-0000-0000-000000000000','started_at':1000,'next_sequence':1,'revision':0,'imported_count':0,'entries':[]}
                for a in v['agents'].values():
                    if stage=='migration': a['life']['inventory']['wood']=999
                db.execute('UPDATE world_state SET payload=?',(json.dumps(v),))
elif cmd=='stat': print('0' if '%u' in args else '700')
elif cmd=='chown': pass
else: raise RuntimeError('unexpected fake command '+cmd)
'''

class RecoveryDrills(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory(prefix='plaza-release-drill-'); self.addCleanup(directory.cleanup)
        r = Path(directory.name); (r/'var/lib/ai-plaza').mkdir(parents=True); (r/'var/backups/ai-plaza').mkdir(parents=True)
        return r

    def test_restore_and_archive_boundaries(self):
        r=self.fixture(); live=r/'var/lib/ai-plaza/world.sqlite'; original=template(); write_db(live,original)
        archive=r/'var/backups/ai-plaza/release-test.tar.gz'
        with tarfile.open(archive,'w:gz') as t:
            t.add(live,arcname='var/lib/ai-plaza/world.sqlite')
            entry=tarfile.TarInfo('../../outside');entry.size=3;t.addfile(entry,io.BytesIO(b'bad'))
        changed=copy.deepcopy(original);changed['agents']['a']['life']['inventory']['wood']=999;write_db(live,changed)
        result=RECOVERY.restore(archive,'test',r)
        self.assertEqual(read_db(live),original);self.assertEqual(read_db(Path(result['failed_data'])/'world.sqlite'),changed)
        self.assertFalse((r/'outside').exists())
        with self.assertRaises(ValueError): RECOVERY.restore(archive,'../escape',r)
        corrupt=r/'var/backups/ai-plaza/corrupt.tar.gz'
        with tarfile.open(corrupt,'w:gz') as t:
            m=tarfile.TarInfo('var/lib/ai-plaza/world.sqlite');m.size=8;t.addfile(m,io.BytesIO(b'not a db'))
        with self.assertRaises(sqlite3.DatabaseError): RECOVERY.restore(corrupt,'corrupt',r)
        self.assertEqual(read_db(live),original)
        outside=r/'outside.tar.gz'; shutil.copyfile(archive,outside)
        with self.assertRaises(ValueError): RECOVERY.restore(outside,'outside',r)

    def test_plot_loss_and_sqlite_integrity_fail_closed(self):
        old=template(); new=copy.deepcopy(old)
        MIGRATION.compare_states(old,new)
        with self.assertRaises(AssertionError): MIGRATION.compare_states(old,new,require_history=True)
        for field in ['encounter', 'discovery_ready_at', 'next_attack_at', 'discovery_sequence']:
            damaged=copy.deepcopy(new);damaged['agents']['a']['adventure'][field]=None
            with self.assertRaises(AssertionError): MIGRATION.compare_states(old,damaged)
        damaged=copy.deepcopy(new);damaged['agents']['a']['personal_goal']=None
        with self.assertRaises(AssertionError): MIGRATION.compare_states(old,damaged)
        new['agents']['a']['life']['plots'].pop()
        with self.assertRaises(AssertionError): MIGRATION.compare_states(old,new)
        r=self.fixture(); bad=r/'bad.sqlite'; bad.write_bytes(b'corrupt fixture')
        with self.assertRaises(sqlite3.DatabaseError): MIGRATION.read_database(bad)

    def run_release(self, failure):
        r=self.fixture(); prefix=r.as_posix()
        def rewrite(text):
            for path in ['/opt/ai-plaza','/var/lib/ai-plaza','/var/backups/ai-plaza','/etc/ai-plaza','/home/dsh']:
                text=text.replace(path,prefix+path)
            return text
        for folder in ['opt/ai-plaza','candidate/deploy','candidate/tests','etc/ai-plaza','home/dsh/.ai-plaza','home/dsh/.agents/skills/ai-plaza','home/dsh/.config/ai-plaza','bin']:
            (r/folder).mkdir(parents=True,exist_ok=True)
        (r/'opt/ai-plaza/package.json').write_text('{"version":"0.18.0"}'); (r/'candidate/package.json').write_text('{"version":"0.19.0"}')
        release=rewrite((REPO/'deploy/release.sh').read_text()).replace('"$EUID" == 0','1 == 1')
        release=release.replace('set -euo pipefail','set -euo pipefail\nexport PATH="'+prefix+'/bin:$PATH"')
        release=release.replace('-C / var/lib/ai-plaza','-C "'+prefix+'" var/lib/ai-plaza')
        release=release.replace('"$backup" "$stamp" || restored=0','"$backup" "$stamp" --root "'+prefix+'" || restored=0')
        (r/'candidate/deploy/release.sh').write_text(release,newline='\n')
        shutil.copyfile(REPO/'deploy/release-data.py',r/'candidate/deploy/release-data.py')
        (r/'candidate/deploy/verify-history.mjs').write_text('// Simulated only in this release fault drill.\n')
        (r/'candidate/deploy/verify-scenes.mjs').write_text('// Real locations are checked by migration-v017.test.js.\n')
        (r/'etc/ai-plaza/server.env').write_text('FIXTURE_ONLY=true\n')
        (r/'home/dsh/.config/ai-plaza/bridge.env').write_text('FIXTURE_ONLY=true\n')
        skill=r/'home/dsh/.agents/skills/ai-plaza'; (skill/'config.json').write_text('{}'); (skill/'version.json').write_text('{"version":"0.18.0"}')
        cp={'run_id':'same-run','max_calls':20,'calls_used':7,'expires_at':9999999999999}
        (r/'home/dsh/.ai-plaza/client.json.bridge.json').write_text(json.dumps(cp)); (r/'home/dsh/.ai-plaza/client.json').write_text('{"agent_id":"a"}')
        original=template();write_db(r/'var/lib/ai-plaza/world.sqlite',original)
        (r/'services.json').write_text('{"server":true,"bridge":true}')
        for cmd in ['git','npm','node','curl','runuser','systemctl','stat','chown']:
            p=r/'bin'/cmd;p.write_text(FAKE_COMMAND,newline='\n');p.chmod(0o755)
        python=(r/'bin/python3')
        python.write_text('#!/usr/bin/env bash\nexec "'+Path(sys.executable).as_posix()+'" "$@"\n',newline='\n');python.chmod(0o755)
        skill_stub="import os,json,subprocess;from pathlib import Path\n"+(
            "raise SystemExit(1)" if failure=='skill' else
            "p=Path(os.environ['FIXTURE_ROOT'])/'home/dsh/.agents/skills/ai-plaza/version.json';p.write_text('{\"version\":\"0.19.0\"}');subprocess.run(['runuser','start','ai-plaza-bridge.service'],check=True)")
        source=remote_literal().replace('REVISION',repr('a'*40)).replace('MIGRATION',repr((REPO/'deploy/verify-migration.py').read_text())).replace('SKILL',repr(skill_stub))
        source=rewrite(source).replace('"--backup",sys.argv[4]', '"--backup",sys.argv[4],"--root",'+repr(prefix))
        path=r/'orchestrator.py';path.write_text(source)
        env={**os.environ,'PATH':str(r/'bin')+os.pathsep+str(Path(BASH).parent)+os.pathsep+os.environ['PATH'],'FIXTURE_ROOT':str(r),'FAIL_STAGE':failure}
        result=subprocess.run([sys.executable,str(path)],env=env,capture_output=True,text=True,timeout=90)
        state=json.loads((r/'services.json').read_text());trace=(r/'trace.log').read_text() if (r/'trace.log').exists() else ''
        details=result.stdout+result.stderr+'\n'.join(p.read_text() for p in (r/'var/backups/ai-plaza').glob('*.log'))
        self.assertIn('prepare:',trace,details)
        if failure=='lingering':
            self.assertFalse(state['bridge'],details);self.assertFalse(state['server'],details)
            self.assertEqual(read_db(r/'var/lib/ai-plaza/world.sqlite'),original)
            self.assertIn('operator_recovery_required',result.stdout)
            return
        self.assertTrue(state['server'],details);self.assertTrue(state['bridge'],details)
        if failure=='success':
            self.assertEqual(result.returncode,0,result.stdout+result.stderr);self.assertEqual(json.loads((r/'opt/ai-plaza/package.json').read_text())['version'],'0.19.0')
        elif failure=='skill':
            self.assertNotEqual(result.returncode,0);self.assertEqual(json.loads((skill/'version.json').read_text())['version'],'0.18.0')
            self.assertEqual(json.loads((r/'opt/ai-plaza/package.json').read_text())['version'],'0.19.0')
        else:
            self.assertNotEqual(result.returncode,0);self.assertEqual(json.loads((r/'opt/ai-plaza/package.json').read_text())['version'],'0.18.0')
            self.assertEqual(read_db(r/'var/lib/ai-plaza/world.sqlite'),original)
        if failure=='prepare': self.assertNotIn('bridge:stop',trace)
        else: self.assertLess(trace.index('prepare:tests'),trace.index('bridge:stop'))
        if failure in ['migration','health']:
            self.assertTrue(list((r/'var/backups/ai-plaza').glob('failed-data-*/world.sqlite')))
            self.assertLess(trace.index('server:start:0.18.0'),trace.rindex('bridge:start'))

    def test_release_faults(self):
        for failure in ['prepare','bridge-stop','server-stop','lingering','health','migration','skill','success']:
            with self.subTest(failure=failure): self.run_release(failure)

if __name__=='__main__': unittest.main()
