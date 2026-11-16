const __require = (name) => {
  throw new Error(`Dynamic require of "${name}" is not supported`);
};
__require("events");
