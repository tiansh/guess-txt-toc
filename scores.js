/*!
 * @license MPL-2.0-no-copyleft-exception
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * This Source Code Form is "Incompatible With Secondary Licenses", as
 * defined by the Mozilla Public License, v. 2.0.
 */

// never try to detect a contents with more items
const MAX_CONTENTS_LENGTH = 2000;
// never try to generate a content with less items
const MIN_CONTENTS = 3;
// title with characters exceed following number considered invalid
const MAX_TITLE_LENGTH = 200;
// sensitivity to small TOC
const FACTOR_CONTENTS_SIZE = 4;
// sensitivity to outliner chapter size
const FACTOR_OUTLINER = 8;
// sensitivity to contents mixed with small and large ones
const FACTOR_VARIANCE_SIZE = 5;
// smaller value mark outliner more strict
const OUTLINER_DISTANCE = 3;
// setsitive to invalid TOC items
const FACTOR_TITLE_INVALID = 8;
// number of allowed duplicate TOC; =0 for disallow duplicate
const TOC_DUPLICATE_TOLERATE = 1;
// sensitive to max number in contents
const FACTOR_NUMBER_MAX = 5;
// sensitive to discontinue number in contents
const FACTOR_NUMBER_HOLES = 5;
// sensitive to decreasing number in contents
const FACTOR_NUMBER_INVALID = 5;
// sensitive to non-symbol prefix
const FACTOR_TEXT_PREFIX = 3;
// sensitive to uniqueness of prefix pattern
const KEYWORD_UNIQUE_FACTOR = 4;
// minimal beauty to pass stage 1
const BEAUTY_MIN_1 = 0.1;
// minimal ratio to detect prefix
const PREFIX_MIN_RATIO = 0.45;
// number of contents from stage 1 per type
const TEMPLATE_COUNT_1 = 10;
// minimal beauty to generate suggestion template
const BEAUTY_MIN_2 = 0.1;


/**
 * Ensure that chapter should have similar size
 * @param {{ title: string; cursor: number }[]} contents Size of each section of the book
 * @param {{ chars: number }} context The whole article
 * @returns number probability the selection is a chapter
 */
function contentsBeautyBySize(contents, { chars: totalChars }) {
  if (contents.length > MAX_CONTENTS_LENGTH) return 0;

  const starts = [0, ...contents.map(content => content.cursor + content.title.length)];
  const ends = [...contents.map(content => content.cursor), totalChars];
  const chapters = ends.map((end, i) => Math.max(end - starts[i], 0));
  if (OUTLINER_DISTANCE * Math.max(...chapters.slice(0, -1)) < chapters[chapters.length - 1]) chapters.pop();
  const length = chapters.length - 1;
  if (length < 3) return 0;

  const values = chapters.slice(1).sort((a, b) => a - b);
  const at = (/** @type {number} */n) => (n < 0 ? values[0] : n > values.length - 1 ? values[values.length - 1] :
    values[Math.floor(n)] * (1 - n % 1) + values[Math.ceil(n)] * (n % 1));
  const acc = values.reduce((a, x) => [...a, a[a.length - 1] + x], [0]);
  const sum = (first, last) => acc[last] - acc[first];
  const bound = (v, l = 0, h = length, m = Math.floor((l + h) / 2)) => l < h ? values[m] < v ? bound(v, m + 1, h) : bound(v, l, m) : l;

  const vLeft = at((length - 1) * 0.25), vRight = at((length - 1) * 0.75);
  let low = Math.max(Math.floor(vLeft / 2 ** OUTLINER_DISTANCE) - 1, 1), leftIndex = bound(low), left = at(leftIndex);
  let high = Math.ceil(vRight * 2 ** OUTLINER_DISTANCE) + 1, rightIndex = bound(high), right = at(rightIndex);
  let mid = Math.ceil((left + right) / 2), centerIndex = bound(mid), center = at(centerIndex);

  for (let iterate = 0; iterate < 10; iterate++) {
    if (center === left || center === right) break;
    const leftSum = sum(leftIndex, centerIndex), leftLen = centerIndex - leftIndex, leftMean = leftSum / leftLen;
    const rightSum = sum(centerIndex, rightIndex), rightLen = rightIndex - centerIndex, rightMean = rightSum / rightLen;
    const newMid = Math.ceil(leftMean + rightMean) / 2, newCenterIndex = bound(newMid);
    if (newCenterIndex === centerIndex) break;
    mid = newMid, centerIndex = newCenterIndex, center = at(centerIndex);
  }
  const rate = (first, last) => {
    if (first === last) return 0;
    const s = sum(first, last), n = last - first, m = s / n, c = bound(m);
    const l = (c - first) * m - sum(first, c), r = sum(c, last) - (last - c) * m;
    const t = (l + r) / s;
    return t ** 2;
  };
  const factors = [
    (1 / FACTOR_CONTENTS_SIZE) ** (1 / length),
    (1 / FACTOR_OUTLINER) ** (length / (rightIndex - leftIndex) - 1),
    (1 / FACTOR_OUTLINER) ** (totalChars / sum(leftIndex, rightIndex) - 1),
    (1 / FACTOR_VARIANCE_SIZE) ** rate(leftIndex, centerIndex),
    (1 / FACTOR_VARIANCE_SIZE) ** rate(centerIndex, rightIndex),
  ];
  return factors.reduce((x, y) => x * y, 1);
}

