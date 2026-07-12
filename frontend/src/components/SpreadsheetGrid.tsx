import { useEffect, useRef, useState } from "react";

export type CellKind = "corner" | "colHeader" | "rowHeader" | "body";

export interface GridCell {
  text: string;
  kind: CellKind;
  readOnly?: boolean;
}

export interface GridRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

interface Sel {
  anchor: { r: number; c: number };
  active: { r: number; c: number };
}

function normRange(s: Sel): GridRange {
  return {
    r0: Math.min(s.anchor.r, s.active.r),
    c0: Math.min(s.anchor.c, s.active.c),
    r1: Math.max(s.anchor.r, s.active.r),
    c1: Math.max(s.anchor.c, s.active.c),
  };
}

/** Parse spreadsheet clipboard text (TSV rows) into a block of strings. */
export function parseClipboardMatrix(text: string): string[][] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  if (cleaned === "") return [];
  return cleaned.split("\n").map((row) => row.split("\t"));
}

/**
 * Excel-like grid over a matrix of cells. Supports single/range selection
 * (click, shift-click, drag, arrow keys), block copy (Ctrl+C → TSV) and
 * block paste (Ctrl+V from Excel), in-cell editing, and Delete to clear.
 */
export function SpreadsheetGrid({
  matrix,
  onCommit,
  onPasteBlock,
  onClearRange,
  onSelectionChange,
  columnClass,
}: {
  matrix: GridCell[][];
  onCommit: (r: number, c: number, text: string) => void;
  onPasteBlock: (r: number, c: number, block: string[][]) => void;
  onClearRange?: (cells: { r: number; c: number }[]) => void;
  onSelectionChange?: (range: GridRange) => void;
  /** optional per-column className (by column index) for width control */
  columnClass?: (c: number) => string | undefined;
}) {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [sel, setSel] = useState<Sel>({ anchor: { r: 1, c: 0 }, active: { r: 1, c: 0 } });
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const dragging = useRef(false);

  const range = normRange(sel);
  const inRange = (r: number, c: number) =>
    r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  useEffect(() => {
    onSelectionChange?.(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.anchor.r, sel.anchor.c, sel.active.r, sel.active.c]);

  const clamp = (r: number, c: number) => ({
    r: Math.min(rows - 1, Math.max(0, r)),
    c: Math.min(cols - 1, Math.max(0, c)),
  });

  const cellAt = (r: number, c: number): GridCell | undefined => matrix[r]?.[c];
  const isEditable = (r: number, c: number) => {
    const cell = cellAt(r, c);
    return cell && !cell.readOnly;
  };

  const focusGrid = () => containerRef.current?.focus();

  const startEdit = (r: number, c: number, seed?: string) => {
    if (!isEditable(r, c)) return;
    setEditing({ r, c, value: seed ?? cellAt(r, c)?.text ?? "" });
  };

  const commitEdit = (move?: "down" | "right") => {
    if (!editing) return;
    const { r, c, value } = editing;
    if (cellAt(r, c)?.text !== value) onCommit(r, c, value);
    setEditing(null);
    if (move === "down") {
      const n = clamp(r + 1, c);
      setSel({ anchor: n, active: n });
    } else if (move === "right") {
      const n = clamp(r, c + 1);
      setSel({ anchor: n, active: n });
    }
    setTimeout(focusGrid, 0);
  };

  const moveActive = (dr: number, dc: number, extend: boolean) => {
    setSel((prev) => {
      const active = clamp(prev.active.r + dr, prev.active.c + dc);
      return { anchor: extend ? prev.anchor : active, active };
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSel({ anchor: { r: 0, c: 0 }, active: { r: rows - 1, c: cols - 1 } });
      return;
    }
    if (meta) return; // let copy/paste (onCopy/onPaste) run
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1, 0, e.shiftKey);
        return;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1, 0, e.shiftKey);
        return;
      case "ArrowLeft":
        e.preventDefault();
        moveActive(0, -1, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        moveActive(0, 1, e.shiftKey);
        return;
      case "Enter":
        e.preventDefault();
        if (isEditable(sel.active.r, sel.active.c)) startEdit(sel.active.r, sel.active.c);
        else moveActive(1, 0, false);
        return;
      case "Tab":
        e.preventDefault();
        moveActive(0, e.shiftKey ? -1 : 1, false);
        return;
      case "F2":
        e.preventDefault();
        startEdit(sel.active.r, sel.active.c);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        if (onClearRange) {
          const cells: { r: number; c: number }[] = [];
          for (let r = range.r0; r <= range.r1; r++)
            for (let c = range.c0; c <= range.c1; c++) cells.push({ r, c });
          onClearRange(cells);
        }
        return;
    }
    // printable character → begin editing with it
    if (e.key.length === 1 && !e.altKey) {
      if (isEditable(sel.active.r, sel.active.c)) {
        e.preventDefault();
        startEdit(sel.active.r, sel.active.c, e.key);
      }
    }
  };

  const onCopy = (e: React.ClipboardEvent) => {
    if (editing) return;
    const lines: string[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const row: string[] = [];
      for (let c = range.c0; c <= range.c1; c++) row.push(cellAt(r, c)?.text ?? "");
      lines.push(row.join("\t"));
    }
    e.clipboardData.setData("text/plain", lines.join("\n"));
    e.preventDefault();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    const text = e.clipboardData.getData("text/plain");
    const block = parseClipboardMatrix(text);
    if (block.length === 0) return;
    e.preventDefault();
    if (block.length === 1 && block[0].length === 1) {
      if (isEditable(sel.active.r, sel.active.c)) onCommit(sel.active.r, sel.active.c, block[0][0]);
    } else {
      onPasteBlock(sel.active.r, sel.active.c, block);
    }
  };

  const cellClass = (cell: GridCell) => {
    switch (cell.kind) {
      case "corner":
        return "ss-cell ss-cell-corner";
      case "colHeader":
        return "ss-cell ss-cell-colhead";
      case "rowHeader":
        return "ss-cell ss-cell-rowhead";
      default:
        return "ss-cell ss-cell-body";
    }
  };

  return (
    <div
      className="ss-grid-frame"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
      style={{ outline: "none" }}
    >
      <table className="ss-grid">
        <tbody>
          {matrix.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => {
                const active = sel.active.r === r && sel.active.c === c;
                const isEditingCell = editing?.r === r && editing?.c === c;
                return (
                  <td
                    key={c}
                    className={`${inRange(r, c) ? "ss-selected " : ""}${active ? "ss-active " : ""}${
                      columnClass?.(c) ?? ""
                    }`}
                    onMouseDown={(e) => {
                      if (isEditingCell) return;
                      e.preventDefault();
                      focusGrid();
                      if (e.shiftKey) setSel((prev) => ({ ...prev, active: { r, c } }));
                      else {
                        setSel({ anchor: { r, c }, active: { r, c } });
                        dragging.current = true;
                      }
                    }}
                    onMouseEnter={() => {
                      if (dragging.current) setSel((prev) => ({ ...prev, active: { r, c } }));
                    }}
                    onDoubleClick={() => startEdit(r, c)}
                  >
                    {isEditingCell ? (
                      <input
                        className="ss-cell-input"
                        autoFocus
                        value={editing.value}
                        onChange={(e) => setEditing({ r, c, value: e.target.value })}
                        onFocus={(e) => e.target.select()}
                        onBlur={() => commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit("down");
                          } else if (e.key === "Tab") {
                            e.preventDefault();
                            commitEdit("right");
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                            setTimeout(focusGrid, 0);
                          } else {
                            e.stopPropagation();
                          }
                        }}
                      />
                    ) : (
                      <div className={cellClass(cell)} title={cell.text}>
                        {cell.text || " "}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
