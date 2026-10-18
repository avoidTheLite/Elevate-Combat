#!/usr/bin/env python3
"""Validate the staged Elevate bundles using DKR's canonical semantic validator."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--report', type=Path, help='Fresh Vitest JSON report from this implementation checkout')
a = p.parse_args([x for x in sys.argv[1:] if x != '--'])
spec = importlib.util.spec_from_file_location('gherkin', ROOT / 'dkr/domains/pde/dkr/features/pipeline/scripts/gherkin/component.py')
component = importlib.util.module_from_spec(spec)
spec.loader.exec_module(component)
observed = {}
if a.report:
    report = json.loads(a.report.read_text())
    for f in report['testResults']:
        path = str(Path(f['name']).relative_to(ROOT))
        for t in f['assertionResults']:
            observed[(path, t['fullName'])] = t['status']
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
evidence_trees = {}
errors = warnings = scenarios = 0
for path in sorted((ROOT / 'dkr/domains/games/Elevate-Combat/features').glob('*/stages/03-execution/*/SEMANTICS.json')):
    doc = json.loads(path.read_text())
    diagnostics = component.validate(doc, ROOT / 'dkr')
    for s in doc['scenarios']:
        scenarios += 1
        test = s['test']
        source = ROOT / test['path']
        if not source.is_file() or not source.resolve().is_relative_to(ROOT):
            diagnostics.append(dict(severity='error', code='evidence.path', message=test['path']))
        pin = test['implementation_sha']
        if pin not in evidence_trees:
            evidence_trees[pin] = subprocess.run(
                ['git', 'diff', '--quiet', pin, head, '--', 'packages/engine'], cwd=ROOT
            ).returncode == 0
        if not evidence_trees[pin]:
            diagnostics.append(dict(severity='warning', code='evidence.stale', message=s['id']))
        if a.report and observed.get((test['path'], test['name'])) != 'passed':
            diagnostics.append(dict(severity='error', code='evidence.not-passed', message=test['name']))
    e = sum(d['severity'] == 'error' for d in diagnostics)
    w = sum(d['severity'] == 'warning' for d in diagnostics)
    errors += e; warnings += w
    print(f'{path.parts[-5]}/{path.parts[-2]}: {len(doc["use_cases"])} use cases, {len(doc["scenarios"])} scenarios, {e} errors, {w} warnings')
    for d in diagnostics:
        print(f'  {d["severity"]}: {d["code"]}: {d["message"]}')
if not scenarios:
    errors += 1
    print('error: no mapped scenarios found')
print(f'{scenarios} scenarios; {errors} errors; {warnings} warnings. Evidence report: {"checked" if a.report else "not supplied (structure/path checks only)"}.')
sys.exit(bool(errors))
