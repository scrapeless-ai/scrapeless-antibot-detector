/**
 * Explanation Modals Module
 *
 * Contains methods for explanation/help modals:
 * - Regex explanation modal
 * - Whole Word explanation modal
 * - Case Sensitive explanation modal
 * - Method Help modal (detection method descriptions)
 *
 * These methods are added to the Rules prototype.
 * Dependencies: rules-modal-lifecycle.js, rules.js
 */

// ============================================
// Data-driven explanation modal setup
// ============================================

const EXPLANATION_DIALOG_CONFIGS = [
  {
    modal: '#regexExplanationModal',
    btn: '#regexExplanationBtn',
    btnAlt: '#regexExplanationBtnValue',
    buttons: ['#payloadUrlRegexExplanationBtn'],
    close: '#closeRegexExplanation'
  },
  {
    modal: '#wholeWordExplanationModal',
    btn: '#wholeWordExplanationBtn',
    btnAlt: '#wholeWordExplanationBtnValue',
    close: '#closeWholeWordExplanation'
  },
  {
    modal: '#caseSensitiveExplanationModal',
    btn: '#caseSensitiveExplanationBtn',
    btnAlt: '#caseSensitiveExplanationBtnValue',
    buttons: ['#payloadUrlCaseExplanationBtn'],
    close: '#closeCaseSensitiveExplanation'
  }
];

/**
 * Setup all explanation modals (regex, wholeWord, caseSensitive)
 * Replaces setupRegexExplanationModal, setupWholeWordExplanationModal, setupCaseSensitiveExplanationModal
 */
CatalogPresenter.prototype.wireExplanationDialogs = function() {
  this._explanationModals = {};

  for (const profile of EXPLANATION_DIALOG_CONFIGS) {
    const dialog = new PolicyDialogCoordinator(profile.modal);
    dialog.wireCloseSubscriptions(profile.close);
    [profile.btn, profile.btnAlt, ...(profile.buttons || [])]
      .filter(Boolean)
      .forEach((localSelector) => dialog.wireOpenSubscription(localSelector));
    this._explanationModals[profile.modal] = dialog;
  }
};

// ============================================
// Method Help Modal
// ============================================

/**
 * Setup method help modal event listeners
 */
CatalogPresenter.prototype.wirePhaseHelpDialog = function() {
  this._methodHelpModal = new PolicyDialogCoordinator('#methodHelpModal', {
    hideParentOnOpen: false
  });
  this._methodHelpModal.wireCloseSubscriptions('#closeMethodHelp');
};

/**
 * Get help content for detection method types
 */
