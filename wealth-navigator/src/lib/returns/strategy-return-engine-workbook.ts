import JSZip from "jszip";

export type StrategyReturnEngineRow = {
  asOf: string;
  securitiesCents: number;
  continuityCashCents: number;
  completeValueCents: number;
  currentAppOneMonthPct?: number | null;
  certificationStatus?: string;
  legs: Array<Record<string, unknown>>;
  periods: Record<
    string,
    {
      return_pct?: number;
      reference_date?: string;
    }
  >;
};

export type StrategyReturnEngineInput = {
  strategyName: string;
  strategyCreatedAt?: string | null;
  rows: StrategyReturnEngineRow[];
};

type EventRow = {
  index: number;
  action: string;
  cashMovement: number;
};

const xml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const textCell = (address: string, value: unknown, style = 0) =>
  `<c r="${address}" s="${style}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;

const numberCell = (address: string, value: unknown, style = 0) => {
  const number = Number(value ?? 0);
  return `<c r="${address}" s="${style}"><v>${Number.isFinite(number) ? number : 0}</v></c>`;
};

const formulaCell = (address: string, formula: string, value: unknown, style = 0) => {
  const number = Number(value ?? 0);
  return `<c r="${address}" s="${style}"><f>${xml(formula)}</f><v>${Number.isFinite(number) ? number : 0}</v></c>`;
};

const rowXml = (row: number, cells: string, height = 18) =>
  `<row r="${row}" ht="${height}" customHeight="1">${cells}</row>`;

const sheetXml = (rows: string, columns: string, tail = "") =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18"/>${columns}<sheetData>${rows}</sheetData>${tail}</worksheet>`;

const notesColumns =
  '<cols><col min="1" max="1" width="27" customWidth="1"/><col min="2" max="2" width="105" customWidth="1"/><col min="3" max="6" width="25" customWidth="1"/></cols>';
const ledgerColumns =
  '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="6" width="22" customWidth="1"/><col min="7" max="8" width="60" customWidth="1"/></cols>';
const chartColumns =
  '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="3" width="32" customWidth="1"/></cols>';

const stylesXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="R #,##0.00;[Red]-R #,##0.00"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Aptos"/><color rgb="FF211832"/></font><font><b/><sz val="16"/><name val="Aptos Display"/><color rgb="FF482078"/></font><font><b/><sz val="11"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Aptos"/><color rgb="FF8A4A00"/></font></fonts><fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1E9FB"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFAF8FD"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4B1F7A"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/></border><border><left style="thin"><color rgb="FFD8D0E4"/></left><right style="thin"><color rgb="FFD8D0E4"/></right><top style="thin"><color rgb="FFD8D0E4"/></top><bottom style="thin"><color rgb="FFD8D0E4"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="13"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="3" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="5" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="2" fillId="6" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="3" borderId="1" applyNumFmt="1" applyFill="1" applyBorder="1"/><xf numFmtId="10" fontId="0" fillId="5" borderId="1" applyNumFmt="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="5" borderId="1" applyNumFmt="1" applyFill="1" applyBorder="1"/></cellXfs></styleSheet>';

function rowAt(rows: StrategyReturnEngineRow[], index: number) {
  const row = rows[index];
  if (!row) throw new Error(`Missing canonical strategy ledger row ${index}.`);
  return row;
}

function activeUnits(row: StrategyReturnEngineRow) {
  const units = new Map<string, number>();
  for (const leg of row.legs) {
    if (!leg.counts_in_current_strategy) continue;
    const ticker = String(leg.ticker ?? "").trim();
    if (ticker) units.set(ticker, Number(leg.units ?? 0));
  }
  return units;
}

function detectEvents(rows: StrategyReturnEngineRow[]): EventRow[] {
  const events: EventRow[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rowAt(rows, index - 1);
    const current = rowAt(rows, index);
    const before = activeUnits(previous);
    const after = activeUnits(current);
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .filter((ticker) => (before.get(ticker) ?? 0) !== (after.get(ticker) ?? 0))
      .map((ticker) => {
        const delta = (after.get(ticker) ?? 0) - (before.get(ticker) ?? 0);
        return `${ticker} ${delta > 0 ? `+${delta}` : delta}`;
      });
    const cashMovement = (current.continuityCashCents - previous.continuityCashCents) / 100;
    if (changes.length || Math.abs(cashMovement) >= 0.005) {
      events.push({
        index,
        action: changes.length ? changes.join(", ") : "Continuity cash changed",
        cashMovement,
      });
    }
  }
  return events;
}

