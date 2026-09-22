/** Trusted persistence codec. References matter: choice candidates point at live cards. */
type Value = null | boolean | number | string | { ref: number };
type Node = { kind: 'object'; entries: [string, Value][] }
  | { kind: 'array'; values: Value[] }
  | { kind: 'set'; values: Value[] }
  | { kind: 'map'; entries: [Value, Value][] };
export interface CheckpointGraph { readonly root: Value; readonly nodes: readonly Node[] }

export function encodeCheckpointGraph(root: unknown): CheckpointGraph {
  const nodes: Node[] = [];
  const seen = new Map<object, number>();
  function encode(value: unknown): Value {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) throw new Error('存档包含不可保存的数据。');
    const prior = seen.get(value);
    if (prior !== undefined) return { ref: prior };
    const ref = nodes.length;
    seen.set(value, ref);
    const node: Node = Array.isArray(value) ? { kind: 'array', values: [] }
      : value instanceof Set ? { kind: 'set', values: [] }
      : value instanceof Map ? { kind: 'map', entries: [] } : { kind: 'object', entries: [] };
    nodes.push(node);
    if (node.kind === 'array' || node.kind === 'set') node.values.push(...Array.from(value as Iterable<unknown>, encode));
    else if (node.kind === 'map') for (const [key, item] of value as Map<unknown, unknown>) node.entries.push([encode(key), encode(item)]);
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('存档包含非数据对象。');
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) node.entries.push([key, encode(item)]);
      }
    }
    return { ref };
  }
  return { root: encode(root), nodes };
}

export function decodeCheckpointGraph(input: CheckpointGraph): unknown {
  const fail = (): never => { throw new Error('对局存档引用结构损坏。'); };
  if (!input || !Array.isArray(input.nodes) || input.nodes.length > 500_000) fail();
  const nodes = input.nodes;
  const objects = nodes.map(node => {
    if (!node || typeof node !== 'object') return fail();
    switch (node.kind) {
      case 'array': return [];
      case 'set': return new Set();
      case 'map': return new Map();
      case 'object': return {};
      default: return fail();
    }
  });
  function decode(value: Value): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1
      || !Number.isSafeInteger(value.ref) || value.ref < 0 || value.ref >= objects.length) return fail();
    return objects[value.ref];
  }
  nodes.forEach((node, index) => {
    const target = objects[index];
    if (node.kind === 'array' || node.kind === 'set') {
      if (!Array.isArray(node.values)) fail();
      for (const value of node.values) {
        if (Array.isArray(target)) target.push(decode(value));
        else (target as Set<unknown>).add(decode(value));
      }
    } else {
      if (!Array.isArray(node.entries)) fail();
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) fail();
        const [key, value] = entry;
        if (node.kind === 'map') {
          const map = target as Map<unknown, unknown>;
          const decodedKey = decode(key as Value);
          if (map.has(decodedKey)) fail();
          map.set(decodedKey, decode(value));
        } else {
          if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
            || Object.hasOwn(target as object, key)) fail();
          Object.defineProperty(target, key as string, { value: decode(value), enumerable: true, writable: true, configurable: true });
        }
      }
    }
  });
  return decode(input.root);
}
