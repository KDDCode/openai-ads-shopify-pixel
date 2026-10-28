# OpenAI Ads Pixel for Shopify

Shopify **custom pixel** (Settings → Customer events) that sends conversion events to the
[OpenAI Ads Measurement Pixel](https://developers.openai.com/ads/measurement-pixel) (`oaiq`)
to measure ChatGPT ads. No app or theme changes are needed.

## Features

- Maps Shopify customer events to OpenAI events, including item data and order value
- Loads the SDK only after consent and reacts to consent changes without a reload, using Shopify's Customer Privacy API
- Sends `order_<id>` as `event_id`, so events are deduplicated against the Conversions API
- Keeps the ChatGPT click id (`oppref`) across page loads in a first-party cookie
- Keeps event order stable, serializes cookie access and drops queued events when consent is withdrawn
- Validates amounts and currencies (ISO 4217 minor units) and omits values it cannot compute exactly

## Event mapping

| Shopify event           | OpenAI event       | Value sent                                              |
| ----------------------- | ------------------ | ------------------------------------------------------- |
| `page_viewed`           | `page_viewed`      | –                                                       |
| `product_viewed`        | `contents_viewed`  | Variant price                                           |
| `product_added_to_cart` | `items_added`      | Cart line total                                         |
| `checkout_started`      | `checkout_started` | Checkout total                                          |
| `checkout_completed`    | `order_created`    | Checkout total or subtotal (see `ORDER_VALUE`)          |

Amounts are integers in the currency's minor unit, as OpenAI requires (EUR 49.90 → `4990`).

## Installation

1. Build the minified pixel with your Pixel ID from OpenAI Ads Manager (Conversions tab):

   ```bash
   npm install
   PIXEL_ID=<your-pixel-id> npm run build
   ```

   The output is `dist/openai-ads-pixel.min.js`. Add `DEBUG=true` to the command to get console output while testing.

2. In Shopify admin, open **Settings → Customer events → Add custom pixel**.
3. Paste the contents of the built file. It is JavaScript only, so do not wrap it in `<script>` tags.
4. Under **Customer privacy**, require the **Marketing** and **Analytics** permissions. Shopify then
   controls when the pixel starts, and the code handles consent changes during a page view.
5. Save and click **Connect**.

You can also paste `src/openai-ads-pixel.js` directly after setting `PIXEL_ID` in the file.

## Configuration

Constants at the top of `src/openai-ads-pixel.js`:

| Constant                         | Default         | Description                                                                         |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `PIXEL_ID`                       | `YOUR_PIXEL_ID` | OpenAI Pixel ID; the build script sets it                                           |
| `DEBUG`                          | `false`         | Console logging and SDK debug mode; logs never contain URLs or click ids            |
| `REQUIRE_MARKETING`              | `true`          | Requires `marketingAllowed`                                                         |
| `REQUIRE_ANALYTICS`              | `true`          | Requires `analyticsProcessingAllowed`                                               |
| `REQUIRE_SALE_OF_DATA`           | `false`         | Requires `saleOfDataAllowed` (US opt-out laws)                                      |
| `ORDER_VALUE`                    | `"total"`       | `"total"` (incl. shipping and taxes) or `"subtotal"`; must match the Conversions API |
| `ITEM_ID`                        | `"variant_id"`  | `"variant_id"`, `"product_id"` or `"sku"`; must match your OpenAI product feed      |
| `PERSIST_OPPREF`                 | `true`          | Stores the click id for 30 days                                                     |
| `STOP_IF_MIRROR_FAILS`           | `true`          | Sends nothing if the click id cannot be passed to the SDK                           |
| `SEND_PAGE_VIEW_ON_LATE_CONSENT` | `true`          | Sends the current page view when consent is given on that page                      |

## Known limitations

- **Sandbox workaround (unverified).** Shopify runs custom pixels in a sandboxed iframe whose URL is
  not the storefront URL, but the OpenAI SDK reads `oppref` from the page URL. Before the SDK loads,
  this pixel copies the storefront path and query into the sandbox URL with `history.replaceState()`.
  This is not a documented Shopify or OpenAI integration, it does not change the iframe's origin,
  and it is not known whether the SDK re-reads the URL after it has initialized. **Verify attribution in a live test.**
- **Browser only.** Ad blockers, browser tracking protection and declined consent reduce coverage.
  OpenAI recommends adding the server-side Conversions API; send the same `event_id` (`order_<id>`) from both.
- **Item prices.** Unit prices are sent only when the line total divides exactly by the quantity.
  Order-level discounts are not distributed to items. `finalLinePrice` requires Checkout Extensibility.
- **Currency list.** Currencies not in the built-in ISO 4217 list are rejected. Update the list when ISO 4217 changes.
- **Late consent.** Events from before consent are not sent, except the current page view.

## Testing

### Automated

```bash
npm test
```

The tests run the pixel in a simulated Shopify sandbox. They cover consent races, SDK load failures,
timeouts, failed URL mirroring, price and currency handling, and log hygiene. They do not replace a live test.

### Live

Build with `DEBUG=true`, then use Chrome incognito without ad blockers, with DevTools open.

1. Open `https://<shop>/?oppref=test_123` **without** accepting the cookie banner.
   No request to `bzrcdn.openai.com` should be made.
2. Accept the banner. `oaiq.min.js` loads and `Sandbox URL mirrored.` is logged.
3. Open another page. The request to `bzr.openai.com` must contain `test_123` and the **storefront URL**
   (not a `/wpm@…/sandbox/` URL).
4. View a product, add it to the cart and place a test order. Check the events, the amounts in minor
   units, and that `event_id` is `order_<id>`.
5. Withdraw consent. `consent:false` is sent and the `_oai_oppref_shop` cookie is removed.
6. Rebuild without `DEBUG` before going live.

A made-up `oppref` only proves that the click id is passed through. Real attribution shows up only
after real ad clicks, with 24–48 h reporting delay in Ads Manager.

## Project structure

```
src/openai-ads-pixel.js   Readable source (paste-ready after setting PIXEL_ID)
scripts/build.mjs         Sets PIXEL_ID/DEBUG and minifies with terser
test/pixel.test.mjs       Sandbox simulation tests (node:test)
dist/                     Build output (git-ignored)
```

## Requirements

Node.js ≥ 20 for building and testing. The pixel itself runs in Shopify's custom pixel sandbox.

## License

[MIT](LICENSE)
