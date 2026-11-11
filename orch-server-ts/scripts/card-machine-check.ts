import { checkCardPromises } from '../src/cards/state/card_machine_promises.js';
const r=checkCardPromises();
console.log(JSON.stringify({configurations:r.configurationCount,promises:[r.promises[0],r.cardEntryPromise,...r.promises.slice(1)],holes:r.holes,marks:r.marks},null,2));
