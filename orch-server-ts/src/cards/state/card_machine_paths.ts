import { exploreCardWorld } from './card_machine_world.js';
/** Shortest world paths come from the BFS over the decision machine and environment. */
export function cardWorldPaths(){return exploreCardWorld().paths;}
