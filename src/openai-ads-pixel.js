// OpenAI Ads Measurement Pixel for Shopify Customer Events (custom pixel).
// See README.md for setup, configuration and known limitations.

(() => {
  "use strict";

  const PIXEL_ID = "YOUR_PIXEL_ID";
  const DEBUG = false;

  const REQUIRE_MARKETING = true;
  const REQUIRE_ANALYTICS = true;
  const REQUIRE_SALE_OF_DATA = false;

  const ORDER_VALUE = "total";

  const ITEM_ID = "variant_id";

  const PERSIST_OPPREF = true;
  const OPPREF_COOKIE = "_oai_oppref_shop";
  const OPPREF_MAX_AGE = 60 * 60 * 24 * 30;

  const STOP_IF_MIRROR_FAILS = true;

  const SEND_PAGE_VIEW_ON_LATE_CONSENT = true;

  const SDK_URL = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
  const SDK_LOAD_TIMEOUT_MS = 10_000;

  const CURRENCIES_2 = (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL " +
    "BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP " +
    "DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR " +
    "ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD " +
    "MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN " +
    "PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP " +
    "STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES " +
    "WST XCD XCG YER ZAR ZMW ZWG"
  ).split(" ");
  const CURRENCIES_0 = "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" ");
  const CURRENCIES_3 = "BHD IQD JOD KWD LYD OMR TND".split(" ");
  const CURRENCIES_4 = "CLF UYW".split(" ");

  const CURRENCY_EXPONENT = new Map([
    ...CURRENCIES_2.map((c) => [c, 2]),
    ...CURRENCIES_0.map((c) => [c, 0]),
    ...CURRENCIES_3.map((c) => [c, 3]),
    ...CURRENCIES_4.map((c) => [c, 4]),
  ]);

  const log = (...args) => DEBUG && console.log("[OpenAI Pixel]", ...args);
  const logError = (...args) => console.error("[OpenAI Pixel]", ...args);

  if (PIXEL_ID === "YOUR_PIXEL_ID" || PIXEL_ID.trim() === "") {
    logError("Please set PIXEL_ID.");
    return;
  }

  // Classic function on purpose: the SDK replays native `arguments` objects.
  if (!window.oaiq) {
    const queue = function () { queue.q.push(arguments); };
    queue.q = [];
    window.oaiq = queue;
  }

  let privacy = init.customerPrivacy;
  let consentEpoch = 0;
  let lastPageHref = init.context?.document?.location?.href ?? null;
  let pendingPageView = null;

  let sdkState = "idle";
  let sdkPromise = null;
  let sdkConsentSent = null;

  let preparedEpoch = -1;
  let mirroredHref = null;
  let currentOppref = null;

  let jobChain = Promise.resolve();
  let cookieChain = Promise.resolve();

  const trackingAllowed = () =>
    (!REQUIRE_MARKETING || privacy?.marketingAllowed === true) &&
    (!REQUIRE_ANALYTICS || privacy?.analyticsProcessingAllowed === true) &&
    (!REQUIRE_SALE_OF_DATA || privacy?.saleOfDataAllowed === true);

  const isCurrent = (job) => job.epoch === consentEpoch && trackingAllowed() && sdkState !== "failed";

  const hrefFromEvent = (event) => event?.context?.document?.location?.href ?? null;

  const setSdkConsent = (value) => {
    if (sdkConsentSent === value) return;
    sdkConsentSent = value;
    window.oaiq("consent", value);
  };

  const markFailed = (reason, error) => {
    if (sdkState === "failed") return;
    sdkState = "failed";
    window.oaiq.q?.splice(0);
    sdkConsentSent = null;
    setSdkConsent(false);
    logError(`Tracking disabled for this page: ${reason}`, error?.message ?? "");
  };

  const parseUrl = (href) => {
    try {
      return new URL(href);
    } catch {
      return null;
    }
  };

  const opprefFromHref = (href) => parseUrl(href)?.searchParams.get("oppref") || null;

  const mirrorPageUrl = (pageHref, oppref) => {
    const url = parseUrl(pageHref);
    if (!url) return false;

    if (oppref) url.searchParams.set("oppref", oppref);
    else url.searchParams.delete("oppref");

    try {
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      log("Sandbox URL mirrored.");
      return true;
    } catch (error) {
      logError("Could not mirror sandbox URL. Click attribution will not work.", error?.message ?? "");
      return false;
    }
  };

  const cookieOp = (operation) => {
    const result = cookieChain.then(operation);
    cookieChain = result.catch(() => {});
    return result;
  };

  const storeOppref = (oppref) =>
    cookieOp(() =>
      browser.cookie.set(
        `${OPPREF_COOKIE}=${encodeURIComponent(oppref)}; path=/; max-age=${OPPREF_MAX_AGE}; SameSite=Lax`
      )
    );

  const readStoredOppref = () =>
    cookieOp(async () => {
      const stored = await browser.cookie.get(OPPREF_COOKIE);
      return stored ? decodeURIComponent(stored) : null;
    });

  const clearStoredOppref = () =>
    cookieOp(() => browser.cookie.set(`${OPPREF_COOKIE}=; path=/; max-age=0; SameSite=Lax`));

  const resolveOppref = async (pageHref) => {
    const urlOppref = opprefFromHref(pageHref);
    if (!PERSIST_OPPREF) return urlOppref;

    try {
      if (urlOppref) {
        await storeOppref(urlOppref);
        return urlOppref;
      }
      return await readStoredOppref();
    } catch (error) {
      log("Cookie error", error?.message ?? "");
      return urlOppref;
    }
  };

  const loadSdk = () => {
    sdkPromise ??= new Promise((resolve, reject) => {
      sdkState = "loading";
      setSdkConsent(true);
      window.oaiq("init", { pixelId: PIXEL_ID, debug: DEBUG });

      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const script = document.createElement("script");
      const timer = setTimeout(() => settle(reject, new Error("SDK load timeout")), SDK_LOAD_TIMEOUT_MS);

      script.async = true;
      script.src = SDK_URL;
      script.onload = () => settle(resolve);
      script.onerror = () => settle(reject, new Error("SDK could not be loaded (adblocker or CSP?)"));
      (document.head ?? document.documentElement).appendChild(script);
    }).then(
      () => {
        if (sdkState === "loading") sdkState = "ready";
      },
      (error) => markFailed("SDK load failed", error)
    );

    return sdkPromise;
  };

  const prepare = async (job) => {
    if (preparedEpoch !== consentEpoch) {
      const oppref = await resolveOppref(job.pageHref);
      if (!isCurrent(job)) return false;

      if (!mirrorPageUrl(job.pageHref, oppref) && STOP_IF_MIRROR_FAILS) {
        markFailed("sandbox URL could not be mirrored");
        return false;
      }
      currentOppref = oppref;
      mirroredHref = job.pageHref;
      preparedEpoch = consentEpoch;
      return true;
    }

    if (job.isPageView && job.pageHref && job.pageHref !== mirroredHref) {
      const newOppref = opprefFromHref(job.pageHref);
      if (newOppref && newOppref !== currentOppref) {
        currentOppref = newOppref;
        if (PERSIST_OPPREF) await storeOppref(newOppref).catch((error) => log("Cookie error", error?.message ?? ""));
        if (!isCurrent(job)) return false;
      }
      if (!mirrorPageUrl(job.pageHref, currentOppref) && STOP_IF_MIRROR_FAILS) {
        markFailed("sandbox URL could not be mirrored");
        return false;
      }
      mirroredHref = job.pageHref;
    }
    return true;
  };

  const runJob = async (job) => {
    if (!isCurrent(job)) return;
    if (!(await prepare(job))) return;
    if (!isCurrent(job)) return;

    await loadSdk();
    if (sdkState !== "ready" || !isCurrent(job)) return;

    const data = job.buildData();
    if (!data) return;

    setSdkConsent(true);
    const options = job.eventId ? { event_id: String(job.eventId) } : undefined;
    log("measure", job.eventName, data, options);
    window.oaiq("measure", job.eventName, data, options);
  };

  const track = (event, eventName, buildData, eventId) => {
    const href = hrefFromEvent(event);
    if (href) lastPageHref = href;

    if (sdkState === "failed") return;

    const isPageView = eventName === "page_viewed";
    if (!trackingAllowed()) {
      if (isPageView) pendingPageView = event;
      return;
    }
    if (isPageView) pendingPageView = null;

    const job = {
      epoch: consentEpoch,
      pageHref: href ?? lastPageHref,
      isPageView,
      eventName,
      buildData,
      eventId,
    };

    jobChain = jobChain
      .then(() => runJob(job))
      .catch((error) => logError(`Error in ${eventName}`, error?.message ?? ""));
  };

  api.customerPrivacy.subscribe("visitorConsentCollected", (event) => {
    const wasAllowed = trackingAllowed();
    privacy = event.customerPrivacy;
    const allowed = trackingAllowed();
    log("Consent updated -> allowed:", allowed);

    if (!allowed) {
      if (wasAllowed) {
        consentEpoch += 1;
        pendingPageView = null;
      }
      currentOppref = null;
      preparedEpoch = -1;
      if (sdkState !== "idle") setSdkConsent(false);
      clearStoredOppref().catch((error) => log("Cookie delete error", error?.message ?? ""));
      if (mirroredHref) mirrorPageUrl(mirroredHref, null);
      return;
    }

    if (SEND_PAGE_VIEW_ON_LATE_CONSENT && pendingPageView) {
      const pageView = pendingPageView;
      pendingPageView = null;
      track(pageView, "page_viewed", () => ({ type: "contents" }), pageView.id);
    }
  });

  const isPositiveInteger = (n) => Number.isSafeInteger(n) && n > 0;

  const toMinorUnits = (amount, currency) => {
    if (amount == null || (typeof amount === "string" && amount.trim() === "")) return null;
    if (typeof amount !== "number" && typeof amount !== "string") return null;

    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return null;

    const exponent = CURRENCY_EXPONENT.get(currency);
    if (exponent === undefined) {
      logError("Unknown currency:", currency);
      return null;
    }

    const minor = Math.round(value * 10 ** exponent);
    return Number.isSafeInteger(minor) ? minor : null;
  };

  const money = (moneyV2, fallbackCurrency) => {
    const currency = moneyV2?.currencyCode ?? fallbackCurrency;
    const amount = toMinorUnits(moneyV2?.amount, currency);
    return amount == null ? null : { amount, currency };
  };

  const exactUnitPrice = (lineTotal, quantity) =>
    lineTotal && lineTotal.amount % quantity === 0
      ? { amount: lineTotal.amount / quantity, currency: lineTotal.currency }
      : null;

  const itemId = (variant) => {
    const raw = {
      variant_id: variant?.id,
      product_id: variant?.product?.id,
      sku: variant?.sku,
    }[ITEM_ID];
    return raw ? String(raw) : null;
  };

  const buildItem = (variant, quantity, unitPrice) => {
    if (!variant || !isPositiveInteger(quantity)) return null;

    const id = itemId(variant);
    const name = variant.product?.title || variant.title;

    return {
      content_type: "product",
      quantity,
      ...(id && { id }),
      ...(name && { name }),
      ...unitPrice,
    };
  };

  const itemFromCheckoutLine = (line, fallbackCurrency) => {
    if (!isPositiveInteger(line?.quantity)) return null;
    const unitPrice = exactUnitPrice(money(line.finalLinePrice, fallbackCurrency), line.quantity);
    return buildItem(line.variant, line.quantity, unitPrice);
  };

  const itemsFromCheckout = (checkout) =>
    (checkout?.lineItems ?? [])
      .map((line) => itemFromCheckoutLine(line, checkout?.currencyCode))
      .filter(Boolean);

  const contentsPayload = (items = [], value = null) => ({
    type: "contents",
    ...(items.length > 0 && { contents: items }),
    ...value,
  });

  analytics.subscribe("page_viewed", (event) => {
    track(event, "page_viewed", () => ({ type: "contents" }), event.id);
  });

  analytics.subscribe("product_viewed", (event) => {
    track(event, "contents_viewed", () => {
      const variant = event.data?.productVariant;
      const price = money(variant?.price);
      const item = buildItem(variant, 1, price);
      return contentsPayload(item ? [item] : [], price);
    }, event.id);
  });

  analytics.subscribe("product_added_to_cart", (event) => {
    track(event, "items_added", () => {
      const line = event.data?.cartLine;
      const lineTotal = money(line?.cost?.totalAmount);
      const item = buildItem(line?.merchandise, line?.quantity, exactUnitPrice(lineTotal, line?.quantity));
      return contentsPayload(item ? [item] : [], lineTotal);
    }, event.id);
  });

  analytics.subscribe("checkout_started", (event) => {
    const checkout = event.data?.checkout;

    track(
      event,
      "checkout_started",
      () => contentsPayload(itemsFromCheckout(checkout), money(checkout?.totalPrice, checkout?.currencyCode)),
      checkout?.token ? `checkout_${checkout.token}` : event.id
    );
  });

  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event.data?.checkout;
    const orderId = checkout?.order?.id;

    track(
      event,
      "order_created",
      () => {
        const priceField = ORDER_VALUE === "subtotal" ? checkout?.subtotalPrice : checkout?.totalPrice;
        const value = money(priceField, checkout?.currencyCode);

        if (!value) {
          logError("order_created skipped: missing or invalid order value.");
          return null;
        }
        return contentsPayload(itemsFromCheckout(checkout), value);
      },
      orderId ? `order_${orderId}` : event.id
    );
  });
})();
