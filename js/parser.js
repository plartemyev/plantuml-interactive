// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Tolerant parser for the PlantUML *deployment diagram* subset.
//
// Converts raw .puml text into a structured model:
//   {
//     name, title,
//     elements: Map<id, Element>,   // insertion-ordered, includes ports
//     rootOrder: [id, ...],         // top-level declaration order
//     relations: [Relation, ...],
//     notes: [Note, ...],
//     warnings: [{ line, message }, ...],
//   }
//
// Design rules:
// - never throws on user input; problems become warnings and the line is skipped
// - 'together' blocks are transparent: children are hoisted into the parent
// - references to undeclared aliases auto-create elements (PlantUML behaviour,
//   which renders them as actors); a warning is emitted
// - labels are stored with real newlines ('\n' escapes and quoted multi-line
//   strings are both decoded)

const KINDS = new Set([
  'actor', 'agent', 'artifact', 'boundary', 'card', 'cloud', 'component',
  'control', 'database', 'entity', 'file', 'folder', 'frame', 'hexagon',
  'interface', 'label', 'node', 'package', 'person', 'port', 'portin',
  'portout', 'queue', 'rectangle', 'stack', 'storage', 'usecase',
]);

const PORT_KINDS = new Set(['port', 'portin', 'portout']);

// PlantUML renders references to never-declared aliases as actors.
const AUTO_KIND = 'actor';

const IGNORED_RE = new RegExp(
  '^(?:skinparam|!pragma|!theme|!include|!includeurl|!log|hide\\s|show\\s|' +
  'scale\\s|set\\s|left to right direction|top to bottom direction|' +
  'autonumber|center\\s|footer\\b|header\\b|rotate|skip\\b|nolayout|allowmixing)',
);

function warn(state, line, message) {
  state.warnings.push({ line: line + 1, message });
}

function decodeEscapes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const c = s[i + 1];
      if (c === 'n') { out += '\n'; i++; continue; }
      if (c === '"' || c === "'" || c === '\\') { out += c; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

function countUnescapedQuotes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== '\\') n++;
  }
  return n;
}

// Replace /' ... '/ block comments with blank lines, keeping line numbers stable.
function stripBlockComments(lines) {
  const out = new Array(lines.length);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let rest = lines[i];
    let keep = '';
    if (inBlock) {
      const end = rest.indexOf("'/");
      if (end === -1) { out[i] = ''; continue; }
      rest = rest.slice(end + 2);
      inBlock = false;
    }
    for (let guard = 0; guard < 64; guard++) {
      const start = rest.indexOf("/'");
      if (start === -1) { keep += rest; break; }
      keep += rest.slice(0, start);
      const end = rest.indexOf("'/", start + 2);
      if (end === -1) { inBlock = true; break; }
      rest = rest.slice(end + 2);
    }
    out[i] = keep;
  }
  return out;
}

// A quoted label may span physical lines; join until quotes balance.
function readLogical(lines, i) {
  let text = lines[i];
  let j = i + 1;
  for (let guard = 0; guard < 200 && j < lines.length; guard++) {
    if (countUnescapedQuotes(text) % 2 === 0) break;
    text += ' ' + lines[j++];
  }
  return { text, next: j };
}

function parseElementDecl(text) {
  const m = /^([A-Za-z_]\w*)\s+(.*)$/s.exec(text.trim());
  if (!m) return null;
  const kind = m[1];
  let rest = m[2].trim();
  if (kind === 'together') {
    if (!(rest === '' || rest === '{')) return null;
    return { kind, label: null, alias: null, stereotype: null, block: true };
  }
  if (!KINDS.has(kind)) return null;
  let block = false;
  if (rest.endsWith('{')) { block = true; rest = rest.slice(0, -1).trim(); }
  let label = null;
  let alias = null;
  let stereotype = null;
  const qm = /^"((?:[^"\\]|\\.)*)"\s*(.*)$/s.exec(rest);
  if (qm) { label = decodeEscapes(qm[1]); rest = qm[2].trim(); }
  for (let guard = 0; guard < 8; guard++) {
    const sm = /^<<([^>]*)>>\s*/.exec(rest);
    if (!sm) break;
    stereotype = stereotype ? stereotype + ', ' + sm[1].trim() : sm[1].trim();
    rest = rest.slice(sm[0].length).trim();
  }
  const am = /^as\s+([\w.]+)\s*(.*)$/i.exec(rest);
  if (am) { alias = am[1]; rest = am[2].trim(); } else if (!label) {
    const bm = /^([\w.]+)\s*(.*)$/.exec(rest);
    if (bm) { alias = bm[1]; rest = bm[2].trim(); }
  }
  return { kind, label, alias, stereotype, block };
}

