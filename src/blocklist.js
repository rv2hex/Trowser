'use strict';

// Network hygiene: everything the browser refuses to download, plus the
// honest count the footer badge shows. Two goals, both user-facing:
//
//   1. Speed + RAM. Videos are never fetched (the user asked for this
//      explicitly): no mp4/webm/m3u8 bytes ever enter memory, and media
//      elements never buffer. Fonts and trackers go the same way.
//   2. Clean pages. Ads/trackers are the bulk of the junk DOM that makes
//      article extraction ugly, so blocking them improves both looks and
//      extraction quality.
//
// The list is deliberately short and generic: hostnames shared by the big
// networks. Nothing site-specific, nothing that could break content
// delivery for the page itself.

const MEDIA_EXT = /\.(mp4|webm|m4v|mov|mkv|avi|m3u8|mpd|flv|ogv|mp3|m4a|aac|wav|flac|opus)(\?|#|$)/i;

// Hosts whose requests never leave the machine. Media (by extension) is
// blocked too, so video is never downloaded — see MEDIA_EXT.
const TRACKER_HOSTS = [
  // Google ads/analytics/tag manager
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'adservice.google.com',
  'partner.googleadservices.com',
  // Meta / Microsoft / X / LinkedIn / TikTok pixels
  'facebook.net',
  'facebook.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'bat.bing.com',
  'clarity.ms',
  'ads.linkedin.com',
  'analytics.linkedin.com',
  'px.ads.linkedin.com',
  'platform.twitter.com',
  'analytics.twitter.com',
  'static.ads-twitter.com',
  // Common ad + behaviour networks
  'adnxs.com',
  'adsrvr.org',
  'adform.net',
  'advertising.com',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'casalemedia.com',
  'smartadserver.com',
  'taboola.com',
  'outbrain.com',
  'branch.io',
  'crazyegg.com',
  'fullstory.com',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'scorecardresearch.com',
  'quantserve.com',
  'chartbeat.com',
  'newrelic.com',
  'nr-data.net',
  'sentry.io',
  'bugsnag.com',
  'intercom.io',
  'driftt.com',
  'optimizely.com',
  'onetrust.com',
  'cookiebot.com',
  'cookielaw.org',
];

// Cheap set built once: substring match on the hostname is intentional
// (covers apex + every subdomain) and false positives are all ad/tracker
// domains we would rather drop than render.
const TRACKER_SET = new Set(TRACKER_HOSTS);

// Path beacons on ANY host. Analytics pings hide inside first-party hosts
// (wikimedia.org/beacon, /px.gif, gtm containers…), so a hostname list
// alone under-counts. These paths never carry content.
const TRACKER_PATH = /\/(beacon|gtm\.js|gtag\/js|analytics(?:\.js)?|collect|px\.gif|stats\.g\.|telemetry|pixel(?:\.gif)?|track(?:\.js)?)(\?|$|\/)/i;

function isMediaUrl(url) {
  const s = String(url || '');
  if (MEDIA_EXT.test(s)) return true;
  // mime query hints used by some CDNs
  return /[?&](mime|content_type|type)=(video|audio)\//i.test(s);
}

// Hostname OR path tracker test. Returns false for anything unparseable so
// a weird URL is fetched rather than silently dropped.
function isTrackerUrl(url) {
  let host = '';
  let full = '';
  try {
    const u = new URL(String(url || ''));
    host = u.hostname.toLowerCase();
    full = u.pathname + (u.search || '');
  } catch {
    return false;
  }
  if (!host) return false;
  if (TRACKER_PATH.test(full)) return true;
  for (const t of TRACKER_SET) {
    if (host === t || host.endsWith(`.${t}`)) return true;
  }
  return false;
}

const BLOCKED_RESOURCES = new Set(['font', 'media']);

module.exports = { MEDIA_EXT, TRACKER_HOSTS, TRACKER_PATH, BLOCKED_RESOURCES, isMediaUrl, isTrackerUrl };