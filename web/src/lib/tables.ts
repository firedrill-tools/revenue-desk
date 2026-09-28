// Numbers in the agent's tables line up on the right, as in a ledger. The
// model writes plain Markdown tables (usually without alignment), so the
// thread aligns a column on the right when every filled cell in it is a
// number, an amount or a percentage.

/** "$3,600.00", "70", "-12.5%", "(1,200.00)", "USD 49.00", "49.00 EUR", "1.2k". */
const NUMERIC_CELL =
  /^\(?[-+−]?\s*(?:[$€£¥]|[A-Z]{3}\s)?\s*[-+−]?\d[\d,\s]*(?:\.\d+)?\s*(?:%|[kKmMbB]|\s[A-Z]{3})?\)?$/;

/** Cells that say "nothing here" and do not decide a column's alignment. */
const BLANK_CELL = /^(?:|[-–—]|n\/a)$/i;

export function isNumericCell(text: string): boolean {
  return NUMERIC_CELL.test(text.trim());
}

/**
 * The indexes of the columns whose filled cells are all numeric (at least
 * one filled). `rows` are the body rows' cell texts.
 */
export function numericColumns(rows: readonly (readonly string[])[]): number[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const columns: number[] = [];
  for (let column = 0; column < width; column += 1) {
    const filled = rows
      .map((row) => (row[column] ?? "").trim())
      .filter((text) => !BLANK_CELL.test(text));
    if (filled.length > 0 && filled.every(isNumericCell)) columns.push(column);
  }
  return columns;
}

/** Marks numeric columns of every table under `root` with data-align="end" (styled in globals.css). */
export function alignNumericColumns(root: HTMLElement | null): void {
  if (root === null) return;
  for (const table of root.querySelectorAll("table")) {
    const body = Array.from(table.tBodies).flatMap((section) => Array.from(section.rows));
    const numeric = new Set(
      numericColumns(body.map((row) => Array.from(row.cells, (cell) => cell.textContent ?? ""))),
    );
    for (const row of Array.from(table.rows)) {
      Array.from(row.cells).forEach((cell, index) => {
        if (numeric.has(index)) cell.dataset.align = "end";
        else delete cell.dataset.align;
      });
    }
  }
}
