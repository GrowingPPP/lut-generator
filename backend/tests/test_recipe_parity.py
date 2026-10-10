"""前后端可复用配方的纯函数交叉回归。"""
import copy
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from lut_engine.recipe import (
    RecipeError, apply_recipe, input_contract, validate_input_contract,
    validate_params,
)


ROOT = Path(__file__).resolve().parents[2]
RANGES = {
    'temp': (-3000, 3000), 'tint': (-500, 500), 'exposure': (-3, 3),
    'contrast': (-1, 1), 'contrast_pivot': (0.1, 0.9), 'saturation': (-1, 1),
    'hue': (-180, 180), 'vibrance': (-1, 1), 'look_strength': (0, 1),
    'highlights': (-1, 1), 'shadows': (-1, 1), 'whites': (-1, 1),
    'blacks': (-1, 1), 'curve': (-1, 1), 'split_shadow_hue': (0, 360),
    'split_shadow_sat': (0, 1), 'split_highlight_hue': (0, 360),
    'split_highlight_sat': (0, 1), 'split_mid_hue': (0, 360),
    'split_mid_sat': (0, 1), 'split_balance': (0, 1),
    'selective_hue_center': (0, 360), 'selective_hue_width': (1, 180),
    'selective_hue_shift': (-180, 180), 'selective_saturation': (-1, 1),
    'lift': (-0.1, 0.1), 'gamma': (0.5, 1.5), 'gain': (0.5, 1.5),
}
DEPENDENCIES = {
    'contrast': ('contrast_pivot',),
    'selective_hue_shift': ('selective_hue_center', 'selective_hue_width'),
    'selective_saturation': ('selective_hue_center', 'selective_hue_width'),
    'split_shadow_sat': ('split_shadow_hue', 'split_balance'),
    'split_highlight_sat': ('split_highlight_hue', 'split_balance'),
    'split_mid_sat': ('split_mid_hue', 'split_balance'),
}
RGB = {'lift', 'gamma', 'gain'}


def recipe_for(field, value, mode='add', params=None):
    current = validate_params(params or {})
    needed = list(DEPENDENCIES.get(field, ()))
    if field not in {'temp', 'tint', 'exposure', 'look_strength'}:
        needed.append('look_strength')
    operations = {field: {'mode': mode, 'value': value}}
    operations.update({key: {'mode': 'set', 'value': current[key], 'dependency': True}
                       for key in needed})
    return {'format_version': 1, 'kind': 'portable_style',
            'input_contract': input_contract(current), 'operations': operations,
            'source': {}}


def application_case(name, recipe, params=None, locks=(), valid=True):
    return {'name': name, 'action': 'apply', 'recipe': recipe,
            'params': validate_params(params or {}), 'locks': list(locks), 'valid': valid}


