import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const source = path.resolve("docs/MINT_CANONICAL_SOURCE_OF_TRUTH_OPERATIONS.md");
const output = process.argv[2];
if (!output) throw new Error("output path required");
const purple = "4C1D95";
const violet = "7C3AED";
const pale = "F3E8FF";
const ink = "171024";
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const run = (text, options = {}) => `<w:r><w:rPr>${options.bold ? "<w:b/>" : ""}${options.color ? `<w:color w:val="${options.color}"/>` : ""}${options.size ? `<w:sz w:val="${options.size}"/>` : ""}${options.font ? `<w:rFonts w:ascii="${options.font}" w:hAnsi="${options.font}"/>` : ""}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text, options = {}) => `<w:p><w:pPr>${options.style ? `<w:pStyle w:val="${options.style}"/>` : ""}${options.after ? `<w:spacing w:after="${options.after}"/>` : ""}${options.shade ? `<w:shd w:fill="${options.shade}"/>` : ""}</w:pPr>${run(text, options)}</w:p>`;
const cell = (text, header = false) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:shd w:fill="${header ? purple : "FFFFFF"}"/><w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar></w:tcPr>${para(text, { bold: header, color: header ? "FFFFFF" : ink, size: 19 })}</w:tc>`;
const table = (rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="autofit"/><w:tblBorders><w:top w:val="single" w:sz="6" w:color="D8B4FE"/><w:left w:val="single" w:sz="6" w:color="D8B4FE"/><w:bottom w:val="single" w:sz="6" w:color="D8B4FE"/><w:right w:val="single" w:sz="6" w:color="D8B4FE"/><w:insideH w:val="single" w:sz="4" w:color="E9D5FF"/><w:insideV w:val="single" w:sz="4" w:color="E9D5FF"/></w:tblBorders></w:tblPr>${rows.map((r, i) => `<w:tr>${r.map((v) => cell(v, i === 0)).join("")}</w:tr>`).join("")}</w:tbl>${para("", { after: 80 })}`;

const lines = fs.readFileSync(source, "utf8").split(/\r?\n/);
let body = "";
let inCode = false;
let codeLines = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith("```")) {
    if (inCode) {
      body += `<w:p><w:pPr><w:shd w:fill="F8F5FF"/><w:spacing w:before="100" w:after="140"/></w:pPr>${codeLines.map((x, n) => run(`${n ? "\n" : ""}${x}`, { font: "Consolas", size: 18, color: "3B0764" })).join("")}</w:p>`;
      codeLines = [];
    }
    inCode = !inCode;
    continue;
  }
  if (inCode) { codeLines.push(line); continue; }
  if (line.startsWith("|")) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith("|")) {
      const values = lines[i].split("|").slice(1, -1).map((v) => v.trim().replaceAll("`", ""));
      if (!values.every((v) => /^[-: ]+$/.test(v))) rows.push(values);
      i++;
    }
    i--;
    if (rows.length) body += table(rows);
    continue;
  }
  if (line.startsWith("# ")) { body += para(line.slice(2), { style: "Title" }); continue; }
  if (line.startsWith("## ")) { body += para(line.slice(3), { style: "Heading1" }); continue; }
  if (line.startsWith("### ")) { body += para(line.slice(4), { style: "Heading2" }); continue; }
  if (/^\d+\. /.test(line)) { body += para(line.replace(/^\d+\. /, "• "), { style: "ListParagraph" }); continue; }
  if (line.startsWith("- ")) { body += para(`• ${line.slice(2)}`, { style: "ListParagraph" }); continue; }
  if (!line.trim()) { body += para(""); continue; }
  body += para(line.replaceAll("`", ""), { style: "Normal" });
}

const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1150" w:right="1050" w:bottom="1150" w:left="1050" w:header="500" w:footer="500"/><w:headerReference w:type="default" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:footerReference w:type="default" r:id="rId3" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:sectPr></w:body></w:document>`;
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:color w:val="${ink}"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:before="120" w:after="260"/><w:shd w:fill="${purple}"/></w:pPr><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="38"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${purple}"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="90"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="${violet}"/><w:sz w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:style></w:styles>`;
const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:color="${violet}"/></w:pBdr></w:pPr>${run("MINT  |  CANONICAL SOURCE OF TRUTH", { bold: true, color: purple, size: 18 })}</w:p></w:hdr>`;
const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run("MINT Engineering & Investment Operations  •  Controlled operations handbook  •  Page ", { color: "6B7280", size: 17 })}<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;

const zip = new JSZip();
zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.folder("word").file("document.xml", document).file("styles.xml", styles).file("header1.xml", header).file("footer1.xml", footer);
zip.folder("word/_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log(output);