// Scans the arrow between "from" and "to", supporting -->, ..>, --, ..,
// direction hints (-up->) and bracket annotations (-[hidden]->).
function parseRelationRest(rest) {
  let j = 0;
  let bidir = false;
  let sawDash = false;
  let sawDot = false;
  let dir = null;
  let arrow = false;
  let annot = null;
  const consume = () => {
    while (j < rest.length && (rest[j] === '-' || rest[j] === '.')) {
      if (rest[j] === '.') sawDot = true; else sawDash = true;
      j++;
    }
  };
  while (j < rest.length && /\s/.test(rest[j])) j++;
  if (rest[j] === '<') { bidir = true; j++; }
  consume();
  if (rest[j] === '[') {
    const e = rest.indexOf(']', j);
    if (e === -1) return null;
    annot = rest.slice(j + 1, e);
    j = e + 1;
    consume();
  }
  for (const d of ['down', 'left', 'right', 'up']) {
    if (rest.startsWith(d, j)) { dir = d; j += d.length; break; }
  }
  consume();
  if (j < rest.length && rest[j] === '>') { arrow = true; j++; }
  if (!sawDash && !sawDot) return null;
  while (j < rest.length && /\s/.test(rest[j])) j++;
  let to = null;
  const qtm = /^"((?:[^"\\]|\\.)*)"\s*/.exec(rest.slice(j));
  if (qtm) {
    to = '"' + decodeEscapes(qtm[1]) + '"'; // quoted label reference
    j += qtm[0].length;
  } else {
    const tm = /^([\w.]+)\s*/.exec(rest.slice(j));
    if (!tm) return null;
    to = tm[1];
    j += tm[0].length;
  }
  let label = null;
  const tail = rest.slice(j).trim();
  if (tail.startsWith(':')) {
    label = decodeEscapes(tail.slice(1).trim());
  } else if (tail !== '') {
    return null;
  }
  return {
    to, label, dir, arrow, bidir, dotted: sawDot,
    hidden: annot !== null && /hidden/.test(annot),
    color: (annot && /#([#%&*+\-./:\w]+)/.exec(annot) || [null, null])[1] || null,
  };
}

function parseNoteHeader(text) {
  const inline = /^note\s+(?:(left|right|top|bottom)\s+of\s+([\w.]+)|as\s+([\w.]+))\s*:\s*(.*)$/.exec(text);
  if (inline) {
    return {
      side: inline[1] || null, target: inline[2] || null, alias: inline[3] || null,
      text: decodeEscapes(inline[4]), block: false,
    };
  }
  if (/^note\s*:\s*.+$/.test(text)) {
    return { side: null, target: null, alias: null, text: decodeEscapes(text.replace(/^note\s*:\s*/, '')), block: false };
  }
  const block = /^note\s+(?:(left|right|top|bottom)\s+of\s+([\w.]+)|as\s+([\w.]+))\s*$/.exec(text);
  if (block) {
    return { side: block[1] || null, target: block[2] || null, alias: block[3] || null, text: null, block: true };
  }
  if (/^note\s*$/.test(text)) {
    return { side: null, target: null, alias: null, text: null, block: true };
  }
  return null;
}