def cases():
    rows = []
    defaults = validate_params({})
    for field, (low, high) in RANGES.items():
        for name, target in [('low', low), ('high', high)]:
            target = [target] * 3 if field in RGB else target
            rows.append(application_case(f'{field}-set-{name}', recipe_for(field, target, 'set')))
        for direction in [-1, 1]:
            # Interior starting values distinguish appending from replacement.
            start = (low + high) / 2
            delta = direction * (high - low) / 4
            params = {field: [start] * 3 if field in RGB else start}
            value = [delta, -delta, delta / 2] if field in RGB else delta
            rows.append(application_case(f'{field}-add-{direction}',
                                         recipe_for(field, value, params=params), params))
        overflow = high + 1
        overflow = [overflow] * 3 if field in RGB else overflow
        rows.append(application_case(f'{field}-set-overflow', recipe_for(field, overflow, 'set'), valid=False))
        if field != 'hue':
            params = {field: [high] * 3 if field in RGB else high}
            value = [1] * 3 if field in RGB else 1
            rows.append(application_case(f'{field}-add-overflow',
                                         recipe_for(field, value, params=params), params, valid=False))

    for style in ['STD', 'NAT', 'VIVD', 'VLOG']:
        for mapping in [0, 0.25, 1]:
            params = {'base_photo_style': style, 'tone_map': mapping, 'temp': -400}
            rows.append(application_case(f'input-{style}-{mapping}', recipe_for('temp', 300, params=params), params))
    for mode, value, target in [('add', 300, -100), ('set', 900, 900)]:
        row = application_case(f'shared-field-{mode}', recipe_for('temp', value, mode, {'temp': -400}), {'temp': -400})
        row['expected'] = {'temp': target}
        rows.append(row)
    for start, rotation in [(179, 4), (-179, -4), (0, 0.1), (180, 720.1), (-180, -720.1)]:
        params = {'hue': start}
        rows.append(application_case(f'hue-wrap-{start}-{rotation}', recipe_for('hue', rotation, params=params), params))
    for field in RGB:
        params = {field: [0, 0.01, -0.02] if field == 'lift' else [0.8, 1.1, 1.2]}
        value = [0.01, -0.005, 0.02] if field == 'lift' else [-0.1, 0.1, -0.2]
        rows.append(application_case(f'{field}-independent-channels', recipe_for(field, value, params=params), params))
        rows.append(application_case(f'{field}-wrong-channel-count', recipe_for(field, [0, 0]), valid=False))

    rows.append(application_case('locked-value-change', recipe_for('temp', 300), locks=['temp'], valid=False))
    rows.append(application_case('locked-unchanged-target', recipe_for('temp', 0, 'set'), locks=['temp']))
    rows.append(application_case('locked-dependency-change', recipe_for('contrast', 0.2),
                                 {'contrast_pivot': 0.6}, ['contrast_pivot'], valid=False))
    rows.append(application_case('unknown-locked-field', recipe_for('temp', 300), locks=['made_up'], valid=False))
    rows.append(application_case('input-style-mismatch', recipe_for('temp', 300), {'base_photo_style': 'NAT'}, valid=False))
    rows.append(application_case('input-display-mismatch', recipe_for('temp', 300), {'tone_map': 0.25}, valid=False))

    invalid = []
    for technical in ['base_photo_style', 'tone_map', 'made_up']:
        recipe = recipe_for('temp', 300)
        recipe['operations'][technical] = {'mode': 'set', 'value': 'STD' if technical == 'base_photo_style' else 1}
        invalid.append((f'invalid-operation-field-{technical}', recipe))
    for field, dependencies in DEPENDENCIES.items():
        recipe = recipe_for(field, 0.1)
        del recipe['operations'][dependencies[0]]
        invalid.append((f'missing-anchor-{field}', recipe))
    recipe = recipe_for('saturation', 0.1)
    del recipe['operations']['look_strength']
    invalid.append(('missing-look-strength', recipe))
    for value in [True, '0.1', None, [0.1]]:
        invalid.append((f'invalid-scalar-{json.dumps(value)}', recipe_for('temp', value)))
    recipe = recipe_for('contrast', 0.2)
    recipe['operations']['look_strength']['mode'] = 'add'
    invalid.append(('dependency-cannot-add', recipe))
    recipe = recipe_for('contrast', 0.2)
    recipe['operations']['look_strength']['dependency'] = 'false'
    invalid.append(('dependency-must-be-boolean', recipe))
    recipe = recipe_for('contrast', 0.2)
    recipe['operations']['temp'] = {'mode': 'set', 'value': 3000, 'dependency': True}
    invalid.append(('orphan-dependency-cannot-carry-correction', recipe))
    recipe = recipe_for('temp', 300)
    recipe['operations']['contrast_pivot'] = {'mode': 'set', 'value': 0.6, 'dependency': True}
    invalid.append(('orphan-anchor-is-rejected', recipe))
    recipe = recipe_for('temp', 300)
    recipe['operations']['temp']['extra'] = 1
    invalid.append(('unknown-operation-metadata', recipe))
    recipe = recipe_for('temp', 300)
    recipe['extra'] = 1
    invalid.append(('unknown-recipe-metadata', recipe))
    recipe = recipe_for('temp', 300)
    recipe['source'] = []
    invalid.append(('source-must-be-object', recipe))
    for key, value in [('schema_version', 2), ('schema_version', None), ('format_version', None), ('kind', None)]:
        recipe = recipe_for('temp', 300)
        recipe[key] = value
        if key == 'format_version':
            recipe['schema_version'] = 1
        invalid.append((f'invalid-format-{key}-{value}', recipe))
    invalid.append(('zero-increment-is-empty', recipe_for('temp', 0)))
    recipe = recipe_for('temp', 300)
    recipe['input_contract']['output_encoding'] = 'Rec709'
    invalid.append(('invalid-output-encoding', recipe))
    rows.extend(application_case(name, recipe, valid=False) for name, recipe in invalid)

    for style in ['STD', 'NAT', 'VIVD', 'VLOG']:
        contract = input_contract({'base_photo_style': style, 'tone_map': 0.25})
        rows.append({'name': f'contract-{style}', 'action': 'contract', 'contract': contract, 'valid': True})
        bad = {**contract, 'output_encoding': 'sRGB' if style == 'VLOG' else 'Rec709'}
        rows.append({'name': f'contract-invalid-output-{style}', 'action': 'contract', 'contract': bad, 'valid': False})
    rows.append({'name': 'contract-reject-unknown-key', 'action': 'contract',
                 'contract': {**input_contract(defaults), 'extra': 1}, 'valid': False})
    return rows


