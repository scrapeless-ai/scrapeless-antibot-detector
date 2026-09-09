// Page-data extraction helpers for DetectionEngineManager.

function localExtractDocumentCookies() {
    const localCookies = [];

    if (document.cookie) {
        const localCookieStrings = document.cookie.split(';');

        localCookieStrings.forEach(localCookieString => {
            const localTrimmed = localCookieString.trim();
            const eqPosition = localTrimmed.indexOf('=');

            if (eqPosition > 0) {
                const label = localTrimmed.substring(0, eqPosition);
                const datum = localTrimmed.substring(eqPosition + 1);

                localCookies.push({
                    name: label,
                    value: datum.substring(0, 100), // Limit value length for performance
                    domain: window.location.hostname
                });
            }
        });
    }

    // Log all collected cookies - visible in Service Worker console
    if (typeof Telemetry !== 'undefined') {
        Telemetry.memo(`Collected ${localCookies.length} cookies from page`, {
            cookies: localCookies.map(localC => localC.name)
        });
    }

    return localCookies;
}


function localExtractDocumentScripts() {
    const localScripts = [];
    const scriptNodes = document.querySelectorAll('script');

    scriptNodes.forEach((localScript) => {
        // External scripts
        if (localScript.src) {
            const localContent = (localScript.textContent || localScript.innerHTML || '').trim();
            localScripts.push({
                type: 'external',
                src: localScript.src,
                content: localContent || localScript.src
            });
        }
        else if (localScript.textContent || localScript.innerHTML) {
            const localContent2 = (localScript.textContent || localScript.innerHTML || '').trim();
            if (localContent2.length > 0) {
                localScripts.push({
                    type: 'inline',
                    src: null,
                    content: localContent2
                });
            }
        }
    });

    Telemetry.findingsPane(`DetectionEngineManager: Found ${localScripts.length} script elements`);
    return localScripts;
}


function localExtractRelevantDomSnapshot() {
    const domPayload = [];
    let canvasTotal = 0;

    // Use NodeFilter to skip irrelevant elements (20-30% faster)
    const localRelevantTags = new Set(['iframe', 'form', 'div', 'meta', 'script', 'noscript', 'canvas']);

    const localWalker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode: function(localNode) {
                const tagLabel = localNode.tagName.toLowerCase();
                if (!localRelevantTags.has(tagLabel)) {
                    if (localNode.hasAttribute('data-sitekey') ||
                        localNode.hasAttribute('data-captcha') ||
                        localNode.hasAttribute('data-callback')) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const beginMoment = Date.now();
    let nodeTotal = 0;

    while (localWalker.nextNode()) {
        const node = localWalker.currentNode;
        const tagLabel = node.tagName.toLowerCase();
        nodeTotal++;

        if (!localRelevantTags.has(tagLabel)) {
            domPayload.push({
                selector: tagLabel,
                attributes: this.resolveRelevantNodeAttributes(node)
            });
            continue; // Skip switch statement
        }

        switch (tagLabel) {
            case 'iframe': {
                const localSrc = node.getAttribute('src') || '';
                if (localSrc) {
                    domPayload.push({
                        selector: 'iframe',
                        src: localSrc,
                        attributes: this.resolveRelevantNodeAttributes(node)
                    });
                }
                break;
            }

            case 'form': {
                domPayload.push({
                    selector: 'form',
                    action: node.getAttribute('action') || '',
                    id: node.getAttribute('id') || '',
                    class: node.getAttribute('class') || '',
                    attributes: this.resolveRelevantNodeAttributes(node)
                });
                break;
            }

            case 'div': {
                const token = node.getAttribute('id') || '';
                const classLabel = node.getAttribute('class') || '';
                if (token || classLabel) {
                    domPayload.push({
                        selector: 'div',
                        id: token,
                        class: classLabel
                    });
                }
                break;
            }

            case 'meta': {
                const label = node.getAttribute('name') || node.getAttribute('property') || '';
                const localContent = node.getAttribute('content') || '';
                if (label) {
                    domPayload.push({
                        selector: 'meta',
                        name: label,
                        content: localContent
                    });
                }
                break;
            }

            case 'script': {
                const localSrc2 = node.getAttribute('src') || '';
                if (localSrc2) {
                    domPayload.push({
                        selector: 'script',
                        src: localSrc2
                    });
                }
                break;
            }

            case 'noscript': {
                domPayload.push({
                    selector: 'noscript',
                    id: node.getAttribute('id') || '',
                    content: node.textContent.substring(0, 200) // First 200 chars
                });
                break;
            }

            case 'canvas': {
                canvasTotal++;
                break;
            }
        }
    }

    if (canvasTotal > 0) {
        domPayload.push({
            selector: 'canvas',
            count: canvasTotal
        });
    }

    const extractMoment = Date.now() - beginMoment;
    Telemetry.findingsPane(`[8C: DOM Batching] Walked ${nodeTotal} nodes in ${extractMoment}ms, collected ${domPayload.length} elements`);

    return domPayload;
}


function collectRelevantNodeAttributes(node) {
    if (!node) return {};

    const localAttributes = {};
    const localRelevantAttrs = ['id', 'class', 'src', 'href', 'action', 'data-sitekey', 'data-callback'];

    localRelevantAttrs.forEach(localAttr => {
        if (node.hasAttribute(localAttr)) {
            let datum = node.getAttribute(localAttr);
            // Limit attribute value length
            if (datum && datum.length > 100) {
                datum = datum.substring(0, 100) + '...';
            }
            localAttributes[localAttr] = datum;
        }
    });

    return localAttributes;
}
