// A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
//
// The reference reads one character at a time and builds every field a
// character at a time. This module answers exactly as it does, but scans
// with indexOf jumps instead of a per-character loop:
//
//   - An unquoted field ends at the nearest comma or line break, found
//     with two indexOf calls, and is sliced out in one piece; a stray CR
//     inside the slice is the only thing that falls back to a scanning
//     loop, and stray CRs are rare.
//   - A quoted field's closing quote is found with indexOf; doubled
//     quotes are spliced out of the slices. Newlines inside quotes are
//     counted and normalised only when the span actually holds one.
//   - A quote that never closes falls back to the reference's own rule:
//     the quote is literal and the rest is re-read as unquoted.
//
// Every error is recorded at exactly the point the reference records it,
// so the errors array comes out in the same order with the same line and
// row on each entry. Pure: nothing is kept from one call to the next.

/** How a field ended: at the end of the text, at a comma, at a line break. */
const END = 0;
const COMMA = 1;
const BREAK = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1; // a leading BOM is dropped

  // The record being read: the line it starts on, and the index in rows it
  // takes (null while the header is still to come).
  let recordLine = 1;
  let recordRow = null;

  // The field just scanned: its value, how it ended, and how many
  // characters the scan appended (a quoted field's junk counts here).
  let fv = '';
  let fe = END;
  let fa = 0;

  // Scans an unquoted field from p onto `base`: up to the next comma or
  // line break, dropping a CR that is not followed by LF (stray_cr).
  // Sets fv, fe, fa and pos.
  //
  // Fast path: the field runs to the next comma or line break, and the
  // slice between holds no stray CR — checked on the short slice itself,
  // so a CR far away in the file is never hunted for. A field that does
  // hold a stray CR falls back to the scanning loop below.
  function scanUnquoted(p, base) {
    const comma = text.indexOf(',', p);
    const lf = text.indexOf('\n', p);
    let end = -1;
    let isBreak = false;
    if (comma !== -1 && (lf === -1 || comma < lf)) {
      end = comma;
    } else if (lf !== -1) {
      end = lf;
      isBreak = true;
    }
    if (end === -1) {
      // To the end of the text.
      const seg = text.slice(p);
      if (seg.indexOf('\r') === -1) {
        pos = n;
        fv = base === '' ? seg : base + seg;
        fe = END;
        fa = seg.length;
        return;
      }
      scanUnquotedSlow(p, base);
      return;
    }
    const seg = text.slice(p, end);
    const r = seg.indexOf('\r');
    if (r === -1) {
      if (isBreak) {
        line += 1;
        fe = BREAK;
      } else {
        fe = COMMA;
      }
      pos = end + 1;
      fv = base === '' ? seg : base + seg;
      fa = seg.length;
      return;
    }
    if (isBreak && r === seg.length - 1) {
      // A CRLF: the CR is the line break's, not a stray one.
      const clean = seg.slice(0, -1);
      line += 1;
      pos = end + 1;
      fe = BREAK;
      fv = base === '' ? clean : base + clean;
      fa = clean.length;
      return;
    }
    scanUnquotedSlow(p, base);
  }

  // The scanning loop for an unquoted field that holds a stray CR: the
  // field is built up a slice at a time, each stray CR dropped with its
  // error. Sets fv, fe, fa and pos.
  function scanUnquotedSlow(p, base) {
    let value = base;
    let added = 0;
    for (;;) {
      const comma = text.indexOf(',', p);
      const lf = text.indexOf('\n', p);
      const cr = text.indexOf('\r', p);
      let m = comma;
      let kind = COMMA;
      if (lf !== -1 && (m === -1 || lf < m)) {
        m = lf;
        kind = BREAK;
      }
      if (cr !== -1 && (m === -1 || cr < m)) {
        m = cr;
        kind = 3; // a CR: a line break with LF after it, else a stray CR
      }
      if (m === -1) {
        if (p < n) {
          value += text.slice(p);
          added += n - p;
        }
        pos = n;
        fv = value;
        fe = END;
        fa = added;
        return;
      }
      if (kind === 3 && text.charCodeAt(m + 1) !== 10) {
        // A stray CR: dropped, one error, and the field goes on.
        if (m > p) {
          value += text.slice(p, m);
          added += m - p;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        p = m + 1;
        continue;
      }
      if (m > p) {
        value += text.slice(p, m);
        added += m - p;
      }
      if (kind === COMMA) {
        pos = m + 1;
        fe = COMMA;
      } else if (text.charCodeAt(m) === 10) {
        line += 1;
        pos = m + 1;
        fe = BREAK;
      } else {
        // A CRLF: one line break, two characters.
        line += 1;
        pos = m + 2;
        fe = BREAK;
      }
      fv = value;
      fa = added;
      return;
    }
  }

  // Scans a quoted field whose opening quote is at pos. Sets fv, fe, fa
  // and pos.
  function scanQuoted() {
    const open = pos;
    // The closing quote: the next quote that is not doubled.
    let q = text.indexOf('"', open + 1);
    let segStart = open + 1;
    let segs = null;
    while (q !== -1 && text.charCodeAt(q + 1) === 34) {
      if (segs === null) segs = [];
      segs.push(text.slice(segStart, q));
      segStart = q + 2;
      q = text.indexOf('"', segStart);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted. `line` was never moved by the
      // search above, so it is still the opening quote's line.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanUnquoted(open + 1, '"');
      return;
    }
    let raw;
    if (segs === null) {
      raw = text.slice(open + 1, q);
    } else {
      segs.push(text.slice(segStart, q));
      raw = segs.join('"');
    }
    // Each CRLF or lone CR inside quotes is one LF, and every line break
    // inside quotes counts as a line.
    if (raw.indexOf('\r') !== -1 || raw.indexOf('\n') !== -1) {
      const breaks = raw.match(/\r\n|\r|\n/g);
      line += breaks === null ? 0 : breaks.length;
      raw = raw.replace(/\r\n?/g, '\n');
    }
    const np = q + 1;
    if (np >= n) {
      pos = np;
      fv = raw;
      fe = END;
      fa = 0;
      return;
    }
    const cc = text.charCodeAt(np);
    if (cc === 44) {
      pos = np + 1;
      fv = raw;
      fe = COMMA;
      fa = 0;
      return;
    }
    if (cc === 10) {
      line += 1;
      pos = np + 1;
      fv = raw;
      fe = BREAK;
      fa = 0;
      return;
    }
    if (cc === 13 && text.charCodeAt(np + 1) === 10) {
      line += 1;
      pos = np + 2;
      fv = raw;
      fe = BREAK;
      fa = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break; anything appended is quote junk.
    scanUnquoted(np, raw);
    if (fa > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Finishes a record: the header is kept, other records are padded or cut
  // to the first record's width, with an error either way.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fields one by one.
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        scanQuoted();
        quoted = true;
      } else {
        scanUnquoted(pos, '');
        quoted = false;
      }
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