CASES = cases()
NODE_PROGRAM = r"""
import fs from 'node:fs';
import {applyStyleRecipe, validateInputContract} from './frontend/src/lib/styleRecipe.js';
const results = JSON.parse(fs.readFileSync(0, 'utf8')).map(test => {
  const before = JSON.stringify([test.recipe, test.params, test.contract]);
  try {
    const value = test.action === 'contract' ? validateInputContract(test.contract)
      : applyStyleRecipe(test.recipe, test.params, {lockedFields: test.locks});
    return {ok: true, value, unchanged: before === JSON.stringify([test.recipe, test.params, test.contract])};
  } catch (error) {
    return {ok: false, code: error.code, fields: error.fields || [],
      unchanged: before === JSON.stringify([test.recipe, test.params, test.contract])};
  }
});
process.stdout.write(JSON.stringify(results));
"""


@pytest.fixture(scope='module')
def frontend_results():
    node = shutil.which('node')
    if not node:
        pytest.skip('Cross-runtime parity requires Node.js')
    process = subprocess.run([node, '--input-type=module', '-e', NODE_PROGRAM],
                             input=json.dumps(CASES, allow_nan=False), text=True,
                             cwd=ROOT, capture_output=True, timeout=30, check=True)
    return dict(zip((case['name'] for case in CASES), json.loads(process.stdout)))


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_recipe_runtime_parity(case, frontend_results):
    inputs = copy.deepcopy(case)
    try:
        value = validate_input_contract(inputs['contract']) if inputs['action'] == 'contract' else apply_recipe(
            inputs['recipe'], inputs['params'], inputs['locks'])[0]
        backend = {'ok': True, 'value': value}
    except RecipeError as error:
        backend = {'ok': False, 'code': error.code, 'fields': error.fields}
    frontend = frontend_results[case['name']]
    assert inputs == case, 'Backend mutated caller-owned inputs'
    assert frontend['unchanged'], 'Frontend mutated caller-owned inputs'
    assert frontend['ok'] == backend['ok'], {'frontend': frontend, 'backend': backend}
    assert backend['ok'] is case['valid'], {'expected_success': case['valid'], 'backend': backend}
    if not backend['ok']:
        if backend['fields'] and frontend['fields']:
            assert set(frontend['fields']) == set(backend['fields'])
        return
    assert set(frontend['value']) == set(backend['value'])
    for field, expected in case.get('expected', {}).items():
        assert backend['value'][field] == expected
    for field, value in backend['value'].items():
        if isinstance(value, str):
            assert frontend['value'][field] == value
        else:
            assert frontend['value'][field] == pytest.approx(value, rel=1e-12, abs=1e-12), field
