"""Create a source-only upload bundle; never include runtime databases or secrets."""
from pathlib import Path
import hashlib
import tarfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'artifacts' / 'ai-plaza-source.tar.gz'
ROOT_FILES = ['package.json', 'package-lock.json', 'README.md', 'index.html',
              'vite.config.js', 'playwright.config.js', '.gitignore', '.gitattributes']
DIRECTORIES = ['server', 'src', 'runner', 'skills', 'tests', 'deploy', 'docs', 'scripts']
EXTENSIONS = {'.js', '.jsx', '.css', '.md', '.html', '.json', '.sh', '.mjs', '.py', '.service'}

def normalize(info):
    if not info.isfile():
        raise ValueError(f'Only regular source files are allowed: {info.name}')
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mode = 0o644
    return info

files = [ROOT / name for name in ROOT_FILES]
for directory in DIRECTORIES:
    for candidate in sorted((ROOT / directory).rglob('*')):
        if candidate.is_symlink():
            raise ValueError(f'Refusing symlink in source bundle: {candidate}')
        if not candidate.is_file():
            continue
        if candidate.name == '.env.example' or candidate.name.endswith('.env.example') or candidate.name == 'Caddyfile.example':
            files.append(candidate)
        elif candidate.suffix in EXTENSIONS and not candidate.name.startswith('.') and '.local.' not in candidate.name:
            files.append(candidate)
OUTPUT.parent.mkdir(exist_ok=True)
with tarfile.open(OUTPUT, 'w:gz') as archive:
    for source in sorted(set(files)):
        if not source.is_file() or source.is_symlink():
            raise ValueError(f'Missing or unsafe source: {source}')
        archive.add(source, arcname=source.relative_to(ROOT).as_posix(), recursive=False, filter=normalize)

with tarfile.open(OUTPUT, 'r:gz') as archive:
    entries = archive.getnames()
    assert 'package.json' in entries and 'deploy/ai-plaza.service' in entries
    assert not any(name.startswith(('data/', 'node_modules/', 'dist/', 'artifacts/')) or name.endswith(('.sqlite', '.env', '.env.local')) for name in entries)
checksum = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_name(OUTPUT.name + '.sha256').write_text(f'{checksum}  {OUTPUT.name}\n', encoding='utf-8')
print(f'Packaged {len(files)} source files; {OUTPUT.stat().st_size} bytes')
print(f'SHA256: {checksum}')
