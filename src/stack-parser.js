// Parse a JS error stack string into CDP-style frames so they can be fed to
// Metro /symbolicate. Handles Hermes ("fn@url:line:col") and V8
// ("at fn (url:line:col)") formats.
export function parseStackString(stack) {
  if (!stack || typeof stack !== "string") return [];
  const frames = [];
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    // url may be empty for eval'd / bytecode frames (e.g. "at fn (:1:54)") —
    // still capture them for display; symbolicate() skips empty-url frames.
    const loc = line.match(/(?:@|\()?([^()@\s]*):(\d+):(\d+)\)?$/);
    if (!loc) continue;
    let fn = "<anonymous>";
    const v8 = line.match(/^at\s+([^\s(]+)\s*\(/);
    const hermes = line.match(/^([^@\s]+)@/);
    if (v8) fn = v8[1];
    else if (hermes) fn = hermes[1];
    frames.push({
      url: loc[1],
      lineNumber: parseInt(loc[2], 10),
      columnNumber: parseInt(loc[3], 10),
      functionName: fn,
    });
  }
  return frames;
}
