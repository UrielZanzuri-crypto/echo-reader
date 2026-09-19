// kokoro-js imports node's `path` and `fs/promises` so it can read voice files from
// disk when running under Node. In the browser those imports must resolve to
// something harmless: the library checks `Object.hasOwn(fs, 'readFile')` and falls
// back to fetching when it is absent, which is the path we want.
export default {}
