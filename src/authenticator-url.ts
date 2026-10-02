export function parseAuthenticatorUrl(value: string): URL {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('badAuthenticator URL must use http:// or https://.');
    if (url.search || url.hash)
        throw new Error('badAuthenticator URL must not include a query string or fragment.');
    // Treat the configured path as a directory, including when it has no trailing slash.
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}
