/**
 * HTTP header, cookie, payload, and network URL capture via webRequest API.
 * Stores captured data in TTLMap stores for use by the detection engine.
 */

// Wrap a webRequest listener so an unexpected throw is logged instead of
// becoming an unhandled service-worker rejection (which Chrome drops silently
// and which can destabilize the worker).
function safeWebInboundSubscription(operation) {
    return async (localDetails) => {
        try {
            return await operation(localDetails);
        } catch (failure) {
            Telemetry.failure('NETWORK', '[headerCapture] webRequest listener failed:', failure);
        }
    };
}

function wireHeaderCapture() {
    // Listen for response headers
    chrome.webRequest.onHeadersReceived.addListener(
        safeWebInboundSubscription(async (localDetails) => {
            // Skip if extension is disabled
            if (!await isExtensionActive()) {
                return;
            }

            // Skip header capture if tab has cache hit
if (cacheBackedTabs.has(localDetails.tabId)) {
                return;
            }

            // Only capture headers for main frame requests
            if (localDetails.type === 'main_frame' && localDetails.responseHeaders) {
                const localHeaders = {};
                const replyCookies = [];

                // Convert headers to object and extract Set-Cookie values
                localDetails.responseHeaders.forEach(localHeader => {
                    const headerLabel = localHeader.name.toLowerCase();
                    localHeaders[headerLabel] = localHeader.value;

                    if (headerLabel === 'set-cookie') {
                        const localCookieParts = localHeader.value.split(';')[0].split('=');
                        if (localCookieParts.length >= 2) {
                            replyCookies.push({
                                name: localCookieParts[0].trim(),
                                value: localCookieParts.slice(1).join('=').trim()
                            });
                        }
                    }
                });

                responseHeaderCache.assign(localDetails.tabId, {
                    url: localDetails.url,
                    headers: localHeaders,
                    timestamp: Date.now()
                });

                if (replyCookies.length > 0) {
                    setCookieCache.assign(localDetails.tabId, {
                        url: localDetails.url,
                        cookies: replyCookies,
                        timestamp: Date.now()
                    });
                }
            }
        }),
        { urls: ["<all_urls>"] },
        ["responseHeaders"]
    );

    // Listen for request headers
    chrome.webRequest.onBeforeSendHeaders.addListener(
        safeWebInboundSubscription(async (localDetails) => {
            // Skip if extension is disabled
            if (!await isExtensionActive()) {
                return;
            }

            // Skip header capture if tab has cache hit
if (cacheBackedTabs.has(localDetails.tabId)) {
                return;
            }

            // Only capture headers for main frame requests
            if (localDetails.type === 'main_frame' && localDetails.requestHeaders) {
                const localHeaders = {};

                localDetails.requestHeaders.forEach(localHeader => {
                    localHeaders[localHeader.name.toLowerCase()] = localHeader.value;
                });

                requestHeaderCache.assign(localDetails.tabId, {
                    url: localDetails.url,
                    headers: localHeaders,
                    timestamp: Date.now()
                });
            }
        }),
        { urls: ["<all_urls>"] },
        ["requestHeaders"]
    );

    // Listen for request payloads (POST/PUT/PATCH/DELETE bodies)
    chrome.webRequest.onBeforeRequest.addListener(
        safeWebInboundSubscription(async (localDetails) => {
            // Skip if extension is disabled
            if (!await isExtensionActive()) {
                return;
            }

            // Skip payload capture if tab has cache hit
if (cacheBackedTabs.has(localDetails.tabId)) {
                return;
            }

            if (localDetails.requestBody) {
                const phase = localDetails.method || 'GET';

                // Only store payloads for methods that typically have bodies
                if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(phase)) {
                    let payloadPayload = null;
                    let payloadKind = 'unknown';

                    if (localDetails.requestBody.formData) {
                        payloadPayload = localDetails.requestBody.formData;
                        payloadKind = 'formData';
                    }
                    else if (localDetails.requestBody.raw && localDetails.requestBody.raw.length > 0) {
                        const unprocessedPayload = localDetails.requestBody.raw.map(entry => {
                            if (entry.bytes) {
                                try {
                                    const localDecoder = new TextDecoder('utf-8');
                                    return localDecoder.decode(entry.bytes);
                                } catch (failure) {
                                    return btoa(String.fromCharCode(...new Uint8Array(entry.bytes)));
                                }
                            }
                            return '';
                        }).join('');

                        payloadPayload = unprocessedPayload;
                        payloadKind = 'raw';
                    }

                    // Store all payloads in an array per tab
                    if (payloadPayload) {
                        let localPayloads = requestBodyCache.resolve(localDetails.tabId) || [];

                        localPayloads.push({
                            url: localDetails.url,
                            method: phase,
                            payload: payloadPayload,
                            type: payloadKind,
                            timestamp: Date.now()
                        });

                        if (localPayloads.length > RuntimePolicy.MAX_PAYLOADS_PER_TAB) {
                            localPayloads.shift();
                        }

                        requestBodyCache.assign(localDetails.tabId, localPayloads);
                    }
                }
            }
        }),
        { urls: ["<all_urls>"] },
        ["requestBody"]
    );

    // Capture all network URLs for pattern detection (anti-bot scripts load asynchronously)
    chrome.webRequest.onBeforeRequest.addListener(
        safeWebInboundSubscription(async (localDetails) => {
            // Skip if extension is disabled
            if (!await isExtensionActive()) {
                return;
            }

if (cacheBackedTabs.has(localDetails.tabId)) return;

            if (localDetails.tabId < 0) return;

            // Skip heavy static-asset request types that anti-bot / fingerprint URL
            // patterns never meaningfully match, to bound per-tab memory and the
            // amount of URL data scanned on asset-heavy pages. Keep script/xhr/fetch/
            // websocket/image/ping/main_frame/sub_frame (beacons can be images/pings).
            if (localDetails.type === 'font' || localDetails.type === 'media' || localDetails.type === 'stylesheet') return;

            let networkAddresses = requestUrlCache.resolve(localDetails.tabId) || [];

            networkAddresses.push({
                url: localDetails.url,
                type: localDetails.type,        // 'main_frame', 'sub_frame', 'script', 'xhr', 'fetch', etc.
                method: localDetails.method,     // 'GET', 'POST', etc.
                timestamp: Date.now()
            });

            if (networkAddresses.length > RuntimePolicy.MAX_NETWORK_URLS_PER_TAB) {
                networkAddresses.shift();
            }

            requestUrlCache.assign(localDetails.tabId, networkAddresses);
        }),
        { urls: ["<all_urls>"] }
    );
}
