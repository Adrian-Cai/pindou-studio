'use strict';

/**
 * 本地安全实现，替代已停止维护且存在原型污染漏洞的 lodash.set@4.3.2
 * （CVE-2020-8203，lodash <4.17.19）。
 *
 * 行为对齐 lodash 4.17.21 的 _.set：字符串路径按 . 与 [] 拆分，
 * 数组路径原样使用；路径中出现 __proto__ / constructor / prototype 时直接放弃写入。
 *
 * 该文件为自研代码，参考 lodash 4.17.21（MIT License）的 _.set 语义实现。
 */

var INFINITY = 1 / 0;
var MAX_MEMOIZE_SIZE = 500;

/** 匹配路径中的属性名、[n]、["x"] 与空段。 */
var rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;
var reEscapeChar = /\\(\\)?/g;
var reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/;
var reIsPlainProp = /^\w*$/;
var reIsUint = /^(?:0|[1-9]\d*)$/;
var reIsSymbol = /^\[object Symbol\]$/;

var pathCache = new Map();

function isObject(value) {
  var type = typeof value;
  return value != null && (type === 'object' || type === 'function');
}

function isSymbol(value) {
  return typeof value === 'symbol' ||
    (isObject(value) && Object.prototype.toString.call(value) === '[object Symbol]');
}

function isIndex(value, length) {
  var type = typeof value;
  length = length == null ? Number.MAX_SAFE_INTEGER : length;
  return !!length &&
    (type === 'number' || (type !== 'symbol' && reIsUint.test(value))) &&
    (value > -1 && value % 1 === 0 && value < length);
}

function toKey(value) {
  if (typeof value === 'string' || isSymbol(value)) {
    return value;
  }
  var result = value + '';
  return (result === '0' && (1 / value) === -INFINITY) ? '-0' : result;
}

function stringToPath(string) {
  var cached = pathCache.get(string);
  if (cached !== undefined) {
    return cached;
  }
  var result = [];
  if (string.charCodeAt(0) === 46 /* . */) {
    result.push('');
  }
  string.replace(rePropName, function (match, number, quote, subString) {
    result.push(quote ? subString.replace(reEscapeChar, '$1') : (number || match));
  });
  if (pathCache.size === MAX_MEMOIZE_SIZE) {
    pathCache.clear();
  }
  pathCache.set(string, result);
  return result;
}

function isKey(value, object) {
  if (Array.isArray(value)) {
    return false;
  }
  var type = typeof value;
  if (type === 'number' || type === 'symbol' || type === 'boolean' ||
      value == null || isSymbol(value)) {
    return true;
  }
  return reIsPlainProp.test(value) || !reIsDeepProp.test(value) ||
    (object != null && value in Object(object));
}

function castPath(value, object) {
  if (Array.isArray(value)) {
    return value;
  }
  return isKey(value, object) ? [value] : stringToPath(String(value));
}

function assignValue(object, key, value) {
  var objValue = object[key];
  if (!(Object.prototype.hasOwnProperty.call(object, key) &&
        (objValue === value || (objValue !== objValue && value !== value)))) {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      value: value,
      writable: true
    });
  }
}

module.exports = function set(object, path, value) {
  if (object == null) {
    return object;
  }
  if (!isObject(object)) {
    return object;
  }
  var keys = castPath(path, object);
  var index = -1;
  var length = keys.length;
  var lastIndex = length - 1;
  var nested = object;

  while (nested != null && ++index < length) {
    var key = toKey(keys[index]);

    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return object;
    }

    var newValue = value;
    if (index !== lastIndex) {
      var objValue = nested[key];
      newValue = isObject(objValue) ? objValue : (isIndex(keys[index + 1]) ? [] : {});
    }
    assignValue(nested, key, newValue);
    nested = nested[key];
  }
  return object;
};
