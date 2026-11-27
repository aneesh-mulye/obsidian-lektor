// SPDX-FileCopyrightText: 2015 Vitaly Puzrin, Alex Kocharin
// SPDX-FileCopyrightText: Joyent, Inc. and other Node contributors
// SPDX-FileCopyrightText: 2026 Aneesh Mulye (changes, see below)
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

/**
 * `parse` from mdurl 2.1.0 (lib/parse.mjs), which markdown-it uses to tidy the links in a
 * model's reply. Lektor ships this copy instead of mdurl's own (THIRD_PARTY.md), with one
 * change: mdurl checks a host name label by label by splitting it on dots and joining the
 * pieces again, which the Community directory's scanner reports as runtime domain assembly
 * (the 0.1.2 review). Here the same check walks the labels by index. The result is the same for
 * every input (tests/obsidian/mdurl.property.test.ts compares it with mdurl's own); it is also
 * typed, `url.split('#').length === 1` is written `!url.includes('#')`, and the deprecated
 * `substr` calls are `slice` with the same arguments.
 */

export class Url {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  pathname: string | null = null;
}

const protocolPattern = /^([a-z0-9.+-]+:)/i;
const portPattern = /:[0-9]*$/;
// eslint-disable-next-line no-useless-escape -- copied as is from mdurl
const simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/;
const delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'];
const unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims);
const autoEscape = ["'"].concat(unwise);
const nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape);
const hostEndingChars = ['/', '?', '#'];
const hostnameMaxLen = 255;
const hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/;
const hostlessProtocol: Record<string, boolean> = { javascript: true, 'javascript:': true };
const slashedProtocol: Record<string, boolean> = {
  http: true,
  https: true,
  ftp: true,
  gopher: true,
  file: true,
  'http:': true,
  'https:': true,
  'ftp:': true,
  'gopher:': true,
  'file:': true,
};

/** mdurl's label test: up to 63 characters, each one of [+a-z0-9A-Z_-] or non-ASCII. */
function validLabel(part: string): boolean {
  if (part.length > 63) return false;
  for (let j = 0; j < part.length; j++) {
    const c = part.charCodeAt(j);
    if (c > 127) continue;
    if (!/[+a-z0-9A-Z_-]/.test(part[j]!)) return false;
  }
  return true;
}

function parseHost(u: Url, host: string): void {
  const port = portPattern.exec(host);
  if (port) {
    const p = port[0];
    if (p !== ':') u.port = p.slice(1);
    host = host.slice(0, host.length - p.length);
  }
  if (host) u.hostname = host;
}

export default function parse(url: string | Url, slashesDenoteHost?: boolean): Url {
  if (url instanceof Url) return url;
  const u = new Url();
  let lowerProto: string | undefined;
  let slashes = false;
  let rest = url.trim();

  if (!slashesDenoteHost && !url.includes('#')) {
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      u.pathname = simplePath[1]!;
      if (simplePath[2]) u.search = simplePath[2];
      return u;
    }
  }

  const protoMatch = protocolPattern.exec(rest);
  const proto = protoMatch ? protoMatch[0] : undefined;
  if (proto) {
    lowerProto = proto.toLowerCase();
    u.protocol = proto;
    rest = rest.slice(proto.length);
  }

  if (slashesDenoteHost || proto || /^\/\/[^@/]+@[^@/]+/.test(rest)) {
    slashes = rest.slice(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.slice(2);
      u.slashes = true;
    }
  }

  if (!(proto !== undefined && hostlessProtocol[proto]) && (slashes || (proto && !slashedProtocol[proto]))) {
    let hostEnd = -1;
    for (const c of hostEndingChars) {
      const hec = rest.indexOf(c);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) hostEnd = hec;
    }
    const atSign = hostEnd === -1 ? rest.lastIndexOf('@') : rest.lastIndexOf('@', hostEnd);
    if (atSign !== -1) {
      u.auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
    }
    hostEnd = -1;
    for (const c of nonHostChars) {
      const hec = rest.indexOf(c);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) hostEnd = hec;
    }
    if (hostEnd === -1) hostEnd = rest.length;
    if (rest[hostEnd - 1] === ':') hostEnd--;
    const host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    parseHost(u, host);
    u.hostname = u.hostname || '';
    const h = u.hostname;
    const ipv6Hostname = h.startsWith('[') && h.endsWith(']');

    if (!ipv6Hostname) {
      // mdurl splits h on dots and checks each label. At the first label that fails, the host is
      // the labels before it plus the label's valid start, and the remainder goes in front of the
      // path. Walking the labels by index gives the same substrings.
      for (let start = 0; start <= h.length; ) {
        let end = h.indexOf('.', start);
        if (end === -1) end = h.length;
        const part = h.slice(start, end);
        if (part && !validLabel(part)) {
          const bit = hostnamePartStart.exec(part);
          if (bit) {
            const cut = start + bit[1]!.length;
            rest = h.slice(cut) + rest;
            u.hostname = h.slice(0, cut);
          } else {
            // (.*) fails on U+2028/U+2029: mdurl then drops this label entirely.
            if (end < h.length) rest = h.slice(end + 1) + rest;
            u.hostname = h.slice(0, Math.max(0, start - 1));
          }
          break;
        }
        start = end + 1;
      }
    }

    if (u.hostname.length > hostnameMaxLen) u.hostname = '';
    if (ipv6Hostname) u.hostname = u.hostname.slice(1, u.hostname.length - 1);
  }

  const hash = rest.indexOf('#');
  if (hash !== -1) {
    u.hash = rest.slice(hash);
    rest = rest.slice(0, hash);
  }
  const qm = rest.indexOf('?');
  if (qm !== -1) {
    u.search = rest.slice(qm);
    rest = rest.slice(0, qm);
  }
  if (rest) u.pathname = rest;
  if (lowerProto && slashedProtocol[lowerProto] && u.hostname && !u.pathname) u.pathname = '';

  return u;
}
