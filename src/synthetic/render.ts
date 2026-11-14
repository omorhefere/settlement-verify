import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import { formatPenceAsPounds } from "../checks.ts";
import type { LetterTruth } from "./types.ts";

// Draws a LetterTruth as a PDF, in one of the layout styles. Each layout uses
// a different date format and wording, as real creditors do.

type PdfDocument = PDFKit.PDFDocument;

// Makes an A4 PDF, lets `draw` put content on it, and returns the file bytes.
const drawPdfToBuffer = (title: string, draw: (doc: PdfDocument) => void): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: title } });
    const pdfChunks: Buffer[] = [];
    doc.on("data", (pdfChunk: Buffer) => pdfChunks.push(pdfChunk));
    doc.on("end", () => resolve(Buffer.concat(pdfChunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });

const dateTimeFromIso = (iso: string) => DateTime.fromISO(iso, { zone: "UTC" });
// A YYYY-MM-DD date written out: "11 November 2026".
export const formatIsoAsLongDate = (iso: string) => dateTimeFromIso(iso).toFormat("d MMMM yyyy"); // 11 November 2026
// A YYYY-MM-DD date in UK numeric form: "02/11/2026".
export const formatIsoAsNumericDate = (iso: string) => dateTimeFromIso(iso).toFormat("dd/MM/yyyy"); // 02/11/2026
// A YYYY-MM-DD date with an ordinal day: "5th November 2026".
export const formatIsoAsOrdinalDate = (iso: string) => {
  const dayOfMonth = dateTimeFromIso(iso).day;
  const suffix =
    dayOfMonth >= 11 && dayOfMonth <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[dayOfMonth % 10] ?? "th";
  return `${dayOfMonth}${suffix} ${dateTimeFromIso(iso).toFormat("MMMM yyyy")}`; // 5th November 2026
};

const drawLetterHeader = (doc: PdfDocument, truth: LetterTruth) => {
  doc.font("Helvetica-Bold").fontSize(18).text(truth.creditor.name);
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  for (const addressLine of truth.creditor.address) doc.text(addressLine);
  doc.text(truth.creditor.phone).fillColor("#000").moveDown(2);
  doc.fontSize(11);
  for (const addressLine of [truth.customer.name, ...truth.customer.address]) doc.text(addressLine);
  doc.moveDown();
};

const drawLetterFooter = (doc: PdfDocument, truth: LetterTruth) => {
  doc.moveDown(3).fontSize(7).fillColor("#666").text(
    `${truth.creditor.name} is a trading name of ${truth.creditor.legalName}. ${truth.creditor.legalName} is authorised and ` +
      "regulated by the Financial Conduct Authority (firm reference number 900001) and registered in England and " +
      "Wales (company number 00000001). This is a synthetic test document.",
  );
};

// One line of a table: label on the left, amount on the right.
const drawTableRow = (doc: PdfDocument, label: string, amountText: string, isBold = false) => {
  const rowTop = doc.y;
  doc.font(isBold ? "Helvetica-Bold" : "Helvetica").text(label, 56, rowTop, { width: 300 });
  doc.text(amountText, 356, rowTop, { width: 183, align: "right" });
  doc.font("Helvetica");
  doc.x = doc.page.margins.left; // back to the left margin for whatever follows
};

const drawAppLayout = (doc: PdfDocument, truth: LetterTruth) => {
  if (truth.validity.kind !== "period") throw new Error("app layout needs a validity period");
  drawLetterHeader(doc, truth);
  doc.text(formatIsoAsLongDate(truth.letterDate)).moveDown();
  doc.text(`Dear ${truth.customer.name.split(" ")[0]},`).moveDown();
  doc.font("Helvetica-Bold").text(`Settlement figure: ${formatPenceAsPounds(truth.settlementPence)}`).font("Helvetica").moveDown();
  doc.text(`Please note, your settlement figure is valid for ${truth.validity.wording}. To settle your loan, follow the steps below:`);
  doc.moveDown(0.5);
  ["Go to your Loan Dashboard", "Tap your loan", "Tap Settle loan", "Follow the steps on the screen"].forEach((step, stepIndex) =>
    doc.text(`${stepIndex + 1}. ${step}`, { indent: 12 }),
  );
  doc.moveDown().text("Kind regards,").text("Customer Team");
  drawLetterFooter(doc, truth);
};

const drawFormalLayout = (doc: PdfDocument, truth: LetterTruth) => {
  if (truth.validity.kind !== "date" || !truth.breakdown || !truth.accountNumber) {
    throw new Error("formal layout needs a date, breakdown and account number");
  }
  drawLetterHeader(doc, truth);
  doc.text(`Date: ${formatIsoAsNumericDate(truth.letterDate)}`);
  doc.text(`Agreement number: ${truth.accountNumber}`);
  if (truth.loanStartDate) doc.text(`Agreement date: ${formatIsoAsNumericDate(truth.loanStartDate)}`);
  doc.moveDown();
  doc.font("Helvetica-Bold").fontSize(13).text("EARLY SETTLEMENT STATEMENT").fontSize(11).font("Helvetica");
  doc.text("Consumer Credit Act 1974, section 97").moveDown();
  doc.text("Dear Customer,").moveDown(0.5);
  doc.text("As requested, the amount required to settle your agreement in full is shown below.").moveDown();
  drawTableRow(doc, "Outstanding balance", formatPenceAsPounds(truth.breakdown.balancePence));
  drawTableRow(doc, "Interest to settlement date", formatPenceAsPounds(truth.breakdown.interestPence));
  drawTableRow(doc, "Less rebate of charges", `-${formatPenceAsPounds(truth.breakdown.rebatePence)}`);
  doc.moveDown(0.3);
  drawTableRow(doc, "Settlement amount", formatPenceAsPounds(truth.settlementPence), true);
  doc.moveDown();
  doc.text(`This figure is valid until ${formatIsoAsNumericDate(truth.validity.date)}. After this date please request a new statement.`);
  drawLetterFooter(doc, truth);
};

const drawCarFinanceLayout = (doc: PdfDocument, truth: LetterTruth) => {
  if (truth.validity.kind !== "date" || !truth.breakdown || !truth.accountNumber) {
    throw new Error("car layout needs a date, breakdown and account number");
  }
  drawLetterHeader(doc, truth);
  doc.text(formatIsoAsOrdinalDate(truth.letterDate)).moveDown();
  doc.text(`Account: ${truth.accountNumber}`);
  if (truth.vehicleReg) doc.text(`Vehicle registration: ${truth.vehicleReg}`);
  doc.moveDown().font("Helvetica-Bold").text("Your settlement quotation").font("Helvetica").moveDown(0.5);
  doc.text(
    `Thank you for your request. The amount needed to settle your agreement is ${formatPenceAsPounds(truth.settlementPence)}, ` +
      `provided payment reaches us on or before ${formatIsoAsOrdinalDate(truth.validity.date)}.`,
  );
  doc.moveDown(0.5).text(`Your current balance is ${formatPenceAsPounds(truth.breakdown.balancePence)}.`);
  doc.moveDown().text("Ownership of the vehicle passes to you once the agreement is settled.");
  doc.moveDown().text("Yours sincerely,").text("Settlements Team");
  drawLetterFooter(doc, truth);
};

const drawNextPaymentLayout = (doc: PdfDocument, truth: LetterTruth) => {
  if (!truth.accountNumber) throw new Error("next_payment layout needs an account number");
  drawLetterHeader(doc, truth);
  doc.text(formatIsoAsLongDate(truth.letterDate)).moveDown();
  doc.text(`Loan reference: ${truth.accountNumber}`).moveDown();
  doc.text(`Dear ${truth.customer.name},`).moveDown(0.5);
  doc.text(`The amount required to repay your loan in full today is ${formatPenceAsPounds(truth.settlementPence)}.`);
  doc.text("This figure is valid until your next payment due date.");
  doc.moveDown().text("Kind regards,").text("Kestrel Customer Services");
  drawLetterFooter(doc, truth);
};

// Not a settlement letter: a normal monthly statement for the same loan.
const drawMonthlyStatementLayout = (doc: PdfDocument, truth: LetterTruth) => {
  drawLetterHeader(doc, truth);
  doc.font("Helvetica-Bold").fontSize(13).text("Monthly statement").fontSize(11).font("Helvetica");
  doc.text(`Statement date: ${formatIsoAsNumericDate(truth.letterDate)}`);
  if (truth.accountNumber) doc.text(`Agreement number: ${truth.accountNumber}`);
  doc.moveDown();
  drawTableRow(doc, "Opening balance", formatPenceAsPounds((truth.breakdown?.balancePence ?? truth.settlementPence) + 21_450));
  drawTableRow(doc, "Payment received", "-£214.50");
  drawTableRow(doc, "Closing balance", formatPenceAsPounds(truth.breakdown?.balancePence ?? truth.settlementPence), true);
  doc.moveDown().text("Your next payment of £214.50 is due on 01/12/2026.");
  drawLetterFooter(doc, truth);
};

const DRAW_FUNCTION_BY_LAYOUT = {
  app: drawAppLayout,
  formal: drawFormalLayout,
  car_finance: drawCarFinanceLayout,
  next_payment: drawNextPaymentLayout,
  monthly_statement: drawMonthlyStatementLayout,
};

// Draws the letter described by a LetterTruth, in its layout, as a PDF.
// `title` goes in the PDF's metadata. Returns the PDF file bytes.
export const renderLetterTruthAsPdf = (truth: LetterTruth, title: string): Promise<Buffer> =>
  drawPdfToBuffer(title, (doc) => DRAW_FUNCTION_BY_LAYOUT[truth.layout](doc, truth));
