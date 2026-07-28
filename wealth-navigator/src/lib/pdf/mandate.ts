/**
 * Discretionary FSP Mandate PDF — a verbatim port of MyMintAdmin's
 * buildMandatePdfReport (public/index.html): the full legal mandate document
 * (cover, client details, numbered clauses 1-14, termination, addendum,
 * risk/horizon checkboxes, category tables, bank details). The legal text and
 * layout are reproduced exactly; only the jsPDF acquisition (dynamic import)
 * and the data source (pack + onboarding, instead of the CRM's in-memory maps)
 * are adapted. Kept in its own module because of its size.
 */

// Verbatim port of the CRM's mandate generator: the `any` on the dynamic pack
// traversal, the .forEach loops and the string concatenation are the CRM's own
// code kept unchanged on purpose. Lint rules for those are scoped off for this
// file in biome.json (overrides) rather than rewriting the ported legal doc.
import type { jsPDF as JsPdfType } from "jspdf";

type Rec = Record<string, unknown>;

function parseJsonSafe(value: unknown): any {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function pickPackValue(source: any, paths: string[] = []): any {
  for (const path of paths) {
    const parts = path.split(".");
    let current: any = source;
    for (const part of parts) {
      if (current === null || current === undefined) { current = undefined; break; }
      current = current[part];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return null;
}

function sanitizeFilename(value: string): string {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

// Mandate data source: the captured onboarding pack first, then the onboarding
// row's sumsub_raw (mirrors the CRM's getMandateDataSource precedence).
function getMandateDataSource(pack: unknown, onboarding: Rec): any {
  const fromPack = parseJsonSafe(pack);
  if (fromPack && Object.keys(fromPack).length) return fromPack;
  const fromOnboarding = parseJsonSafe(onboarding?.sumsub_raw);
  if (fromOnboarding) return fromOnboarding;
  return {};
}

function getMandatePrefillData(profile: Rec = {}, onboarding: Rec = {}, pack: unknown = {}) {
  const source = getMandateDataSource(pack, onboarding);
  const fullNameFromSource = String(pickPackValue(source, ['fullName', 'info.fullName', 'full_name']) || '').trim();
  const sourceFirstName = String(pickPackValue(source, ['firstName', 'first_name', 'fixedInfo.firstName', 'info.firstName', 'name.first']) || '').trim();
  const sourceLastName = String(pickPackValue(source, ['lastName', 'last_name', 'fixedInfo.lastName', 'info.lastName', 'name.last']) || '').trim();
  const profileFirstName = String((profile as any)?.first_name || '').trim();
  const profileLastName = String((profile as any)?.last_name || '').trim();
  const firstName = sourceFirstName || profileFirstName || fullNameFromSource.split(/s+/).filter(Boolean).slice(0, -1).join(' ');
  const lastName = sourceLastName || profileLastName || fullNameFromSource.split(/s+/).filter(Boolean).slice(-1).join(' ');
  const identityNumber = String(pickPackValue(source, ['info.idDocs.0.number','info.idDocs.0.idNumber','fixedInfo.idDocs.0.number','fixedInfo.idDocs.0.idNumber','info.idNumber','idDocs.0.number','idDocs.0.idNumber','document.idNumber','fixedInfo.idNumber','fixedInfo.nationality.idNumber','idNumber','identityNumber','passportNumber','document.number']) || '').trim();
  const email = String(pickPackValue(source, ['email', 'emails.0', 'info.email', 'fixedInfo.email', 'contacts.email']) || (profile as any)?.email || '').trim();
  const phone = String(pickPackValue(source, ['phone', 'phoneNumber', 'phone_number', 'mobile', 'info.phone', 'fixedInfo.phone']) || (profile as any)?.phone_number || '').trim();
  const residentialAddress = String(pickPackValue(source, ['info.addresses.0.streetEn','info.addresses.0.street','info.idDocs.1.address.streetEn','info.idDocs.1.address.street','fixedInfo.address','fixedInfo.fullAddress','fixedInfo.residentialAddress','info.address','info.residentialAddress','address.formattedAddress','address.fullAddress','address.street','address.line1','addresses.residential.formatted','addresses.residential.fullAddress','addresses.residential.addressLine','addresses.residential.street','addresses.0.streetEn','addresses.0.street','addresses.0.fullAddress','addresses.0.formattedAddress','addresses.0.addressLine']) || (profile as any)?.address || '').trim();
  const postalAddress = String(pickPackValue(source, ['info.addresses.0.formattedAddress','info.idDocs.1.address.formattedAddress','info.addresses.0.fullAddress','fixedInfo.postalAddress','fixedInfo.address','info.postalAddress','info.address','addresses.postal.formatted','addresses.postal.fullAddress','addresses.postal.addressLine','addresses.postal.street','addresses.0.formattedAddress','addresses.0.fullAddress','addresses.0.addressLine','postalAddress','mailingAddress','address.formattedAddress']) || (profile as any)?.address || '').trim();
  const postalCode = String(pickPackValue(source, ['info.addresses.0.postCode','info.idDocs.1.address.postCode','info.addresses.0.postalCode','fixedInfo.postCode','fixedInfo.postalCode','info.postCode','info.postalCode','address.postCode','address.postalCode','addresses.postal.postCode','addresses.postal.postalCode','addresses.0.postCode','addresses.0.postalCode']) || '').trim();
  const initials = ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || 'NA';
  const phoneDigits = phone.replace(/D/g, '');
  let countryCode = ''; let areaOrCellCode = ''; let phoneBody = '';
  if (phoneDigits.length >= 9) {
    if (phoneDigits.startsWith('27')) { countryCode = '27'; areaOrCellCode = phoneDigits.slice(2, 4); phoneBody = phoneDigits.slice(4); }
    else { countryCode = phoneDigits.slice(0, 2); areaOrCellCode = phoneDigits.slice(2, 4); phoneBody = phoneDigits.slice(4); }
  }
  return { firstName, lastName, identityNumber, email, phone, postalAddress, postalCode, residentialAddress, initials, countryCode, areaOrCellCode, phoneBody };
}

export async function buildMandatePdfReport(
  profile: Rec,
  onboarding: Rec,
  pack: unknown = {},
): Promise<{ doc: JsPdfType; filename: string }> {
  const { jsPDF: JsPdf } = await import("jspdf");
      const d = getMandatePrefillData(profile, onboarding, pack);
      const doc = new JsPdf({ unit: 'pt', format: 'a4' });
      const pw  = doc.internal.pageSize.getWidth();
      const ph  = doc.internal.pageSize.getHeight();
      const m   = 40;
      const cw  = pw - m * 2;
      let y = m;

      /* ---------- helpers ---------- */
      const ensureSpace = (need = 20) => {
        if (y + need > ph - 60) { doc.addPage(); y = m; }
      };

      const drawCheckbox = (x: number, cy: number, checked: boolean | undefined, label?: string) => {
        const sz = 10;
        doc.setDrawColor(60, 60, 60);
        doc.setLineWidth(0.5);
        doc.rect(x, cy - sz + 2, sz, sz);
        if (checked) {
          doc.setLineWidth(1.4);
          doc.line(x + 2, cy - 2, x + 4.5, cy + 1);
          doc.line(x + 4.5, cy + 1, x + sz - 1.5, cy - sz + 4);
          doc.setLineWidth(0.5);
        }
        if (label) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10);
          doc.setTextColor(30, 30, 30);
          doc.text(String(label), x + sz + 6, cy);
        }
      };

      const drawField = (label: string, value: unknown) => {
        ensureSpace(24);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(80, 80, 80);
        doc.text(String(label), m + 4, y + 12);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(20, 20, 20);
        const lines = doc.splitTextToSize(String(value || '-'), cw - 180);
        doc.text(lines, m + 175, y + 12);
        doc.setDrawColor(210, 210, 210);
        doc.line(m + 4, y + 18, m + cw - 4, y + 18);
        y += Math.max(22, lines.length * 12 + 10);
      };

      const drawHeading = (text: string) => {
        ensureSpace(30);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(30, 30, 30);
        doc.text(text, pw / 2, y + 14, { align: 'center' });
        y += 28;
      };

      const drawSubHeading = (text: string) => {
        ensureSpace(20);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30, 30, 30);
        doc.text(text, m + 4, y + 10);
        y += 18;
      };

      const drawInitials = () => {
        const bx = pw - m - 100;
        const by = ph - 55;
        doc.setDrawColor(60, 60, 60);
        doc.rect(bx, by, 90, 28);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(60, 60, 60);
        doc.text('Initials:', bx + 4, by + 10);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(20, 20, 20);
        doc.text(d.initials, bx + 4, by + 22);
      };

      const drawParagraph = (text: string, indent = 0) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(30, 30, 30);
        const maxW = cw - indent - 8;
        const lines = doc.splitTextToSize(String(text), maxW);
        const need = lines.length * 11 + 4;
        ensureSpace(need);
        doc.text(lines, m + 4 + indent, y + 10);
        y += need;
      };

      const drawSectionParagraph = (num: string, text: string, indent = 0) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(30, 30, 30);
        const prefix = num ? num + '  ' : '';
        const maxW = cw - indent - 8;
        const lines = doc.splitTextToSize(prefix + String(text), maxW);
        const need = lines.length * 11 + 4;
        ensureSpace(need);
        if (num) {
          doc.setFont('helvetica', 'bold');
          doc.text(num, m + 4 + indent, y + 10);
          doc.setFont('helvetica', 'normal');
          const numW = doc.getTextWidth(num + '  ');
          const bodyLines = doc.splitTextToSize(String(text), maxW - numW);
          doc.text(bodyLines[0] || '', m + 4 + indent + numW, y + 10);
          if (bodyLines.length > 1) {
            for (let li = 1; li < bodyLines.length; li++) {
              doc.text(bodyLines[li], m + 4 + indent, y + 10 + li * 11);
            }
          }
          y += Math.max(bodyLines.length, 1) * 11 + 4;
        } else {
          doc.text(lines, m + 4 + indent, y + 10);
          y += need;
        }
      };

      const drawCategoryTable = (title: string, colHeader: string, rows: (string | number)[][]) => {
        const col0W = 40;
        const col2W = 90;
        const col1W = cw - col0W - col2W;
        const rowH = 18;
        const headerH = 20;
        const totalH = headerH + rows.length * rowH;
        ensureSpace(totalH + 10);
        doc.setFillColor(240, 240, 240);
        doc.setDrawColor(51, 51, 51);
        doc.setLineWidth(0.5);
        doc.rect(m, y, cw, headerH, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(30, 30, 30);
        doc.text(title, m + 4, y + 13);
        doc.text(colHeader, m + col0W + col1W + 4, y + 13);
        y += headerH;
        rows.forEach((row: (string | number)[]) => {
          doc.setDrawColor(51, 51, 51);
          doc.rect(m, y, col0W, rowH);
          doc.rect(m + col0W, y, col1W, rowH);
          doc.rect(m + col0W + col1W, y, col2W, rowH);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(30, 30, 30);
          doc.text(String(row[0]), m + 4, y + 12);
          doc.text(String(row[1]), m + col0W + 4, y + 12);
          doc.text(String(row[2] || 'X'), m + col0W + col1W + (col2W / 2) - 4, y + 12);
          y += rowH;
        });
        y += 6;
      };

      const drawPageNumber = (num: number) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text('Page ' + num, pw / 2, m - 10, { align: 'center' });
      };

      /* ---------- checkbox state determination ---------- */
      const sumsubRaw  = parseJsonSafe(onboarding?.sumsub_raw) || {};
      const mandateData    = sumsubRaw.mandate_data || {};
      const mandateNotSigned = !mandateData.checkedBoxes;
      const checkedBoxes   = mandateData.checkedBoxes || {};
      const discretionType = mandateData.discretionType || 'full';
      const isBoxChecked   = (key: string) => checkedBoxes[key] === true;

      const fullLocal    = isBoxChecked('full-local');
      const fullOffshore = isBoxChecked('full-offshore');
      const fullBoth     = isBoxChecked('full-both');

      const limInstrSelf    = isBoxChecked('lim-instr-0');
      const limInstrAdvisor = isBoxChecked('lim-instr-1');
      const limInstrAdvice  = isBoxChecked('lim-instr-2');
      const limLocal        = isBoxChecked('lim-local');
      const limOffshore     = isBoxChecked('lim-offshore');
      const limBoth         = isBoxChecked('lim-both');
      const limReinvest     = isBoxChecked('lim-payout-0');
      const limPayout       = isBoxChecked('lim-payout-1');

      const pfx    = discretionType === 'limited' ? 'lim' : 'full';
      const riskEntries = [
        { id: 'vcons', label: 'Very Conservative' },
        { id: 'cons',  label: 'Conservative' },
        { id: 'mod',   label: 'Moderate' },
        { id: 'agg',   label: 'Aggressive' },
        { id: 'vagg',  label: 'Very Aggressive' }
      ];

      const drawHorizonBlock = (blockPfx: string) => {
        const bLtGrowth = isBoxChecked(`${blockPfx}-lt-0`);
        const bLtIncome = isBoxChecked(`${blockPfx}-lt-1`);
        const bMtGrowth = isBoxChecked(`${blockPfx}-mt-0`);
        const bMtIncome = isBoxChecked(`${blockPfx}-mt-1`);
        const bStGrowth = isBoxChecked(`${blockPfx}-st-0`);
        const bStIncome = isBoxChecked(`${blockPfx}-st-1`);
        const bRisk    = riskEntries.map((r, i) => isBoxChecked(`${blockPfx}-rp-${i}`));
        drawSubHeading('Long Term (5 years or longer)');
        drawCheckbox(m + 10, y, bLtGrowth, 'Capital Growth'); y += 18;
        drawCheckbox(m + 10, y, bLtIncome, 'Income Generation'); y += 22;
        drawSubHeading('Medium Term (2 to 5 years)');
        drawCheckbox(m + 10, y, bMtGrowth, 'Capital Growth'); y += 18;
        drawCheckbox(m + 10, y, bMtIncome, 'Income Generation'); y += 22;
        drawSubHeading('Short Term (3 months to 2 years)');
        drawCheckbox(m + 10, y, bStGrowth, 'Capital Growth'); y += 18;
        drawCheckbox(m + 10, y, bStIncome, 'Income Generation'); y += 22;
        drawSubHeading('Risk Preference*');
        riskEntries.forEach((r, i) => {
          drawCheckbox(m + 10, y, bRisk[i], r.label); y += 18;
        });
        y += 4;
      };

      const ltGrowth = isBoxChecked(`${pfx}-lt-0`);
      const ltIncome = isBoxChecked(`${pfx}-lt-1`);
      const mtGrowth = isBoxChecked(`${pfx}-mt-0`);
      const mtIncome = isBoxChecked(`${pfx}-mt-1`);
      const stGrowth = isBoxChecked(`${pfx}-st-0`);
      const stIncome = isBoxChecked(`${pfx}-st-1`);
      const riskChecked = riskEntries.map((r, i) => isBoxChecked(`${pfx}-rp-${i}`));

      /* ===== PAGE 1 &mdash; Cover ===== */
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(26);
      doc.setTextColor(30, 30, 30);
      doc.text('DISCRETIONARY FSP MANDATE', pw / 2, ph / 2 - 50, { align: 'center' });
      doc.setFontSize(18);
      doc.text('(Mandate)', pw / 2, ph / 2 - 18, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.setTextColor(80, 80, 80);
      doc.text('Prepared by ALGOHIVE (PTY) LTD', pw / 2, ph / 2 + 30, { align: 'center' });
      doc.text('An Authorised Financial Services Provider', pw / 2, ph / 2 + 48, { align: 'center' });
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 30, 30);
      doc.text('FSP NO 55118', pw / 2, ph / 2 + 76, { align: 'center' });

      if (mandateNotSigned) {
        doc.setFillColor(220, 53, 69);
        doc.rect(m, ph / 2 + 100, cw, 26, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(255, 255, 255);
        doc.text('CLIENT HAS NOT YET COMPLETED THE MANDATE SIGNING PROCESS', pw / 2, ph / 2 + 117, { align: 'center' });
      }

      /* ===== PAGE 2 &mdash; Client Details ===== */
      doc.addPage(); y = m;
      drawHeading('DISCRETIONARY INVESTMENT MANAGEMENT MANDATE');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(30, 30, 30);
      doc.text('ENTERED INTO BETWEEN', pw / 2, y, { align: 'center' });
      y += 22;

      doc.setFontSize(12);
      doc.text('ALGOHIVE (PTY) LTD', pw / 2, y, { align: 'center' });
      y += 14;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(80, 80, 80);
      doc.text('(Registration Number: 2024/644796/07)', pw / 2, y, { align: 'center' });
      y += 18;

      drawField('Street Address',    '3 Gwen Lane, Sandown, Sandton, 2031');
      drawField('Telephone Number',  '+27 (0) 73 781 3375');
      drawField('Email Address',     'info@thealgohive.com');
      y += 4;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(80, 80, 80);
      doc.text('(hereinafter referred to as ALGOHIVE)', pw / 2, y, { align: 'center' });
      y += 14;
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 30, 30);
      doc.text('and', pw / 2, y, { align: 'center' });
      y += 20;

      doc.setFontSize(11);
      doc.text('CLIENT DETAILS', m + 4, y);
      y += 16;

      drawField('Surname',              d.lastName);
      drawField('First Name/s',         d.firstName);
      drawField('ID / Passport Number', d.identityNumber);
      drawField('Company/Trust Reg No', '-');
      drawField('Postal Address',       d.postalAddress);
      drawField('Postal Code',          d.postalCode);
      drawField('Residential Address',  d.residentialAddress);

      const phoneFull = d.countryCode
        ? `+${d.countryCode} ${d.areaOrCellCode} ${d.phoneBody}`
        : (d.phone || '-');
      drawField('Tel Number (H)',       phoneFull);
      drawField('Tel Number (W)',       phoneFull);
      drawField('Cell Number',          phoneFull);
      drawField('Email (Confidential)', d.email);
      drawField('Email (Other)',        d.email);
      drawInitials();

      /* ===== PAGE 3 &mdash; Introduction + Category Tables ===== */
      doc.addPage(); y = m;
      drawPageNumber(3);

      drawSubHeading('1. INTRODUCTION');
      drawSectionParagraph('1.1', 'ALGOHIVE warrants that it is the holder of a Category II FSP license number 55118, in accordance with the Financial Advisory and Intermediary Services Act, 2002 (Act No. 37 of 2002), hereafter referred to as FAIS and is authorised to render intermediary services of a discretionary nature in respect of investment products residing under the financial product subcategories indicated in paragraph 1.2 hereunder. The Conditions promulgated in terms of FAIS, provide that a Discretionary Financial Service Provider shall enter into a written mandate with the Client to record the arrangements between the Client and the Financial Service Provider (FSP). The terms and conditions of this written mandate are recorded hereunder.');
      drawSectionParagraph('1.2', 'ALGOHIVE may, in order to render an intermediary service to the Client, utilise the services of its own staff/approved strategists or that of another approved FSP.');
      drawSectionParagraph('1.3', 'ALGOHIVE is authorised to invest in any of the following financial product categories:');

      drawCategoryTable('Category I', 'Advice and Intermediary Services', [
        ['1.1',  'Long term Insurance Sub Category A', 'X'],
        ['1.3',  'Long term Insurance Sub Category B1', 'X'],
        ['1.4',  'Long term Insurance Sub Category C', 'X'],
        ['1.20', 'Long term Insurance Sub Category B2', 'X'],
        ['1.5',  'Retail Pension Funds', 'X'],
        ['1.7',  'Pension Fund Benefits', 'X'],
        ['1.8',  'Shares', 'X'],
        ['1.9',  'Money Market', 'X'],
        ['1.17', 'Participatory Interest in a Collective Investment Scheme', 'X'],
        ['1.17', 'Long-term Deposits', 'X'],
        ['1.18', 'Short-term Deposits', 'X'],
        ['1.20', 'Long term Insurance Sub Category B2', 'X'],
        ['1.27', 'Crypto Assets', 'X']
      ]);

      drawCategoryTable('Category II', 'Intermediary Services', [
        ['2.5',  'Shares', 'X'],
        ['2.11', 'Participatory Interest in a Collective Investment Scheme', 'X'],
        ['2.13', 'Long term Deposits', 'X'],
        ['2.14', 'Short term deposits', 'X'],
        ['2.21', 'Crypto Assets', 'X']
      ]);

      drawSectionParagraph('1.4', 'Prior to entering into this Mandate ALGOHIVE obtained from the Client information, with regards to the Client\u2019s financial circumstances, needs and objectives and such other information necessary to enable ALGOHIVE to render suitable intermediary services to the Client in terms');
      drawInitials();

      /* ===== PAGE 4 &mdash; Authorisation, Investment Objectives, Risk Disclosure ===== */
      doc.addPage(); y = m;
      drawPageNumber(4);

      drawParagraph('hereof. Alternatively, ALGOHIVE has ascertained that such information was obtained from the Client\u2019s financial advisor and has checked that the advisor is licensed in terms of the FAIS Act.');

      drawSubHeading('2. AUTHORISATION');
      drawSectionParagraph('2.1', 'The Client hereby authorises ALGOHIVE to manage the Client\u2019s investments either with full discretion or limited discretion as set out in the schedule that is attached to this Mandate.');
      drawSectionParagraph('2.2', 'This Mandate and attached schedules authorise ALGOHIVE, as the Client\u2019s duly authorised agent, to purchase, sell and enter into any transaction on the Client\u2019s behalf and in respect of the investments:');
      drawSectionParagraph('2.3', 'ALGOHIVE may implement investment instructions or model portfolios that replicate, or mirror investment strategies selected by the Client from approved strategist models, within the discretion authorised under this mandate.');
      drawSectionParagraph('2.4', 'ALGOHIVE may invest in foreign investments on behalf of the Client.');

      drawSubHeading('3. INVESTMENT OBJECTIVES');
      drawSectionParagraph('3.1', 'The Client\u2019s investment objectives are specified in the schedule that is attached to this Mandate.');
      drawSectionParagraph('3.2', 'The Client\u2019s risk profile is determined considering the Client\u2019s current set of information and circumstances and the Client acknowledges that these circumstances and information may change over time.');
      drawSectionParagraph('3.3', 'The Client warrants the on-going accuracy and correctness of the Client\u2019s investment objectives and any other information that has been provided to ALGOHIVE in order to conclude this Mandate.');

      drawSubHeading('4. RISK DISCLOSURE');
      drawSectionParagraph('4.1', 'ALGOHIVE uses its discretion to invest on the Client\u2019s behalf with great care and diligence. However, the Client acknowledges that there is a risk associated with investing in the financial products involved. The value of the investments and income may rise as well as fall, and there is a risk that the Client may suffer financial losses.');
      drawSectionParagraph('4.2', 'Where the Client selects a strategist model for replication, performance may vary due to timing, execution, liquidity, and cost factors. Past performance of strategist models is not necessarily indicative of future results. ALGOHIVE does not guarantee identical performance or outcomes.');
      drawSectionParagraph('4.3', 'The Client acknowledges that it has been made aware by ALGOHIVE of risks pertaining to the investments which may result in financial loss to it and acknowledges that it accepts such risks and ALGOHIVE or its staff will not be liable or responsible for any financial losses.');
      drawSectionParagraph('4.4', 'The Client hereby irrevocably indemnifies ALGOHIVE and holds it harmless against all and any claims of whatsoever nature that might be made against it howsoever arising from its management of the investments including but not limited to any loss or damage which might be suffered by the Client in consequence of any depreciation in the value of the investments from whatsoever cause arising.');
      drawSectionParagraph('4.5', 'When investing in foreign investment products, it is important to be aware of the following risks:');
      drawInitials();

      /* ===== PAGE 5 &mdash; Risk Disclosure continued, Registration of Investments ===== */
      doc.addPage(); y = m;
      drawPageNumber(5);

      drawSectionParagraph('4.5.1', 'Obtaining access to investment performance information may be more difficult than South African based investments.', 30);
      drawSectionParagraph('4.5.2', 'Investments are exposed to different tax regimes which may change without warning, and which may influence investment returns.', 30);
      drawSectionParagraph('4.5.3', 'Exchange control measures may change in the country of investment and it may influence accessibility to the invested capital;', 30);
      drawSectionParagraph('4.5.4', 'The value of the Rand with respect to the base currencies in which the foreign investment products are invested will fluctuate. The Rand value of such foreign investment products will also fluctuate accordingly.', 30);
      drawSectionParagraph('4.6', 'Subject to its discretionary authorisation, ALGOHIVE may invest in wrap funds or models on behalf of the Client in terms of this Mandate and is thus required by the registrar to make certain disclosures regarding wrap funds and how they differ from funds of funds:');
      drawSectionParagraph('4.6.1', 'A fund of funds is a collective investment scheme fund that is not allowed to invest more than 50% of the value of the fund in any one collective investment scheme fund. The Collective Investment Scheme Act guarantees the repurchase of participatory interests in a fund of funds by the management company.', 30);
      drawSectionParagraph('4.6.2', 'A wrap fund or a model is a basket of different collective investment schemes wrapped as a single investment portfolio. The underlying combination of collective investments schemes is selected optimally to target the risk/return requirement and investment objectives of the client. In fact, it is a number of separate investments in which the investor has direct ownership. These underlying investments are selected in line with the investment requirements of the Client. There is no joint ownership among investors and individual ownership of the participatory interests in the collective investment schemes can be transparently demonstrated at all times. A wrap fund investment is administered and facilitated by a linked investment service provider (LISP) i.e. an Administrative FSP. A wrap fund has no limit concerning the collective investment schemes that it may include in its portfolio. The Administrative FSP of the wrap funds does not guarantee the repurchase of participatory interests in the collective investment schemes that comprise the wrap funds. The Administrative FSP has service level agreements in place with the management company of each collective investment scheme according to which the repurchase of participatory interests in collective investment schemes comprising wrap funds are guaranteed. The costs and other information applicable to wrap funds are set out in the documentation of the administrator of the wrap funds.', 30);
      drawSectionParagraph('4.7', 'Any jurisdiction restrictions in respect of the client\u2019s portfolio are specified in the schedule that is attached to this Mandate.');

      drawSubHeading('5. REGISTRATION OF INVESTMENTS');
      drawSectionParagraph('5.1', 'All investments managed by ALGOHIVE in terms of this Mandate shall, at ALGOHIVE\u2019s election, be registered from time to time in the name of:');
      drawSectionParagraph('5.1.1', 'The Client, or', 30);
      drawInitials();

      /* ===== PAGE 6 &mdash; Registration cont, Treatment of Funds, Voting, Section 8 header ===== */
      doc.addPage(); y = m;
      drawPageNumber(6);

      drawSectionParagraph('5.1.2', 'A Nominee company as the custodian thereof for the benefit of the Client, or', 30);
      drawSectionParagraph('5.1.3', 'A Nominee company of a member of the relevant stock or securities exchange, or', 30);
      drawSectionParagraph('5.1.4', 'In the case of a discretionary LISP, the independent custodian', 30);
      drawSectionParagraph('5.2', 'The Client warrants and undertakes that all investments entrusted and/or delivered by it, or under its authority, to ALGOHIVE in terms of or for the purposes of this Mandate, are not and will not be subject to any lien, charge or other encumbrance or impediment to transfer and that the same shall remain free to any such lien, charge, encumbrance or impediment whilst subject to ALGOHIVE\u2019s authority pursuant to this Mandate.');

      drawSubHeading('6. TREATMENT OF FUNDS');
      drawSectionParagraph('6.1', 'ALGOHIVE shall not receive funds from the Client for the purpose of managing the investments as defined in the Mandate. The Client will deposit the funds directly into the bank account of the investment company or their nominee company (see Annexure A for banking details) where such funds are to be placed for the future management of the investment. Further, ALGOHIVE will not receive any monies whatsoever which are not received through the intermediation of a bank.');
      drawSectionParagraph('6.2', 'Any income, dividends or other distributions generated by the investment will be re-invested in the investment for the Client unless otherwise instructed in the Schedule. If the Client instructs such income, dividends or other distributions to be paid to the Client quarterly or six-monthly, depending on the underlying investments, payment will be effected into the Client\u2019s stipulated bank account as they fall due.');
      drawSectionParagraph('6.3', 'In respect of any monies received from an ALGOHIVE client and paid into the ALGOHIVE Client Account, a rate equal to the prevailing banks daily call rate will be accrued and invested for or on behalf of the client as part of their portfolio as soon as the investment on behalf of the client is made. Any other cash portfolio utilized by ALGOHIVE on behalf of a client which earns either interest and/or dividends will be solely for the account of the client after the deduction of the stated fees. Both interest and dividends will be apportioned immediately following accrual and receipt thereof.');
      drawSectionParagraph('6.4', 'No third-party payments will be undertaken by ALGOHIVE on behalf of the Client.');

      drawSubHeading('7. VOTING ON BEHALF OF CLIENTS');
      drawSectionParagraph('7.1', 'ALGOHIVE may vote on behalf of the Client in respect of a ballot conducted by collective investment scheme in so far as the ballot relates to the investments managed by ALGOHIVE on behalf of the Client.');

      drawSubHeading('8. INFORMATION TO BE DISCLOSED BY PRODUCT PROVIDERS');
      drawInitials();

      /* ===== PAGE 7 &mdash; Sections 8, 9, 10, 11 ===== */
      doc.addPage(); y = m;
      drawPageNumber(7);

      drawSectionParagraph('8.1', 'The Client confirms that ALGOHIVE shall not be required to provide the Client with any information other than that which a product provider, such as a collective investment scheme or other listed insurance company, is required by law to disclose to the Client.');

      drawSubHeading('9. PROHIBITION AGAINST SELLING OR BUYING CERTAIN INVESTMENTS');
      drawSectionParagraph('9.1', 'ALGOHIVE shall not directly or indirectly:');
      drawSectionParagraph('9.1.1', 'Sell any financial products owned by ALGOHIVE to the Client', 30);
      drawSectionParagraph('9.1.2', 'Buy for its own account any investments owned by the Client', 30);

      drawSubHeading('10. DECLARATION REGARDING FUNDS & INVESTMENTS');
      drawSectionParagraph('10.1', 'The Client warrants, declares and undertakes that all investments entrusted and/or delivered by it, or under its authority, to ALGOHIVE in terms or for the purposes of this Mandate are derived from legitimate sources and do not constitute the \u201Cproceeds of unlawful activities\u201D either as defined in the Prevention of Organised Crime Act No. 121 of 1998, as amended, or at all.');
      drawSectionParagraph('10.2', 'The Client further warrants that, where required, all funds entrusted to ALGOHIVE in terms or for the purpose of this Mandate are duly declared in terms of the Income Tax Act of 1962 and that the Client has obtained all necessary approvals from the South African Reserve Bank for foreign funds, assets or investments owned by the Client.');

      drawSubHeading('11. REPORTING');
      drawSectionParagraph('11.1', 'ALGOHIVE shall furnish the Client with quarterly reports concerning the Client\u2019s investments.');
      drawSectionParagraph('11.2', 'ALGOHIVE may furnish the Client with electronic reports provided that the Client can access the reports.');
      drawSectionParagraph('11.3', 'The reports shall contain such information as is reasonably necessary to enable the Client to:');
      drawSectionParagraph('11.3.1', 'Produce a set of financial statements;', 30);
      drawSectionParagraph('11.3.2', 'Determine the composition of the financial products comprising the investments and any changes therein over the period to which such report relates;', 30);
      drawSectionParagraph('11.3.3', 'Determine the market value of such financial products and any changes therein during the period to which such report relates.', 30);
      drawSectionParagraph('11.4', 'ALGOHIVE shall, on request in a comprehensible and timely manner, provide to the Client any reasonable information regarding the investments, market practices and the risks inherent in the different markets and products.');
      drawSectionParagraph('11.5', 'Reports will include details of portfolio holdings, transactions, and where applicable, performance attribution relative to the selected strategist model.');
      drawInitials();

      /* ===== PAGE 8 &mdash; Remuneration, Disputes ===== */
      doc.addPage(); y = m;
      drawPageNumber(8);

      drawSubHeading('12. REMUNERATION');
      drawSectionParagraph('12.1', 'In consideration for the management by ALGOHIVE of the investments, the Client shall make payment to ALGOHIVE an annual management fee of 1.00% based on the market value of the portfolio of the Client. Such management fee will be calculated on the market value of the portfolio at the end of each month.');
      drawSectionParagraph('12.2', 'ALGOHIVE may recover the remuneration referred to above at intervals of 1 month from the investment of the Client.');
      drawSectionParagraph('12.3', 'ALGOHIVE will receive no commission / incentives, fee reductions or rebates from a LISP, collective investment scheme for placing the Client\u2019s funds with them.');
      drawSectionParagraph('12.4', 'In the event of ALGOHIVE being remunerated by the Life Assurance or Investment Companies, this fact will be disclosed to the Client and the parties may elect to negotiate a different fee structure.');
      drawSectionParagraph('12.5', 'Fees for managing the Client\u2019s investments will depend on the type of solution selected:');

      y += 4;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 30, 30);
      ensureSpace(14);
      doc.text('(a) AlgoHive Managed Funds', m + 4, y + 10);
      y += 16;
      drawParagraph('For investments placed into AlgoHive-managed funds or model portfolios (excluding the OpenStrategies platform), the Client shall pay an annual management fee of 0.99% based on the market value of the portfolio. This fee will be calculated monthly in arrears on the closing market value and deducted directly from the investment account.', 20);

      doc.setFont('helvetica', 'bold');
      ensureSpace(14);
      doc.text('(b) OpenStrategies Platform', m + 4, y + 10);
      y += 16;
      drawParagraph('For investments executed via the OpenStrategies mirrored strategy platform, no asset-based management fee will be charged. Instead:', 20);
      drawParagraph('70% of profits realised accrue to the Client,', 20);
      drawParagraph('20\u201325% of profits are allocated to the selected Strategist, and', 20);
      drawParagraph('5\u201310% of profits are retained by AlgoHive for platform and oversight services.', 20);
      drawParagraph('These allocations are calculated and settled in accordance with the OpenStrategies participation terms signed by the Client.', 20);

      doc.setFont('helvetica', 'bold');
      ensureSpace(14);
      doc.text('(c) Transaction Costs', m + 4, y + 10);
      y += 16;
      drawParagraph('Brokerage and execution fees, including those from Interactive Brokers (IBKR) or any appointed execution broker, are for the Client\u2019s account. AlgoHive may earn a margin on these execution costs and pass them through at cost as disclosed by the executing broker.', 20);

      drawSectionParagraph('12.6', 'Fees and performance allocations will be deducted automatically from the investment account and itemised in periodic statements provided to the Client.');

      drawSubHeading('13. DISPUTES');
      drawSectionParagraph('13.1', 'If any dispute or difference arises as to the validity, interpretation, effect or rights and obligations of either party under this Mandate, either party shall have the right to require that such dispute or difference be referred for a decision to arbitration before a single arbitrator.');
      drawSectionParagraph('13.2', 'The arbitration shall be held in an informal manner in Durban and the identity of the arbitrator shall be mutually agreed upon between the parties within a period of 5 (five) days from the date that the arbitration is called for. The arbitrator shall be an attorney or advocate of 10 (ten) years\u2019 standing or more with experience and knowledge of insurance law and with no interest in the proceedings.');
      drawSectionParagraph('13.3', 'The parties agree to keep the arbitration, its subject matter and evidence heard during the arbitration confidential and not to disclose it to any other person.');
      drawSectionParagraph('13.4', 'The decision of the arbitrator shall be final and binding upon the parties and not subject to appeal.');
      drawInitials();

      /* ===== PAGE 9 &mdash; Disputes cont, Termination, Effective Date, Admin ===== */
      doc.addPage(); y = m;
      drawPageNumber(9);

      drawSectionParagraph('13.5', 'The arbitrator shall include in his award an order as to the costs of the arbitration and who shall bear them.');
      drawSectionParagraph('13.6', 'The arbitrator shall at his sole discretion decide on the formulation of the dispute for arbitration but shall at all times be guided by the requirements of the Financial Advisory and Intermediary Services Act 2002 and all applicable ancillary legislation.');
      drawSectionParagraph('13.7', 'The inclusion of this arbitration clause shall not prevent a party from applying to court for urgent relief in the appropriate circumstances.');
      drawSectionParagraph('13.8', 'The parties agree that all the terms of this Mandate are material.');

      drawSubHeading('14. TERMINATION OF MANDATE');
      drawSectionParagraph('14.1', 'ALGOHIVE or the Client shall be entitled to terminate this Mandate by furnishing, the one to the other, not less than sixty (60) calendar days\u2019 written notice of such termination.');
      drawSectionParagraph('14.2', 'ALGOHIVE shall not initiate any market transactions in respect of any investments on behalf of the Client after receipt of notice of termination by the Client of this Mandate unless specifically instructed otherwise by the Client.');
      drawSectionParagraph('14.3', 'Upon receipt from the Client of any such notice of termination of this Mandate, all outstanding fees owing to ALGOHIVE in terms of or arising from the Mandate shall forthwith thereupon be and become due, owing and payable. In this regard the Client irrevocably authorises and empowers ALGOHIVE to deduct such fees either from the cash standing to the credit of the investment\u2019s portfolio or from the sale of any securities or financial instruments forming part of the investments if such cash balance is insufficient to enable payment of such fees to be made.');
      drawSectionParagraph('14.4', 'Notwithstanding any other provision in this Mandate, ALGOHIVE\u2019s appointment shall immediately cease without prejudice to the rights and obligations of ALGOHIVE and the Client if its status as an authorised financial services provider is finally withdrawn in terms of the FAIS Act or any other provision of applicable legislation.');

      drawSubHeading('15. EFFECTIVE DATE');
      drawSectionParagraph('15.1', 'This Agreement will become of force and effect on last date of signature.');

      drawSubHeading('16. ADMINISTRATIVE ARRANGEMENTS');
      drawSectionParagraph('16.1', 'The Client shall apply for the investment products and portfolios on the applicable initial investment application forms.');
      drawSectionParagraph('16.2', 'Any amendment of any provision of this mandate shall be in writing and shall be by means of a supplementary or new agreement between ALGOHIVE and the Client.');
      drawSectionParagraph('16.3', 'ALGOHIVE may make use of the services of its staff and/or that of another authorised financial services provider to execute certain administrative functions in the course of rendering intermediary services to the Client.');
      drawInitials();

      /* ===== PAGE 10 &mdash; Full Discretion ===== */
      doc.addPage(); y = m;
      drawHeading('SCHEDULE \u2013 FULL DISCRETION');

      ensureSpace(38);
      doc.setDrawColor(60, 60, 60);
      doc.setLineWidth(1.5);
      doc.rect(m, y, cw, 30);
      doc.setLineWidth(0.5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 30, 30);
      const warnLines = doc.splitTextToSize(
        'This schedule delegates authority to ALGOHIVE to effect transactions in your name without limitation.',
        cw - 16
      );
      doc.text(warnLines, m + 8, y + 12);
      y += 40;

      if (mandateNotSigned) {
        doc.setFillColor(255, 243, 205);
        doc.setDrawColor(255, 193, 7);
        doc.setLineWidth(1);
        doc.rect(m, y, cw, 22, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(102, 77, 3);
        doc.text('Client has not yet completed the mandate signing process &mdash; no selections recorded.', m + 8, y + 14);
        doc.setLineWidth(0.5);
        y += 30;
      }

      drawCheckbox(m + 10, y, fullLocal, 'Local jurisdictions only'); y += 20;
      drawCheckbox(m + 10, y, fullOffshore, 'Off-shore jurisdictions only'); y += 20;
      drawCheckbox(m + 10, y, fullBoth, 'Both local and off-shore jurisdictions'); y += 26;
      drawHorizonBlock('full');
      drawInitials();

      /* ===== PAGE 11 &mdash; Limited Discretion ===== */
      doc.addPage(); y = m;
      drawHeading('SCHEDULE \u2013 LIMITED DISCRETION');

      if (mandateNotSigned) {
        doc.setFillColor(255, 243, 205);
        doc.setDrawColor(255, 193, 7);
        doc.setLineWidth(1);
        doc.rect(m, y, cw, 22, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(102, 77, 3);
        doc.text('Client has not yet completed the mandate signing process &mdash; no selections recorded.', m + 8, y + 14);
        doc.setLineWidth(0.5);
        y += 30;
      }

      drawCheckbox(m + 10, y, limInstrSelf, 'On my instruction and prior consent'); y += 20;
      drawCheckbox(m + 10, y, limInstrAdvisor, 'On the instruction of my investment advisor'); y += 20;
      drawCheckbox(m + 10, y, limInstrAdvice, 'Upon me receiving advice and consent'); y += 26;

      drawCheckbox(m + 10, y, limLocal, 'Local jurisdictions only'); y += 20;
      drawCheckbox(m + 10, y, limOffshore, 'Off-shore jurisdictions only'); y += 20;
      drawCheckbox(m + 10, y, limBoth, 'Both local and off-shore jurisdictions'); y += 26;

      drawCheckbox(m + 10, y, limReinvest, 'Reinvested as and when they fall due'); y += 20;
      drawCheckbox(m + 10, y, limPayout, 'Paid out to client account'); y += 26;
      drawHorizonBlock('lim');
      drawInitials();

      /* ===== PAGE 12 &mdash; Addendum ===== */
      doc.addPage(); y = m;
      drawHeading('ADDENDUM TO MANDATE');

      const drawAddendumSection = (title: string, rows: [string, boolean | undefined][]) => {
        ensureSpace(30 + rows.length * 22);
        doc.setFillColor(224, 224, 224);
        doc.rect(m, y, cw, 20, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30, 30, 30);
        doc.text(title, pw / 2, y + 14, { align: 'center' });
        y += 22;
        rows.forEach(([label, checked]: [string, boolean | undefined]) => {
          doc.setDrawColor(51, 51, 51);
          doc.rect(m, y, cw, 20);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10);
          doc.setTextColor(30, 30, 30);
          doc.text(label, m + 8, y + 14);
          drawCheckbox(m + cw - 30, y + 13, checked, '');
          y += 20;
        });
        y += 8;
      };

      drawAddendumSection('Long Term (5 years or longer)', [
        ['Capital Growth',    ltGrowth],
        ['Income Generation', ltIncome]
      ]);
      drawAddendumSection('Medium Term (2 to 5 years)', [
        ['Capital Growth',    mtGrowth],
        ['Income Generation', mtIncome]
      ]);
      drawAddendumSection('Short Term (3 months to 2 years)', [
        ['Capital Growth',    stGrowth],
        ['Income Generation', stIncome]
      ]);
      drawAddendumSection('Risk Preference', riskEntries.map((r, i) => [r.label, riskChecked[i]]));
      drawInitials();

      /* ===== PAGE 13 &mdash; Annexure A ===== */
      doc.addPage(); y = m;
      drawPageNumber(13);

      drawHeading('Annexure A');
      drawSubHeading('Bank account details');
      drawParagraph('This account is the ALGOHIVE Client Account. You are required to pay your funds into this account and ALGOHIVE will execute transaction/s to invest these funds in Securities which will constitute your Portfolio in accordance with this Mandate.');
      y += 8;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(30, 30, 30);
      ensureSpace(16);
      doc.text('Local Bank Account', m + 4, y + 10);
      y += 20;

      drawField('Name of account',  'TBA');
      drawField('Bank',             'TBA');
      drawField('Type of account',  'Business Current Account');
      drawField('Account number',   '000 000 000');
      drawField('Branch opened',    'TBA');
      drawField('Branch code',      '000000');
      drawInitials();

      /* ---------- filename ---------- */
      const safeBase = sanitizeFilename(
        String([(profile as any)?.first_name, (profile as any)?.last_name].filter(Boolean).join('_') || (profile as any)?.id || 'client')
      ) || 'client';

      return { doc, filename: `mandate-${safeBase}.pdf` };

}
