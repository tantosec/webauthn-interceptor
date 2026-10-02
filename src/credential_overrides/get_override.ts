import { publicKeyCredentialRequestOptionsToJSON } from '../common_types';
import { GetBypass, makeCredentialOverride, PendingRequestsMap } from './common_override_utils';

export function getGetOverride(
    downstream: typeof navigator.credentials.get,
    pendingRequests: PendingRequestsMap,
    bypass: GetBypass,
): typeof navigator.credentials.get {
    return makeCredentialOverride<CredentialRequestOptions>(
        'get',
        downstream,
        publicKeyCredentialRequestOptionsToJSON,
        pendingRequests,
        bypass,
    );
}
