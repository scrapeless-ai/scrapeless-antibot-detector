/**
 * Background message handler registry.
 */
function assemblePacketRouteRegistry(localContext) {
    const localRegistry = {};

    if (typeof registerLoggingRoutes === 'function') {
        registerLoggingRoutes(localRegistry, localContext);
    }
    if (typeof registerScanRoutes === 'function') {
        registerScanRoutes(localRegistry, localContext);
    }
    if (typeof registerMemoRoutes === 'function') {
        registerMemoRoutes(localRegistry, localContext);
    }
    if (typeof registerPreferencesRoutes === 'function') {
        registerPreferencesRoutes(localRegistry, localContext);
    }
    if (typeof registerTraceCollectorRoutes === 'function') {
        registerTraceCollectorRoutes(localRegistry, localContext);
    }

    return localRegistry;
}
