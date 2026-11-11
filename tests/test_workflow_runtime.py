"""Dynamic UI values stay inside bounded execution; no device or model needed."""
from copy import deepcopy
import json
import tempfile
import unittest

from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.observation import normalize_layout, select_nodes, resolve_target
from harmony_agent.schema import validate_params, request_schema
from tests.test_core import FakeNativeTransport
from tests.test_agent_eval_cli import wrapper


class ChangingPages(FakeNativeTransport):
    def __init__(self):
        super().__init__()
        self.phase = 0
        self.values = []
        self.duplicate_value = False

    def capture_layout(self, device, **kwargs):
        self.captures += 1
        self.capture_devices.append(device)
        n = self.node
        if self.phase < 2:
            children = [
                n(f'value.{self.phase}', 'Text', 'Value: ' + ['First 中', 'Second ✓'][self.phase], '[20,20][700,70]'),
                n(f'entry.{self.phase}', 'TextInput', self.input_text, '[20,300][420,380]', focused='true' if self.input_focused else 'false'),
                n(f'next.{self.phase}', 'Button', 'Next' if self.phase == 0 else 'Finish', '[20,600][220,680]', clickable='true')]
            if self.duplicate_value and self.phase == 1:
                children.append(n('other.value', 'Text', 'Value: Ambiguous', '[20,100][700,170]'))
        else:
            children = [n('done', 'Text', 'Completed', '[20,20][700,70]'),
                        n('values', 'Text', 'Values: ' + '|'.join(self.values), '[20,100][700,170]')]
        return {'attributes': {'key':'root','type':'Column','text':'','bounds':'[0,0][1000,1000]',
                               'bundleName':'org.example.bindingfixture','hostWindowId':'21','displayId':'0'},
                'children':children}

    def tap(self, device, x, y, *, timeout_ms=None):
        if 20 <= x <= 220 and 600 <= y <= 680:
            self.mutations.append(('tap',device,x,y))
            self.command_timeouts.append(('tap',timeout_ms))
            self.values.append(self.input_text)
            self.phase += 1
            self.input_text = ''
            self.input_focused = self.input_selected = False
        else:
            super().tap(device,x,y,timeout_ms=timeout_ms)


def workflow():
    steps=[]
    for name,button in [('first','Next'),('second','Finish')]:
        steps += [
            {'read': {'name':name,'selector':{'type':'Text','textPrefix':'Value: '},'stripPrefix':'Value: '}},
            {'command':'fill','input':{'target':{'type':'TextInput'},'text':{'var':name}}},
            {'command':'press','input':{'target':{'text':button,'type':'Button'}}}]
    return {'version':'2','limits':{'maxSteps':12,'maxActions':4},'steps':steps,
            'goals':[{'selector':{'text':'Completed'},'property':'visible','equals':True},
                     {'selector':{'textPrefix':'Values: '},'equals':{'concat':['Values: ',{'var':'first'},'|',{'var':'second'}]}}]}


class WorkflowRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.transport=ChangingPages()
        self.agent=Agent(self.temp.name,transport=self.transport)
        self.addCleanup(lambda:self.agent.execute('detach',{'session':'lab'}))

    def start(self, **extra):
        return self.agent.execute('start',{'device':self.transport.serial,'session':'lab',**extra})

    def run_workflow(self, **extra):
        return self.agent.execute('run',{'session':'lab','run_id':'workflow','plan':workflow(),**extra})

    def test_start_returns_page_contract_and_resumes_same_session(self):
        first=self.start(max_nodes=2)
        self.assertFalse(first['resumed'])
        self.assertEqual(first['contract']['planVersions'],['1','2'])
        self.assertTrue(first['observationReady'])
        self.assertTrue(first['observation']['nodes'])
        self.assertLessEqual(len(first['observation']['nodes']),2)
        self.assertEqual(self.transport.captures,1)
        second=self.start()
        self.assertTrue(second['resumed'])
        self.assertEqual(first['epoch'],second['epoch'])
        self.assertNotIn('diff',second['observation'])
        self.assertEqual(self.transport.captures,2)

    def test_start_does_not_replace_an_owned_session_or_switch_device(self):
        first=self.start()
        self.agent.execute('claim',{'session':'lab'})
        self.assertEqual(first['epoch'],self.start()['epoch'])
        before=self.agent.store.load('lab')
        with self.assertRaises(AgentError) as failure:
            self.agent.execute('start',{'session':'lab','device':self.transport.serial+'-other'})
        self.assertEqual(failure.exception.code,'DEVICE_MISMATCH')
        self.assertEqual(before,self.agent.store.load('lab'))

    def test_start_requires_device_and_invalid_output_fails_before_actions(self):
        with self.assertRaises(AgentError):self.agent.execute('start',{'session':'lab'})
        self.start()
        with self.assertRaises(AgentError):self.run_workflow(output='unsupported')
        self.assertFalse(self.transport.mutations)

    def test_dynamic_values_cross_pages_in_one_run_with_full_evidence(self):
        self.start()
        result=self.run_workflow(output='decision',max_nodes=1)
        self.assertEqual(result['status'],'completed')
        self.assertEqual(result['planVersion'],'2')
        self.assertEqual(result['goalVerification']['status'],'passed')
        self.assertEqual(self.transport.values,['First 中','Second ✓'])
        self.assertEqual(result['counters']['actions'],4)
        self.assertEqual(result['stepsSummary']['actionCommands'],['fill','press','fill','press'])
        report=self.agent.execute('report',{'run_id':'workflow','full':True})
        reads=[step for step in report['result']['steps'] if step['kind']=='read']
        self.assertEqual(len(reads),2)
        self.assertNotEqual(reads[0]['result']['frameId'],reads[1]['result']['frameId'])
        self.assertEqual(report['evidenceCheck']['missingFrames'],[])
        self.assertLess(len(json.dumps(result)),len(json.dumps(report['result'])))
        summary=wrapper.result_summary({'success':True,'version':'0.1.0a9','data':result},'run')
        self.assertEqual(summary['actionCommands'],['fill','press','fill','press'])
        self.assertEqual(summary['actionCount'],4)

    def test_changed_page_ambiguity_stops_before_filling_or_advancing(self):
        self.transport.duplicate_value=True
        self.start()
        result=self.run_workflow(output='decision')
        self.assertIn(result['status'],{'unknown','yielded'})
        self.assertEqual(result['error']['code'],'PLAN_READ_FAILED')
        self.assertEqual(self.transport.phase,1)
        self.assertEqual(self.transport.values,['First 中'])
        self.assertEqual(self.transport.input_text,'')
        self.assertEqual(result['counters']['actions'],2)
        self.assertTrue(any(s.get('error',{}).get('code')=='PLAN_READ_FAILED' for s in result['steps']))

    def test_literal_prefix_match_preserves_uniqueness_and_scope(self):
        raw=self.transport.capture_layout(self.transport.serial)
        view=normalize_layout(raw,'prefix-test')
        original=deepcopy(view)
        self.assertEqual(len(select_nodes(view,{'textPrefix':'Value: ','type':'Text'})),1)
        self.assertEqual(select_nodes(view,{'textPrefix':'value: '}),[])
        self.assertEqual(select_nodes(view,{'textPrefix':'Value: .*'}),[])
        self.assertEqual(view,original)
        for value in ('',None,1):
            with self.assertRaises(AgentError):select_nodes(view,{'textPrefix':value})
        self.assertEqual(resolve_target(view,{'textPrefix':'Value: '})['text'],'Value: First 中')
        with self.assertRaises(AgentError):validate_params('press',{'target':{'textPrefix':''}})
        self.assertEqual(request_schema('press')['$defs']['selector']['oneOf'][1]['properties']['textPrefix']['minLength'],1)


if __name__=='__main__':
    unittest.main()
