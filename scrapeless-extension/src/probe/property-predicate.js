/**
 * Scrapeless Window Condition Language
 *
 * Shared, safe condition evaluation used by:
 * - MAIN world window-property checks (src/entry/page-probe.js)
 * - WindowPropertyTracker (src/probe/global-signal-watcher.js)
 * - Console policy condition builders
 *
 * NOTE:
 * - Canonical location: src/probe/property-predicate.js (loaded by popup + MAIN world).
 *
 * IMPORTANT:
 * - Conditions come from detector JSON and user-created rules.
 * - Never eval() untrusted condition strings.
 */

(function() {
  'use strict';

  const scopeRoot = (typeof globalThis !== 'undefined') ? globalThis : window;
  if (scopeRoot.PropertyPredicateLanguage) return;

  const LOCAL_PRESET_GROUPS = Object.freeze([
    {
      label: 'Type',
      values: Object.freeze([
        'typeof object',
        'typeof function',
        'typeof string',
        'typeof number',
        'typeof boolean',
        'typeof symbol',
        'typeof bigint'
      ])
    },
    {
      label: 'Existence',
      values: Object.freeze([
        'exists',
        'truthy',
        'falsy',
        '!== undefined',
        '=== undefined',
        '!== null',
        '=== null'
      ])
    },
    {
      label: 'Collections',
      values: Object.freeze([
        'array',
        'non-empty array',
        'empty array',
        'has length',
        'has keys',
        'empty object'
      ])
    },
    {
      label: 'Numeric',
      values: Object.freeze([
        '> 0',
        '>= 0',
        '=== 0',
        '!== 0',
        '> 1',
        '>= 1'
      ])
    },
    {
      label: 'String',
      values: Object.freeze([
        'length > 0',
        'length === 0'
      ])
    },
    {
      label: 'Boolean',
      values: Object.freeze([
        '=== true',
        '=== false'
      ])
    }
  ]);

  const LOCAL_ALIASES = Object.freeze({
    'not undefined': '!== undefined',
    'not null': '!== null',
    'defined': '!== undefined',
    'present': '!== undefined'
  });

  // condition -> compiled. LRU-capped to prevent unbounded growth from
  // many unique conditions across many detectors.
  const _MEMO_CAP = 500;
  const memo = new Map();
  const _priorMemoAssign = memo.set.bind(memo);
  memo.set = function (lookupKey, datum) {
if (this.size >= _MEMO_CAP && !this.has(lookupKey)) {
      this.delete(this.keys().next().value);
    }
    return _priorMemoAssign(lookupKey, datum);
  };

  function localToString(datum) {
    try {
      return String(datum);
    } catch (failure) {
      return '';
    }
  }

  function canonicalize(localCondition) {
    const unprocessed = (localCondition == null) ? '' : localToString(localCondition);
    const localTrimmed = unprocessed.trim().replace(/\s+/g, ' ');
    if (!localTrimmed) return '';
    const localAlias = LOCAL_ALIASES[localTrimmed];
    return localAlias ? localAlias : localTrimmed;
  }

  function localCompare(localOp, localLeft, localRight) {
    switch (localOp) {
      case '>': return localLeft > localRight;
      case '>=': return localLeft >= localRight;
      case '<': return localLeft < localRight;
      case '<=': return localLeft <= localRight;
      case '===': return localLeft === localRight;
      case '!==': return localLeft !== localRight;
      default: return false;
    }
  }

  function localCompile(localCondition) {
    const localNormalized = canonicalize(localCondition);

    if (memo.has(localNormalized)) return memo.get(localNormalized);

    /** @type {{ok:boolean, normalized:string, reason?:string, fn?:Function}} */
    let localCompiled;

    // Empty means "truthy" in our engines.
    if (!localNormalized) {
      localCompiled = { ok: true, normalized: 'truthy', fn: (entryValue) => !!entryValue };
      memo.set(localNormalized, localCompiled);
      return localCompiled;
    }

    // Exact matches first
    switch (localNormalized) {
      case 'exists':
      case '!== undefined':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue !== undefined };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case '=== undefined':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue === undefined };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case '!== null':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue !== null };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case '=== null':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue === null };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'truthy':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => !!entryValue };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'falsy':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => !entryValue };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'array':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => Array.isArray(entryValue) };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'empty array':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => Array.isArray(entryValue) && entryValue.length === 0 };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'non-empty array':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => Array.isArray(entryValue) && entryValue.length > 0 };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'has length':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue != null && typeof entryValue.length === 'number' };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'has keys':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue != null && typeof entryValue === 'object' && Object.keys(entryValue).length > 0 };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      case 'empty object':
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => entryValue != null && typeof entryValue === 'object' && Object.keys(entryValue).length === 0 };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      default:
        break;
    }

    // typeof <type>
    const typeofHit = /^typeof\s+([a-z]+)$/i.exec(localNormalized);
    if (typeofHit) {
      const localT = typeofHit[1].toLowerCase();
      if (localT === 'object') {
        localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => typeof entryValue === 'object' && entryValue !== null };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      }
      localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => typeof entryValue === localT };
      memo.set(localNormalized, localCompiled);
      return localCompiled;
    }

    // length <op> <number>
    const extentHit = /^length\s*(>=|<=|>|<|===|!==)\s*(-?\d+(?:\.\d+)?)$/i.exec(localNormalized);
    if (extentHit) {
      const localOp = extentHit[1];
      const localN = Number(extentHit[2]);
      if (!Number.isFinite(localN)) {
        localCompiled = { ok: false, normalized: localNormalized, reason: 'INVALID_NUMBER' };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      }
      localCompiled = {
        ok: true,
        normalized: localNormalized,
        fn: (entryValue) => entryValue != null && typeof entryValue.length === 'number' && localCompare(localOp, entryValue.length, localN)
      };
      memo.set(localNormalized, localCompiled);
      return localCompiled;
    }

    // boolean equality
    const boolEqHit = /^(===|!==)\s*(true|false)$/i.exec(localNormalized);
    if (boolEqHit) {
      const localOp2 = boolEqHit[1];
      const rightValue = boolEqHit[2].toLowerCase() === 'true';
      localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => localCompare(localOp2, entryValue, rightValue) };
      memo.set(localNormalized, localCompiled);
      return localCompiled;
    }

    // numeric comparisons: <op> <number>
    const numHit = /^(>=|<=|>|<|===|!==)\s*(-?\d+(?:\.\d+)?)$/i.exec(localNormalized);
    if (numHit) {
      const localOp3 = numHit[1];
      const localN2 = Number(numHit[2]);
      if (!Number.isFinite(localN2)) {
        localCompiled = { ok: false, normalized: localNormalized, reason: 'INVALID_NUMBER' };
        memo.set(localNormalized, localCompiled);
        return localCompiled;
      }
      localCompiled = { ok: true, normalized: localNormalized, fn: (entryValue) => typeof entryValue === 'number' && localCompare(localOp3, entryValue, localN2) };
      memo.set(localNormalized, localCompiled);
      return localCompiled;
    }

    localCompiled = { ok: false, normalized: localNormalized, reason: 'UNSUPPORTED_CONDITION' };
    memo.set(localNormalized, localCompiled);
    return localCompiled;
  }

  function localEvaluate(datum, localCondition) {
    const localCompiled = localCompile(localCondition);
    if (!localCompiled.ok || typeof localCompiled.fn !== 'function') return false;
    try {
      return !!localCompiled.fn(datum);
    } catch (failure) {
      return false;
    }
  }

  function resolvePresetGroups() {
    // Safe shallow copy; values are primitive strings.
    return LOCAL_PRESET_GROUPS.map((localG) => ({ label: localG.label, values: Array.from(localG.values) }));
  }

  function resolvePresetData() {
    const localOut = [];
    for (const localGroup of LOCAL_PRESET_GROUPS) {
      for (const datum of localGroup.values) localOut.push(datum);
    }
    return localOut;
  }

  function localDescribe() {
    return 'Supported: exists/truthy/falsy, typeof <type>, numeric comparisons (<op> N), length comparisons (length <op> N), arrays/objects helpers.';
  }

  scopeRoot.PropertyPredicateLanguage = Object.freeze({
    compile: localCompile,
    evaluate: localEvaluate,
    getPresetGroups: resolvePresetGroups,
    getPresetValues: resolvePresetData,
    describe: localDescribe
  });
})();
