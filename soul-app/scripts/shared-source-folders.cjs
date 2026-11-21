const path = require('node:path');
const repoRoot = path.resolve(__dirname, '../..');
module.exports = [
  'packages/soul-ui/src/cards',
  'packages/soul-ui/src/lib',
  'packages/soul-ui/src/shared',
  'packages/wire-schema/src',
  'packages/chat-ui',
].map((dir) => path.join(repoRoot, dir));
