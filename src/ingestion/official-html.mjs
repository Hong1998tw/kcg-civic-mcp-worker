// Small non-executing HTML reader. It only reads captured official bytes; scripts
// and styles never participate in text or link extraction.
export function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", ndash: "–", mdash: "—", hellip: "…", bull: "•", copy: "©", reg: "®" };
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? all;
    const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�";
  });
}

export function htmlTree(html) {
  const root = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const tokens = String(html).replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "").match(/<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith("</")) {
      const tag = /^<\/\s*([\w:-]+)/.exec(token)?.[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
    } else if (/^<[a-z]/i.test(token)) {
      const tag = /^<([\w:-]+)/.exec(token)[1].toLowerCase();
      const attrs = {};
      for (const match of token.slice(tag.length + 1, -1).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
      const node = { tag, attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!voids.has(tag) && !token.endsWith("/>")) stack.push(node);
    } else if (!token.startsWith("<")) stack.at(-1).children.push(decodeEntities(token));
  }
  return root;
}

export function allNodes(node, predicate) {
  if (!node || typeof node === "string") return [];
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => allNodes(child, predicate))];
}
export function byId(node, id) { return allNodes(node, (item) => item.attrs.id === id)[0]; }
export function byClass(node, name) { return allNodes(node, (item) => (item.attrs.class || "").split(/\s+/).includes(name)); }
export function nodeText(node) {
  if (typeof node === "string") return node;
  if (!node) return "";
  const boundary = /^(br|p|div|tr|li|h[1-6]|pre|strong)$/.test(node.tag) ? "\n" : "";
  return boundary + node.children.map(nodeText).join("") + boundary;
}
export function cleanText(node) { return nodeText(node).replace(/[\t\r \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }
