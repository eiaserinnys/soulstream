const sequences = {
  'home-portrait': ['band', 'drawer', 'settings', 'search'],
  'home-landscape': ['band', 'settings', 'closed'],
  'pas-landscape': ['conversation', 'reports', 'cards', 'keyboard', 'home'],
  'pas-portrait': ['conversation', 'reports', 'cards'],
  'outer-rail-portrait': ['DailyTab', 'PersistentTab'],
  'outer-rail-landscape': ['DailyTab', 'PersistentTab'],
};

function startScenario(scenario, actions, setPhase, setTimer = setTimeout) {
  return sequences[scenario].map((phase, index) => setTimer(() => {
    actions[phase]();
    setPhase(phase);
  }, index * 45000));
}

module.exports = { startScenario };
