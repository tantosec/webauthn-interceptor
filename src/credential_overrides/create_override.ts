import { publicKeyCredentialCreationOptionsToJSON } from '../common_types';
import { CreateBypass, makeCredentialOverride, PendingRequestsMap } from './common_override_utils';

export function getCreateOverride(
    downstream: typeof navigator.credentials.create,
    pendingRequests: PendingRequestsMap,
    bypass: CreateBypass,
): typeof navigator.credentials.create {
    return makeCredentialOverride<CredentialCreationOptions>(
        'create',
        downstream,
        publicKeyCredentialCreationOptionsToJSON,
        pendingRequests,
        bypass,
    );
}
