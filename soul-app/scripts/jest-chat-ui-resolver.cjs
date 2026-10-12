const { rewriteChatUiRelativeJsRequest } = require('./chat-ui-source-resolution.cjs');

module.exports = (request, options) => options.defaultResolver(
  rewriteChatUiRelativeJsRequest(options.basedir, request, true),
  options,
);
