/**
 * Minimal RFC 4180 CSV parser. Fields hold JSON blobs with commas in them, so
 * split(",") does not work. Writers quote a field only when it contains a
 * comma, quote or newline (see CsvUtil in transactions-fit-performer).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      endField();
      i += 1;
    } else if (c === "\n") {
      endRow();
      i += 1;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) throw new Error("Unterminated quoted CSV field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export function parseCsvWithHeader(text: string, expectedHeader: string[]): string[][] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSV file is empty (no header)");
  const header = rows[0];
  if (header.join(",") !== expectedHeader.join(",")) {
    throw new Error(`Unexpected CSV header: got "${header.join(",")}", want "${expectedHeader.join(",")}"`);
  }
  const data = rows.slice(1);
  for (const row of data) {
    if (row.length !== expectedHeader.length) {
      throw new Error(`CSV row has ${row.length} fields, want ${expectedHeader.length}: ${row.join(",")}`);
    }
  }
  return data;
}
