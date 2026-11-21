// Faster drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// Returns, for every input {text, header}, exactly the reference's answer {columns, rows, errors},
// under the same broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is
//     one quote; each CRLF or lone CR inside it is read as LF); what follows its closing quote, up
//     to the next comma or line break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it is read again as an
//     unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows are padded ("") or cut to
//     the first record's width (short_row with fields:, long_row with extra:);
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts
//     on (every LF, CRLF and lone CR inside quotes counted), row its index in rows (null for the
//     header).
//
// How it is faster than the reference: the reference walks one character at a time and builds
// every field character by character. This reader finds field ends with indexOf (native search),
// takes most fields as a single slice of the text, and only falls back to a character loop on
// the rare spans that hold a CR (stray CRs, CRLF endings, CRs inside quotes). No state is kept
// from one call to the next (the scratch variables below are rewritten on every field).

// How a field ended.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The last field read: its value, how it ended, and how many characters the reader itself
  // kept (the reference's `added`: an initial value handed in does not count).
  let fVal = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `initial` up to the next comma or line break, exactly as the
  // reference's readUnquoted does (a CR not followed by LF is dropped, stray_cr). Sets
  // fVal/fEnded/fAdded and advances pos/line.
  function readUnquoted(initial) {
    const start = pos;
    // The field's span: up to the first comma or LF (whichever comes first), or the text's end.
    const iC = text.indexOf(',', start);
    const iN = text.indexOf('\n', start);
    let end;
    let ended;
    if (iC === -1 && iN === -1) {
      end = len;
      ended = END;
    } else if (iN === -1 || (iC !== -1 && iC < iN)) {
      end = iC;
      ended = COMMA;
    } else {
      end = iN;
      ended = LINE_BREAK;
    }
    // Any CR in the span changes things; without one the field is the plain slice (the search
    // runs on the slice, so it stays inside the span and native). A CR inside the span is stray
    // unless it is the span's only CR, its last character, and the span ends at an LF: a CRLF
    // ending.
    const span = text.slice(start, end);
    const cr = span.indexOf('\r');
    if (cr === -1) {
      fVal = initial === '' ? span : initial + span;
      fAdded = end - start;
      fEnded = ended;
      if (ended === COMMA) {
        pos = end + 1;
      } else if (ended === LINE_BREAK) {
        pos = end + 1;
        line += 1;
      } else {
        pos = end;
      }
      return;
    }
    if (ended === LINE_BREAK && cr === span.length - 1) {
      // The span's only CR is its last character: a CRLF ending, the CR is not part of the field.
      const body = span.slice(0, span.length - 1);
      fVal = initial === '' ? body : initial + body;
      fAdded = span.length - 1;
      fEnded = LINE_BREAK;
      pos = end + 1;
      line += 1;
      return;
    }
    // Rare span (a stray CR inside it): the reference's character loop, unchanged.
    let value = initial;
    let added = 0;
    let p = start;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === 44) {
        fVal = value;
        fEnded = COMMA;
        fAdded = added;
        pos = p + 1;
        return;
      }
      if (c === 10) {
        fVal = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        pos = p + 1;
        line += 1;
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(p + 1) === 10) {
          fVal = value;
          fEnded = LINE_BREAK;
          fAdded = added;
          pos = p + 2;
          line += 1;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        p += 1;
        continue;
      }
      value += text[p];
      added += 1;
      p += 1;
    }
    fVal = value;
    fEnded = END;
    fAdded = added;
    pos = p;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnded and advances pos/line.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let segStart = open + 1;
    let p = segStart;
    let parts = null; // segment strings, once a doubled quote or a CR forces building the value
    let single = ''; // the value when it is one plain slice of the text
    while (true) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      // The segment [segStart, q): a slice of the text; only a CR in it forces a rebuild.
      let seg = text.slice(segStart, q);
      if (seg.indexOf('\r') === -1) {
        // No CR: the segment stands as it is; only its LFs move the line count.
        const firstLf = seg.indexOf('\n');
        if (firstLf !== -1) {
          let lf = 1;
          for (let j = firstLf + 1; j < seg.length; j++) {
            if (seg.charCodeAt(j) === 10) lf += 1;
          }
          line += lf;
        }
      } else {
        // A CR inside quotes: rebuild the segment, each CRLF or lone CR read as one LF.
        let out = '';
        for (let j = segStart; j < q; j++) {
          const c = text.charCodeAt(j);
          if (c === 13) {
            out += '\n';
            line += 1;
            if (j + 1 < q && text.charCodeAt(j + 1) === 10) j += 1; // the LF of a CRLF pair
            continue;
          }
          if (c === 10) line += 1;
          out += text[j];
        }
        seg = out;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote, and the field goes on.
        if (parts === null) {
          parts = [seg, '"'];
          single = '';
        } else {
          parts.push(seg, '"');
        }
        p = q + 2;
        segStart = p;
        continue;
      }
      // The closing quote.
      let value;
      if (parts === null) {
        value = seg;
      } else {
        parts.push(seg);
        value = parts.join('');
      }
      pos = q + 1;
      if (pos >= len) {
        fVal = value;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fVal = value;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fVal = value;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fVal = value;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line
      // break (its stray CRs are recorded first, as the reference records them).
      readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
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
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnquoted('');
      }
      fields.push(fVal);
      ended = fEnded;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
