import { sendEmail, buildTradeConfirmationHtml } from "./src/lib/admin/email";

async function main() {
  const html = buildTradeConfirmationHtml({
    firstName: "Mufaro",
    symbol: "FAKE",
    name: "Fake Instrument Ltd",
    quantity: 100,
    price: 15.50
  });

  await sendEmail({
    to: "mufaroncibe90@gmail.com",
    subject: "Trade Confirmation (TEST)",
    html: html,
    emailType: "trade_confirmation_test",
    source: "cli-script"
  });

  console.log("Email sent successfully!");
}

main().catch(err => {
  console.error("Failed to send email:", err);
  process.exit(1);
});
