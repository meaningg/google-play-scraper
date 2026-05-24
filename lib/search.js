import * as R from "ramda";
import url from "url";
import request from "./utils/request.js";
import { BASE_URL } from "./constants.js";
import { processFullDetailApps } from "./utils/processPages.js";
import scriptData from "./utils/scriptData.js";

/*
 * Make the first search request as in the browser and extract apps from the
 * new Google Play search page structure (ds:4).
 */
function initialRequest(opts) {
  const url = `${BASE_URL}/store/search?q=${opts.term}&hl=${opts.lang}&gl=${opts.country}&price=${opts.price}`;
  return request(
    Object.assign({ url }, opts.requestOptions),
    opts.throttle,
  ).then((html) => processFirstPage(html, opts));
}

function extractDeveloperId(link) {
  return link.split("?id=")[1];
}

/*
 * Extract apps from Google Play's ds:4 data structure.
 *
 * Google moved search results from ds:1 to ds:4[0][1] (an array of "clusters").
 * Each cluster can contain:
 *   - A "featured" app with full details at the last non-null index's [16][2]
 *   - A flat array of compact app entries at the last non-null index's [0]
 *
 * The first cluster may have the featured app pattern; subsequent clusters
 * (and sometimes the first) have the flat array pattern.
 */
function extractSearchApps(html) {
  const sections = R.path(["ds:4", 0, 1], html);
  if (!Array.isArray(sections) || sections.length === 0) return [];

  const apps = [];

  for (const section of sections) {
    if (!Array.isArray(section)) continue;

    // Find the last non-null item in this section
    let lastIdx = section.length - 1;
    while (lastIdx >= 0 && section[lastIdx] === null) lastIdx--;
    if (lastIdx < 0) continue;

    const lastItem = section[lastIdx];
    if (!Array.isArray(lastItem)) continue;

    // Pattern 1: Featured app with full data at [16][2]
    const featuredApp = tryExtractFeaturedApp(lastItem);
    if (featuredApp) {
      apps.push(featuredApp);
    }

    // Pattern 2: Flat array of compact app entries at [0]
    const compactApps = tryExtractCompactApps(lastItem);
    for (const app of compactApps) {
      // Avoid duplicating the featured app
      if (app && !apps.some((a) => a.appId === app.appId)) {
        apps.push(app);
      }
    }
  }

  return apps;
}

function tryExtractFeaturedApp(item) {
  if (!Array.isArray(item[16]) || !item[16][2]) return null;

  const appData = item[16][2];
  const meta = item[16][3];

  const appId = meta?.["12"]?.[0]?.[0];
  if (!appId || typeof appId !== "string") return null;

  const title = appData[0]?.[0];
  if (!title) return null;

  const developerData = appData[68];
  const scoreData = appData[51];
  const iconPath = appData[95];

  const extractedUrl = R.path([41, 0, 2], appData)
    ? new url.URL(R.path([41, 0, 2], appData), BASE_URL).toString()
    : undefined;

  return {
    title,
    appId,
    url:
      extractedUrl || `https://play.google.com/store/apps/details?id=${appId}`,
    icon: R.path([0, 0, 3, 2], iconPath),
    developer: developerData?.[0],
    developerId: developerData?.[1]?.[4]?.[2]
      ? extractDeveloperId(developerData[1][4][2])
      : undefined,
    summary: R.path([73, 0, 1], appData),
    scoreText: R.path([51, 0, 0], appData),
    score: R.path([51, 0, 1], appData),
    price: 0,
    currency: "USD",
    free: true,
  };
}

function tryExtractCompactApps(item) {
  const apps = [];

  // The flat array could be at item[0] or item itself
  const candidates = [item[0]].filter(Boolean);

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;

    for (const entry of candidate) {
      if (!Array.isArray(entry)) continue;

      // Each entry wraps the app data in its first element
      const appData = entry[0];
      if (!Array.isArray(appData)) continue;

      const appId = appData[0]?.[0];
      if (!appId || typeof appId !== "string") continue;

      const scoreInfo = appData[4];
      const iconInfo = appData[1];
      const urlData = appData[10];
      const urlPath = urlData?.[4]?.[2];

      // Ensure URL is always present - construct from appId as fallback
      const entryUrl = urlPath
        ? new url.URL(urlPath, BASE_URL).toString()
        : `https://play.google.com/store/apps/details?id=${appId}`;

      apps.push({
        title: appData[3],
        appId,
        url: entryUrl,
        icon: extractIconFromCompactEntry(iconInfo),
        developer: appData[14],
        developerId: urlPath ? extractDeveloperId(urlPath) : undefined,
        summary: appData[13]?.[1],
        scoreText: scoreInfo?.[0],
        score: scoreInfo?.[1],
        price: 0,
        currency: "USD",
        free: true,
      });
    }
  }

  return apps;
}

function extractIconFromCompactEntry(iconData) {
  if (!Array.isArray(iconData)) return undefined;
  // Icon path in compact entries: [3][2] for the URL
  return iconData[3]?.[2];
}

async function processFirstPage(html, opts) {
  if (R.is(String, html)) {
    html = scriptData.parse(html);
  }

  const apps = extractSearchApps(html);

  if (apps.length === 0) return [];

  // Ensure every app has required fields (construct missing ones from appId as fallback)
  for (const app of apps) {
    if (app.appId) {
      if (!app.url) {
        app.url = `https://play.google.com/store/apps/details?id=${app.appId}`;
      }
      if (!app.icon) {
        app.icon = app.url;
      }
    }
  }

  let results = apps.slice(0, opts.num);

  if (opts.fullDetail && results.length > 0) {
    results = await processFullDetailApps(results, opts);
  }

  return results;
}

function getPriceGoogleValue(value) {
  switch (value.toLowerCase()) {
    case "free":
      return 1;
    case "paid":
      return 2;
    case "all":
    default:
      return 0;
  }
}

function search(appData, opts) {
  return new Promise(function (resolve, reject) {
    if (!opts || !opts.term) {
      throw Error("Search term missing");
    }

    if (opts.num && opts.num > 250) {
      throw Error("The number of results can't exceed 250");
    }

    opts = {
      term: encodeURIComponent(opts.term),
      lang: opts.lang || "en",
      country: opts.country || "us",
      num: opts.num || 20,
      fullDetail: opts.fullDetail,
      price: opts.price ? getPriceGoogleValue(opts.price) : 0,
      throttle: opts.throttle,
      cache: opts.cache,
      requestOptions: opts.requestOptions,
    };

    initialRequest(opts).then(resolve).catch(reject);
  }).then((results) => {
    if (opts.fullDetail && results.length > 0) {
      // if full detail is wanted get it from the app module
      return Promise.all(
        results.map((app) => appData({ ...opts, appId: app.appId })),
      );
    }
    return results;
  });
}

export default search;