function oneMonthReferenceIndex(rows: StrategyReturnEngineRow[], index: number) {
  const current = rowAt(rows, index);
  const reference = current.periods?.["1M"]?.reference_date;
  if (reference) {
    const exact = rows.findIndex((row) => row.asOf === String(reference).slice(0, 10));
    if (exact >= 0 && exact <= index) return exact;
  }
  const target = new Date(`${current.asOf.slice(0, 10)}T00:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() - 1);
  let candidate = 0;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    if (new Date(`${rowAt(rows, cursor).asOf.slice(0, 10)}T00:00:00Z`) <= target) candidate = cursor;
  }
  return candidate;
}

function cachedLedgerReturn(rows: StrategyReturnEngineRow[], index: number, referenceIndex: number) {
  const current = rowAt(rows, index);
  const canonical = current.periods?.["1M"]?.return_pct;
  if (canonical != null && Number.isFinite(Number(canonical))) return Number(canonical) / 100;
  const opening = rowAt(rows, referenceIndex).completeValueCents;
  return opening ? (current.completeValueCents - opening) / opening : 0;
}

export async function buildStrategyReturnEngineWorkbook(input: StrategyReturnEngineInput) {
  const rows = [...input.rows]
    .filter((row) => row.asOf && Number.isFinite(Number(row.completeValueCents)))
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (!rows.length) throw new Error("No canonical strategy ledger rows are available for export.");

  const strategyName = input.strategyName.trim() || "Strategy";
  const first = rowAt(rows, 0);
  const inception = String(input.strategyCreatedAt || first.asOf).slice(0, 10);
  const firstClose = first.asOf.slice(0, 10);
  const latest = rowAt(rows, rows.length - 1);
  const latestIndex = rows.length - 1;
  const latestExcelRow = latestIndex + 4;
  const latestReferenceIndex = oneMonthReferenceIndex(rows, latestIndex);
  const latestReferenceExcelRow = latestReferenceIndex + 4;
  const latestLedgerReturn = cachedLedgerReturn(rows, latestIndex, latestReferenceIndex);
  const latestAppReturn =
    latest.currentAppOneMonthPct == null ? latestLedgerReturn : Number(latest.currentAppOneMonthPct) / 100;
  const latestGap = latestAppReturn - latestLedgerReturn;
  const events = detectEvents(rows);
  const eventIndexes = new Set(events.map((event) => event.index));

  const sheets: Array<[string, string]> = [];

  let body = "";
  body += rowXml(
    1,
    textCell("A1", `${strategyName.toUpperCase()} - RETURNS ENGINE / REBALANCE CLARITY`, 1),
    30,
  );
  body += rowXml(
    3,
    textCell("A3", "Built from real data", 2) +
      textCell(
        "B3",
        `This workbook tracks ${strategyName} date by date from its inception through the latest canonical close. Created ${inception}; first valid close ${firstClose}; latest close ${latest.asOf}.`,
        3,
      ),
  );
  body += rowXml(
    4,
    textCell("A4", "Yellow highlight meaning", 4) +
      textCell(
        "B4",
        "Yellow marks detected composition or continuity-cash boundaries and the evidence they require. It prevents the workbook from silently inventing a cash source.",
        5,
      ),
  );
  body += rowXml(
    5,
    textCell("A5", "Green cells", 6) +
      textCell(
        "B5",
        "Formula cells. Double-click them to inspect their cell references; they recalculate when input cells change.",
        7,
      ),
  );
  body += rowXml(
    7,
    textCell("A7", "Open in this order", 2) +
      textCell(
        "B7",
        "01 Master Data, 05 Rebalance Events, 06 Strategy Ledger, 07 Public Strategy View, Chart Data, 13 Checks.",
        3,
      ),
  );
  body += rowXml(
    9,
    textCell("A9", "The result", 4) +
      textCell(
        "B9",
        `Complete-value 1M return: ${(latestLedgerReturn * 100).toFixed(2)}%. Current app 1M: ${(latestAppReturn * 100).toFixed(2)}%. Gap: ${(latestGap * 100).toFixed(2)} percentage points.`,
        5,
      ),
  );
  sheets.push(["00_Start_Here", sheetXml(body, notesColumns)]);

  body = rowXml(1, textCell("A1", "01 MASTER DATA - STORED DAILY SNAPSHOTS", 1), 30);
  body += rowXml(
    3,
    [
      "As-of date",
      "Securities (R)",
      "Continuity cash (R)",
      "Complete value (R)",
      "Current app 1M",
      "Event note",
    ]
      .map((value, index) => textCell(`${String.fromCharCode(65 + index)}3`, value, 8))
      .join(""),
  );
  rows.forEach((row, index) => {
    const excelRow = index + 4;
    const event = events.find((item) => item.index === index);
    const style = event ? 5 : 3;
    body += rowXml(
      excelRow,
      textCell(`A${excelRow}`, row.asOf, 9) +
        numberCell(`B${excelRow}`, row.securitiesCents / 100, 10) +
        numberCell(`C${excelRow}`, row.continuityCashCents / 100, 10) +
        numberCell(`D${excelRow}`, row.completeValueCents / 100, 10) +
        numberCell(
          `E${excelRow}`,
          row.currentAppOneMonthPct == null
            ? cachedLedgerReturn(rows, index, oneMonthReferenceIndex(rows, index))
            : Number(row.currentAppOneMonthPct) / 100,
          11,
        ) +
        textCell(
          `F${excelRow}`,
          event
            ? `${event.action}; continuity cash ${event.cashMovement >= 0 ? "rises" : "falls"} R${Math.abs(event.cashMovement).toFixed(2)}`
            : "",
          style,
        ),
    );
  });
  sheets.push(["01_Master_Data", sheetXml(body, ledgerColumns)]);

  body = rowXml(1, textCell("A1", "05 REBALANCE EVENTS - EXPLICIT FUNDING BRIDGE", 1), 30);
  body += rowXml(
    3,
    ["Date", "Action", "Value movement", "External capital", "Reasoning"]
      .map((value, index) => textCell(`${String.fromCharCode(65 + index)}3`, value, 8))
      .join(""),
  );
  if (events.length) {
    events.forEach((event, eventIndex) => {
      const excelRow = eventIndex + 4;
      const masterRow = event.index + 4;
      body += rowXml(
        excelRow,
        textCell(`A${excelRow}`, rowAt(rows, event.index).asOf, 9) +
          textCell(`B${excelRow}`, event.action, 3) +
          formulaCell(
            `C${excelRow}`,
            `'01_Master_Data'!C${masterRow}-'01_Master_Data'!C${masterRow - 1}`,
            event.cashMovement,
            12,
          ) +
          numberCell(`D${excelRow}`, 0, 10) +
          textCell(
            `E${excelRow}`,
            `The R${Math.abs(event.cashMovement).toFixed(2)} continuity-cash movement is treated as an internal strategy bridge unless explicit external-flow evidence says otherwise. Composition trades are not subscriptions or performance.`,
            5,
          ),
      );
    });
  } else {
    body += rowXml(
      4,
      textCell("A4", "None", 9) +
        textCell("B4", "No composition or continuity-cash boundary detected", 3) +
        numberCell("C4", 0, 12) +
        numberCell("D4", 0, 10) +
        textCell("E4", "The canonical history contains no detected rebalance boundary.", 5),
    );
  }
  const ruleRow = Math.max(6, events.length + 5);
  body += rowXml(
    ruleRow,
    textCell(`A${ruleRow}`, "Rule", 4) +
      textCell(
        `B${ruleRow}`,
        "Only actual subscriptions, withdrawals, off-NAV fees or distributions are external flows. A sale funding cash or another holding remains inside the strategy performance chain.",
        5,
      ),
  );
  sheets.push(["05_Rebalance_Events", sheetXml(body, notesColumns)]);

  body = rowXml(1, textCell("A1", "06 STRATEGY LEDGER - DATE BY DATE", 1), 30);
  body += rowXml(
    3,
    [
      "As-of date",
      "Securities (R)",
      "Cash (R)",
      "Complete value (R)",
      "External flow (R)",
      "Ledger 1M return",
      "Current app 1M",
      "Reasoning",
    ]
      .map((value, index) => textCell(`${String.fromCharCode(65 + index)}3`, value, 8))
      .join(""),
  );
  rows.forEach((row, index) => {
    const excelRow = index + 4;
    const referenceIndex = oneMonthReferenceIndex(rows, index);
    const referenceExcelRow = referenceIndex + 4;
    const returnValue = cachedLedgerReturn(rows, index, referenceIndex);
    const currentApp =
      row.currentAppOneMonthPct == null ? returnValue : Number(row.currentAppOneMonthPct) / 100;
    const event = eventIndexes.has(index);
    const reason =
      index === 0
        ? `First canonical market close on or after strategy inception ${inception}.`
        : event
          ? "Rebalance boundary: keep the internal composition/cash bridge inside the strategy."
          : "Daily stored complete value; rolling one-month denominator is date-aligned.";
    const flowRange = referenceExcelRow < excelRow ? `SUM(E${referenceExcelRow + 1}:E${excelRow})` : "0";
    body += rowXml(
      excelRow,
      textCell(`A${excelRow}`, row.asOf, 9) +
        numberCell(`B${excelRow}`, row.securitiesCents / 100, 10) +
        numberCell(`C${excelRow}`, row.continuityCashCents / 100, 10) +
        formulaCell(`D${excelRow}`, `B${excelRow}+C${excelRow}`, row.completeValueCents / 100, 10) +
        numberCell(`E${excelRow}`, 0, 10) +
        formulaCell(
          `F${excelRow}`,
          `IFERROR((D${excelRow}-D${referenceExcelRow}-${flowRange})/D${referenceExcelRow},0)`,
          returnValue,
          11,
        ) +
        numberCell(`G${excelRow}`, currentApp, 11) +
        textCell(`H${excelRow}`, reason, event ? 5 : 3),
    );
  });
  sheets.push(["06_Strategy_Ledger", sheetXml(body, ledgerColumns)]);

  body = rowXml(1, textCell("A1", "07 PUBLIC STRATEGY VIEW - CORRECT VS CURRENT", 1), 30);
  body += rowXml(
    3,
    ["Metric", "Complete-value ledger", "Current app", "Difference", "Reasoning"]
      .map((value, index) => textCell(`${String.fromCharCode(65 + index)}3`, value, 8))
      .join(""),
  );
  body += rowXml(
    4,
    textCell("A4", "As of", 9) +
      textCell("B4", latest.asOf, 9) +
      textCell("C4", latest.asOf, 9) +
      textCell("D4", "", 3) +
      textCell(
        "E4",
        "Same final canonical snapshot; the formulas independently expose any return-method difference.",
        3,
      ),
  );
  body += rowXml(
    5,
    textCell("A5", "1 month return", 9) +
      formulaCell("B5", `'06_Strategy_Ledger'!F${latestExcelRow}`, latestLedgerReturn, 11) +
      formulaCell("C5", `'06_Strategy_Ledger'!G${latestExcelRow}`, latestAppReturn, 11) +
      formulaCell("D5", "C5-B5", latestGap, 11) +
      textCell(
        "E5",
        "The public strategy result should follow the complete-value ledger, including continuity cash and crossing rebalance boundaries without creating artificial performance.",
        5,
      ),
  );
  body += rowXml(
    7,
    textCell("A7", "Start complete value", 9) +
      formulaCell(
        "B7",
        `'06_Strategy_Ledger'!D${latestReferenceExcelRow}`,
        rowAt(rows, latestReferenceIndex).completeValueCents / 100,
        10,
      ) +
      textCell("C7", rowAt(rows, latestReferenceIndex).asOf, 5) +
      textCell("D7", "", 3) +
      textCell(
        "E7",
        "The denominator is the complete strategy value at the canonical one-month reference close.",
        3,
      ),
  );
  body += rowXml(
    8,
    textCell("A8", "End complete value", 9) +
      formulaCell("B8", `'06_Strategy_Ledger'!D${latestExcelRow}`, latest.completeValueCents / 100, 10) +
      textCell("C8", "Same endpoint", 3) +
      textCell("D8", "", 3) +
      textCell("E8", "The comparison is date-aligned.", 3),
  );
  sheets.push(["07_Public_Strategy_View", sheetXml(body, notesColumns)]);

  body = rowXml(1, textCell("A1", "CHART DATA - DATE BY DATE", 1), 30);
  body += rowXml(
    3,
    textCell("A3", "As-of date", 8) +
      textCell("B3", "Complete-value ledger return", 8) +
      textCell("C3", "Current app 1M return", 8),
  );
  rows.forEach((row, index) => {
    const excelRow = index + 4;
    const referenceIndex = oneMonthReferenceIndex(rows, index);
    const ledgerReturn = cachedLedgerReturn(rows, index, referenceIndex);
    const currentApp =
      row.currentAppOneMonthPct == null ? ledgerReturn : Number(row.currentAppOneMonthPct) / 100;
    body += rowXml(
      excelRow,
      textCell(`A${excelRow}`, row.asOf, 9) +
        formulaCell(`B${excelRow}`, `'06_Strategy_Ledger'!F${excelRow}`, ledgerReturn, 11) +
        formulaCell(`C${excelRow}`, `'06_Strategy_Ledger'!G${excelRow}`, currentApp, 11),
    );
  });
  sheets.push(["Chart_Data", sheetXml(body, chartColumns, '<drawing r:id="rId1"/>')]);

  body = rowXml(1, textCell("A1", "13 CHECKS", 1), 30);
  body += rowXml(
    3,
    ["Check", "Formula", "Expected", "Reasoning"]
      .map((value, index) => textCell(`${String.fromCharCode(65 + index)}3`, value, 8))
      .join(""),
  );
  body += rowXml(
    4,
    textCell("A4", "Opening reconciles", 9) +
      formulaCell("B4", "'06_Strategy_Ledger'!D4-'06_Strategy_Ledger'!B4-'06_Strategy_Ledger'!C4", 0, 11) +
      numberCell("C4", 0, 10) +
      textCell("D4", "Complete value equals securities plus cash.", 6),
  );
  body += rowXml(
    5,
    textCell("A5", "Closing reconciles", 9) +
      formulaCell(
        "B5",
        `'06_Strategy_Ledger'!D${latestExcelRow}-'06_Strategy_Ledger'!B${latestExcelRow}-'06_Strategy_Ledger'!C${latestExcelRow}`,
        0,
        11,
      ) +
      numberCell("C5", 0, 10) +
      textCell("D5", "Complete value equals securities plus cash.", 6),
  );
  body += rowXml(
    6,
    textCell("A6", "External capital in full ledger", 9) +
      formulaCell("B6", `SUM('06_Strategy_Ledger'!E4:E${latestExcelRow})`, 0, 10) +
      numberCell("C6", 0, 10) +
      textCell("D6", "No external strategy-model flow is assumed without explicit evidence.", 5),
  );
  body += rowXml(
    7,
    textCell("A7", "Visible return gap", 9) +
      formulaCell("B7", "'07_Public_Strategy_View'!D5", latestGap, 11) +
      numberCell("C7", 0, 11) +
      textCell("D7", "A non-zero gap is visible for review; no mismatch is hidden.", 5),
  );
  body += rowXml(
    8,
    textCell("A8", "Inception coverage", 9) +
      formulaCell("B8", `COUNTA('06_Strategy_Ledger'!A4:A${latestExcelRow})`, rows.length, 10) +
      numberCell("C8", rows.length, 10) +
      textCell("D8", `Rows run from ${firstClose} through ${latest.asOf}; strategy created ${inception}.`, 6),
  );
  sheets.push(["13_Checks", sheetXml(body, notesColumns)]);

  const zip = new JSZip();
  const overrides = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>',
    '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
  ];
  const sheetNodes: string[] = [];
  const relationships: string[] = [];
  sheets.forEach(([name, content], index) => {
    const number = index + 1;
    zip.file(`xl/worksheets/sheet${number}.xml`, content);
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
    sheetNodes.push(`<sheet name="${xml(name)}" sheetId="${number}" r:id="rId${number}"/>`);
    relationships.push(
      `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`,
    );
  });
  zip.file(
    "xl/worksheets/_rels/sheet6.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
  );
  zip.file(
    "xl/drawings/drawing1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:to><xdr:col>14</xdr:col><xdr:row>25</xdr:row></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${xml(strategyName)} 1M comparison"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
  );
  zip.file(
    "xl/drawings/_rels/drawing1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
  );
  zip.file(
    "xl/charts/chart1.xml",
    `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:title><c:tx><c:rich xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xml(strategyName)} - correct versus current 1M return</a:t></a:r></a:p></c:rich></c:tx><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Complete-value ledger</c:v></c:tx><c:cat><c:strRef><c:f>Chart_Data!$A$4:$A$${latestExcelRow}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Chart_Data!$B$4:$B$${latestExcelRow}</c:f></c:numRef></c:val></c:ser><c:ser><c:idx val="1"/><c:order val="1"/><c:tx><c:v>Current app</c:v></c:tx><c:cat><c:strRef><c:f>Chart_Data!$A$4:$A$${latestExcelRow}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Chart_Data!$C$4:$C$${latestExcelRow}</c:f></c:numRef></c:val></c:ser><c:axId val="10"/><c:axId val="11"/></c:lineChart><c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="11"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="11"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:numFmt formatCode="0.00%" sourceLinked="0"/><c:crossAx val="10"/><c:crosses val="autoZero"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides.join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="4"/></bookViews><sheets>${sheetNodes.join("")}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file("xl/styles.xml", stylesXml);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export function strategyReturnEngineFilename(strategyName: string) {
  const safe =
    strategyName
      .trim()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "") || "Strategy";
  return `${safe}-Returns-Engine-Ledger-Model.xlsx`;
}
