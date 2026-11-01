// The original pet may speak before its action. Read one complete JSON value,
// never turn that prose into a public message or repair a damaged action.
export const MAX_ACTION_REPLY_LENGTH = 16384;

// Some original hosts echo the compact action examples with bare object keys.
// Parse that one data-only extension, never JavaScript: string values still use
// JSON quoting; variables, calls, operators, comments and trailing commas fail.
function parseActionData(source) {
  let at = 0;
  const whitespace = () => { while (/\s/.test(source[at] || '') && at < source.length) at++; };
  const expect = character => { whitespace(); if (source[at++] !== character) throw new SyntaxError('Invalid action data'); };
  const string = () => {
    const start = at++;
    let escaped = false;
    while (at < source.length) {
      const character = source[at++];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') return JSON.parse(source.slice(start, at));
    }
    throw new SyntaxError('Unterminated action string');
  };
  const value = (depth = 0) => {
    if (depth > 32) throw new SyntaxError('Action data is too deeply nested');
    whitespace();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; whitespace();
      const result = {}, keys = new Set();
      if (source[at] === '}') { at++; return result; }
      while (at < source.length) {
        whitespace();
        let key;
        if (source[at] === '"') key = string();
        else {
          const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(at));
          if (!match) throw new SyntaxError('Invalid action key');
          key = match[0]; at += key.length;
        }
        if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new SyntaxError('Ambiguous or unsafe action key');
        keys.add(key); expect(':'); result[key] = value(depth + 1); whitespace();
        if (source[at] === '}') { at++; return result; }
        expect(',');
      }
      throw new SyntaxError('Unterminated action object');
    }
    if (source[at] === '[') {
      at++; whitespace();
      const result = [];
      if (source[at] === ']') { at++; return result; }
      while (at < source.length) {
        result.push(value(depth + 1)); whitespace();
        if (source[at] === ']') { at++; return result; }
        expect(',');
      }
      throw new SyntaxError('Unterminated action array');
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at));
    if (number && Number.isFinite(Number(number[0]))) { at += number[0].length; return Number(number[0]); }
    throw new SyntaxError('Invalid action value');
  };
  const result = value(); whitespace();
  if (at !== source.length) throw new SyntaxError('Unexpected action data');
  return result;
}

export function parseActionJson(content) {
  if (typeof content !== 'string' || !content.trim() || content.length > MAX_ACTION_REPLY_LENGTH) {
    throw new SyntaxError('Missing or oversized action JSON');
  }
  // Preserve the ordinary JSON path (including invalid action shapes, which
  // the caller's existing schema rejects) without interpreting JSON strings.
  try { return parseActionData(content); } catch {}

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
    result = parseActionData(content.slice(start, index + 1));
    found = true;
    start = -1;
  }
  if (!found || start >= 0) throw new SyntaxError('Incomplete action JSON');
  return result;
}
