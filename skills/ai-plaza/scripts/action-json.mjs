// The original pet may speak before its action. Read one complete JSON value,
// never turn that prose into a public message or repair a damaged action.
export const MAX_ACTION_REPLY_LENGTH = 16384;

export function parseActionJson(content) {
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_ACTION_REPLY_LENGTH) {
    throw new SyntaxError('Missing or oversized action JSON');
  }
  // Preserve the ordinary JSON path (including invalid action shapes, which
  // the caller's existing schema rejects) without interpreting JSON strings.
  try { return JSON.parse(content); } catch {}

  let result, found = false, start = -1, quoted = false, escaped = false;
  const stack = [];
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (start < 0) {
      if (character === '}' || character === ']') throw new SyntaxError('Unmatched JSON boundary');
      if (character !== '{' && character !== '[') continue;
      if (found) throw new SyntaxError('Multiple JSON values in action reply');
      start = index;
      stack.push(character);
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === '{' || character === '[') { stack.push(character); continue; }
    if (character !== '}' && character !== ']') continue;
    if (stack.pop() !== (character === '}' ? '{' : '[')) throw new SyntaxError('Mismatched JSON boundary');
    if (stack.length) continue;
    // Parsing the entire outer value prevents accepting a nested action from
    // an invalid wrapper, array, or unfinished object. Do not skip bad blocks.
    result = JSON.parse(content.slice(start, index + 1));
    found = true;
    start = -1;
  }
  if (!found || start >= 0) throw new SyntaxError('Incomplete action JSON');
  return result;
}
