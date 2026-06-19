---
name: Email patterns
description: How transactional emails are built and sent in this app
---

## Transport
All emails use plain `fetch` to `https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}`. No Resend SDK installed.

## Senders
- Trade confirmations: `ORDERBOOK_EMAIL_FROM` env var (set to `noreply@mymint.co.za`)
- EFT/wallet emails: same env var
- Mint Mornings: `MINT_MORNINGS_FROM` env var (defaults to `MINT Mornings <mornings@mymint.co.za>`)

## Trade confirmation template
Built in `api/_orderbook.js` → `buildEmailHtml()` + `buildTradeRow()`. Table-based HTML, purple gradient header with inline "M" logo, BUY/SELL badge pills, reference banner. No external image URLs — fully self-contained.

**Why no images:** previous version used CID attachments and a Vercel-hosted header image; both caused issues (attachments appeared as downloads, external URL could break). Current approach is pure HTML/CSS.

## EFT template
Built client-side in `public/eft.html`, POSTed as HTML string to `/api/send-eft-email`. Images still reference `my-mint-admin.vercel.app` URLs — acceptable as they still resolve.

## Mint Mornings template
Built in `api/mint-mornings.js` → `buildMintMorningsHtml()`. Card-based layout with hero article, top headlines, market open section, and per-section news cards. Sources article body text parsed by `----------` separator into named sections.