export function parsePlantUml(text) {
  const rawLines = stripBlockComments(String(text ?? '').split(/\r?\n/));
  const state = {
    name: '', title: '', warnings: [],
  };
  const elements = new Map();
  const labelIndex = new Map();
  const rootOrder = [];
  const relations = [];
  const notes = [];
  const stack = []; // { id: string|null, transparent: bool }
  let anonSeq = 0;

  const parentId = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!stack[i].transparent) return stack[i].id;
    }
    return null;
  };

  const addElement = (decl, line) => {
    let id = decl.alias;
    if (id && elements.has(id)) {
      warn(state, line, `duplicate alias "${id}" — generating a unique one`);
      id = null;
    }
    if (!id) id = `#anon${++anonSeq}`;
    const el = {
      id, kind: decl.kind,
      label: decl.label ?? (decl.alias ?? null),
      stereotype: decl.stereotype ?? null,
      parent: parentId(),
      children: [], ports: [], portIndex: -1,
    };
    elements.set(id, el);
    if (PORT_KINDS.has(el.kind)) {
      el.kind = 'port';
      const p = elements.get(el.parent);
      if (p) { el.portIndex = p.ports.length; p.ports.push(id); } else {
        warn(state, line, `port "${id}" declared outside any element — ignored`);
      }
    } else if (el.parent && elements.has(el.parent)) {
      elements.get(el.parent).children.push(id);
    } else {
      rootOrder.push(id);
    }
    if (el.label && decl.kind !== 'port' && !labelIndex.has(el.label)) {
      labelIndex.set(el.label, id);
    }
    return id;
  };

  const resolveEndpoint = (name, line) => {
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    if (elements.has(name)) {
      const el = elements.get(name);
      if (el.kind === 'port') {
        return { id: el.parent, viaPort: name };
      }
      return { id: name, viaPort: null };
    }
    if (labelIndex.has(name)) return { id: labelIndex.get(name), viaPort: null };
    warn(state, line, `unknown reference "${name}" — auto-created as ${AUTO_KIND}`);
    const id = addElement({ kind: AUTO_KIND, label: name, alias: name, stereotype: null, block: false }, line);
    return { id, viaPort: null };
  };

  let i = 0;
  while (i < rawLines.length) {
    const lineNo = i;
    const trimmed = rawLines[i].trim();
    if (trimmed === '' || trimmed.startsWith("'")) { i++; continue; }

    if (trimmed.startsWith('@startuml')) {
      state.name = decodeEscapes(trimmed.replace(/^@startuml\s*/, '').trim()) || state.name;
      i++;
      continue;
    }
    if (trimmed.startsWith('@enduml')) { i++; continue; }

    if (/^title\b/.test(trimmed) || trimmed === 'title:') {
      const rest = trimmed.replace(/^title:?\s*/, '');
      if (rest !== '') {
        state.title = decodeEscapes(rest);
        i++;
      } else {
        const body = [];
        i++;
        while (i < rawLines.length && rawLines[i].trim() !== 'end title') {
          body.push(rawLines[i].trim());
          i++;
        }
        i++; // skip 'end title'
        state.title = body.join('\n');
      }
      continue;
    }
    if (/^legend\b/.test(trimmed)) {
      while (i < rawLines.length && rawLines[i].trim() !== 'end legend') i++;
      i++;
      continue;
    }
    if (IGNORED_RE.test(trimmed)) { i++; continue; }

    if (trimmed === '}') {
      stack.pop();
      i++;
      continue;
    }

    if (trimmed.startsWith('note')) {
      const head = parseNoteHeader(trimmed);
      if (!head) {
        warn(state, lineNo, `unrecognized note: "${trimmed}"`);
        i++;
        continue;
      }
      let body = head.text;
      if (head.block) {
        const lines = [];
        i++;
        while (i < rawLines.length && !/^(end\s*note|endnote)$/.test(rawLines[i].trim())) {
          lines.push(rawLines[i].trim());
          i++;
        }
        i++; // skip 'end note'
        body = lines.join('\n');
      } else {
        i++;
      }
      notes.push({ target: head.target, alias: head.alias, side: head.side, text: body, line: lineNo });
      continue;
    }

    const logical = readLogical(rawLines, i);

    const decl = parseElementDecl(logical.text);
    if (decl) {
      let block = decl.block;
      if (!block) {
        const peek = (rawLines[logical.next] || '').trim();
        if (peek === '{') { block = true; logical.next++; }
      }
      if (decl.kind === 'together') {
        stack.push({ id: null, transparent: true });
      } else {
        const newId = addElement(decl, lineNo);
        if (block) stack.push({ id: newId, transparent: false });
      }
      i = logical.next;
      continue;
    }

    const relHead = /^("[^"]*"|[\w.]+)\s*(.*)$/s.exec(logical.text.trim());
    if (relHead) {
      const fromName = relHead[1].startsWith('"')
        ? relHead[1].slice(1, -1)
        : relHead[1];
      const rel = parseRelationRest(relHead[2]);
      if (rel) {
        relations.push({
          from: fromName, to: rel.to, label: rel.label, dir: rel.dir,
          arrow: rel.arrow, bidir: rel.bidir, dotted: rel.dotted,
          hidden: rel.hidden, color: rel.color, line: lineNo,
        });
        i = logical.next;
        continue;
      }
    }

    warn(state, lineNo, `unrecognized line skipped: "${trimmed.slice(0, 60)}"`);
    i = logical.next;
  }

  // Resolve relation endpoints (auto-creating missing elements like PlantUML).
  for (const r of relations) {
    const a = resolveEndpoint(r.from, r.line);
    const b = resolveEndpoint(r.to, r.line);
    r.fromId = a.id;
    r.fromPort = a.viaPort;
    r.toId = b.id;
    r.toPort = b.viaPort;
    r.self = a.id === b.id && !a.viaPort && !b.viaPort;
  }

  // Notes referencing aliases: attach to the other endpoint of their first relation.
  for (const n of notes) {
    if (n.alias) {
      n.target = null;
      for (const r of relations) {
        if (r.from === n.alias && !r.self) { n.target = r.toId; break; }
        if (r.to === n.alias && !r.self) { n.target = r.fromId; break; }
      }
    } else if (n.target) {
      const res = resolveEndpoint(n.target, n.line);
      n.target = res.id;
    }
  }

  return {
    name: state.name,
    title: state.title,
    elements,
    rootOrder,
    relations,
    notes,
    warnings: state.warnings,
  };
}
