#!/usr/bin/env python3
"""Validate selected 63+7 foundation scenario evidence against fresh Vitest results and pinned source.

This extends the existing structural checker without changing its historical mappings.
It does not promote DKR feature roots or infer full behavior from test names.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DKR = ROOT / 'dkr'
BASE = DKR / 'domains/games/Elevate-Combat/features'
SOURCES = [BASE / 'campaign/stages/02-analysis/strategic-infrastructure/SEMANTICS.json',
           BASE / 'tactical/stages/02-analysis/side-tile-raze/SEMANTICS.json']
DEFAULT_MATRIX = BASE / 'campaign/stages/03-execution/strategic-infrastructure/foundation-verification/evidence/scenario-matrix.json'
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--matrix', type=Path, default=DEFAULT_MATRIX)
p.add_argument('--report', type=Path, action='append', required=True, help='Fresh Vitest JSON report (repeatable)')
a = p.parse_args()
errors = []
spec = importlib.util.spec_from_file_location('gherkin', DKR / 'domains/pde/dkr/features/pipeline/scripts/gherkin/component.py')
component = importlib.util.module_from_spec(spec)
spec.loader.exec_module(component)
canonical = {}
for path in SOURCES:
    document = json.loads(path.read_text())
    for diagnostic in component.validate(document, DKR):
        if diagnostic['severity'] == 'error':
            errors.append(f'{path}: {diagnostic["code"]}: {diagnostic["message"]}')
    for scenario in document['scenarios']:
        if scenario['id'] in canonical:
            errors.append('Duplicate canonical scenario: ' + scenario['id'])
        canonical[scenario['id']] = scenario
if len(canonical) != 70:
    errors.append(f'Expected selected 63 campaign + 7 tactical scenarios; found {len(canonical)}')
observed = {}
for path in a.report:
    report = json.loads(path.read_text())
    if not report.get('success'):
        errors.append(f'Vitest report is not successful: {path}')
    for file in report['testResults']:
        full = file['name'].replace('\\', '/')
        source = next((prefix + full.split('/' + prefix, 1)[1] for prefix in ('packages/', 'apps/') if '/' + prefix in full), full)
        for test in file['assertionResults']:
            observed[(source, test['fullName'])] = test['status']
matrix = json.loads(a.matrix.read_text())
pin = matrix['implementation_sha']
if subprocess.run(['git', 'cat-file', '-e', pin + '^{commit}'], cwd=ROOT, capture_output=True).returncode:
    errors.append('Unknown implementation commit: ' + pin)
elif subprocess.run(['git', 'diff', '--quiet', pin, '--', 'packages/engine/src', 'apps/web/src', 'scripts/check-foundation-acceptance.py'], cwd=ROOT).returncode:
    errors.append('Application/test/checker source differs from pinned implementation ' + pin)
try:
    committed_ms = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', pin], cwd=ROOT, text=True)) * 1000
    for report_path in a.report:
        if json.loads(report_path.read_text()).get('startTime', 0) < committed_ms:
            errors.append('Vitest report predates pinned implementation: ' + str(report_path))
except (ValueError, subprocess.CalledProcessError):
    errors.append('Cannot establish implementation timestamp')
for source, digest in matrix['source_sha256'].items():
    path = ROOT / source
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        errors.append('Source hash differs: ' + source)
rows = matrix['scenarios']
ids = [row['scenario_id'] for row in rows]
if len(ids) != len(set(ids)) or set(ids) != set(canonical):
    errors.append('Matrix must map each selected canonical scenario exactly once')
counts = {'pass': 0, 'fail': 0, 'unknown': 0}
for row in rows:
    ident = row['scenario_id']
    original = canonical.get(ident)
    status = row.get('status', 'unknown')
    counts[status] = counts.get(status, 0) + 1
    if original is None:
        continue
    if row.get('gherkin') != original['gherkin']:
        errors.append('Canonical meaning differs: ' + ident)
    if original['status'] != status:
        errors.append('Draft outcome differs from matrix: ' + ident)
    if status != 'pass':
        if not row.get('reason'):
            errors.append('Non-PASS scenario lacks an explicit reason: ' + ident)
        continue
    tests = row.get('tests') or ([row['test']] if row.get('test') else [])
    if not tests or not row.get('verified_behavior'):
        errors.append('PASS lacks mapped assertions/tests: ' + ident)
    for test in tests:
        path = ROOT / test['path']
        if not path.is_file() or not path.resolve().is_relative_to(ROOT):
            errors.append('Invalid test path: ' + ident)
        if observed.get((test['path'], test['name'])) != 'passed':
            errors.append('Mapped test did not pass in supplied report: ' + ident + ': ' + test['name'])
    if not original.get('test') or original['test'].get('implementation_sha') != pin:
        errors.append('Draft scenario lacks current immutable test pin: ' + ident)
print(json.dumps({'implementation_sha': pin, 'scenario_count': len(rows), 'statuses': counts,
                  'observed_tests': len(observed), 'errors': errors}, indent=2))
sys.exit(bool(errors))
