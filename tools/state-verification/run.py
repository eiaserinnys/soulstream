#!/usr/bin/env python3
"""Run bounded source checks and TLC models without changing product source."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request


def main():
    tool_root = Path(__file__).resolve().parent
    manifest = json.loads((tool_root / 'manifest.json').read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=tool_root.parents[1])
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--subsystem', choices=list(manifest['subsystems']))
    parser.add_argument('--tlc-jar', type=Path,
                        help='Optional existing official TLC v1.7.4 release JAR; otherwise download and verify it')
    args = parser.parse_args()
    source_root = args.source_root.resolve()
    output_root = (args.output_dir or tool_root / '.output').resolve()
    jar = (args.tlc_jar or tool_root / '.cache' / 'tla2tools-1.7.4.jar').resolve()
    if args.tlc_jar is None and not jar.is_file():
        jar.parent.mkdir(parents=True, exist_ok=True)
        url = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar'
        print('Downloading pinned TLC v1.7.4...', flush=True)
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(10 * 1024 * 1024 + 1)
            if hashlib.sha256(data).hexdigest() != manifest['tlcSha256']:
                parser.error('Downloaded TLC JAR failed SHA-256 validation.')
            jar.write_bytes(data)
        except (OSError, TimeoutError) as error:
            parser.error(f'Cannot download TLC; supply --tlc-jar with a verified local copy: {error}')
    if not jar.is_file():
        parser.error(f'TLC JAR does not exist: {jar}')
    digest = hashlib.sha256(jar.read_bytes()).hexdigest()
    if digest != manifest['tlcSha256']:
        parser.error('TLC JAR SHA-256 does not match manifest.json; review a tool upgrade explicitly.')
    node_version = subprocess.check_output(['node', '--version'], text=True).strip()
    version = tuple(int(x) for x in node_version.lstrip('v').split('.')[:3])
    if version < (24, 22, 1):
        parser.error(f'Node 24.22.1 or newer is required; observed {node_version}')
    output_root.mkdir(parents=True, exist_ok=True)
    results = {
        'sourceSyncCommit': manifest['sourceSyncCommit'],
        'sourceRoot': str(source_root), 'runtime': node_version,
        'tlcSha256': digest, 'checks': [],
    }
    selected = [args.subsystem] if args.subsystem else list(manifest['subsystems'])

    def run(command, cwd, log_path, env=None):
        try:
            done = subprocess.run(command, cwd=cwd, env=env, capture_output=True,
                                  text=True, timeout=60)
            output = done.stdout + done.stderr
            code = done.returncode
        except subprocess.TimeoutExpired as error:
            output = f'Verification timed out after {error.timeout} seconds.\n'
            code = None
        except OSError as error:
            output = f'Verification could not start: {error}\n'
            code = None
        log_path.write_text(output)
        return code, output

    for area in selected:
        definition = manifest['subsystems'][area]
        area_source = tool_root / area
        area_output = output_root / area
        area_output.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, SOURCE_ROOT=str(source_root),
                   VERIFICATION_OUTPUT=str(area_output))
        log = area_output / 'source-check.log'
        code, output = run(['node', '--experimental-transform-types',
                            '--disable-warning=ExperimentalWarning',
                            str(area_source / definition['script'])],
                           source_root, log, env)
        result_path = area_output / 'results.json'
        # The child exits nonzero if baseline or mutation expectations fail.
        passed = code == 0 and result_path.is_file()
        results['checks'].append({'subsystem': area, 'kind': 'actual-source',
                                  'pass': passed, 'exitCode': code,
                                  'log': str(log), 'results': str(result_path)})
        print(f'{area}: actual-source {"PASS" if passed else "FAIL"}', flush=True)
        for configuration in definition.get('configs', []):
            stem = Path(configuration['file']).stem
            model_output = area_output / 'models' / stem
            model_output.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(area_source / definition['model'], model_output / definition['model'])
            shutil.copyfile(area_source / configuration['file'], model_output / configuration['file'])
            log = model_output / 'tlc.log'
            code, output = run(['java', '-XX:+UseParallelGC', '-cp', str(jar),
                                'tlc2.TLC', '-workers', '1', '-config',
                                configuration['file'], definition['model']], model_output, log)
            expected = configuration.get('violates')
            found = re.search(r'Invariant (\w+) is violated', output)
            invariant = found.group(1) if found else None
            if expected:
                passed = code == 12 and invariant == expected
            else:
                passed = code == 0 and 'Model checking completed. No error has been found.' in output
            states = re.search(r'([\d,]+) states generated, ([\d,]+) distinct states found', output)
            results['checks'].append({
                'subsystem': area, 'kind': 'TLC', 'config': configuration['file'],
                'pass': passed, 'exitCode': code, 'expectedViolation': expected,
                'observedViolation': invariant, 'log': str(log),
                'distinctStates': int(states.group(2).replace(',', '')) if states else None,
            })
            print(f'{area}: {configuration["file"]} {"PASS" if passed else "FAIL"}', flush=True)

    results['pass'] = all(item['pass'] for item in results['checks'])
    summary = output_root / 'summary.json'
    summary.write_text(json.dumps(results, indent=2) + '\n')
    print(f'Results: {summary}')
    return 0 if results['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
