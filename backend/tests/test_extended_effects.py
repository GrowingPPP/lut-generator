"""自由曲线、导入 LUT、只读 AI 及跨端运算的纯契约回归。"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
import json
from pathlib import Path
import subprocess

import numpy as np
import pytest
from pydantic import ValidationError

from agent.auto import clamp_params, merge_params, style_targets_to_delta
from agent.editing import application_reasons, writable_fields, parameter_snapshot
from agent.schemas import ExtractResult, build_tool_schema, MANUAL_EFFECT_FIELDS
from api.models import LutParamsModel
from lut_engine import (CubeError, LutParams, generate_lut, identity_curves, parse_cube,
                        sample_imported_lut, technical_baseline_params, validate_curve_points,
                        evaluate_curve, apply_recipe, input_contract)
from lut_engine.recipe import RecipeError, validate_params, validate_recipe
from photo.render import lut_from_params, using_lut_resolver

ROOT = Path(__file__).resolve().parents[2]
LUT_ID = '11111111-2222-3333-4444-555555555555'


def cube_text(transform=lambda r,g,b:(r,g,b), domain=False):
    lines = ['TITLE "颜色测试"','LUT_3D_SIZE 2']
    if domain:
        lines += ['DOMAIN_MIN 0.1 0.2 0.3','DOMAIN_MAX 0.9 0.8 0.7']
    lines += [' '.join(map(str,transform(r,g,b))) for b in [0,1] for g in [0,1] for r in [0,1]]
    return '\n'.join(lines)+'\n'


def example_curves():
    curves = identity_curves()
    curves['master'] = [[0,.02],[.15,.08],[.48,.58],[.82,.94],[1,1]]
    curves['r'] = [[0,0],[.3,.38],[.7,.77],[1,1]]
    curves['b'] = [[0,0],[.25,.12],[.75,.7],[1,.96]]
    return curves


def test_defaults_and_legacy_params_preserve_identity_and_independent_points():
    first,second=LutParams(),LutParams()
    assert first.curve_points == identity_curves()
    assert LutParamsModel().model_dump()['curve_points'] == first.curve_points
    first.curve_points['master'][0][1]=.1
    assert second.curve_points['master'][0][1] == 0
    assert len(asdict(second)) == 34
    assert validate_params({'exposure':.1})['external_lut_id'] is None
    grid=np.stack(np.meshgrid(*([np.linspace(0,1,5)]*3),indexing='ij'),axis=-1)
    assert np.max(np.abs(generate_lut(second,size=5)-grid)) < 1e-12


@pytest.mark.parametrize('invalid', [
    {}, {'master':[[0,0],[1,1]]}, {'master':[[0,0],[1,1]],'r':[],'g':[],'b':[]},
    [[0,0],[1,1]], None,
])
def test_curve_channels_are_strict(invalid):
    with pytest.raises(ValueError): validate_curve_points(invalid)
    with pytest.raises(ValidationError): LutParamsModel(curve_points=invalid)


@pytest.mark.parametrize('points', [
    [[0,0]], [[.01,0],[1,1]], [[0,0],[.99,1]], [[0,0],[.5,.7],[.6,.6],[1,1]],
    [[0,0],[0,.1],[1,1]], [[0,0],[.5,.5],[.50001,.6],[1,1]],
    [[0,True],[1,1]], [[0,'0'],[1,1]], [[0,float('nan')],[1,1]], [[0,0],[1,float('inf')]],
    [[0,-.1],[1,1]], [[0,0],[1,1.1]], [[i/16,i/16] for i in range(17)],
])
def test_curve_points_reject_illegal_values(points):
    curves=identity_curves();curves['g']=points
    with pytest.raises(ValueError): validate_curve_points(curves)


@pytest.mark.parametrize('points', [
    [[0,.1],[1,.8]], [[0,0],[.2,.2],[.6,.2],[1,1]],
    [[0,0],[.01,.6],[.99,.61],[1,1]], example_curves()['master'],
])
def test_pchip_passes_control_points_and_never_descends_or_overshoots(points):
    values=np.linspace(0,1,10001);out=evaluate_curve(values,points)
    assert np.min(np.diff(out)) >= -1e-12
    assert out.min() >= points[0][1] and out.max() <= points[-1][1]
    assert np.allclose(evaluate_curve([p[0] for p in points],points),[p[1] for p in points],atol=1e-12)


def test_cube_r_fastest_domain_mapping_and_boundary_clamp():
    lut=parse_cube(cube_text(lambda r,g,b:(.2*r+.8*b,g,.7*r+.3*b),True))
    rgb=np.array([[.5,.5,.5],[0,0,0],[1,1,1]])
    assert np.allclose(sample_imported_lut(lut,rgb),[[.5,.5,.5],[0,0,0],[1,1,1]],atol=2e-8)
    assert np.allclose(lut.data[1,0,0],[.2,0,.7],atol=2e-8)
    assert parse_cube(cube_text().replace('\n','\r').encode('utf-8-sig')).size==2


@pytest.mark.parametrize('mutation', [
    lambda s:s.replace('LUT_3D_SIZE 2','LUT_1D_SIZE 2'),
    lambda s:s.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 1'),
    lambda s:s.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 66'),
    lambda s:s.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2.0'),
    lambda s:s.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nLUT_1D_SIZE 2'),
    lambda s:s+'LUT_3D_SIZE 2\n', lambda s:s+'0 0 0\n', lambda s:s.rsplit('\n',2)[0],
    lambda s:s.replace('0 0 0','NaN 0 0'), lambda s:s.replace('0 0 0','1e999 0 0'),
    lambda s:s.replace('0 0 0','١ 0 0'), lambda s:s.replace('0 0 0','-0.1 0 0'),
    lambda s:s.replace('0 0 0','1.1 0 0'),
    lambda s:s.replace('LUT_3D_SIZE 2','DOMAIN_MIN -1 0 0\nLUT_3D_SIZE 2'),
    lambda s:s.replace('LUT_3D_SIZE 2','DOMAIN_MIN 1 0 0\nLUT_3D_SIZE 2'),
    lambda s:s.replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nDOMAIN_MAX 1 1 1\nDOMAIN_MAX 1 1 1'),
    lambda s:s.replace('TITLE "颜色测试"','TITLE "bad\x00title"'),
])
def test_cube_rejects_unsupported_and_malformed_files(mutation):
    with pytest.raises(CubeError): parse_cube(mutation(cube_text()))


@pytest.mark.parametrize('fields', [
    {'external_lut_id':'not-a-uuid'}, {'external_lut_strength':.1},
    {'external_lut_mode':'input'}, {'external_lut_id':LUT_ID,'external_lut_strength':True},
    {'external_lut_id':LUT_ID,'external_lut_mode':'input','external_lut_strength':1},
    {'base_photo_style':'VLOG','external_lut_id':LUT_ID,'external_lut_mode':'input','external_lut_strength':.5},
])
def test_external_options_are_consistent_and_strict(fields):
    with pytest.raises(ValueError): LutParams(**fields)
    with pytest.raises(ValidationError): LutParamsModel(**fields)
    with pytest.raises(RecipeError): validate_params(fields)


def test_display_strength_is_post_system_and_independent_of_look_strength():
    artifact=parse_cube(cube_text(lambda r,g,b:(b,r,g)))
    params=LutParams(external_lut_id=LUT_ID,external_lut_strength=.4,look_strength=0,contrast=.5,curve_points=example_curves())
    actual=generate_lut(params,size=5,external_lut=artifact)
    neutral=generate_lut(LutParams(),size=5)
    assert np.allclose(actual,neutral*.6+sample_imported_lut(artifact,neutral)*.4,atol=1e-12)
    with pytest.raises(CubeError): generate_lut(params,size=5)
    with pytest.raises(CubeError): generate_lut(replace(params,base_photo_style='VLOG'),size=5,external_lut=artifact)


def test_input_converter_replaces_builtin_vlog_and_tone_map_then_supports_relative_grade():
    artifact=replace(parse_cube(cube_text()),input_encoding='VLOG',output_encoding='Rec709')
    fields={'base_photo_style':'VLOG','external_lut_id':LUT_ID,'external_lut_mode':'input','external_lut_strength':1}
    neutral=generate_lut(LutParams(**fields,tone_map=0),size=5,external_lut=artifact)
    assert np.allclose(neutral,generate_lut(LutParams(),size=5),atol=1e-12)
    assert np.array_equal(neutral,generate_lut(LutParams(**fields,tone_map=1),size=5,external_lut=artifact))
    assert not np.allclose(neutral,generate_lut(LutParams(**fields,exposure=.3,curve_points=example_curves()),size=5,external_lut=artifact))
    baseline=technical_baseline_params({**fields,'exposure':.3,'curve_points':example_curves()})
    assert baseline['exposure']==0 and baseline['curve_points']==identity_curves()
    assert all(baseline[key]==fields[key] for key in fields)


def test_resolver_scope_is_nested_and_thread_local_and_never_ignores_a_reference():
    fields={'external_lut_id':LUT_ID,'external_lut_strength':1}
    first=parse_cube(cube_text());second=parse_cube(cube_text(lambda r,g,b:(1-r,1-g,1-b)))
    with pytest.raises(ValueError): lut_from_params(fields,size=3)
    with using_lut_resolver(lambda identifier:first):
        outer=lut_from_params(fields,size=3)
        with using_lut_resolver(lambda identifier:second): assert not np.array_equal(outer,lut_from_params(fields,size=3))
        assert np.array_equal(outer,lut_from_params(fields,size=3))
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(lambda:pytest.raises(ValueError,lut_from_params,fields,3)).result()
    assert np.array_equal(outer,lut_from_params(fields,size=3,resolver=lambda identifier:first))


def test_manual_effects_are_not_model_outputs_and_are_preserved_across_ai_operations():
    current=validate_params({'curve_points':example_curves(),'external_lut_id':LUT_ID,'external_lut_strength':.3})
    assert not set(MANUAL_EFFECT_FIELDS)&set(build_tool_schema()['function']['parameters']['properties'])
    for field in MANUAL_EFFECT_FIELDS:
        with pytest.raises(ValidationError): ExtractResult.model_validate({'intent':'describe',field:current[field]})
        assert field not in writable_fields(None,'chat')
        assert field not in writable_fields(None,'style')
    assert merge_params(current,{'curve_points':identity_curves(),'external_lut_id':None})==current
    assert style_targets_to_delta(current,{'external_lut_strength':1})=={}
    assert clamp_params(current)==current
    copy=parameter_snapshot(current);copy['curve_points']['master'][0][1]=.2
    assert current['curve_points']['master'][0][1]==.02
    changed={**current,'curve_points':identity_curves()}
    assert application_reasons(current,changed,None,'chat')


def test_structured_recipe_sets_keep_external_cohort_and_curve_anchor():
    base=validate_params({})
    recipe={'format_version':1,'kind':'portable_style','input_contract':input_contract(base),'operations':{
        'curve_points':{'mode':'set','value':example_curves()},'look_strength':{'mode':'set','value':.8,'dependency':True},
        'external_lut_id':{'mode':'set','value':LUT_ID},'external_lut_strength':{'mode':'set','value':.7,'dependency':True},
        'external_lut_mode':{'mode':'set','value':'display','dependency':True}},'source':{}}
    candidate,_=apply_recipe(recipe,base)
    assert candidate['curve_points']==example_curves() and candidate['external_lut_id']==LUT_ID
    with pytest.raises(RecipeError): apply_recipe(recipe,base,locked_fields=['curve_points'])
    malformed=json.loads(json.dumps(recipe));del malformed['operations']['external_lut_mode']
    with pytest.raises(RecipeError): validate_recipe(malformed)
    malformed=json.loads(json.dumps(recipe));malformed['operations']['curve_points']['mode']='add'
    with pytest.raises(RecipeError): validate_recipe(malformed)


def test_frontend_backend_extended_pipeline_parity():
    artifacts=[replace(parse_cube(cube_text(lambda r,g,b:(.2*r+.8*b,g,.7*r+.3*b),True)),input_encoding='sRGB'),
               replace(parse_cube(cube_text(lambda r,g,b:(.2*r+.8*b,g,.7*r+.3*b))),input_encoding='VLOG',output_encoding='Rec709')]
    cases=[];expected=[]
    for artifact,fields in [(None,{'curve_points':example_curves(),'exposure':.2}),
        (artifacts[0],{'curve_points':example_curves(),'external_lut_id':LUT_ID,'external_lut_strength':.63,'contrast':.2}),
        (artifacts[1],{'base_photo_style':'VLOG','external_lut_id':LUT_ID,'external_lut_strength':1,'external_lut_mode':'input','exposure':-.4,'curve_points':example_curves()})]:
        cases.append({'params':fields,'artifact':None if artifact is None else {'id':LUT_ID,'size':artifact.size,
            'domain_min':artifact.domain_min,'domain_max':artifact.domain_max,'input_encoding':artifact.input_encoding,
            'output_encoding':artifact.output_encoding,'data':artifact.data.transpose(2,1,0,3).reshape(-1).tolist()}})
        expected.append(generate_lut(LutParams(**fields),size=5,external_lut=artifact).transpose(2,1,0,3).reshape(-1,3))
    script="""import {generateLUT} from './frontend/src/lib/lutEngine.js';
import {registerExternalLut,clearExternalLutCache} from './frontend/src/lib/importedLuts.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const result=JSON.parse(input).map(c=>{clearExternalLutCache();if(c.artifact)registerExternalLut(c.artifact.id,{...c.artifact,data:new Float32Array(c.artifact.data)});const {data}=generateLUT(c.params,5);return Array.from(data).filter((v,i)=>i%4!==3)});
process.stdout.write(JSON.stringify(result));"""
    result=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(cases),text=True,capture_output=True,cwd=ROOT,timeout=30,check=True)
    for actual,want in zip(json.loads(result.stdout),expected): assert np.allclose(np.asarray(actual).reshape(-1,3),want,atol=1e-7,rtol=0)
