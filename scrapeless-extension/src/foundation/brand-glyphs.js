/**
 * Vendor glyphs
 *
 * The picker shipped fourteen third-party logo PNGs inherited from the
 * upstream project — Akamai, AWS, Cloudflare, F5, Imperva, reCAPTCHA and the
 * rest. Two problems with keeping them: they are somebody else's artwork
 * bundled in our package, and they are the upstream project's asset set, so
 * the grid looked like its grid.
 *
 * These are our own marks, drawn in the same line language as the fingerprint
 * glyphs — deliberately NOT imitations of the vendors' logos, because a
 * lookalike would carry the same trademark problem as the original file. Each
 * says what kind of thing the vendor is; the vendor is named in the label
 * beneath it, which is where naming a competitor belongs.
 *
 * Keyed by the original filenames so every detector's `icon` field, every
 * saved rule and every export keeps working untouched.
 */
(function localAttachVendorGlyphs(scopeRoot) {
  'use strict';

  const localSvg = (localBody) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
    + 'stroke-linecap="round" stroke-linejoin="round">' + localBody + '</svg>';

  const toPayloadAddress = (localMarkup) => {
    if (!localMarkup) return '';
    const localImageMarkup = localMarkup.replace(
      '<svg ',
      '<svg xmlns="http://www.w3.org/2000/svg" color="#a3a3a3" '
    );
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(localImageMarkup)}`;
  };

  const LOCAL_GLYPHS = {
    // Edge networks — concentric reach from a point of presence.
    'akamai_official.png': localSvg('<circle cx="12" cy="12" r="2.5"/><path d="M6.5 8.2a7 7 0 0 0 0 7.6"/><path d="M17.5 8.2a7 7 0 0 1 0 7.6"/><path d="M3.6 5.4a11 11 0 0 0 0 13.2"/><path d="M20.4 5.4a11 11 0 0 1 0 13.2"/>'),
    'cloudflare_official.png': localSvg('<path d="M9.5 17.5h8a3.5 3.5 0 0 0 .2-7 5 5 0 0 0-9.4-1.6A3.7 3.7 0 0 0 9.5 17.5z"/><path d="M2 11.5h4M2.8 14.6h3.4M4 17.5h2.6"/>'),

    // Cloud platform — a stack behind the cloud.
    'aws_official.png': localSvg('<path d="M8.8 11.5h6.4a2.8 2.8 0 0 0 .2-5.6 4 4 0 0 0-7.4-1.1A2.9 2.9 0 0 0 8.8 11.5z"/><path d="M4 15h16M6 18h12M8 21h8"/>'),

    // Bot management — a figure inside a boundary.
    'datadome_official.png': localSvg('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M3 16h18"/><circle cx="12" cy="10" r="2"/><path d="M12 19v2"/>'),
    'perimeterx_official.png': localSvg('<path d="M4 4h4M16 4h4M20 8v4M20 16v4M16 20h-4M8 20H4M4 16v-4M4 8V4"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>'),
    'reblaze_official.png': localSvg('<path d="M12 2.5c3.4 3.2 5.4 6.1 5.4 8.9A5.4 5.4 0 0 1 12 21a5.4 5.4 0 0 1-5.4-5.6c0-2.8 2-5.7 5.4-8.9z"/><path d="M12 12.5c1.3 1.3 2 2.4 2 3.4a2 2 0 0 1-4 0c0-1 .7-2.1 2-3.4z"/>'),
    'shape_security_official.png': localSvg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 8l4 2.2v4.4L12 17l-4-2.4v-4.4L12 8z"/>'),

    // Application firewalls — a wall, a shield, a lock.
    'f5_official.png': localSvg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9.7h18M3 14.3h18"/><path d="M9 5v4.7M15 9.7v4.6M9 14.3V19"/>'),
    'imperva_official.png': localSvg('<path d="M12 3l7 3v5.6c0 4.1-2.9 7.5-7 8.4-4.1-.9-7-4.3-7-8.4V6l7-3z"/><circle cx="12" cy="11" r="1.6"/><path d="M12 12.6V15"/>'),
    'sucuri_official.png': localSvg('<rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/><path d="M12 14v2.5"/>'),

    // Challenges — the thing a human is asked to do.
    'recaptcha_official.png': localSvg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>'),
    'hcaptcha_official.png': localSvg('<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8.2 12.2l2.6 2.6 5-5.6"/>'),
    'funcaptcha_official.png': localSvg('<path d="M10 4h4v2.6a1.6 1.6 0 0 0 2.6 1.2l1.8 1.8A1.6 1.6 0 0 0 17.4 12H20v4h-2.6a1.6 1.6 0 0 0-1.2 2.6L14.4 20H10v-2.6a1.6 1.6 0 0 0-2.6-1.2L5.6 14.4A1.6 1.6 0 0 0 6.6 12H4V8h2.6A1.6 1.6 0 0 0 7.8 5.4L10 4z"/>'),
    'geetest_official.png': localSvg('<rect x="3.5" y="7" width="17" height="10" rx="2"/><rect x="5.5" y="9.5" width="5" height="5" rx="1"/><path d="M13 12h5"/><path d="M16 9.8L18.2 12 16 14.2"/>')
  };

  scopeRoot.BrandGlyphs = Object.freeze({
    /** Raw map, keyed by the historical `*_official.png` filenames. */
    map: LOCAL_GLYPHS,
    /** The glyph for an icon filename, or '' when it is not a vendor icon. */
    resolve(glyphLabel) {
      if (!glyphLabel || typeof glyphLabel !== 'string') return '';
      return LOCAL_GLYPHS[glyphLabel.toLowerCase()] || '';
    },
    /** An image-safe source for UI surfaces that must render through an <img>. */
    resolvePayloadAddress(glyphLabel) {
      if (!glyphLabel || typeof glyphLabel !== 'string') return '';
      return toPayloadAddress(LOCAL_GLYPHS[glyphLabel.toLowerCase()] || '');
    },
    performHas(glyphLabel) {
      return !!(glyphLabel && typeof glyphLabel === 'string' && LOCAL_GLYPHS[glyphLabel.toLowerCase()]);
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