/**
 * Ensure that title of contents have proper length and not duplicate
 * @param {{ title: string; cursor: number }[]} contents
 * @returns {number}
 */
function contentsBeautyByTitle(contents) {
  const length = contents.length;
  if (length < MIN_CONTENTS) return 0;
  if (length > MAX_CONTENTS_LENGTH) return 0;
  const nameSet = new Map();
  const validSize = contents.filter(({ title }) => {
    if (title.length > MAX_TITLE_LENGTH) return false;
    const count = nameSet.has(title) ? nameSet.get(title) : 0;
    nameSet.set(title, count + 1);
    if (count > TOC_DUPLICATE_TOLERATE) return false;
    return true;
  }).length;
  const beauty = (1 / FACTOR_TITLE_INVALID) ** (length / validSize - 1) ** 0.5;
  return beauty;
}

const exactRegex = (/** @type {string} */str) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

/**
 * @param {object} config
 * @param {{ key: string; optional: string }} config.charset
 * @param {(key: string) => string} config.regex
 * @param {(str: string) => number} config.parser
 * @param {string} config.group
 * @param {number} config.priority
 */
const extractNumber = function ({ charset, regex, parser, group, priority }) {
  const matcher = new RegExp(regex(charset.key, charset.optional));
  return {
    extract: function (/** @type {string} */str) {
      const match = str.match(matcher);
      if (!match) return null;
      const prefix = str.slice(0, match.index);
      const infix = match[0];
      const number = parser(infix);
      const suffix = str.slice(match.index + infix.length);
      if (!Number.isFinite(number)) return null;
      return { prefix, infix, suffix, number };
    },
    charset,
    regex,
    group,
    priority,
  };
}

const hanMap = {
  '0': 0, '０': 0, 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000,
  零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9, 拾: 10, 貳: 2, 參: 3, 陸: 6, 佰: 100, 仟: 1000,
};

/**
 * @param {string} text
 * @returns number
 */
const parseHanNumber = function parse(text) {
  let result = 0, current = 0;
  for (const ch of text) {
    const val = hanMap[ch];
    if (val >= 10) {
      result += (current || 1) * val;
      current = 0;
    } else {
      current = current * 10 + val;
    }
  }
  return result + current;
};


const hanCharset1 = { key: '零〇一二三四五六七八九十百千', optional: '0０两兩' };
const hanCharset2 = { key: '零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟', optional: '' };
const hanCharset3 = { key: hanCharset1.key + hanCharset2.key, optional: hanCharset1.optional + hanCharset2.optional };

const parseHan1 = extractNumber({ charset: hanCharset1, regex: chars => `[${chars}]+`, parser: parseHanNumber, group: 'han', priority: 1 });
const parseHan2 = extractNumber({ charset: hanCharset2, regex: chars => `[${chars}]+`, parser: parseHanNumber, group: 'han', priority: 1 });
const parseHan3 = extractNumber({ charset: hanCharset3, regex: chars => `[${chars}]+`, parser: parseHanNumber, group: 'han', priority: 2 });


