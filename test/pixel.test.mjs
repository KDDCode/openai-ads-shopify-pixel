import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/openai-ads-pixel.js", import.meta.url), "utf8")
  .replace('"YOUR_PIXEL_ID"', '"px_test"');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const YES = { marketingAllowed: true, analyticsProcessingAllowed: true };
const NO = { marketingAllowed: false, analyticsProcessingAllowed: false };
const variant = { id: "v1", price: { amount: 49.9, currencyCode: "EUR" }, product: { id: "p1", title: "Mug" } };

// Minimal stand-in for Shopify's custom pixel sandbox.
const createSandbox = ({
  consent,
  sdk = "ok",
  sdkDelay = 10,
  cookieDelay = 5,
  mirrorFailFrom = Infinity,
  timeoutMs,
  debug = false,
} = {}) => {
  const subscriptions = {};
  const state = { scripts: 0, cookies: [], errors: [], logs: [] };
  let consentCallback;
  let mirrorCalls = 0;
  let eventCount = 0;

  let code = SOURCE.replace("const DEBUG = false;", `const DEBUG = ${debug};`);
  if (timeoutMs) code = code.replace("10_000", String(timeoutMs));

  const context = {
    URL, Number, Promise, setTimeout, clearTimeout, String, Math, Map, Error,
    console: {
      log: (...args) => state.logs.push(JSON.stringify(args)),
      error: (...args) => state.errors.push(String(args[1])),
    },
    history: {
      replaceState: () => {
        if (++mirrorCalls >= mirrorFailFrom) throw new Error("SecurityError");
      },
    },
    location: { href: "sandbox" },
    document: {
      createElement: () => ({}),
      head: {
        appendChild: (script) => {
          state.scripts++;
          setTimeout(() => (sdk === "ok" ? script.onload() : script.onerror()), sdkDelay);
        },
      },
    },
    analytics: { subscribe: (name, fn) => (subscriptions[name] = fn) },
    api: { customerPrivacy: { subscribe: (_name, fn) => (consentCallback = fn) } },
    init: { customerPrivacy: consent, context: { document: { location: { href: "https://shop.test/" } } } },
    browser: {
      cookie: {
        get: () => sleep(cookieDelay).then(() => null),
        set: (value) => sleep(cookieDelay).then(() => state.cookies.push(value.split(";")[0])),
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);

  return {
    state,
    emit: (name, href, data) =>
      subscriptions[name]({ id: `${name}_${++eventCount}`, name, data, context: { document: { location: { href } } } }),
    setConsent: (customerPrivacy) => consentCallback({ customerPrivacy }),
    // structuredClone moves values out of the vm realm for deepEqual.
    calls: () => structuredClone((context.window.oaiq.q ?? []).map((args) => [...args])),
    measures: () =>
      structuredClone(
        (context.window.oaiq.q ?? [])
          .map((args) => [...args])
          .filter(([method]) => method === "measure")
          .map(([, name, data, options]) => ({ name, data, eventId: options?.event_id }))
      ),
  };
};

const settle = () => sleep(150);

test("sends page view and product view in order", async () => {
  const s = createSandbox({ consent: YES });
  s.emit("page_viewed", "https://shop.test/products/mug?oppref=CLICK1");
  s.emit("product_viewed", "https://shop.test/products/mug?oppref=CLICK1", { productVariant: variant });
  await settle();
  assert.deepEqual(s.measures().map((m) => m.name), ["page_viewed", "contents_viewed"]);
  assert.equal(s.measures()[1].data.amount, 4990);
  assert.deepEqual(s.state.cookies, ["_oai_oppref_shop=CLICK1"]);
});

test("loads nothing without consent", async () => {
  const s = createSandbox({ consent: NO });
  s.emit("page_viewed", "https://shop.test/");
  await settle();
  assert.equal(s.state.scripts, 0);
  assert.equal(s.measures().length, 0);
});

test("revoke during SDK load, then re-consent: new events are sent", async () => {
  const s = createSandbox({ consent: YES, sdkDelay: 30 });
  s.emit("page_viewed", "https://shop.test/a");
  await sleep(15);
  s.setConsent(NO);
  await sleep(40);
  s.setConsent(YES);
  s.emit("product_viewed", "https://shop.test/a", { productVariant: variant });
  await settle();
  assert.deepEqual(s.measures().map((m) => m.name), ["contents_viewed"]);
  assert.equal(s.state.scripts, 1);
});

test("revoke and re-consent during cookie lookup: old job is dropped", async () => {
  const s = createSandbox({ consent: YES, cookieDelay: 30 });
  s.emit("page_viewed", "https://shop.test/a?oppref=CLICK1");
  await sleep(5);
  s.setConsent(NO);
  await sleep(5);
  s.setConsent(YES);
  s.emit("product_viewed", "https://shop.test/a?oppref=CLICK1", { productVariant: variant });
  await settle();
  assert.deepEqual(s.measures().map((m) => m.name), ["contents_viewed"]);
  assert.deepEqual(s.state.cookies, ["_oai_oppref_shop=CLICK1", "_oai_oppref_shop=", "_oai_oppref_shop=CLICK1"]);
});

test("late consent sends the pending page view, also after a repeated denial", async () => {
  const s = createSandbox({ consent: NO });
  s.emit("page_viewed", "https://shop.test/?oppref=CLICK2");
  await sleep(5);
  s.setConsent(NO);
  await sleep(5);
  s.setConsent(YES);
  await settle();
  assert.deepEqual(s.measures().map((m) => m.name), ["page_viewed"]);
});

test("failed URL mirroring stops tracking", async () => {
  const s = createSandbox({ consent: YES, mirrorFailFrom: 2 });
  s.emit("page_viewed", "https://shop.test/checkouts/x/info");
  await sleep(40);
  s.emit("page_viewed", "https://shop.test/checkouts/x/thank-you");
  await settle();
  assert.equal(s.measures().length, 0);
  assert.deepEqual(s.calls().at(-1), ["consent", false]);
});

test("SDK timeout locks tracking and leaves only consent=false", async () => {
  const s = createSandbox({ consent: YES, sdkDelay: 60, timeoutMs: 20 });
  s.emit("page_viewed", "https://shop.test/");
  await sleep(80);
  s.emit("product_viewed", "https://shop.test/", { productVariant: variant });
  await settle();
  assert.deepEqual(s.calls(), [["consent", false]]);
});

test("blocked SDK disables tracking", async () => {
  const s = createSandbox({ consent: YES, sdk: "error" });
  s.emit("page_viewed", "https://shop.test/");
  await settle();
  assert.equal(s.measures().length, 0);
  assert.match(s.state.errors[0], /Tracking disabled/);
});

test("order: exact unit prices only, invalid lines dropped, event id for dedup", async () => {
  const s = createSandbox({ consent: YES });
  s.emit("checkout_completed", "https://shop.test/t", {
    checkout: {
      currencyCode: "EUR",
      totalPrice: { amount: "30", currencyCode: "EUR" },
      order: { id: "7" },
      lineItems: [
        { quantity: 3, variant, finalLinePrice: { amount: "10.00", currencyCode: "EUR" } },
        { quantity: 2, variant, finalLinePrice: { amount: "10.00", currencyCode: "EUR" } },
        { quantity: 2, variant },
        { quantity: 0, variant },
      ],
    },
  });
  await settle();
  const [order] = s.measures();
  assert.equal(order.eventId, "order_7");
  assert.equal(order.data.amount, 3000);
  assert.deepEqual(order.data.contents.map((c) => [c.quantity, c.amount]), [[3, undefined], [2, 500], [2, undefined]]);
});

test("currency minor units and unknown currencies", async () => {
  const s = createSandbox({ consent: YES });
  for (const [currency, amount] of [["JPY", "1500"], ["KWD", "1.234"], ["XQQ", "10"]]) {
    s.emit("checkout_completed", "https://shop.test/t", {
      checkout: { currencyCode: currency, totalPrice: { amount, currencyCode: currency }, order: { id: currency } },
    });
  }
  s.emit("checkout_completed", "https://shop.test/t", {
    checkout: { currencyCode: "EUR", totalPrice: { amount: null, currencyCode: "EUR" }, order: { id: "null" } },
  });
  await settle();
  assert.deepEqual(s.measures().map((m) => [m.eventId, m.data.amount]), [["order_JPY", 1500], ["order_KWD", 1234]]);
});

test("debug logs never contain URLs or click ids", async () => {
  const s = createSandbox({ consent: YES, debug: true });
  s.emit("page_viewed", "https://shop.test/a?oppref=CLICK1");
  await settle();
  assert.ok(s.state.logs.length > 0);
  assert.ok(!s.state.logs.some((line) => line.includes("CLICK1") || line.includes("shop.test")));
});