CatalogPresenter.prototype.resolvePhaseHelpContent = function(phaseKind) {
  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFb) => (localT && localT.resolve(lookupKey)) || localFb;
  const localHelpContent = {
    'js_hooks': {
      title: localTr('helpJsHooksTitle', 'JavaScript Hooks Detection'),
      description: localTr('helpJsHooksDescription', 'Hooks intercept browser API calls like <code>canvas.toDataURL()</code>, <code>navigator.webdriver</code>, or <code>RTCPeerConnection.createOffer()</code>. When a page calls these APIs, the hook records which anti-bot or fingerprinting system is active.'),
      warning: localTr('helpJsHooksWarning', 'Hooks only fire when the APIs are actually called by page scripts. Some sites cache fingerprint results, so use a hard reload (Ctrl+F5) to trigger detection again.'),
      tip: localTr('helpJsHooksTip', 'Specify the full API path (e.g., <code>HTMLCanvasElement.prototype.toDataURL</code>).')
    },
    'window': {
      title: localTr('helpWindowTitle', 'Window Properties Detection'),
      description: localTr('helpWindowDescription', 'Detects JavaScript objects and properties added to the <code>window</code> object by anti-bot scripts. Checks for specific paths like <code>_cf_chl_opt</code> (Cloudflare), <code>grecaptcha</code> (reCAPTCHA), or <code>dataDomeOptions</code> (DataDome).'),
      warning: localTr('helpWindowWarning', 'Window properties must exist at page load time. If scripts create properties asynchronously, detection may fail.'),
      tip: localTr('helpWindowTip', 'Use dot notation for nested properties (e.g., <code>navigator.webdriver</code> or <code>window._pxAppId</code>).')
    },
    'url': {
      title: localTr('helpUrlTitle', 'URL Pattern Detection'),
      description: localTr('helpUrlDescription', 'Matches URLs of loaded resources (scripts, images, stylesheets, XHR requests). Detects CDN URLs, API endpoints, and third-party domains used by anti-bot services.'),
      warning: localTr('helpUrlWarning', 'URL detection triggers on any matching resource. Use specific patterns to avoid false positives.'),
      tip: localTr('helpUrlTip', 'Enable "Regex" for flexible pattern matching (e.g., <code>cdn\\.example\\.com/.*\\.js</code>). Use "Whole Word" to match exact domains.')
    },
    'header': {
      title: localTr('helpHeaderTitle', 'HTTP Header Detection'),
      description: localTr('helpHeaderDescription', 'Detects HTTP request and response headers set by anti-bot systems. Examples: <code>cf-ray</code> (Cloudflare), <code>x-datadome-headers</code> (DataDome), <code>x-akamai-*</code> (Akamai).'),
      warning: localTr('helpHeaderWarning', 'Only response headers are visible to the extension. Request headers sent by the browser cannot be detected.'),
      tip: localTr('helpHeaderTip', 'Use Name/Value pairs for precise matching. Enable "Regex" on name to match header families (e.g., <code>x-akamai-.*</code>).')
    },
    'cookie': {
      title: localTr('helpCookieTitle', 'Cookie Detection'),
      description: localTr('helpCookieDescription', 'Detects cookies set by anti-bot and fingerprinting systems. Examples: <code>__cf_bm</code> (Cloudflare), <code>_abck</code> (Akamai), <code>datadome</code> (DataDome).'),
      warning: localTr('helpCookieWarning', 'HttpOnly cookies are not accessible to JavaScript and cannot be detected. Secure cookies require HTTPS.'),
      tip: localTr('helpCookieTip', 'Use Name/Value pairs: leave Value empty to match any cookie with that name. Enable "Regex" on name to match cookie families (e.g., <code>_px.*</code>).')
    },
    'content': {
      title: localTr('helpContentTitle', 'Page Content Detection'),
      description: localTr('helpContentDescription', 'Searches for text patterns in page HTML, inline scripts, and loaded JavaScript files. Detects obfuscated code, specific function names, or unique strings used by anti-bot scripts.'),
      warning: localTr('helpContentWarning', 'Content detection can be slow on large pages. Use specific patterns and enable "Whole Word" to reduce false positives.'),
      tip: localTr('helpContentTip', 'Search in "Scripts Only" scope for better performance. Use "Regex" for complex patterns (e.g., <code>function\\s+botDetect</code>).')
    },
    'dom': {
      title: localTr('helpDomTitle', 'DOM Selector Detection'),
      description: localTr('helpDomDescription', 'Detects HTML elements using CSS selectors. Finds CAPTCHA containers, challenge pages, bot detection widgets, and invisible tracking elements.'),
      warning: localTr('helpDomWarning', 'DOM detection requires elements to exist in the page. Dynamically created elements may not be detected immediately.'),
      tip: localTr('helpDomTip', 'Use specific selectors like <code>#captcha-container</code> or <code>.g-recaptcha</code>. Attribute selectors work too: <code>[data-sitekey]</code>.')
    },
    'payload': {
      title: localTr('helpPayloadTitle', 'Request Payload Detection'),
      description: localTr('helpPayloadDescription', 'Monitors all HTTP POST/PUT/PATCH requests including main frame navigations, API calls (fetch/XHR), and background requests. Detects patterns in request payloads to identify anti-bot telemetry, form submissions, and sensor data.'),
      warning: localTr('helpPayloadWarning', 'Payload detection can generate many matches on data-heavy sites. Use specific patterns and enable "Case Sensitive" for accurate matching to reduce false positives.'),
      tip: localTr('helpPayloadTip', 'Look for unique parameter names or obfuscated payload structures (e.g., <code>sensor_data</code>, <code>challenge_token</code>). Enable "Regex" for flexible pattern matching of JSON structures.')
    }
  };

  const localContent = localHelpContent[phaseKind];
  if (!localContent) {
    return {
      title: localTr('detectionMethodTitle', 'Detection Method'),
      html: `<p>${localTr('noHelpContentAvailable', 'No help content available for this method type.')}</p>`
    };
  }

  const cautionLabel = localTr('helpWarningLabel', 'Warning:');
  const localTipLabel = localTr('helpTipLabel', 'Tip:');
  return {
    title: localContent.title,
    html: `
      <p>${localContent.description}</p>
      ${localContent.warning ? `<p style="color: var(--warning); margin-top: 12px;"><strong>${cautionLabel}</strong> ${localContent.warning}</p>` : ''}
      ${localContent.tip ? `<p style="color: var(--accent-light); margin-top: 12px;"><strong>${localTipLabel}</strong> ${localContent.tip}</p>` : ''}
    `
  };
};

/**
 * Open method help modal
 */
CatalogPresenter.prototype.openPhaseHelpDialog = function(phaseKind) {
  const localTitle = document.querySelector('#methodHelpTitle');
  const localContent = document.querySelector('#methodHelpContent');
  if (!localTitle || !localContent) return;

  const helpPayload = this.resolvePhaseHelpContent(phaseKind);
  localTitle.textContent = helpPayload.title;
  localContent.innerHTML = helpPayload.html;

  this._methodHelpModal.performOpen();
};
