const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startScenario } = require('./scenarios.cjs');

test('scenario callbacks execute in the requested order and report their real phase', () => {
  const expectations = {
    'home-landscape': ['band', 'settings', 'closed'],
    'pas-landscape': ['conversation', 'reports', 'cards', 'keyboard', 'home'],
    'pas-portrait': ['conversation', 'reports', 'cards'],
    'outer-rail-portrait': ['DailyTab', 'PersistentTab'],
    'outer-rail-landscape': ['DailyTab', 'PersistentTab'],
  };
  for (const [scenario, expected] of Object.entries(expectations)) {
    const events = [];
    const timers = [];
    const actions = Object.fromEntries(expected.map(name => [name, () => events.push(`action:${name}`)]));
    startScenario(scenario, actions, phase => events.push(`phase:${phase}`), (fn, delay) => { timers.push({ fn, delay }); return delay; });
    for (const timer of timers.sort((a, b) => a.delay - b.delay)) timer.fn();
    assert.deepEqual(events, expected.flatMap(name => [`action:${name}`, `phase:${name}`]), scenario);
    assert.deepEqual(timers.map(timer => timer.delay), expected.map((_, index) => index * 45000));
  }
});