const romanMap = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
/**
 * @param {string} text
 * @returns number
 */
const parseRomanNumber = function (text) {
  const normalized = text.normalize('NFKC').toUpperCase();
  let num = 0, prevVal = 0, prevLen = 0;
  for (const part of normalized.match(/(.)\1*/g)) {
    const val = romanMap[part[0]] || 0, len = part.length;
    if (val > prevVal) num -= prevVal * prevLen * 2;
    num += val * len;
    [prevVal, prevLen] = [val, len];
  }
  return num;
};

const romanCharset1 = { key: 'IVXLCDM', optional: '' };
const romanCharset2 = { key: 'ivxlcdm', optional: '' };
const romanCharset3 = { key: romanCharset1.key + romanCharset2.key, optional: '' };
const romanCharset4 = { key: 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅬⅭⅮⅯⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻⅼⅽⅾⅿ', optional: '' };

const parseRoman1 = extractNumber({ charset: romanCharset1, regex: chars => `\\b[${chars}]+\\b`, parser: parseRomanNumber, group: 'roman', priority: 1 });
const parseRoman2 = extractNumber({ charset: romanCharset2, regex: chars => `\\b[${chars}]+\\b`, parser: parseRomanNumber, group: 'roman', priority: 1 });
const parseRoman3 = extractNumber({ charset: romanCharset3, regex: chars => `\\b[${chars}]+\\b`, parser: parseRomanNumber, group: 'roman', priority: 2 });
const parseRoman4 = extractNumber({ charset: romanCharset4, regex: chars => `[${chars}]+`, parser: parseRomanNumber, group: 'roman', priority: 1 });

/**
 * @param {string} text
 * @returns number
 */
const parseNumericNumber = function (text) {
  return Number.parseInt(text.normalize('NFKC'), 10);
}

const parseNumeric1 = extractNumber({ charset: { key: '0123456789', optional: '' }, regex: chars => `[${chars}]+`, parser: parseNumericNumber, group: 'numeric', priority: 1 });
const parseNumeric2 = extractNumber({ charset: { key: '０１２３４５６７８９', optional: '' }, regex: chars => `[${chars}]+`, parser: parseNumericNumber, group: 'numeric', priority: 1 });

const numberParserList = [
  parseHan1,
  parseHan2,
  parseHan3,
  parseRoman1,
  parseRoman2,
  parseRoman3,
  parseRoman4,
  parseNumeric1,
  parseNumeric2,
].map((p, index) => Object.assign({ index }, p));

const tokenRegex = /(?:\p{Script=Latn}+|\p{Script=Cyrl}+|\p{Script=Grek}+|\p{Script=Geor}+|\p{Script=Armn}+|\p{Script=Arab}+|\p{Script=Tibetan}+|\p{Number}+|.)/sg;

/**
 * @param {{ title: string; cursor: number; number: number }[]} contents Size of each section of the book
 * @returns {number}
 */
const contentsBeautyByNumber = function (contents) {
  const numbers = contents.map(x => x.number);
  const length = numbers.length;
  if (length < MIN_CONTENTS) return 0;
  const best = [];
  const prev = numbers.map((n, i) => {
    if (n === null) return;
    if (!best.length || numbers[best[best.length - 1]] <= n) {
      best.push(i);
      if (best.length === 1) return null;
      return best[best.length - 2];
    } else {
      let l = 0, h = best.length - 1, m;
      while (l < h) {
        m = Math.floor(l + h) / 2;
        if (numbers[best[m]] <= n) l = m + 1; else h = m;
      }
      best[l] = i;
      return l ? best[l - 1] : null;
    }
  });
  const seq = Array(best.length);
  for (let i = best.length - 1, n = best[i]; i >= 0; i--, n = prev[n]) seq[i] = numbers[n];
  const size = seq.length, max = seq[seq.length - 1], min = Math.min(seq[0], 1);
  if (!max) return 0;
  let holes = max - min + 1, seen = new Set();
  seq.forEach(n => !seen.has(n) && (seen.add(n), holes--));
  const factors = [
    (1 / FACTOR_NUMBER_MAX) ** (1 / max),
    (1 / FACTOR_NUMBER_INVALID) ** (length / size - 1),
    (1 / FACTOR_NUMBER_HOLES) ** (max / (max - holes) - 1),
  ];
  if (factors.some(x => !(x >= 0))) process.exit(-1);
  return factors.reduce((x, y) => x * y);
}

/** @type {({ pattern: string; key: string; priority: number; beauty: number } & ({ type: 'number'; parser: typeof numberParserList[number] } | { type: 'prefix', prefixBeauty: number }))[]} */
const patterns = [];

/**
 * 
 * @param {string} article
 * @param {{ chars: number; tokenCounts: Map<string, number>; lines: { line: string; tokens: string[]; numbers: number[] }[] }} articleContext
 */
const recognizeContents = function (article, articleContext = {}) {
  Object.assign(articleContext, {
    chars: 0,
    tokenCounts: new Map(),
    lines: [],
  });
  /** @typedef {ReturnType<typeof numberParserList[number]['extract']> & { cursor: number; title: string }} NumberMatchItem */
  /** @type {Map<string, NumberMatchItem>[]>[]} */
  const numberMatching = numberParserList.map(_ => new Map());
  /** @type {Map<string, { cursor: number; title: string; context: { line: string; tokens: RegExpMatchArray | null; numbers: number[]; } }[]>} */
  const prefixMatching = new Map();
  let cursor = 0;
  const lines = article.split('\n');
  lines.forEach(line => {
    const tokens = line.trim().match(tokenRegex), firstToken = tokens && tokens[0];
    const lineContext = { line, tokens, numbers: [] };
    articleContext.lines.push(lineContext);
    if (tokens?.length) {
      [...new Set(tokens)].forEach(token => {
        articleContext.tokenCounts.set(token, (articleContext.tokenCounts.get(token) ?? 0) + 1);
      });
      if (firstToken) {
        if (!prefixMatching.has(firstToken)) prefixMatching.set(firstToken, []);
        prefixMatching.get(firstToken).push({ title: line, cursor, context: lineContext });
      }
    }
    if (line.length < MAX_TITLE_LENGTH) {
      numberParserList.forEach((parser, index) => {
        const matched = parser.extract(line);
        if (matched) {
          lineContext.numbers.push(matched.number);
          const context = numberMatching[index];
          const prefix = matched.prefix.trimStart();
          if (!context.has(prefix)) context.set(prefix, []);
          context.get(prefix).push({ ...matched, cursor, title: line });
        } else {
          lineContext.numbers.push(null);
        }
      });
    }
    cursor += line.length + 1;
  });
  articleContext.chars = cursor;
  /**
   * 
   * @param {typeof numberParserList[number]} parser
   * @param {{ prefix: string; suffix: string }} pattern
   * @param {NumberMatchItem[]} matches
   */
  const commitNumberPattern = function (parser, { prefix, suffix }, matches) {
    const beauty1 = contentsBeautyByNumber(matches);
    if (beauty1 < BEAUTY_MIN_1) return;
    const beauty2 = contentsBeautyBySize(matches, articleContext) * contentsBeautyByTitle(matches);
    if (beauty1 * beauty2 < BEAUTY_MIN_1) return;
    let lcp = '', lcps = 0;
    while (matches.every(m => m.suffix[lcps] && m.suffix[lcps] === matches[0].suffix[lcps])) lcp += matches[0].suffix[lcps++];
    const key = JSON.stringify([parser.index, prefix, lcp]);
    const infixCollection = matches.map(m => m.infix), infixSet = new Set(infixCollection.join(''));
    const charset = parser.charset.key + parser.charset.optional.replace(/./g, ch => infixSet.has(ch) ? ch : '');
    const pattern = !['/', '*'].some(ch => (prefix + suffix).includes(ch)) ?
      `${prefix}*${lcp}`.replace(/\s+/g, ' ') : `/${exactRegex(prefix)}.*${exactRegex(lcp)}/u`;
    patterns.push({ pattern, key, priority: parser.priority * 10, type: 'number', parser, beauty: beauty1 * beauty2 });
    const charsetPattern = ([...new Set(charset)].sort()
      .map(ch => ch.charCodeAt())
      .map((ch, i, chs) => ch - 1 === chs[i - 1] && ch + 1 === chs[i + 1] ? null : ch)
      .reduce((p, ch, i, chs) => p + (ch == null ? chs[i - 1] != null ? '-' : '' : exactRegex(String.fromCharCode(ch))), ''))
    const regexPattern = `/^\\s*${exactRegex(prefix)}[${charsetPattern}]+${exactRegex(lcp)}/`;
    patterns.push({ pattern: regexPattern, key, priority: parser.priority * 10 + 1, type: 'number', parser, beauty: beauty1 * beauty2 });
  };

  numberMatching.forEach((byPrefix, patternIndex) => {
    const parser = numberParserList[patternIndex];
    [...byPrefix.entries()].forEach(([prefix, matches]) => {
      if (matches.length < 3) return;
      commitNumberPattern(parser, { prefix, suffix: '' }, matches);
      /** @type {Map<string, typeof group>} */
      const bySuffix = new Map();
      matches.forEach(match => {
        const tokens = match.suffix.match(tokenRegex);
        if (!tokens || !tokens.length) return;
        let suffix = '';
        tokens.forEach(token => {
          suffix += token;
          if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
          bySuffix.get(suffix).push(match);
        });
      });
      [...bySuffix.entries()].forEach(([suffix, matches]) => {
        if (matches.length < MIN_CONTENTS) return;
        commitNumberPattern(parser, { prefix, suffix }, matches);
      });
    });
  });
  [...prefixMatching.entries()].forEach(([prefix, matches]) => {
    if (matches.length > MAX_CONTENTS_LENGTH / PREFIX_MIN_RATIO) return;
    const totalLines = articleContext.tokenCounts.get(prefix) * FACTOR_TEXT_PREFIX ** /\p{L}/u.test(prefix[0]);
    const matchLines = matches.length;
    if (matchLines < MIN_CONTENTS) return;
    if (matchLines / totalLines < PREFIX_MIN_RATIO) return;
    ; (function findPrefix(prefixTokens, lines) {
      const countNext = new Map(), n = prefixTokens.length;
      lines.forEach(line => {
        if (line.tokens.length >= n) {
          const next = line.tokens[n];
          if (!next) return;
          if (!countNext.has(next)) countNext.set(next, []);
          else countNext.get(next).push(line);
        }
      });
      let extendPrefix = false;
      [...countNext.entries()].forEach(([next, newMatches]) => {
        if (newMatches.length < MIN_CONTENTS) return;
        if (newMatches.length / totalLines < PREFIX_MIN_RATIO) return;
        extendPrefix = newMatches === lines;
        findPrefix([...prefixTokens, next], newMatches);
      });
      if (extendPrefix) return;
      const suffixList = lines.map(line => line.tokens.slice(prefixTokens.length + 1));
      /** @type {Map<string, string[]>} */
      const tokenCount = new Map();
      suffixList.forEach(suffix => {
        let seen = new Set();
        suffix.forEach((token, index) => {
          if (seen.has(token)) return;
          seen.add(token);
          if (!tokenCount.has(token)) tokenCount.set(token, []);
          tokenCount.get(token).push(suffix.slice(index + 1));
        });
      });
      [...tokenCount.entries()].forEach(([token, sublines]) => {
        if (sublines.length < MIN_CONTENTS) return;
        if (sublines.length / totalLines < PREFIX_MIN_RATIO) return;
        let lcp = '', lcps = 0;
        while (sublines.every(tokens => tokens[lcps] && tokens[lcps] === sublines[0][lcps])) lcp += sublines[0][lcps++];
        const prefix = prefixTokens.join(''), suffix = token + lcp;
        const selected = matches.filter(match => match.title.includes(suffix));
        if (selected.length < sublines.length) {
          process.exit(-1);
        }
        const beauty1 = (sublines.length / totalLines) ** (KEYWORD_UNIQUE_FACTOR / 10);
        const beauty2 = contentsBeautyByTitle(selected) * contentsBeautyBySize(selected, articleContext);
        if (beauty1 * beauty2 < BEAUTY_MIN_1) return;
        const pattern = !['/', '*'].some(ch => (prefix + suffix).includes(ch)) ?
          `${prefix}*${suffix}` : `/^\s*${exactRegex(prefix)}.*${exactRegex(suffix)}/u`;
        const key = JSON.stringify([null, prefix, suffix]);
        patterns.push({ pattern, key, priority: 10, type: 'prefix', beauty: beauty1 * beauty2, prefixBeauty: beauty1 });
      });
    }([prefix], matches.map(match => ({ match, tokens: match.context.tokens }))));
  });
  const seen = new Set(), dedupe = patterns.filter(pattern => seen.has(pattern.pattern) ? false : seen.add(pattern.pattern));
  const numberPatterns = dedupe.filter(p => p.type === 'number').sort((x, y) => y.beauty - x.beauty).slice(0, TEMPLATE_COUNT_1);
  const prefixPatterns = dedupe.filter(p => p.type === 'prefix').sort((x, y) => y.beauty - x.beauty).slice(0, TEMPLATE_COUNT_1);
  const chosenPatterns = [...numberPatterns, ...prefixPatterns];
  const regexen = chosenPatterns.map(x => parseContentTemplate(x.pattern));
  const contents = regexen.map(x => []);
  cursor = 0;
  article.split('\n').forEach(line => {
    if (line.length <= MAX_TITLE_LENGTH) {
      regexen.forEach((matchReg, index) => {
        if (matchReg.test(line)) {
          contents[index].push({
            title: line.trim(),
            cursor,
          });
        }
      });
    }
    cursor += line.length + 1;
  });
  const contentsWithBeauty = contents.map((content, index) => {
    const pattern = chosenPatterns[index];
    const beauty1 = contentsBeautyBySize(content, articleContext) * contentsBeautyByTitle(content);
    const beauty2 = pattern.type === 'number' ? contentsBeautyByNumber(content.map(line => ({ number: pattern.parser.extract(line.title)?.number }))) : pattern.prefixBeauty;
    return { content, beauty: beauty1 * beauty2, priority: pattern.priority, pattern };
  });
  contentsWithBeauty.sort((a, b) => b.beauty - a.beauty || a.priority - b.priority);
  const best = contentsWithBeauty[0];
  if (!best || best.beauty < BEAUTY_MIN_2) return null;
  return { content: best.content, template: best.pattern.pattern, beauty: best.beauty }
}


/**
 * @param {string} text
 * @returns {RegExp}
 */
const useRegExpForContent = function (template) {
  if (/\/.*\/[a-zA-Z]*/.test(template)) {
    const [_, reg, flags] = template.match(/\/(.*)\/(.*)/);
    try {
      return new RegExp(reg, flags);
    } catch (e) {
      return null;
    }
  }
  return null;
};

/**
 * @param {string} template
 * @returns {RegExp}
 */
const parseContentTemplate = function (template) {
  const matchReg = useRegExpForContent(template);
  if (matchReg) return matchReg;
  const escape = template.replace(/./g, c => {
    if (c === ' ') return '\\s+';
    if (c === '*') return '.*';
    if (c === '?') return '.';
    return c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g,
      c => `\\u${c.charCodeAt().toString(16).padStart(4, 0)}`);
  });
  return new RegExp(`^\\s*(?:${escape})`, 'u');
}

/**
 * @param {string} article
 * @param {string} template
 * @param {{ maxLength: number, limit: number }} details
 */
const generateContent = function (article, template, { maxLength, limit }) {
  const matchReg = parseContentTemplate(template);
  /** @type {{ title: string, cursor: number }[]} */
  const content = [];
  let cursor = 0;
  const limitExceed = article.split('\n').some(line => {
    if (line.length <= maxLength) {
      if (matchReg.test(line)) {
        if (content.length > limit) {
          return true;
        }
        content.push({
          title: line.trim(),
          cursor,
        });
      }
    }
    cursor += line.length + 1;
    return false;
  });
  if (limitExceed) return null;
  return content;
};


const filename = process.argv[2];
const article = require('fs').readFileSync(filename, 'utf8').replace(/\r\n|\r/g, '\n');
const start = performance.now();
console.profile();
console.log(recognizeContents(article))
console.profileEnd();
const end = performance.now();
console.log(end - start);

