/**
 * Shared router response helpers.
 */
function sendFailureReply(sendReply, failure, localExtra = {}) {
    const packet = failure && failure.message ? failure.message : String(failure);
    sendReply({ status: 'error', error: packet, ...localExtra });
    return false;
}

function sendUnknownPacketReply(sendReply) {
    sendReply({ status: 'unknown' });
    return false;
}
