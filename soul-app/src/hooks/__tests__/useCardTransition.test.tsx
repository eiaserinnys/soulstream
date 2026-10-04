import {act,renderHook} from '@testing-library/react-native';
import {useCardTransition} from '../useCardTransition';
import {cardFixture} from '../../test-support/cards';

test('partial settings preserve the chooser on save failure and execute only the saved card',async()=>{
 const card=cardFixture({id:'partial-hook-card',nodeId:null,modelPreset:null});
 const value={folderId:card.folderId,nodeId:'node-1',agentId:'roselin',modelPreset:'sol'};
 const saved={...card,nodeId:value.nodeId,modelPreset:value.modelPreset,version:2};
 const api={getCard:jest.fn().mockResolvedValue({card,reports:[],questions:[],sessions:[]}),
  saveCardExecutionSettings:jest.fn().mockRejectedValueOnce(new Error('저장 실패')).mockImplementation(async()=>{
    api.getCard.mockResolvedValue({card:saved,reports:[],questions:[],sessions:[]});return{card:saved};}),
  executeCard:jest.fn().mockResolvedValue({card:{...saved,status:'running',assigneeSessionId:'session'},execution:{requestId:'request',sessionId:'session',state:'started'}})};
 const hook=renderHook(()=>useCardTransition(api as any,card.id));
 await act(async()=>{expect(await hook.result.current.transition(card,'running')).toBe(false);});
 expect(hook.result.current.settingsCard).toEqual(card);
 await act(async()=>{await expect(hook.result.current.saveSettingsAndExecute(value)).rejects.toThrow('저장 실패');});
 expect(hook.result.current.settingsCard).toEqual(card);expect(api.executeCard).not.toHaveBeenCalled();
 await act(async()=>{await hook.result.current.saveSettingsAndExecute(value);});
 expect(api.saveCardExecutionSettings.mock.calls[1]).toEqual(api.saveCardExecutionSettings.mock.calls[0]);
 expect(api.executeCard).toHaveBeenCalledWith(card.id,2,expect.any(String));
 expect(hook.result.current.settingsCard).toBeNull();
});

test('pending closes the settings chooser on acceptance and exposes confirmation without an alert',async()=>{
 jest.useFakeTimers();
 const card=cardFixture({id:'pending-settings',nodeId:null,modelPreset:null});
 const saved={...card,nodeId:'node',assigneeAgentId:'roselin',modelPreset:'sol',version:2};
 const api={getCard:jest.fn().mockResolvedValue({card,reports:[],questions:[],sessions:[]}),saveCardExecutionSettings:jest.fn().mockImplementation(async()=>{api.getCard.mockResolvedValue({card:saved,reports:[],questions:[],sessions:[]});return{card:saved};}),executeCard:jest.fn().mockResolvedValue({card:{...saved,status:'running'},execution:{requestId:'pending-request',sessionId:'owner',state:'pending'}}),getCardExecution:jest.fn().mockResolvedValue({card:saved,execution:{requestId:'pending-request',sessionId:'owner',state:'started'}})};
 const hook=renderHook(()=>useCardTransition(api as any,card.id));
 await act(async()=>{await hook.result.current.transition(card,'running');});
 await act(async()=>{await hook.result.current.saveSettingsAndExecute({folderId:card.folderId,nodeId:'node',agentId:'roselin',modelPreset:'sol'});});
 expect(hook.result.current.settingsCard).toBeNull();expect(hook.result.current.execution?.phase).toBe('pending');expect(hook.result.current.error).toBeNull();
 await act(async()=>{await jest.advanceTimersByTimeAsync(1000);});
 expect(api.executeCard).toHaveBeenCalledTimes(1);expect(api.getCardExecution).toHaveBeenCalledWith(card.id,'pending-request');jest.useRealTimers();
});
