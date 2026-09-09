/**
 * registerLogCollectorHandlers registration.
 * Extracted from message-router switch cases for maintainability.
 */
function registerTraceCollectorRoutes(localRegistry, localContext) {
    void localContext;

    const routeTraceCollectorEnable = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            traceCollector.performEnable();
            Telemetry.repository('[LogCollector] Log collection enabled via settings');
        }
        if (typeof globalThis !== 'undefined') {
            globalThis.journalActive = true;
        }
        sendReply({ status: 'success' });
    };
    localRegistry['JOURNAL_ENABLE'] = routeTraceCollectorEnable;

    const routeTraceCollectorDisable = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            traceCollector.performDisable();
            Telemetry.repository('[LogCollector] Log collection disabled via settings');
        }
        if (typeof globalThis !== 'undefined') {
            globalThis.journalActive = false;
        }
        sendReply({ status: 'success' });
    };
    localRegistry['JOURNAL_DISABLE'] = routeTraceCollectorDisable;

    const routeTraceCollectorPurge = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            traceCollector.purge();
            Telemetry.repository('[LogCollector] Logs cleared');
            sendReply({ status: 'success' });
        } else {
            sendReply({ status: 'error', message: 'LogCollector not available' });
        }
        return true; // Keep message channel open for response
    };
    localRegistry['JOURNAL_PURGE'] = routeTraceCollectorPurge;

    const routeTraceCollectorExportJson = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            const localJsonFilename = traceCollector.performExportAsJSON();
            Telemetry.repository('[LogCollector] Exported logs as JSON:', localJsonFilename);
            sendReply({ status: 'success', filename: localJsonFilename });
        } else {
            sendReply({ status: 'error', message: 'LogCollector not available' });
        }
        return true; // Keep message channel open for response
    };
    localRegistry['JOURNAL_EXPORT_JSON'] = routeTraceCollectorExportJson;

    const routeTraceCollectorExportCopy = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            const copyFilename = traceCollector.exportAsCopy();
            Telemetry.repository('[LogCollector] Exported logs as text:', copyFilename);
            sendReply({ status: 'success', filename: copyFilename });
        } else {
            sendReply({ status: 'error', message: 'LogCollector not available' });
        }
        return true; // Keep message channel open for response
    };
    localRegistry['JOURNAL_EXPORT_TEXT'] = routeTraceCollectorExportCopy;

    const routeTraceCollectorResolveTotal = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            // getLogCount is async, so handle it with Promise
            traceCollector.resolveTraceTotal().then((total) => {
                sendReply({ status: 'success', count: total });
            }).catch((failure) => {
                Telemetry.failure('STORAGE', '[LogCollector] Error getting log count:', failure);
                sendReply({ status: 'error', message: 'Failed to get log count', count: 0 });
            });
            return true; // Indicate async response
        } else {
            sendReply({ status: 'error', message: 'LogCollector not available', count: 0 });
        }
    };
    localRegistry['JOURNAL_READ_COUNT'] = routeTraceCollectorResolveTotal;

    const routeTraceCollectorAssignLimitTraces = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (typeof traceCollector !== 'undefined') {
            const limitTraces = inbound.maxLogs;
            traceCollector.assignLimitTraces(limitTraces);
            Telemetry.repository('[LogCollector] Max logs set to:', limitTraces);
            sendReply({ status: 'success', maxLogs: limitTraces });
        } else {
            sendReply({ status: 'error', message: 'LogCollector not available' });
        }
    };
    localRegistry['JOURNAL_SET_CEILING'] = routeTraceCollectorAssignLimitTraces;

}
