/** LiveATC edge that answers a mount name with a redirect to a stream host. */
export const ATC_STREAM_ORIGIN = 'https://d.liveatc.net';
/** Every hop of the redirect chain must stay on a LiveATC host. */
export const ATC_STREAM_HOST_SUFFIX = '.liveatc.net';
/** Redirect hops tolerated before giving up (d.liveatc.net → sN-xxx.liveatc.net). */
export const ATC_STREAM_MAX_REDIRECTS = 3;
/** Header deadline for the upstream connection; a live body then runs on. */
export const ATC_STREAM_TIMEOUT_MS = 12_000;
/** LiveATC answers bare or bot-looking agents with a challenge page. */
export const ATC_STREAM_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
/** Concurrent listeners this proxy will relay at once (one page plays one stream). */
export const ATC_STREAM_MAX_CONCURRENT = 8;
