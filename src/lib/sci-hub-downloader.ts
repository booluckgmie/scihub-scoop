
'use server';
/**
 * @fileOverview Server-side utility to download a PDF from Sci-Hub for a given DOI.
 * Uses axios for HTTP requests and supports SOCKS proxy.
 * Returns the PDF content as a Base64 data URI or an error.
 *
 * - downloadSciHubPdf - A function that handles the download process.
 * - SciHubInput - The input type for the downloadSciHubPdf function.
 * - SciHubOutput - The return type for the downloadSciHubPdf function (Base64 data URI or error).
 */
import { z } from 'zod';
import axios, { AxiosRequestConfig, AxiosResponse, ResponseType } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent'; // For potential HTTPS proxy support
import * as https from 'https';

// Define input schema using Zod
const SciHubInputSchema = z.object({
  doi: z.string().describe('The DOI of the paper to download.'),
});
export type SciHubInput = z.infer<typeof SciHubInputSchema>;

// Define output schema using Zod
const SciHubOutputSchema = z.object({
    success: z.boolean(),
    dataUri: z.string().optional().describe("The Base64 encoded data URI of the PDF file (e.g., 'data:application/pdf;base64,...'). Present only on success."),
    resolvedUrl: z.string().optional().describe("The final URL resolved from Sci-Hub."),
    errorMessage: z.string().optional().describe("Error message if the download failed."),
    contentType: z.string().optional().describe("The content type received from the final download URL."),
});
export type SciHubOutput = z.infer<typeof SciHubOutputSchema>;

// --- Proxy Configuration ---
const USE_PROXY = false; // Set to true to enable proxy
const proxyUrl = 'socks5://127.0.0.1:7890'; // Your proxy address (SOCKS5 in this case)
// --- End Proxy Configuration ---

const getAxiosAgent = (): https.Agent | undefined => {
    if (!USE_PROXY) return undefined;
    try {
        if (proxyUrl.startsWith('socks')) {
            console.log(`Using SOCKS proxy agent: ${proxyUrl}`);
            return new SocksProxyAgent(proxyUrl);
        } else if (proxyUrl.startsWith('http')) {
            console.log(`Using HTTPS proxy agent: ${proxyUrl}`);
            // Axios needs HttpsProxyAgent for http/https proxies when making HTTPS requests
            return new HttpsProxyAgent(proxyUrl);
        } else {
             console.warn(`Unsupported proxy protocol in URL: ${proxyUrl}`);
             return undefined;
        }
    } catch (e) {
        console.error("Failed to create proxy agent:", e);
        return undefined;
    }
}

const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/',
};

const getAxiosConfig = (responseType: ResponseType = 'text'): AxiosRequestConfig => {
    const agent = getAxiosAgent();
    return {
        headers: commonHeaders,
        // Axios needs separate agents for HTTP and HTTPS when using proxies
        httpsAgent: agent,
        // httpAgent: agent, // Add if you need proxy for HTTP requests too
        timeout: 90000, // 90 seconds timeout
        maxRedirects: 10, // Follow redirects (axios default is 5)
        responseType: responseType,
         // Validate status to handle non-2xx responses without throwing immediately
        validateStatus: function (status) {
            return status >= 200 && status < 500; // Accept 2xx, 3xx, 4xx
        },
    };
};

/**
 * Attempts to download a PDF from Sci-Hub for the given DOI using Axios.
 * @param input The input containing the DOI.
 * @returns A promise resolving to the SciHubOutput.
 */
