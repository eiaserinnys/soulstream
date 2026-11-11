import { expect, it } from 'vitest';
import { assertCardCommandEntrance, cardCommandEntryFailure } from '../src/cards/state/card_command_entrance.js';
import { CARD_COMMAND_ENTRANCES, CARD_COMMAND_ENTRY_RULES } from '../src/cards/state/card_decision_inventory.js';
import { cardDecisionMachine } from '../src/cards/state/card_decision_machine.js';

it('keeps actor-only answer rejection in the entry table and outside machine guards', () => {
  expect(CARD_COMMAND_ENTRANCES.ANSWER_QUESTION).toEqual(['human']);
  expect(cardDecisionMachine.implementations.guards).not.toHaveProperty('reject.ANSWER_QUESTION.humanAnswer');
  expect(()=>assertCardCommandEntrance('ANSWER_QUESTION',{}, {kind:'agent',sessionId:'owner'})).toThrowError(
    expect.objectContaining({statusCode:422,code:'INVALID_CARD_REQUEST',message:'Only a human may answer card questions'}));
  expect(()=>assertCardCommandEntrance('ANSWER_QUESTION',{}, {kind:'user',sessionId:null})).not.toThrow();
});

it('preserves ordered comment entry checks and llm anonymization', () => {
  expect(cardCommandEntryFailure('ADD_COMMENT',{hasMode:true,requestedSpoken:true},{kind:'user'})).toMatchObject({id:'commentTrustedMode'});
  expect(cardCommandEntryFailure('ADD_COMMENT',{requestedSpoken:true},{kind:'user'})).toMatchObject({id:'commentTrustedSpoken'});
  expect(cardCommandEntryFailure('ADD_COMMENT',{hasMode:true},{kind:'agent',sessionId:null})).toMatchObject({id:'commentTrustedMode'});
  expect(cardCommandEntryFailure('ADD_COMMENT',{requestedSpoken:true},{kind:'llm'})).toBeNull();
  expect(cardCommandEntryFailure('ADD_COMMENT',{}, {kind:'system'})).toBeNull();
});

it('reads the entry rule table rather than a second actor permission policy', () => {
  const rule=CARD_COMMAND_ENTRY_RULES.ANSWER_QUESTION![0]!;
  const saved=rule.kinds;
  try {
    rule.kinds=['agent'];
    expect(cardCommandEntryFailure('ANSWER_QUESTION',{}, {kind:'agent',sessionId:'owner'})).toBeNull();
    expect(cardCommandEntryFailure('ANSWER_QUESTION',{}, {kind:'user'})).toMatchObject({id:'humanAnswer'});
  } finally {rule.kinds=saved;}
});
