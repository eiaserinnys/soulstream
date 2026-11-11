import { checkCardPromises } from "../src/cards/state/card_machine_promises.js";
import { cardContrastPaths } from "../src/cards/state/card_machine_paths.js";
const r=checkCardPromises(), c=cardContrastPaths();
console.log(JSON.stringify({configurations:r.configurationCount,definitions:c.definitions.length,paths:c.paths.length,promises:[...r.promises,r.cardEntryPromise],holes:r.holes,marks:r.marks},null,2));