export async function downloadSciHubPdf(input: SciHubInput): Promise<SciHubOutput> {
    const validation = SciHubInputSchema.safeParse(input);
    if (!validation.success) {
        return { success: false, errorMessage: `Invalid input: ${validation.error.message}` };
    }

    const { doi } = validation.data;
    const sciHubDomains = ['sci-hub.se', 'sci-hub.st', 'sci-hub.ru', 'sci-hub.hk', 'sci-hub.tw'];
    let lastError: any = new Error('Failed to connect to any Sci-Hub mirror.');
    let resolvedUrl: string | undefined = undefined;
    let finalContentType: string | undefined = undefined;

    console.log(`Starting download process for DOI: ${doi} ${USE_PROXY ? `via proxy ${proxyUrl}` : ''}`);

    for (const domain of sciHubDomains) {
        const initialSciHubUrl = `https://${domain}/${doi}`;
        try {
            console.log(`Step 1: Resolving URL for DOI: ${doi} from ${initialSciHubUrl}`);

            // === Step 1: Initial request to handle redirects and get final URL ===
            // Make a HEAD request first to avoid downloading unnecessary HTML if it's not a PDF redirect
            let headResponse: AxiosResponse;
            try {
                 headResponse = await axios.head(initialSciHubUrl, getAxiosConfig());
                 resolvedUrl = headResponse.request?.responseURL || headResponse.request?._redirectable?._options?.href || initialSciHubUrl; // Get final URL after redirects
            } catch (headError: any) {
                 // If HEAD fails (e.g., 405 Method Not Allowed), try GET immediately
                if (axios.isAxiosError(headError) && headError.response?.status === 405) {
                    console.warn(`HEAD request failed for ${initialSciHubUrl}, trying GET...`);
                     const getResponse = await axios.get(initialSciHubUrl, getAxiosConfig('arraybuffer')); // Get binary data directly
                     resolvedUrl = getResponse.request?.responseURL || getResponse.request?._redirectable?._options?.href || initialSciHubUrl;
                     headResponse = getResponse; // Use the GET response for checks below
                } else {
                    console.error(`Initial request failed for ${initialSciHubUrl}:`, headError.message || headError);
                    lastError = headError;
                    continue; // Try next domain
                }

            }

            console.log(`Resolved URL for ${doi} from ${domain}: ${resolvedUrl}`);
            finalContentType = headResponse.headers['content-type'];
            console.log(`Initial response status: ${headResponse.status}, Content-Type: ${finalContentType}`);

            // Check status and content type from the initial response
             if (headResponse.status >= 400) {
                 let errorBody = '';
                 if (headResponse.data) {
                      // If responseType was arraybuffer, need to convert it to string to check content
                     if (headResponse.config.responseType === 'arraybuffer' && headResponse.data instanceof ArrayBuffer) {
                         errorBody = Buffer.from(headResponse.data).toString('utf-8');
                     } else if (typeof headResponse.data === 'string'){
                        errorBody = headResponse.data;
                     }
                 }
                 console.error(`Initial request failed with status ${headResponse.status} for ${resolvedUrl}`);
                 if (errorBody.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub.');
                 } else if (errorBody.toLowerCase().includes('captcha')) {
                    lastError = new Error('Sci-Hub requires CAPTCHA.');
                 } else {
                    lastError = new Error(`Initial request failed with status ${headResponse.status}`);
                 }
                  // If we got a 4xx error, it's likely the DOI is the issue, not the mirror
                 if (headResponse.status >= 400 && headResponse.status < 500) {
                     return { success: false, resolvedUrl: resolvedUrl, errorMessage: lastError.message, contentType: finalContentType };
                 }
                 continue; // Try next domain for server errors (5xx)
             }


            // === Step 2: Check Content-Type and potentially fetch content if needed ===
            if (finalContentType?.includes('application/pdf')) {
                console.log(`Initial response is PDF for ${doi}. Fetching content...`);

                // If the initial request wasn't already a GET with arraybuffer, fetch it now
                let contentResponse: AxiosResponse<ArrayBuffer>;
                if (headResponse.config.method?.toUpperCase() !== 'GET' || headResponse.config.responseType !== 'arraybuffer') {
                     contentResponse = await axios.get(resolvedUrl, getAxiosConfig('arraybuffer'));
                      if (contentResponse.status >= 400) {
                         console.error(`Content fetch failed with status ${contentResponse.status} for ${resolvedUrl}`);
                         lastError = new Error(`Content fetch failed with status ${contentResponse.status}`);
                          // Treat as final failure for this DOI if 4xx
                         if (contentResponse.status < 500) return { success: false, resolvedUrl: resolvedUrl, errorMessage: lastError.message, contentType: finalContentType };
                         continue; // Try next domain for 5xx
                      }
                } else {
                     contentResponse = headResponse as AxiosResponse<ArrayBuffer>; // Reuse the response if suitable
                }

                const buffer = contentResponse.data;
                if (!buffer || buffer.byteLength === 0) {
                    console.error(`Received empty PDF buffer for ${doi} from ${resolvedUrl}`);
                    lastError = new Error('Downloaded PDF file is empty.');
                    continue; // Try next domain, might be a temporary issue
                }
                const base64Pdf = Buffer.from(buffer).toString('base64');
                const dataUri = `data:application/pdf;base64,${base64Pdf}`;
                console.log(`Successfully generated data URI for ${doi}. Length: ${dataUri.length}`);
                return { success: true, dataUri, resolvedUrl: resolvedUrl, contentType: finalContentType };

            } else if (finalContentType?.includes('html')) {
                 console.warn(`Received HTML instead of PDF for DOI: ${doi} from ${resolvedUrl}.`);
                 // Fetch the HTML body if we only did a HEAD request
                 let bodyText = '';
                 if (headResponse.config.method?.toUpperCase() === 'HEAD') {
                    const getResponse = await axios.get(resolvedUrl, getAxiosConfig('text'));
                     if (getResponse.status < 400 && typeof getResponse.data === 'string') {
                         bodyText = getResponse.data;
                     }
                 } else if (typeof headResponse.data === 'string') {
                     bodyText = headResponse.data;
                 }

                 if (bodyText.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub (HTML response).');
                 } else if (bodyText.toLowerCase().includes('captcha')) {
                    lastError = new Error('Sci-Hub requires CAPTCHA.');
                 } else {
                    lastError = new Error('Received HTML page instead of PDF (unknown reason).');
                 }
                 console.warn(`HTML Body (first 500 chars): ${bodyText.substring(0, 500)}`);
                  // HTML usually means the DOI is the problem, or captcha. Treat as final failure for this DOI.
                  return { success: false, resolvedUrl: resolvedUrl, errorMessage: lastError.message, contentType: finalContentType };

            } else {
                console.error(`Unexpected content type: ${finalContentType} for ${doi} from ${resolvedUrl}.`);
                lastError = new Error(`Unexpected content type received: ${finalContentType ?? 'unknown'}`);
                continue; // Try next domain
            }

        } catch (error: any) {
            console.error(`Error processing DOI ${doi} with domain ${domain}:`, error?.message || error);
            lastError = error;
             if (axios.isAxiosError(error)) {
                 if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                     console.warn(`Timeout occurred for ${domain}. Trying next domain.`);
                     lastError = new Error('Download timed out.');
                 } else if (error.response) {
                     console.warn(`Request failed with status ${error.response.status} for ${domain}.`);
                      // Treat 4xx errors on a specific mirror as potentially final for the DOI
                     if (error.response.status >= 400 && error.response.status < 500) {
                        let errorBody = '';
                         if (error.response.data && typeof error.response.data === 'string') {
                             errorBody = error.response.data;
                         } else if (error.response.data && error.response.config.responseType === 'arraybuffer') {
                             errorBody = Buffer.from(error.response.data).toString('utf-8');
                         }
                         if (errorBody.toLowerCase().includes('article not found')) {
                              lastError = new Error('Article not found on Sci-Hub.');
                         } else if (errorBody.toLowerCase().includes('captcha')) {
                             lastError = new Error('Sci-Hub requires CAPTCHA.');
                         } else {
                            lastError = new Error(`Request failed with status ${error.response.status}`);
                         }
                         return { success: false, resolvedUrl: resolvedUrl, errorMessage: lastError.message, contentType: finalContentType };
                     }
                 } else if (error.request) {
                      console.warn(`No response received for ${domain}. Network issue?`);
                      lastError = new Error('Network error: No response received from Sci-Hub mirror.');
                 }
            }
        }
    }

    // If the loop completes without success
    console.error(`All attempts failed for DOI ${doi}. Last error:`, lastError?.message || lastError);
    let errorMessage = 'Failed to download from all Sci-Hub mirrors.';
    if (lastError instanceof Error) {
        errorMessage = lastError.message;
        // Consolidate common error messages
        if (errorMessage.toLowerCase().includes('article not found')) {
             errorMessage = 'Article not found on Sci-Hub.';
        } else if (errorMessage.toLowerCase().includes('captcha')) {
            errorMessage = 'Sci-Hub CAPTCHA required or content blocked.';
        } else if (errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('timed out')) {
            errorMessage = 'Download timed out. Sci-Hub might be slow or unreachable.';
        } else if (errorMessage.includes('Network error') || errorMessage.toLowerCase().includes('enetunreach') || errorMessage.toLowerCase().includes('econnrefused') || errorMessage.includes('socket hang up')) {
            errorMessage = 'Network error connecting to Sci-Hub mirror.';
        } else if (errorMessage.includes('status code 404')) {
            errorMessage = 'Article not found on Sci-Hub (404).';
        } else if (errorMessage.includes('status')) {
            // Keep specific status errors if not already handled
        } else {
             errorMessage = `An unexpected error occurred: ${errorMessage}`; // Generic fallback
        }
    } else if (typeof lastError === 'string') {
        errorMessage = lastError;
    }

    return { success: false, resolvedUrl: resolvedUrl, errorMessage, contentType: finalContentType };
}
